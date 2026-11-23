// /admin/invites — Allen's approval page for invite requests (CR-INVITEFLOW.1 part A, spec §B).
//
// Who can reach it: a Cloudflare Access application on bervo.ai/admin that allows Allen's email only (never
// everyone). This function ALSO verifies the Access token itself and refuses without one (defence in depth,
// e.g. on a *.pages.dev hostname the bervo.ai Access app does not cover). Settings (Pages variables, Allen):
//   ACCESS_TEAM_DOMAIN  e.g. <team>.cloudflareaccess.com
//   ACCESS_AUD          the Access application's Audience (AUD) tag; comma-separated if previews have their own
//   ADMIN_EMAILS        comma-separated addresses allowed in (Allen's)
//   DB                  the same D1 binding as the form
//
// Approve / Not now / Mark invited / the note change ONLY the D1 row. Nothing here touches a server.
// CR-AUTOPROVISION.1 (Allen 11-15, "Approve is the go"): the Mini's picker (daily-dashboard
// tools/tenant/auto_provision.py, every 5 minutes) sees an approved request with a slug, builds its server and
// delivers the owner's link to /api/provision-link. This page shows the build (queued / building, step N of 14 /
// ready / failed at <step> / waiting: daily cap), a Retry button for a failed build (failed -> queued; the build
// continues from the failed step), and "link ready (expires <date>)" with Send buttons that send the delivered link
// server side (it is never put in this page). The paste field stays as the fallback for a hand-made link.
// CR-AUTOSLUG.1 (Allen 11-23): the Address code box comes pre-filled with a fresh code (_lib/addresscode.js, made on
// the server when the page is drawn: this page's CSP allows no script but its own nonce one). "Approve and build"
// approves with the code in the box (refused with a message when it is empty, invalid, reserved or already used);
// "Approve only" approves with no slug, so the picker builds nothing.
import { checkAccess, escapeHtml, pruneOld, redirect, stripFormatChars, TRIM_SET } from "../_lib/invites.js";
import { friendlyFromDirect, friendlyLink, GO_DEMO_HOSTS, GO_LABEL_RE, GO_PAGES, GO_RESERVED } from "../_lib/golink.js";
import { inviteBody, linkMatchesSlug, needsIphoneNoMacNote, MailError, reminderDue, reminderExpiryDate, sendingOff, sendTemplate, TEMPLATES } from "../_lib/mail.js";
import { addressProblem, addressTaken, newCode, takenAddresses } from "../_lib/addresscode.js";
import { BUILD_STEPS, deleteLink, linksFor, NOTE_WORDS, provisionFor, readLink, sendLinkEmail, TEMPLATE_KIND } from "../_lib/provision.js";

// The invite email (words: daily-dashboard docs/marketing/site/INVITE_FORM_COPY_V1.md §5, approved by Allen 11-10;
// they live in functions/_lib/mail.js now, the one sender). CR-WELCOMEEMAIL.1: **Send invite email** sends it
// through Postmark from this server; **Copy invite email** stays as the fallback (sending off or failed). The link
// Allen pastes is posted with Send, used for that one email and never stored or logged here; with Copy it never
// leaves his browser, as before.
export const INVITE_EMAIL_SUBJECT = TEMPLATES.invite.subject;
export const INVITE_EMAIL_TEMPLATE = TEMPLATES.invite.body;
const MAIL_LABEL = { invite: "Invite email", reminder_day3: "Day-3 reminder", reminder_day10: "Day-10 reminder",
  loaded: "\"You're loaded\" email", texts_mac: "Texts email (Mac)", texts_android: "Texts email (Android)" };
const SENT_FLASH = { ok: "Invite email sent.", reminder: "Reminder sent.", notdue: "Not sent: no reminder is due for this request.", off: "Not sent: sending is off. Use Copy below.",
  host: "Not sent: that link is for another server (this request's slug is on a different host). Nothing was sent.",
  link: "Not sent: that is not an owner link (https://<server>.bervo.ai/set-password?t=…). Nothing was sent.",
  failed: "Not sent: Postmark did not take it. Use Copy below, or try again.",
  // CR-AUTOPROVISION.1: Send with the link the Mini delivered (stored encrypted; never on this page).
  nolink: "Not sent: the delivered link is gone (sent already, or expired). Paste a hand-made link, or Retry the build.",
  state: "Not sent: this request is not approved or invited.",
  retried: "Build queued again: the Mini picks it up within 5 minutes and continues from the failed step.",
  // CR-AUTOSLUG.1: Approve and build refused (nothing changed; the request is as it was).
  code_empty: "Not approved: Approve and build needs an address code in the box. Type one, or reload the page for a new one. To approve without building a server, press Approve only.",
  code_invalid: "Not approved: an address code is lowercase letters, digits and hyphens, starts with a letter or digit, and is at most 31 characters.",
  code_reserved: "Not approved: that address code is a reserved name. Type another, or reload the page for a new one.",
  code_taken: "Not approved: that address code is already used by another request or server. Type another, or reload the page for a new one.",
  only_building: "Not approved: this request's server build was started earlier and would continue once approved. Press Approve and build to continue it, or leave it at Not now.",
  retry_noslug: "Not retried: this request has no address code, so the Mini would never pick the build up. Press Not now, then Approve and build with a code." };

