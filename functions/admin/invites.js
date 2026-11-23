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
// CR-ADMINTABS.2 (Allen 11-23) replaced the Needs you tab: New is the default and the tab names changed (see TABS below).
// CR-ADMINTABS.1 (Allen 11-23): tabs by stage (TABS, stageOf, needsYou, inTab): Needs you (default; old ?show=open
// links land here) · New · Approved (not built yet) · Built (ready, invite not sent) · Invited · Signed up (0009) · Not
// now · Expired · Claimed · All · Server emails. Each card: a summary line, then the one action it needs, then the row
// buttons, with the form answers, about and note folded (open on New and Needs you); the copy-it-yourself box is always
// folded under "Send it yourself instead". A button's answer (?sent=..&r=<id>) opens the tab its request is in now.
// CR-SIGNUPSIGNAL.1: "Signed up <time>" from invite_requests.signed_up_at (written by /api/provision-state, action
// signed_up, from the Mini's picker); before migration 0009 the column is absent and nothing shows as signed up.
// CR-ONBOARDEDTAB.1 (Allen 11-23): Signed up = the owner set a password (automatic); Onboarded = Allen says the customer
// is in use. The tab "Claimed" is now "Onboarded" (old ?show=claimed links land there; the stored status stays
// 'claimed'), the button is "Mark onboarded", a signed-up request is no longer under Needs you (it waits in Signed up),
// its reminder line reads "Reminders stopped (signed up)", and Mark onboarded keeps first name + last initial and the
// address (kept_name / kept_host, migration 0010; before it the trim runs exactly as before), and their email address
// (kept_email, Allen 11-23 "yes, keep email too"; shown only inside the card's folded details, never the summary line).
import { checkAccess, escapeHtml, keptLabel, ONBOARD_ERASE_SET, ONBOARD_ERASE_SIGNED_UP, pruneOld, redirect, stripFormatChars, TRIM_SET } from "../_lib/invites.js";
// CR-ONBOARDEDTAB.1 fix round 2 (Allen 11-23): Mark onboarded keeps only id, status, plan, the request date
// (created_at / privacy_agreed_at), First L, the address and the email; the other dates are erased and cohort is reset.
import { friendlyFromDirect, friendlyLink, GO_DEMO_HOSTS, GO_LABEL_RE, GO_PAGES, GO_RESERVED } from "../_lib/golink.js";
import { inviteBody, linkMatchesSlug, needsIphoneNoMacNote, MailError, reminderDue, reminderExpiryDate, sendingOff, sendTemplate, TEMPLATES } from "../_lib/mail.js";
import { addressProblem, addressTaken, newCode, takenAddresses } from "../_lib/addresscode.js";
import { BUILD_STEPS, deleteLink, linksFor, NOTE_WORDS, provisionFor, readLink, sendLinkEmail, TEMPLATE_KIND } from "../_lib/provision.js";
const HIDDEN_NOTES = new Set(["pronouns_default"]);   // Allen 11-23: never shown on the admin page

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
  code_locked: "Not approved: this request already has a server build under its earlier address code, so Approve and build can only use that code.",
  only_building: "Not approved: this request's server build was started earlier and would continue once approved. Press Approve and build to continue it, or leave it at Not now.",
  onboard_failed: "Not marked onboarded: bervo.ai could not save it, so nothing changed. Try again.",
  retry_noslug: "Not retried: this request has no address code, so the Mini would never pick the build up. Press Not now, then Approve and build with a code." };

const TRANSITIONS = {
  approve: { to: "approved", from: ["new", "not_now"], stamp: "approved_at" },
  not_now: { to: "not_now", from: ["new", "approved"], stamp: null },
  invited: { to: "invited", from: ["approved"], stamp: "invited_at" },
  // Mark onboarded (CR-ONBOARDEDTAB.1; the action and stored value stay "claimed"): the row keeps ONLY id, status, plan,
  // created_at / privacy_agreed_at (the request date) and kept_name / kept_host / kept_email (0010); every form field and
  // every other date is erased, cohort is reset to 'public', and its email/build/link records are deleted, in one batch
  // (onboardBatch).
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
  // CR-ADMINTABS.1: Retry and the delivered-link Send are drawn first in the card (renderRow), not here.
  let codes = [];
  try { codes = prov && prov.notes ? JSON.parse(prov.notes) : []; } catch { codes = []; }
  // Allen 11-23: the pronoun default is not shown (pronouns are set per customer; CR-PRONOUNASK.1 asks at setup).
  const shown = Array.isArray(codes) ? codes.filter((c) => Object.hasOwn(NOTE_WORDS, c) && !HIDDEN_NOTES.has(c)) : [];
  const notes = shown.length ? `<p>Set up with these defaults (check before Send):</p><ul class="notes">${
    shown.map((c) => `<li>${e(NOTE_WORDS[c])}</li>`).join("")}</ul>` : "";
  return `<div class="build"><p>Server: <span class="bs bs-${e(prov ? prov.state : "none")}">${line}</span>${prov && prov.finished_at ? ` · ${fmt(prov.finished_at)}` : ""}</p>${notes}</div>`;
}

// CR-ADMINTABS.1 (Allen 11-23): a request's life as tabs. stageOf() is the one tab a request lives in; needsYou() says
// why (if at all) it is also under Needs you, the default tab. Both read only what the page already loads.
// CR-ADMINTABS.2 (Allen 11-23): no "Needs you" tab. One tab per stage, in this order; the query keys are unchanged so old
// links work. A request's needsYou() reason stays on its card; tabLabel() puts a marker on the tab that holds it.
export const TABS = [["new", "New"], ["not_now", "Deferred"], ["approved", "Build waiting"], ["built", "Ready to send"],
  ["invited", "Invite sent"], ["signed_up", "Signed up"], ["onboarded", "Onboarded"], ["expired", "Expired"], ["all", "All"],
  ["server_emails", "Emails sent"]];
const TAB_KEYS = TABS.map(([k]) => k);
const TAB_ALIASES = { open: "new", needs: "new", claimed: "onboarded" };   // old links: ?show=open / needs (now New), ?show=claimed
const COMPACT_TABS = new Set(["not_now", "expired", "onboarded", "all"]);
const OPEN_ANSWERS_TABS = new Set(["new"]);
const STAGE_WORDS = { new: "new", approved: "approved", built: "built", invited: "invited", signed_up: "signed up",
  not_now: "not now", expired: "expired", onboarded: "onboarded" };
// Allen 11-23 added "keep email too" after the spec's wording; the tooltip names it.
const ONBOARD_TIP = "This customer is onboarded. Erases their form details and dates on bervo.ai; keeps their first name and last initial, Bervo address, email address, plan and request date.";

// approved: not built yet (no build, queued, waiting, building, failed, stopped); built: approved and the build is
// ready (the invite is not sent: sending marks it invited); signed up: invited and the owner set a password (0009);
// onboarded: stored status 'claimed' (CR-ONBOARDEDTAB.1).
export function stageOf(r, prov) {
  if (r.status === "approved") return prov && prov.state === "ready" ? "built" : "approved";
  if (r.status === "invited") return r.signed_up_at ? "signed_up" : "invited";
  if (r.status === "claimed") return "onboarded";
  return r.status;
}

// -> the reason this request needs Allen now, or "".
export function needsYou(r, prov, mails = []) {
  const stage = stageOf(r, prov);
  if (stage === "new") return "New request: approve it, or press Not now.";
  if (stage === "built") return "Server ready: send the invite email.";
  if (r.status === "approved" && prov && prov.state === "failed") return `Server build failed at ${prov.step || "an unknown step"}: press Retry.`;
  if (r.status === "approved" && prov && prov.state === "stopped") return "Server build stopped: approve it again to continue, or tear the server down.";
  // CR-ONBOARDEDTAB.1: a signed-up request is not under Needs you (it waits in Signed up until Mark onboarded), and an
  // old bounce on it no longer brings it back (they have their link: they used it).
  if (stage === "signed_up") return "";
  if (r.status === "approved" || r.status === "invited") {
    const list = mails || [];
    if (list.some((m) => m.status === "bounced" || m.status === "complained"))
      return "An email to them bounced: check the address, then send the invite yourself.";
    if (list.length && list[0].status === "failed") return "The last email was not sent (Postmark did not take it): try again, or send it yourself.";
  }
  return "";
}

export function inTab(tab, r, prov, mails) {
  if (tab === "all") return true;
  return stageOf(r, prov) === tab;
}

// CR-ADMINTABS.2: the marker on a tab label. New and Ready to send always need Allen, so their count is enough; Build
// waiting and Invite sent add what is wrong ("Build waiting (2, 1 failed)"). Returns the text inside the brackets.
export function tabMarker(key, rows) {
  const n = rows.length;
  if (key === "all" || key === "server_emails") return "";
  const parts = [String(n)];
  if (key === "approved" || key === "invited") {
    const c = { failed: 0, stopped: 0, bounced: 0, "not sent": 0 };
    for (const { r, prov, mails } of rows) {
      // Allen 11-23 ("Yes, publish"): Build waiting also counts a bounced / not-sent email, in needsYou()'s order.
      const list = mails || [];
      if (key === "approved" && prov && prov.state === "failed") c.failed++;
      else if (key === "approved" && prov && prov.state === "stopped") c.stopped++;
      else if (list.some((m) => m.status === "bounced" || m.status === "complained")) c.bounced++;
      else if (list.length && list[0].status === "failed") c["not sent"]++;
    }
    for (const [w, k] of Object.entries(c)) if (k) parts.push(`${k} ${w}`);
  }
  return parts.join(", ");
}