const TRANSITIONS = {
  approve: { to: "approved", from: ["new", "not_now"], stamp: "approved_at" },
  not_now: { to: "not_now", from: ["new", "approved"], stamp: null },
  invited: { to: "invited", from: ["approved"], stamp: "invited_at" },
  // The customer is live: the row is trimmed to id, cohort, status and dates in the same UPDATE (Allen 11-10).
  claimed: { to: "claimed", from: ["invited"], stamp: null, trim: true },
  // The invitation ran out unused (14 days): deleted 90 days later with the not-now rows.
  expired: { to: "expired", from: ["invited"], stamp: null },
};

// Allen 11-11: "no-referrer" made browsers send Origin: null on this page's own form posts, so the CSRF check below
// refused every button (checked in a browser: no-referrer -> Origin=null; same-origin -> the real origin). "same-origin"
// still sends nothing to other sites.
// Cloudflare's email obfuscation rewrites addresses to "[email protected]" and its decoder script is blocked by this
// page's CSP, so every address is wrapped in email_off (the same marker privacy.html uses).
function em(v) { return `<!--email_off-->${escapeHtml(v)}<!--/email_off-->`; }

function page(body, status = 200, nonce = "") {
  const csp = "default-src 'none'; " + (nonce ? `script-src 'nonce-${nonce}'; ` : "") +
    "style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, "Cache-Control": "no-store",
      "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function refused(status) {
  return page(`<!doctype html><meta charset="utf-8"><title>Not available</title><p>Not available.</p>`, status);
}

function fmt(iso) { return iso ? escapeHtml(String(iso).replace("T", " ").slice(0, 16) + " UTC") : ""; }

const PLAN_NAMES = { standard: "Standard $49/mo", private: "Dedicated $99/mo" };
const PROVIDER_NAMES = { google: "Google", microsoft: "Microsoft 365 or Exchange", other: "Other" };
const HEARD_NAMES = { referral: "Referred by someone", social: "Social Media", search: "Web Search (Google, etc.)",
  ai: "AI told me (ChatGPT, Claude, Gemini, etc.)", media: "An article, podcast or newsletter", ad: "An online ad",
  event: "An event or talk", other: "Other" };
const COMPUTER_NAMES = { windows: "Windows PC", mac: "Mac", none: "Neither (iPad and/or phone only)" };
function computerList(json) {
  let list;
  try { list = JSON.parse(json || "[]"); } catch { return String(json || ""); }
  return Array.isArray(list) ? list.map((x) => COMPUTER_NAMES[x] || String(x)).join(", ") : String(json);
}

function providerList(json) {
  let list;
  try { list = JSON.parse(json || "[]"); } catch { return String(json || ""); }
  return Array.isArray(list) ? list.map((x) => PROVIDER_NAMES[x] || String(x)).join(", ") : String(json);
}

function renderMail(list) {
  if (!list || !list.length) return "";
  const e = escapeHtml;
  return `<ul class="mail-log">${list.map((m) => `<li>${e(MAIL_LABEL[m.template] || m.template)}: ` +
    `<span class="ms ms-${e(m.status)}">${e(m.status)}${m.detail ? ` (${e(m.detail)})` : ""}</span> · ${fmt(m.created_at)}` +
    `${m.status === "failed" && m.error_code != null ? ` · code ${e(m.error_code)}` : ""}</li>`).join("")}</ul>`;
}