// CR-ADMINTABS.2: shown at the top of New when New is empty and another tab holds a request that needs Allen.
// The wording is a GTM draft (GTM has not given its word yet); this is the plain fallback and it names the tab.
export function pointerLine(tabLabel) {
  return `Nothing new to approve. ${tabLabel} has a request that needs you.`;
}

// Invited: when the reminders fall and when the invitation ends (the same clock as reminderDue: the newest accepted
// invite email, else invited_at).
function renderTimeline(r, mails = []) {
  if (r.status !== "invited") return "";
  const invites = (mails || []).filter((m) => m.template === "invite" && m.status !== "failed");
  // CR-ONBOARDEDTAB.1: once signed up the reminders stop (reminderDue), so their dates are not shown.
  if (r.signed_up_at) {
    const lastS = invites.length ? [...invites].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] : null;
    return `<p class="timeline">${lastS ? `Invite email: <span class="ms ms-${escapeHtml(lastS.status)}">${escapeHtml(lastS.status)}</span> · ` : ""}Reminders stopped (signed up)</p>`;
  }
  const baseMs = invites.length ? Math.max(...invites.map((m) => Date.parse(m.created_at))) : Date.parse(r.invited_at || "");
  if (!Number.isFinite(baseMs)) return "";
  const at = (d) => fmt(new Date(baseMs + d * 86400000).toISOString());
  const sent = (t) => (mails || []).some((m) => m.template === t && m.status !== "failed" && Date.parse(m.created_at) >= baseMs);
  const last = invites.length ? [...invites].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] : null;
  return `<p class="timeline">${last ? `Invite email: <span class="ms ms-${escapeHtml(last.status)}">${escapeHtml(last.status)}</span> · ` : ""}` +
    `Day-3 reminder ${at(3)}${sent("reminder_day3") ? " (sent)" : ""} · Day-10 reminder ${at(10)}${sent("reminder_day10") ? " (sent)" : ""} · ` +
    `Invitation ends ${at(14)}</p>`;
}

function renderRow(r, mails = [], mailOff = null, flash = "", nowMs = Date.now(), prov = null, links = {}, code = "", tab = "new") {
  // Allen 11-23: the paste-form Send stays dimmed while the Mini builds (its link arrives as "Invite link ready"),
  // and otherwise until a link is pasted (the page script turns it on).
  const building = !!prov && !["ready", "failed", "stopped"].includes(prov.state) && !(links && links.invite);
  const e = escapeHtml;
  const personal = r.referral === "allen" ? ` <span class="badge">Personal invite</span>` : "";
  const btn = (action, label) =>
    `<button name="action" value="${action}" type="submit">${label}</button>`;
  const btnT = (action, label, tip) =>
    `<button name="action" value="${action}" type="submit" title="${e(tip)}">${label}</button>`;
  const stage = stageOf(r, prov);
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
  // Allen 11-23: every row button says what it does; Mark invited only where you would send by hand.
  const autoSend = !!(links && links.invite) && !mailOff;
  // CR-ADMINTABS.1: Signed up puts Mark onboarded first (it is the one button that request needs). CR-ONBOARDEDTAB.1:
  // "Mark claimed (trims this request)" is now "Mark onboarded" (the action value stays "claimed").
  if (TRANSITIONS.claimed.from.includes(r.status) && r.signed_up_at) actions.push(btnT("claimed", "Mark onboarded", ONBOARD_TIP));
  if (TRANSITIONS.not_now.from.includes(r.status)) actions.push(btnT("not_now", "Not now",
    building ? "Withdraw this request. The server build stops at its next step; the server is kept (tear it down by hand if needed)."
      : prov ? "Decline or withdraw this request. Its server is kept (tear it down by hand if needed)."
        : "Decline this request for now. You can approve it later."));
  if (TRANSITIONS.invited.from.includes(r.status) && !autoSend) actions.push(btnT("invited", "Mark invited",
    "Use this only if you sent the invite yourself (by copying the email below). Send invite email marks it invited for you."));
  if (TRANSITIONS.claimed.from.includes(r.status) && !r.signed_up_at) actions.push(btnT("claimed", "Mark onboarded", ONBOARD_TIP));
  if (TRANSITIONS.expired.from.includes(r.status)) actions.push(btnT("expired", "Mark expired",
    "The invitation ran out unused. The request is deleted 90 days later."));
  if (r.status === "claimed") {
    // CR-ONBOARDEDTAB.1 fix round 2: "<First L> · <address>.bervo.ai · requested <date>" (the name and address only when
    // 0010 kept them; a request onboarded before it shows "(trimmed)"). No other date is shown, even on a row onboarded
    // before fix round 2 that still holds them.
    return `<article class="req" id="r${e(r.id)}"><h2>#${e(r.id)} · ${r.kept_name ? e(r.kept_name) : "(trimmed)"} <span class="status s-onboarded">onboarded</span></h2>
<p class="sum">${onboardedLine(r)}</p>
<p class="notice">${r.kept_name || r.kept_host || r.kept_email ? e(ONBOARD_TIP)
    : "This customer is onboarded. Erases their form details and dates on bervo.ai; keeps their plan and request date."}</p>
${r.kept_email ? `<details class="answers"><summary>Email address</summary><p>${em(r.kept_email)}</p></details>` : ""}
<dl><dt>Requested</dt><dd>${fmt(r.created_at)}</dd><dt>Plan</dt><dd>${e(PLAN_NAMES[r.plan] || r.plan)}</dd></dl></article>`;
  }
  // CR-AUTOSLUG.1: the box comes pre-filled (the request's own slug if it has one, else a fresh code made for this
  // page view); Allen may type over it.
  const boxValue = r.slug || code || "";
  const codeTip = `${boxValue || "<code>"}.bervo.ai, made up automatically. Type over it for a special case.`;
  // Fix round 2: a request with a build record keeps its earlier slug (a profile, maybe a server, carries that name):
  // shown as plain text, posted as a hidden field, refused by the server if changed.
  const locked = !!(prov && r.slug);
  const slugField = (r.status === "new" || r.status === "not_now") && locked
    ? `<p class="locked" title="${e(`${r.slug}.bervo.ai was set when this request's server build started; it cannot change now.`)}">Address code: <b>${e(r.slug)}</b>.bervo.ai (set when the build started; cannot change)</p>
<input type="hidden" name="slug" value="${e(r.slug)}">`
    : r.status === "new" || r.status === "not_now"
    ? `<label title="${e(codeTip)}">Address code <input name="slug" maxlength="31" pattern="[a-z0-9][a-z0-9\\-]{0,30}" autocomplete="off" spellcheck="false" title="${e(codeTip)}" value="${e(boxValue)}"></label>` : "";
  // CR-ADMINTABS.1: the one thing this request needs goes first in the card: the delivered-link Send, or Retry.
  const need = needsYou(r, prov, mails);
  const inv = links && links.invite;
  const sendFirst = inv && (r.status === "approved" || r.status === "invited") ? `<p class="ready"><b>Invite link ready</b> (made by the Mini; expires ${fmt(inv)}).</p>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}); the link waits here until sending is on, or it expires.</p>`
    : `<form method="post" action="/admin/invites" class="send"><input type="hidden" name="id" value="${e(r.id)}">