function renderReminder(r, mails, mailOff, nowMs, links = {}) {
  const due = reminderDue(r, mails || [], nowMs);
  if (!due) return "";
  const e = escapeHtml;
  const label = due === "reminder_day3" ? "Day-3 reminder" : "Day-10 reminder";
  const ready = links[TEMPLATE_KIND[due]];
  const stored = ready ? `<p class="ready"><b>Fresh link ready</b> (made by the Mini; expires ${fmt(ready)}).</p>
${mailOff ? "" : `<form method="post" action="/admin/invites" class="send"><input type="hidden" name="id" value="${e(r.id)}">
<input type="hidden" name="kind" value="${e(TEMPLATE_KIND[due])}">
<button name="action" value="send_reminder_stored" type="submit">Send ${label.toLowerCase()}</button> to ${em(r.email)} with the delivered link</form>`}` : "";
  return `<div class="remind">${stored}<p><b>${label} due.</b> On the Mini, run <code>tools/tenant/owner_invite_link.py</code> for
this customer again: it makes a fresh link and the earlier one stops working. Paste the fresh link here and send it within a
day (the email says the link stays open until ${e(reminderExpiryDate(nowMs, r.timezone))}).</p>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}).</p>` : `<form method="post" action="/admin/invites" class="send">
<input type="hidden" name="id" value="${e(r.id)}">
<label>Fresh owner link <input name="link" type="url" autocomplete="off" required></label>
<button name="action" value="send_reminder" type="submit">Send ${label.toLowerCase()}</button> to ${em(r.email)}
</form>`}</div>`;
}

// CR-AUTOSLUG.1 fix round: what "Approve only" may do for this request.
//   "clear": no build record -> approve with no slug, nothing is built.
//   "keep":  a build record that the picker never resumes on its own (ready, failed): the earlier slug and record
//            are kept (a server or its profile may exist under that name), nothing more is built.
//   null:    a build record the picker WOULD resume once approved (queued, waiting_cap, stopped, building): keeping
//            the slug would build and clearing it would orphan the build, so Approve only is not offered (refused).
const RESUMED_STATES = ["queued", "waiting_cap", "stopped", "building"];
function approveOnlyMode(r, prov) {
  if (!prov) return "clear";
  return RESUMED_STATES.includes(prov.state) ? null : "keep";
}

// The automatic build (CR-AUTOPROVISION.1): its state, Retry when it failed, and the delivered invite link.
const STATE_WORDS = { queued: "queued (the Mini picks it up within 5 minutes)", ready: "ready", waiting_cap: "waiting: daily cap (runs when a slot frees up)" };
function renderBuild(r, prov, links = {}, mailOff = null) {
  const e = escapeHtml;
  let line;
  if (!prov) {
    if (r.status !== "approved") return "";
    line = r.slug ? "not started yet (the Mini picks it up within 5 minutes)"
      : "not built automatically: this request has no slug (build it by hand, or Not now and Approve again with a slug)";
  } else if (prov.state === "building") {
    const n = BUILD_STEPS.indexOf(prov.step);
    line = n >= 0 ? `building, step ${n + 1} of ${BUILD_STEPS.length} (${e(prov.step)})` : prov.step ? `building (${e(prov.step)})` : "building";
  } else if (prov.state === "failed") {
    line = `failed at ${e(prov.step || "an unknown step")}`;
  } else if (prov.state === "stopped") {
    line = `stopped before ${e(prov.step || "the next step")}: the request was withdrawn during the build. Nothing was torn down; approve it again to continue, or tear the server down (your go)`;
  } else {
    line = e(STATE_WORDS[prov.state] || prov.state);
  }
  // CR-AUTOSLUG.1 fix round: no Retry without a slug (the picker only builds approved requests with one, so a retried
  // build would sit "queued" forever).
  const retry = prov && prov.state === "failed" && r.slug ? `<form method="post" action="/admin/invites" class="act"><input type="hidden" name="id" value="${e(r.id)}">
<button name="action" value="retry_build" type="submit">Retry</button> (continues from the failed step)</form>` : "";
  const inv = links.invite;
  const send = inv ? `<p class="ready"><b>Invite link ready</b> (made by the Mini; expires ${fmt(inv)}).</p>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}); the link waits here until sending is on, or it expires.</p>`
    : `<form method="post" action="/admin/invites" class="send"><input type="hidden" name="id" value="${e(r.id)}">
<button name="action" value="send_invite_stored" type="submit">Send invite email</button> to ${em(r.email)} with the delivered link</form>`}` : "";
  let codes = [];
  try { codes = prov && prov.notes ? JSON.parse(prov.notes) : []; } catch { codes = []; }
  const notes = Array.isArray(codes) && codes.length ? `<p>Set up with these defaults (check before Send):</p><ul class="notes">${
    codes.filter((c) => Object.hasOwn(NOTE_WORDS, c)).map((c) => `<li>${e(NOTE_WORDS[c])}</li>`).join("")}</ul>` : "";
  return `<div class="build"><p>Server: <span class="bs bs-${e(prov ? prov.state : "none")}">${line}</span>${prov && prov.finished_at ? ` · ${fmt(prov.finished_at)}` : ""}</p>${notes}${retry}${send}</div>`;
}

function renderRow(r, mails = [], mailOff = null, flash = "", nowMs = Date.now(), prov = null, links = {}, code = "") {
  const e = escapeHtml;
  const personal = r.referral === "allen" ? ` <span class="badge">Personal invite</span>` : "";
  const btn = (action, label) =>
    `<button name="action" value="${action}" type="submit">${label}</button>`;
  const btnT = (action, label, tip) =>
    `<button name="action" value="${action}" type="submit" title="${e(tip)}">${label}</button>`;
  const actions = [];
  if (TRANSITIONS.approve.from.includes(r.status)) {
    // CR-AUTOSLUG.1 (Allen 11-23): two buttons. Approve and build uses the address code in the box (the Mini's picker
    // builds it); Approve only approves with no address code, so nothing is built (the old empty-box behavior).
    // Approve only comes FIRST: it is the form's default button for Enter if the disabled guard below were ever
    // ignored, and it never builds.
    const only = approveOnlyMode(r, prov);
    if (only === "clear") {
      actions.push(btnT("approve_only", "Approve only",
        "Approve this request without building a server (no address code is kept). Build it by hand later, or press Not now and then Approve and build."));
    } else if (only === "keep") {
      actions.push(btnT("approve_only", "Approve only",
        `Approve this request without building anything more. It keeps its earlier address code (${r.slug || "none"}) and its build record; a failed build stays failed until you press Retry.`));
    }
    actions.push(btnT("approve_build", "Approve and build",
      r.slug && prov ? `Approve this request and continue its server build at ${r.slug}.bervo.ai. The Mini picks it up within 5 minutes.`
        : "Approve this request and build its server at the address code in the box. The Mini starts within 5 minutes."));
  }
  if (TRANSITIONS.not_now.from.includes(r.status)) actions.push(btn("not_now", "Not now"));
  if (TRANSITIONS.invited.from.includes(r.status)) actions.push(btn("invited", "Mark invited"));
  if (TRANSITIONS.claimed.from.includes(r.status)) actions.push(btn("claimed", "Mark claimed (trims this request)"));
  if (TRANSITIONS.expired.from.includes(r.status)) actions.push(btn("expired", "Mark expired"));
  if (r.status === "claimed") {
    return `<article class="req" id="r${e(r.id)}"><h2>#${e(r.id)} · <span class="status s-claimed">claimed</span></h2>
<p>Customer is live; this request was trimmed to its number, cohort, plan and dates.</p>
<dl><dt>Received</dt><dd>${fmt(r.created_at)}</dd><dt>Cohort</dt><dd>${e(r.cohort)}</dd><dt>Plan</dt><dd>${e(PLAN_NAMES[r.plan] || r.plan)}</dd>
${r.approved_at ? `<dt>Approved</dt><dd>${fmt(r.approved_at)}</dd>` : ""}${r.invited_at ? `<dt>Invited</dt><dd>${fmt(r.invited_at)}</dd>` : ""}
<dt>Claimed</dt><dd>${fmt(r.status_changed_at)}</dd></dl></article>`;
  }
  // CR-AUTOSLUG.1: the box comes pre-filled (the request's own slug if it has one, else a fresh code made for this
  // page view); Allen may type over it.
  const boxValue = r.slug || code || "";
  const codeTip = `${boxValue || "<code>"}.bervo.ai, made up automatically. Type over it for a special case.`;
  const slugField = r.status === "new" || r.status === "not_now"
    ? `<label title="${e(codeTip)}">Address code <input name="slug" maxlength="31" pattern="[a-z0-9][a-z0-9\\-]{0,30}" autocomplete="off" spellcheck="false" title="${e(codeTip)}" value="${e(boxValue)}"></label>` : "";
  return `<article class="req" id="r${e(r.id)}">
<h2>#${e(r.id)} · ${e(r.first_name)} ${e(r.last_name)}${personal} <span class="status s-${e(r.status)}">${e(r.status)}</span></h2>
<dl>
<dt>Received</dt><dd>${fmt(r.created_at)}</dd>
<dt>Email</dt><dd>${em(r.email)}</dd>
<dt>Has an assistant</dt><dd>${e(r.has_assistant)}</dd>
<dt>Email provider(s)</dt><dd>${e(providerList(r.email_providers))}</dd>
${r.other_email ? `<dt>Other email account(s)</dt><dd>${e(r.other_email)}</dd>` : ""}
${r.computers ? `<dt>Computer(s)</dt><dd>${e(computerList(r.computers))}</dd>` : ""}
${r.heard_from ? `<dt>How they heard</dt><dd>${e(HEARD_NAMES[r.heard_from] || r.heard_from)}${r.heard_detail ? `: ${e(r.heard_detail)}` : ""}</dd>` : ""}
<dt>Phone</dt><dd>${e(r.phone)}</dd>
<dt>Plan</dt><dd>${e(PLAN_NAMES[r.plan] || r.plan)}</dd>
<dt>Time zone</dt><dd>${e(r.timezone || "(not sent)")}</dd>
<dt>Cohort</dt><dd>${e(r.cohort)}</dd>
${r.slug ? `<dt>Slug</dt><dd>${e(r.slug)}</dd>` : ""}
${r.approved_at ? `<dt>Approved</dt><dd>${fmt(r.approved_at)}</dd>` : ""}
${r.invited_at ? `<dt>Invited</dt><dd>${fmt(r.invited_at)}</dd>` : ""}
</dl>
<h3>About them and their business</h3>
<div class="about">${e(r.about)}</div>
<form method="post" action="/admin/invites" class="act">
<button type="submit" disabled hidden aria-hidden="true" tabindex="-1" class="enter-guard"></button>
<input type="hidden" name="id" value="${e(r.id)}">
<label>Note <textarea name="note" maxlength="2000" rows="2">${e(r.note || "")}</textarea></label>
${slugField}
<div class="buttons">${actions.join(" ")} ${btn("note", "Save note")}</div>
</form>
${renderMail(mails)}
${flash ? `<p class="flash">${e(flash)}</p>` : ""}
${r.status === "approved" || r.status === "invited" || prov ? renderBuild(r, prov, links, mailOff) : ""}
${r.status === "invited" ? renderReminder(r, mails, mailOff, nowMs, links) : ""}
${r.status === "approved" || r.status === "invited" ? `<div class="copy" data-first="${e(r.first_name)}" data-variant="${needsIphoneNoMacNote(r.phone, r.computers) ? "note" : "plain"}">
<form method="post" action="/admin/invites" class="send">
<input type="hidden" name="id" value="${e(r.id)}">
<label>Owner link (paste it here) <input class="link" name="link" type="url" autocomplete="off" required></label>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}). Copy the email below and send it yourself.</p>`
    : `<button name="action" value="send_invite" type="submit">Send invite email</button> to ${em(r.email)}`}
</form>
<p>Subject: <b>${e(INVITE_EMAIL_SUBJECT)}</b></p>
<textarea class="mail" readonly rows="12"></textarea>
<button type="button" class="copybtn">Copy invite email</button> <span class="copied"></span>
</div>` : ""}
</article>`;
}

// CR-LINKPREVIEW.1: the Copy box turns the pasted owner link into the same bervo.ai/go link the Send button's email
// carries (golink.js, embedded here as source so the browser runs the one implementation).
export const COPY_LINK_SCRIPT = [
  `const GO_LABEL_RE = ${GO_LABEL_RE.toString()};`,
  `const GO_RESERVED = ${JSON.stringify(GO_RESERVED)};`,
  `const GO_PAGES = ${JSON.stringify(GO_PAGES)};`,
  `const GO_DEMO_HOSTS = ${JSON.stringify(GO_DEMO_HOSTS)};`,
  friendlyLink.toString(),
  friendlyFromDirect.toString(),
].join("\n").replace(/<\//g, "<\\/");

const FILTERS = { open: ["new", "approved", "invited"], new: ["new"], approved: ["approved"], invited: ["invited"],
  not_now: ["not_now"], claimed: ["claimed"], expired: ["expired"], all: null };

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAccess(request, env, context.fetchImpl || fetch, context.nowMs ?? Date.now());
  if (!auth.ok) return refused(auth.status);
  if (!env.DB) return refused(503);
  const nowMs = context.nowMs ?? Date.now();
  await pruneOld(env.DB, nowMs);
  const url = new URL(request.url);
  const mailOff = sendingOff(env);
  const f = Object.hasOwn(FILTERS, url.searchParams.get("show") || "") ? url.searchParams.get("show") : "open";
  const statuses = FILTERS[f];
  const sql = "SELECT * FROM invite_requests" +
    (statuses ? ` WHERE status IN (${statuses.map(() => "?").join(",")})` : "") + " ORDER BY id DESC LIMIT 300";
  const { results } = await env.DB.prepare(sql).bind(...(statuses || [])).all();
  const mails = await mailsFor(env.DB, results.map((r) => r.id));
  const provs = await provisionFor(env.DB, results.map((r) => r.id));
  const links = await linksFor(env.DB, results.map((r) => r.id));
  const flashId = Number(url.searchParams.get("r"));
  const flash = Object.hasOwn(SENT_FLASH, url.searchParams.get("sent") || "") ? SENT_FLASH[url.searchParams.get("sent")] : "";
  // CR-AUTOSLUG.1: a fresh address code for each request that can be approved and has none yet; never one already in
  // D1, never the same code twice on this page. Approve re-checks, so a code is only taken when it is approved.
  const codes = new Map();
  if (results.some((r) => (r.status === "new" || r.status === "not_now") && !r.slug)) {
    const taken = await takenAddresses(env.DB);
    for (const r of results) {
      if ((r.status !== "new" && r.status !== "not_now") || r.slug) continue;
      const c = await newCode((x) => taken.has(x), context.randomBytes);
      if (c) { taken.add(c); codes.set(r.id, c); }
    }
  }
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const nav = Object.keys(FILTERS).map((k) =>
    k === f ? `<b>${k}</b>` : `<a href="/admin/invites?show=${k}">${k}</a>`).join(" · ");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Invite requests · Bervo admin</title>
<style>body{max-width:900px;margin:1.5rem auto;padding:0 1rem;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1b1b;background:#fff}
.req{border:1px solid #ddd;border-radius:8px;padding:.75rem 1rem;margin:1rem 0}h2{font-size:1.1rem;margin:.2rem 0}
dl{display:grid;grid-template-columns:10rem 1fr;gap:.1rem .75rem;margin:.5rem 0}dt{color:#666}dd{margin:0;overflow-wrap:anywhere}
.about{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7f9;border-radius:6px;padding:.5rem .75rem}
.badge{background:#fde68a;color:#5a3d00;border-radius:4px;padding:0 .4em;font-size:.8rem}
.status{font-size:.8rem;border-radius:4px;padding:0 .4em;background:#eee}.s-approved{background:#d1fae5}.s-not_now{background:#fee2e2}.s-invited{background:#dbeafe}
textarea,input{width:100%;box-sizing:border-box;font:inherit}label{display:block;margin:.4rem 0}.buttons{margin-top:.4rem}
.copy{margin-top:.6rem;border-top:1px dashed #ccc;padding-top:.5rem}
.mail-log{margin:.4rem 0;padding-left:1.2rem}.ms{border-radius:4px;padding:0 .4em;background:#eee}.ms-delivered{background:#d1fae5}
.ms-bounced,.ms-complained,.ms-failed{background:#fee2e2}.build{margin:.5rem 0}.bs{border-radius:4px;padding:0 .4em;background:#eee}.bs-ready{background:#d1fae5}.bs-failed{background:#fee2e2}.bs-waiting_cap{background:#fef3c7}.bs-stopped{background:#fee2e2}.ready{margin:.3rem 0}.remind{background:#eff6ff;border-radius:6px;padding:.3rem .7rem;margin:.5rem 0}.flash{background:#fef3c7;border-radius:6px;padding:.3rem .6rem}.off{color:#7a4b00}</style></head><body>
<h1>Invite requests</h1><p>Signed in as ${em(auth.email)} · Show: ${nav}</p>
${results.length ? results.map((r) => renderRow(r, mails.get(r.id), mailOff, r.id === flashId ? flash : "", nowMs, provs.get(r.id) || null, links.get(r.id) || {}, codes.get(r.id) || "")).join("\n") : "<p>None.</p>"}
${renderServerMail(await serverMails(env.DB))}
<script nonce="${nonce}">
const TEMPLATES = { plain: ${JSON.stringify(INVITE_EMAIL_TEMPLATE).replace(/</g, "\\u003c")}, note: ${JSON.stringify(inviteBody("iphone", '["none"]')).replace(/</g, "\\u003c")} };
${COPY_LINK_SCRIPT}
// CR-AUTOSLUG.1: Enter in the Address code box never submits (a second guard: the form's first submit button is a
// disabled one, so implicit submission does nothing even without this script).
for (const box of document.querySelectorAll('input[name="slug"]')) {
  box.addEventListener("keydown", (ev) => { if (ev.key === "Enter") ev.preventDefault(); });
}
for (const box of document.querySelectorAll(".copy")) {
  const link = box.querySelector(".link"), mail = box.querySelector(".mail"), done = box.querySelector(".copied");
  const fill = () => { mail.value = TEMPLATES[box.dataset.variant || "plain"].split("{first_name}").join(box.dataset.first).split("{link}").join(link.value.trim() ? friendlyFromDirect(link.value.trim()) : "[paste the owner link above]"); };
  link.addEventListener("input", fill); fill();
  box.querySelector(".copybtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(mail.value); done.textContent = "Copied"; }
    catch { mail.select(); done.textContent = "Press Cmd+C to copy"; }
  });
}
</script></body></html>`;
  return page(body, 200, nonce);
}