<button name="action" value="send_invite_stored" type="submit" title="Send the invite email with the link the Mini made. It marks the request invited.">Send invite email</button> to ${em(r.email)} with the delivered link</form>`}` : "";
  // CR-AUTOSLUG.1 fix round: no Retry without a slug (the picker only builds approved requests with one, so a retried
  // build would sit "queued" forever).
  const retryFirst = prov && prov.state === "failed" && r.slug ? `<form method="post" action="/admin/invites" class="act retry"><input type="hidden" name="id" value="${e(r.id)}">
<button name="action" value="retry_build" type="submit" title="Queue the build again. The Mini picks it up within 5 minutes and continues from the failed step.">Retry</button> (continues from the failed step)</form>` : "";
  const answersOpen = OPEN_ANSWERS_TABS.has(tab) ? " open" : "";
  const summary = [e(PLAN_NAMES[r.plan] || r.plan), e(r.timezone || "time zone not sent"),
    r.slug ? `${e(r.slug)}.bervo.ai` : "no address yet", `received ${fmt(r.created_at)}`,
    r.signed_up_at ? `<b>Signed up ${fmt(r.signed_up_at)}</b>` : ""].filter(Boolean).join(" · ");
  return `<article class="req" id="r${e(r.id)}">
<h2>#${e(r.id)} · ${e(r.first_name)} ${e(r.last_name)}${personal} <span class="status s-${e(stage)}">${e(STAGE_WORDS[stage] || r.status)}</span></h2>
<p class="sum">${summary}</p>
${need ? `<p class="need"><b>Needs you:</b> ${e(need)}</p>` : ""}
${sendFirst}${retryFirst}
<form method="post" action="/admin/invites" class="act">
<button type="submit" disabled hidden aria-hidden="true" tabindex="-1" class="enter-guard"></button>
<input type="hidden" name="id" value="${e(r.id)}">
${slugField}
<div class="buttons">${actions.join(" ")}</div>
<details class="answers"${answersOpen}><summary>Form answers, about them, and your note</summary>
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
${r.signed_up_at ? `<dt>Signed up</dt><dd>${fmt(r.signed_up_at)}</dd>` : ""}
</dl>
<h3>About them and their business</h3>
<div class="about">${e(r.about)}</div>
<label>Note <textarea name="note" maxlength="2000" rows="2">${e(r.note || "")}</textarea></label>
${btnT("note", "Save note", "Save the note only; nothing else changes.")}
</details>
</form>
${renderMail(mails)}
${flash ? `<p class="flash">${e(flash)}</p>` : ""}
${r.status === "approved" || r.status === "invited" || prov ? renderBuild(r, prov, links, mailOff) : ""}
${renderTimeline(r, mails)}
${r.status === "invited" ? renderReminder(r, mails, mailOff, nowMs, links) : ""}
${r.status === "approved" || r.status === "invited" ? `<details class="other"><summary>Send it yourself instead</summary><div class="copy" data-first="${e(r.first_name)}" data-variant="${needsIphoneNoMacNote(r.phone, r.computers) ? "note" : "plain"}">
<form method="post" action="/admin/invites" class="send">
<input type="hidden" name="id" value="${e(r.id)}">
<label>Owner link (paste it here) <input class="link" name="link" type="url" autocomplete="off" required></label>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}). Copy the email below and send it yourself.</p>`
    : `<button name="action" value="send_invite" type="submit" disabled data-building="${building ? "1" : "0"}" title="${building ? "Waits for the server to be ready. The Mini fills in the link." : "Paste the owner link first."}">Send invite email</button> to ${em(r.email)}`}
</form>
<p>Subject: <b>${e(INVITE_EMAIL_SUBJECT)}</b></p>
<textarea class="mail" readonly rows="12"></textarea>
<button type="button" class="copybtn" title="Copy the invite email to paste into your own email program.">Copy invite email</button> <span class="copied"></span>
</div></details>` : ""}
</article>`;
}

// CR-ONBOARDEDTAB.1: an onboarded card's summary line.
export function onboardedLine(r) {
  const e = escapeHtml;
  return [r.kept_name ? e(r.kept_name) : "", r.kept_host ? `${e(r.kept_host)}.bervo.ai` : "", `requested ${fmt(r.created_at)}`]
    .filter(Boolean).join(" · ");
}

// Not now / Expired / Onboarded / All: one line per request; click it to open the full card.
function renderCompact(r, prov, card) {
  const e = escapeHtml;
  const stage = stageOf(r, prov);
  const name = r.status === "claimed" ? (r.kept_name ? e(r.kept_name) : "(trimmed)") : `${e(r.first_name)} ${e(r.last_name)}`;
  return `<details class="row"><summary>#${e(r.id)} · ${name} · <span class="status s-${e(stage)}">${e(STAGE_WORDS[stage] || r.status)}</span> · ` +
    `${e(PLAN_NAMES[r.plan] || r.plan)} · ${r.status === "claimed" ? fmt(r.created_at) : fmt(r.status_changed_at || r.created_at)}</summary>${card}</details>`;
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAccess(request, env, context.fetchImpl || fetch, context.nowMs ?? Date.now());
  if (!auth.ok) return refused(auth.status);
  if (!env.DB) return refused(503);
  const nowMs = context.nowMs ?? Date.now();
  await pruneOld(env.DB, nowMs);
  const url = new URL(request.url);
  const mailOff = sendingOff(env);
  // CR-ADMINTABS.1: every request is read (newest 300) so each tab and its count come from one rule (inTab).
  const asked = url.searchParams.get("show") || "";
  let f = TAB_KEYS.includes(asked) ? asked : TAB_ALIASES[asked] || "new";
  const { results: all } = await env.DB.prepare("SELECT * FROM invite_requests ORDER BY id DESC LIMIT 300").all();
  const allIds = all.map((r) => r.id);
  const mails = await mailsFor(env.DB, allIds);
  const provs = await provisionFor(env.DB, allIds);
  const links = await linksFor(env.DB, allIds);
  const P = (r) => provs.get(r.id) || null;
  const M = (r) => mails.get(r.id) || [];
  // A button's answer (?sent=...&r=<id>) opens the tab its request is in now, so the message is never on a hidden card.
  const flashRow = url.searchParams.get("r") && !TAB_KEYS.includes(asked) ? all.find((r) => r.id === Number(url.searchParams.get("r"))) : null;
  if (flashRow && !inTab(f, flashRow, P(flashRow), M(flashRow))) f = stageOf(flashRow, P(flashRow));
  const inTabRows = (k) => all.filter((r) => inTab(k, r, P(r), M(r))).map((r) => ({ r, prov: P(r), mails: M(r) }));
  const flagged = (k) => inTabRows(k).filter((x) => needsYou(x.r, x.prov, x.mails));
  const results = f === "server_emails" ? [] : all.filter((r) => inTab(f, r, P(r), M(r)));
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
  const nav = TABS.map(([k, label]) => {
    const m = tabMarker(k, inTabRows(k));
    const n = m ? ` (${m})` : "";
    return k === f ? `<b>${label}${n}</b>` : `<a href="/admin/invites?show=${k}">${label}${n}</a>`;
  }).join(" · ");
  const draw = (r) => {
    const card = renderRow(r, M(r), mailOff, r.id === flashId ? flash : "", nowMs, P(r), links.get(r.id) || {}, codes.get(r.id) || "", f);
    return COMPACT_TABS.has(f) ? renderCompact(r, P(r), card) : card;
  };
  // CR-ADMINTABS.2: New empty, and some other tab needs Allen: say which (the first one in tab order).
  let pointer = "";
  if (f === "new" && !results.length) {
    const other = TABS.find(([k]) => k !== "new" && k !== "all" && k !== "server_emails" && flagged(k).length);
    if (other) pointer = `<p class="need">${escapeHtml(pointerLine(other[1]))} <a href="/admin/invites?show=${other[0]}">Open ${escapeHtml(other[1])}</a></p>\n`;
  }
  const listHtml = pointer + (f === "server_emails" ? (renderServerMail(await serverMails(env.DB)) || "<p>No account emails yet.</p>")
    : results.length ? results.map(draw).join("\n") : "<p>None.</p>");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Invite requests · Bervo admin</title>