// invite_mail rows for these requests, newest first, as Map(id -> rows). An empty map when the 0002 table is not
// there yet (the page keeps working; sending then fails closed and Copy remains).
async function mailsFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { results } = await db.prepare(`SELECT * FROM invite_mail WHERE request_id IN (${ids.map(() => "?").join(",")}) ORDER BY id DESC`)
      .bind(...ids).all();
    for (const m of results) { if (!out.has(m.request_id)) out.set(m.request_id, []); out.get(m.request_id).push(m); }
  } catch { /* no invite_mail table yet */ }
  return out;
}

// "You're loaded" emails, by customer server (sent through the router; no request row by then). Newest 50.
async function serverMails(db) {
  try {
    const { results } = await db.prepare("SELECT tenant, template, status, detail, error_code, created_at FROM invite_mail " +
      "WHERE tenant IS NOT NULL ORDER BY id DESC LIMIT 50").all();
    return results;
  } catch { return []; }
}

function renderServerMail(list) {
  if (!list.length) return "";
  const e = escapeHtml;
  return `<h2>Account emails by server</h2><ul class="mail-log">${list.map((m) => `<li>${e(m.tenant)} · ` +
    `${e(MAIL_LABEL[m.template] || m.template)}: <span class="ms ms-${e(m.status)}">${e(m.status)}${m.detail ? ` (${e(m.detail)})` : ""}</span>` +
    ` · ${fmt(m.created_at)}${m.status === "failed" && m.error_code != null ? ` · code ${e(m.error_code)}` : ""}</li>`).join("")}</ul>`;
}

// Send reminder (Allen 11-11 Q2/Q3): only when reminderDue() says one is due right now; the link is the FRESH one
// Allen just made with owner_invite_link.py (which retires the earlier link on the server).
async function sendReminder(context, env, id, form, nowMs) {
  const back = (code) => redirect(`/admin/invites?sent=${code}&r=${id}#r${id}`);
  const row = await env.DB.prepare("SELECT * FROM invite_requests WHERE id = ?").bind(id).first();
  if (!row) return refused(404);
  if (sendingOff(env)) return back("off");
  const mails = (await mailsFor(env.DB, [id])).get(id) || [];
  const due = reminderDue(row, mails, nowMs);
  if (!due) return back("notdue");
  if (!linkMatchesSlug(String(form.get("link") || "").trim(), row.slug)) return back("host");
  try {
    const res = await sendTemplate(env, { template: due, to: row.email, requestId: id, nowMs,
      fields: { first_name: row.first_name, link: String(form.get("link") || "").trim(), expiry_date: reminderExpiryDate(nowMs, row.timezone) },
      fetchImpl: context.mailFetch || fetch, say: context.say || console.log });
    return back(res.ok ? "reminder" : "failed");
  } catch (e) {
    if (e instanceof MailError && e.code === "bad_field:link") return back("link");
    return back(e instanceof MailError && e.code === "off" ? "off" : "failed");
  }
}