<style>/* CR-ADMINDARK.1 (Allen 11-23): light/dark tokens, the home page's dark palette; follows the device and the saved home-page choice (bervo-theme). */
:root{--bg:#fff;--fg:#1b1b1b;--muted:#666;--line:#ddd;--dash:#ccc;--soft:#f6f7f9;--gray:#eee;--green:#d1fae5;--red:#fee2e2;--blue:#dbeafe;--yellow:#fef3c7;--remind:#eff6ff;--amber:#fde68a;--amber-ink:#5a3d00;--off:#7a4b00;--link:#0645ad}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d0d0d;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2a2a2a;--dash:#3a3a3a;--soft:#161616;--gray:#262626;--green:#12301f;--red:#3a1717;--blue:#14222f;--yellow:#33290f;--remind:#14222f;--amber:#3d3212;--amber-ink:#fde68a;--off:#e0b060;--link:#6aa9dc;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0d0d0d;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2a2a2a;--dash:#3a3a3a;--soft:#161616;--gray:#262626;--green:#12301f;--red:#3a1717;--blue:#14222f;--yellow:#33290f;--remind:#14222f;--amber:#3d3212;--amber-ink:#fde68a;--off:#e0b060;--link:#6aa9dc;color-scheme:dark}
a{color:var(--link)}
body{max-width:900px;margin:1.5rem auto;padding:0 1rem;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
.req{border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin:1rem 0}h2{font-size:1.1rem;margin:.2rem 0}
dl{display:grid;grid-template-columns:10rem 1fr;gap:.1rem .75rem;margin:.5rem 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.about{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);border-radius:6px;padding:.5rem .75rem}
.badge{background:var(--amber);color:var(--amber-ink);border-radius:4px;padding:0 .4em;font-size:.8rem}
.status{font-size:.8rem;border-radius:4px;padding:0 .4em;background:var(--gray)}.s-approved{background:var(--green)}.s-not_now{background:var(--red)}.s-invited{background:var(--blue)}
textarea,input{width:100%;box-sizing:border-box;font:inherit}label{display:block;margin:.4rem 0}.buttons{margin-top:.4rem}
.copy{margin-top:.6rem;border-top:1px dashed var(--dash);padding-top:.5rem}
.mail-log{margin:.4rem 0;padding-left:1.2rem}.ms{border-radius:4px;padding:0 .4em;background:var(--gray)}.ms-delivered{background:var(--green)}
.ms-bounced,.ms-complained,.ms-failed{background:var(--red)}.build{margin:.5rem 0}.bs{border-radius:4px;padding:0 .4em;background:var(--gray)}.bs-ready{background:var(--green)}.bs-failed{background:var(--red)}.bs-waiting_cap{background:var(--yellow)}.bs-stopped{background:var(--red)}.ready{margin:.3rem 0}.remind{background:var(--remind);border-radius:6px;padding:.3rem .7rem;margin:.5rem 0}.flash{background:var(--yellow);border-radius:6px;padding:.3rem .6rem}.off{color:var(--off)}button:disabled{opacity:.45;cursor:not-allowed}details.other{margin-top:.6rem}details.other summary{cursor:pointer;color:var(--muted)}
.tabs{margin:.5rem 0 1rem;line-height:1.9}.sum{margin:.2rem 0;color:var(--muted)}.sum b{color:var(--fg)}.need{background:var(--yellow);border-radius:6px;padding:.3rem .6rem;margin:.4rem 0}
details.answers{margin:.5rem 0}details.answers summary,details.row summary{cursor:pointer}details.answers summary{color:var(--muted)}
details.row{border:1px solid var(--line);border-radius:8px;padding:.4rem .8rem;margin:.4rem 0}details.row[open] .req{border:0;padding:0}
.timeline{margin:.4rem 0}.s-built{background:var(--green)}.s-signed_up{background:var(--green)}.s-new{background:var(--blue)}.s-onboarded{background:var(--green)}</style></head><body>
<h1>Invite requests</h1><p>Signed in as ${em(auth.email)}</p><nav class="tabs">${nav}</nav>
${listHtml}
<script nonce="${nonce}">
// CR-ADMINDARK.1: the saved home-page light/dark choice (bervo-theme), if any; else the device setting.
try { const t = window[["local", "Storage"].join("")].getItem("bervo-theme"); if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
const TEMPLATES = { plain: ${JSON.stringify(INVITE_EMAIL_TEMPLATE).replace(/</g, "\\u003c")}, note: ${JSON.stringify(inviteBody("iphone", '["none"]')).replace(/</g, "\\u003c")} };
${COPY_LINK_SCRIPT}
// CR-AUTOSLUG.1: Enter in the Address code box never submits (a second guard: the form's first submit button is a
// disabled one, so implicit submission does nothing even without this script).
// Allen 11-23: a paste-form Send turns on only once a link is pasted, and never while the Mini is still building.
for (const btn of document.querySelectorAll('form.send button[data-building]')) {
  const box = btn.form && btn.form.querySelector('input[name="link"]');
  if (!box || btn.dataset.building === "1") continue;
  const sync = () => { btn.disabled = !box.value.trim(); btn.title = btn.disabled ? "Paste the owner link first." : ""; };
  box.addEventListener("input", sync); sync();
}
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
// CR-ADMINTABS.1: in chunks of 90 ids (D1 allows at most 100 bound parameters in one query; the page now reads every
// request, up to 300).
async function mailsFor(db, ids) {
  const out = new Map();
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const { results } = await db.prepare(`SELECT * FROM invite_mail WHERE request_id IN (${part.map(() => "?").join(",")}) ORDER BY id DESC`)
        .bind(...part).all();
      for (const m of results) { if (!out.has(m.request_id)) out.set(m.request_id, []); out.get(m.request_id).push(m); }
    }
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

// CR-ONBOARDEDTAB.1 (fix round 2, Allen 11-23 + verifier-opus): Mark onboarded in ONE D1 batch (D1 runs a batch as a
// transaction: a failed statement rolls the whole batch back). The deletes only act once the request IS onboarded
// (EXISTS ... status = 'claimed'), so they can never take an open request's records. Nothing needs those records for an
// onboarded request: reminders and the sign-up check are for invited requests only, Send/Retry refuse a claimed one,
// pruneOld only clears what is gone already, and the Mini's daily build cap also counts its own records.
const ONBOARD_DELETES = {
  invite_mail: "DELETE FROM invite_mail WHERE request_id = ? AND EXISTS (SELECT 1 FROM invite_requests WHERE id = ? AND status = 'claimed')",
  invite_provision: "DELETE FROM invite_provision WHERE request_id = ? AND EXISTS (SELECT 1 FROM invite_requests WHERE id = ? AND status = 'claimed')",
  invite_links: "DELETE FROM invite_links WHERE request_id = ? AND EXISTS (SELECT 1 FROM invite_requests WHERE id = ? AND status = 'claimed')",
};
export async function onboardBatch(db, id, row, sets, args, where, tail) {
  const k = keptLabel(row);
  const forms = [   // newest schema first: 0010 + 0009, then 0009 only, then neither
    [`, ${ONBOARD_ERASE_SIGNED_UP}, kept_name = ?, kept_host = ?, kept_email = ?`, [k.kept_name, k.kept_host, k.kept_email]],
    [`, ${ONBOARD_ERASE_SIGNED_UP}`, []],
    ["", []],
  ];
  let f = 0;
  const tables = Object.keys(ONBOARD_DELETES);
  for (;;) {
    const [extra, more] = forms[f];
    const stmts = [db.prepare(`UPDATE invite_requests SET ${sets.join(", ")}${extra} ${where}`).bind(...args, ...more, ...tail),
      ...tables.map((t) => db.prepare(ONBOARD_DELETES[t]).bind(id, id))];
    try {
      return await db.batch(stmts);
    } catch (e) {
      const msg = String(e && e.message || e);
      const gone = msg.match(/no such table: (\w+)/i);
      if (/no such column/i.test(msg) && f < forms.length - 1) f += 1;
      else if (gone && tables.includes(gone[1])) tables.splice(tables.indexOf(gone[1]), 1);
      else throw e;
    }
  }
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
  const row = await env.DB.prepare("SELECT id, status, slug, first_name, last_name, email FROM invite_requests WHERE id = ?").bind(id).first();
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
  let prov = null;
  if (kind === "approve_only" || kind === "approve_build") {
    try { prov = await env.DB.prepare("SELECT state FROM invite_provision WHERE request_id = ?").bind(id).first(); }
    catch { /* no 0007 table yet */ }
  }
  // Fix round 2: with a build record, Approve and build uses the earlier slug only.
  const lockedSlug = prov && row.slug ? row.slug : null;
  if (kind === "approve_only") {
    const mode = approveOnlyMode({}, prov);
    if (mode === null) return redirect(`/admin/invites?sent=only_building&r=${id}#r${id}`);
    keepSlug = mode === "keep";
  }
  if (kind === "approve_build") {
    const s = String(form.get("slug") || "").trim().toLowerCase();
    if (lockedSlug && s !== lockedSlug) return redirect(`/admin/invites?sent=code_locked&r=${id}#r${id}`);
    const why = addressProblem(s);
    if (why) return redirect(`/admin/invites?sent=code_${why}&r=${id}#r${id}`);
    if (await addressTaken(env.DB, s, id)) return redirect(`/admin/invites?sent=code_taken&r=${id}#r${id}`);
    slug = s;
  }
  // CR-ONBOARDEDTAB.1 fix round 2: the onboarded trim stamps no date (status_changed_at is erased with the others).
  const sets = t.trim ? ["status = ?", TRIM_SET, ONBOARD_ERASE_SET] : ["status = ?", "status_changed_at = ?", "note = ?"];
  const args = t.trim ? [t.to] : [t.to, nowIso, note || null];
  if (t.stamp) { sets.push(`${t.stamp} = ?`); args.push(nowIso); }
  // Approve only clears any earlier slug when there is no build record, so nothing is built (the old COALESCE kept it,
  // and a not-now request with a slug was then built anyway); with a finished/failed build record it keeps the slug.
  // Approve and build sets the code only if no other request took it meanwhile.
  if (t === TRANSITIONS.approve && !keepSlug) { sets.push("slug = ?"); args.push(slug); }
  const guard = (slug ? " AND NOT EXISTS (SELECT 1 FROM invite_requests o WHERE o.slug = ? AND o.id <> ?)" : "") +
    (slug && lockedSlug ? " AND slug = ?" : "");
  const tail = [id, row.status, ...(slug ? [slug, id] : []), ...(slug && lockedSlug ? [lockedSlug] : [])];
  if (t.trim) {
    // CR-ONBOARDEDTAB.1: one D1 batch (a transaction) = the trim + date erase + kept fields, and the request's email
    // records, build record and any waiting link deleted. Only "no such column / table" (a migration not run yet) moves
    // to the next, smaller form; any other error fails the action visibly with nothing changed.
    try {
      await onboardBatch(env.DB, id, row, sets, args, `WHERE id = ? AND status = ?${guard}`, tail);
    } catch {
      return redirect(`/admin/invites?sent=onboard_failed&r=${id}#r${id}`);
    }
    return redirect(`/admin/invites#r${id}`);
  }
  const res = await env.DB.prepare(`UPDATE invite_requests SET ${sets.join(", ")} WHERE id = ? AND status = ?${guard}`)
    .bind(...args, ...tail).run();
  if (slug && res?.meta && res.meta.changes === 0) {
    const now = await env.DB.prepare("SELECT status FROM invite_requests WHERE id = ?").bind(id).first();
    if (now && now.status === row.status) return redirect(`/admin/invites?sent=${lockedSlug ? "code_locked" : "code_taken"}&r=${id}#r${id}`);
  }
  if (t.to !== "approved" && t.to !== "invited") {
    // CR-AUTOPROVISION.1: a delivered link never outlives an open request.
    for (const k of ["invite", "reminder3", "reminder10"]) await deleteLink(env.DB, id, k);
  }
  return redirect(`/admin/invites#r${id}`);
}