// Send with the link the Mini delivered (CR-AUTOPROVISION.1): decrypted here for this one email, deleted once sent.
async function sendStored(context, env, id, kind, nowMs) {
  const back = (code) => redirect(`/admin/invites?sent=${code}&r=${id}#r${id}`);
  const row = await env.DB.prepare("SELECT id, status, first_name, email, slug, phone, computers, timezone FROM invite_requests WHERE id = ?").bind(id).first();
  if (!row) return refused(404);
  if (sendingOff(env)) return back("off");
  const stored = await readLink(env.DB, env, id, kind, nowMs);
  if (!stored) return back("nolink");
  const why = await sendLinkEmail({ db: env.DB, env, row, kind, link: stored.link, issuedMs: stored.issuedMs, nowMs,
    fetchImpl: context.mailFetch || fetch, say: context.say || console.log });
  if (why === "ok") {
    await deleteLink(env.DB, id, kind);
    return back(kind === "invite" ? "ok" : "reminder");
  }
  return back(why);
}

// Send invite email: the request must be approved or invited. Success marks an approved request invited.
async function sendInvite(context, env, id, form, nowMs) {
  const back = (code) => redirect(`/admin/invites?sent=${code}&r=${id}#r${id}`);
  const row = await env.DB.prepare("SELECT id, status, first_name, email, slug, phone, computers FROM invite_requests WHERE id = ?").bind(id).first();
  if (!row) return refused(404);
  if (row.status !== "approved" && row.status !== "invited") return redirect(`/admin/invites#r${id}`);   // stale page
  if (sendingOff(env)) return back("off");
  const link = String(form.get("link") || "").trim();
  if (!linkMatchesSlug(link, row.slug)) return back("host");
  let res;
  try {
    res = await sendTemplate(env, { template: "invite", to: row.email, fields: { first_name: row.first_name, link, phone: row.phone, computers: row.computers },
      requestId: id, nowMs, fetchImpl: context.mailFetch || fetch, say: context.say || console.log });
  } catch (e) {
    if (e instanceof MailError && e.code === "bad_field:link") return back("link");
    if (e instanceof MailError) return back(e.code === "off" ? "off" : "failed");
    return back("failed");                     // e.g. the 0002 table is missing: nothing claims it was sent
  }
  if (!res.ok) return back("failed");
  if (row.status === "approved") {
    const nowIso = new Date(nowMs).toISOString();
    await env.DB.prepare("UPDATE invite_requests SET status = 'invited', status_changed_at = ?, invited_at = ? WHERE id = ? AND status = 'approved'")
      .bind(nowIso, nowIso, id).run();
  }
  return back("ok");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await checkAccess(request, env, context.fetchImpl || fetch, context.nowMs ?? Date.now());
  if (!auth.ok) return refused(auth.status);
  if (!env.DB) return refused(503);
  // CSRF: a state change must come from this page itself.
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== url.origin || (site && site !== "same-origin")) return refused(403);
  let form;
  try { form = await request.formData(); } catch { return refused(400); }
  const id = Number(form.get("id"));
  const action = String(form.get("action") || "");
  if (!Number.isInteger(id) || id < 1) return refused(400);
  const row = await env.DB.prepare("SELECT id, status FROM invite_requests WHERE id = ?").bind(id).first();
  if (!row) return refused(404);
  const nowIso = new Date(context.nowMs ?? Date.now()).toISOString();
  if (action === "send_invite") return sendInvite(context, env, id, form, context.nowMs ?? Date.now());
  if (action === "send_reminder") return sendReminder(context, env, id, form, context.nowMs ?? Date.now());
  if (action === "send_invite_stored") return sendStored(context, env, id, "invite", context.nowMs ?? Date.now());
  if (action === "send_reminder_stored") {
    const kind = String(form.get("kind") || "");
    if (kind !== "reminder3" && kind !== "reminder10") return refused(400);
    return sendStored(context, env, id, kind, context.nowMs ?? Date.now());
  }
  if (action === "retry_build") {
    // failed -> queued: the picker claims it again and new_customer.sh resumes at the failed step.
    const hasSlug = await env.DB.prepare("SELECT 1 AS x FROM invite_requests WHERE id = ? AND slug IS NOT NULL").bind(id).first();
    if (!hasSlug) return redirect(`/admin/invites?sent=retry_noslug&r=${id}#r${id}`);
    try {
      await env.DB.prepare("UPDATE invite_provision SET state = 'queued', retry_requested_at = ?, updated_at = ? WHERE request_id = ? AND state = 'failed' " +
        "AND EXISTS (SELECT 1 FROM invite_requests WHERE id = ? AND slug IS NOT NULL)")
        .bind(nowIso, nowIso, id, id).run();
    } catch { /* no 0007 table yet */ }
    return redirect(`/admin/invites?sent=retried&r=${id}#r${id}`);
  }
  const note = stripFormatChars(String(form.get("note") ?? "").replace(/\r\n?/g, "\n")).trim().slice(0, 2000);
  if (action === "note") {
    if (row.status === "claimed") return redirect(`/admin/invites#r${id}`);   // a trimmed row takes no note
    await env.DB.prepare("UPDATE invite_requests SET note = ? WHERE id = ?").bind(note || null, id).run();
    return redirect(`/admin/invites#r${id}`);
  }
  // CR-AUTOSLUG.1: "approve_build" needs a usable, unused address code; "approve_only" approves with none. A plain
  // "approve" (a page loaded before this change) keeps its old meaning: build when the box has a code, else not.
  let kind = action;
  if (action === "approve") kind = String(form.get("slug") || "").trim() ? "approve_build" : "approve_only";
  const t = kind === "approve_build" || kind === "approve_only" ? TRANSITIONS.approve
    : Object.hasOwn(TRANSITIONS, action) && action !== "approve" ? TRANSITIONS[action] : null;
  if (!t) return refused(400);
  if (!t.from.includes(row.status)) return redirect(`/admin/invites#r${id}`);   // stale page: no change
  let slug = null;
  let keepSlug = false;
  if (kind === "approve_only") {
    let prov = null;
    try { prov = await env.DB.prepare("SELECT state FROM invite_provision WHERE request_id = ?").bind(id).first(); }
    catch { /* no 0007 table yet */ }
    const mode = approveOnlyMode({}, prov);
    if (mode === null) return redirect(`/admin/invites?sent=only_building&r=${id}#r${id}`);
    keepSlug = mode === "keep";
  }
  if (kind === "approve_build") {
    const s = String(form.get("slug") || "").trim().toLowerCase();
    const why = addressProblem(s);
    if (why) return redirect(`/admin/invites?sent=code_${why}&r=${id}#r${id}`);
    if (await addressTaken(env.DB, s, id)) return redirect(`/admin/invites?sent=code_taken&r=${id}#r${id}`);
    slug = s;
  }
  const sets = t.trim ? ["status = ?", "status_changed_at = ?", TRIM_SET] : ["status = ?", "status_changed_at = ?", "note = ?"];
  const args = t.trim ? [t.to, nowIso] : [t.to, nowIso, note || null];
  if (t.stamp) { sets.push(`${t.stamp} = ?`); args.push(nowIso); }
  // Approve only clears any earlier slug when there is no build record, so nothing is built (the old COALESCE kept it,
  // and a not-now request with a slug was then built anyway); with a finished/failed build record it keeps the slug.
  // Approve and build sets the code only if no other request took it meanwhile.
  if (t === TRANSITIONS.approve && !keepSlug) { sets.push("slug = ?"); args.push(slug); }
  const guard = slug ? " AND NOT EXISTS (SELECT 1 FROM invite_requests o WHERE o.slug = ? AND o.id <> ?)" : "";
  const res = await env.DB.prepare(`UPDATE invite_requests SET ${sets.join(", ")} WHERE id = ? AND status = ?${guard}`)
    .bind(...args, id, row.status, ...(slug ? [slug, id] : [])).run();
  if (slug && res?.meta && res.meta.changes === 0) {
    const now = await env.DB.prepare("SELECT status FROM invite_requests WHERE id = ?").bind(id).first();
    if (now && now.status === row.status) return redirect(`/admin/invites?sent=code_taken&r=${id}#r${id}`);
  }
  if (t.to !== "approved" && t.to !== "invited") {
    // CR-AUTOPROVISION.1: a delivered link never outlives an open request.
    for (const k of ["invite", "reminder3", "reminder10"]) await deleteLink(env.DB, id, k);
  }
  if (t.trim) {
    // The trimmed request keeps no address; its emails keep no address hash either (template, status, dates stay).
    try { await env.DB.prepare("UPDATE invite_mail SET address_hash = NULL WHERE request_id = ?").bind(id).run(); }
    catch { /* no invite_mail table yet */ }
  }
  return redirect(`/admin/invites#r${id}`);
}
