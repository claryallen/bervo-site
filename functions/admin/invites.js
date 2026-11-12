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
// Approve / Not now / Mark invited / the note change ONLY the D1 row. Nothing here touches a server; the
// orchestrator reads an approved row with tools/tenant/invite_to_profile.py (daily-dashboard).
import { checkAccess, escapeHtml, pruneOld, redirect, SLUG_RE, stripFormatChars, TRIM_SET } from "../_lib/invites.js";
import { linkMatchesSlug, MailError, reminderDue, reminderExpiryDate, sendingOff, sendTemplate, TEMPLATES } from "../_lib/mail.js";

// The invite email (words: daily-dashboard docs/marketing/site/INVITE_FORM_COPY_V1.md §5, approved by Allen 11-10;
// they live in functions/_lib/mail.js now, the one sender). CR-WELCOMEEMAIL.1: **Send invite email** sends it
// through Postmark from this server; **Copy invite email** stays as the fallback (sending off or failed). The link
// Allen pastes is posted with Send, used for that one email and never stored or logged here; with Copy it never
// leaves his browser, as before.
export const INVITE_EMAIL_SUBJECT = TEMPLATES.invite.subject;
export const INVITE_EMAIL_TEMPLATE = TEMPLATES.invite.body;
const MAIL_LABEL = { invite: "Invite email", reminder_day3: "Day-3 reminder", reminder_day10: "Day-10 reminder",
  loaded: "\"You're loaded\" email" };
const SENT_FLASH = { ok: "Invite email sent.", reminder: "Reminder sent.", notdue: "Not sent: no reminder is due for this request.", off: "Not sent: sending is off. Use Copy below.",
  host: "Not sent: that link is for another server (this request's slug is on a different host). Nothing was sent.",
  link: "Not sent: that is not an owner link (https://<server>.bervo.ai/set-password?t=…). Nothing was sent.",
  failed: "Not sent: Postmark did not take it. Use Copy below, or try again." };

const TRANSITIONS = {
  approve: { to: "approved", from: ["new", "not_now"], stamp: "approved_at" },
  not_now: { to: "not_now", from: ["new", "approved"], stamp: null },
  invited: { to: "invited", from: ["approved"], stamp: "invited_at" },
  // The customer is live: the row is trimmed to id, cohort, status and dates in the same UPDATE (Allen 11-10).
  claimed: { to: "claimed", from: ["invited"], stamp: null, trim: true },
  // The invitation ran out unused (14 days): deleted 90 days later with the not-now rows.
  expired: { to: "expired", from: ["invited"], stamp: null },
};

function page(body, status = 200, nonce = "") {
  const csp = "default-src 'none'; " + (nonce ? `script-src 'nonce-${nonce}'; ` : "") +
    "style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, "Cache-Control": "no-store",
      "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function refused(status) {
  return page(`<!doctype html><meta charset="utf-8"><title>Not available</title><p>Not available.</p>`, status);
}

function fmt(iso) { return iso ? escapeHtml(String(iso).replace("T", " ").slice(0, 16) + " UTC") : ""; }

const PLAN_NAMES = { standard: "Standard $49/mo", private: "Private $99/mo" };
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

function renderReminder(r, mails, mailOff, nowMs) {
  const due = reminderDue(r, mails || [], nowMs);
  if (!due) return "";
  const e = escapeHtml;
  const label = due === "reminder_day3" ? "Day-3 reminder" : "Day-10 reminder";
  return `<div class="remind"><p><b>${label} due.</b> On the Mini, run <code>tools/tenant/owner_invite_link.py</code> for
this customer again: it makes a fresh link and the earlier one stops working. Paste the fresh link here and send it within a
day (the email says the link stays open until ${e(reminderExpiryDate(nowMs, r.timezone))}).</p>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}).</p>` : `<form method="post" action="/admin/invites" class="send">
<input type="hidden" name="id" value="${e(r.id)}">
<label>Fresh owner link <input name="link" type="url" autocomplete="off" required></label>
<button name="action" value="send_reminder" type="submit">Send ${label.toLowerCase()}</button> to ${e(r.email)}
</form>`}</div>`;
}

function renderRow(r, mails = [], mailOff = null, flash = "", nowMs = Date.now()) {
  const e = escapeHtml;
  const personal = r.referral === "allen" ? ` <span class="badge">Personal invite</span>` : "";
  const btn = (action, label) =>
    `<button name="action" value="${action}" type="submit">${label}</button>`;
  const actions = [];
  if (TRANSITIONS.approve.from.includes(r.status)) actions.push(btn("approve", "Approve"));
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
  const slugField = r.status === "new" || r.status === "not_now"
    ? `<label>Slug (optional) <input name="slug" maxlength="31" pattern="[a-z0-9][a-z0-9\\-]{0,30}" value="${e(r.slug || "")}"></label>` : "";
  return `<article class="req" id="r${e(r.id)}">
<h2>#${e(r.id)} · ${e(r.first_name)} ${e(r.last_name)}${personal} <span class="status s-${e(r.status)}">${e(r.status)}</span></h2>
<dl>
<dt>Received</dt><dd>${fmt(r.created_at)}</dd>
<dt>Email</dt><dd>${e(r.email)}</dd>
<dt>Company</dt><dd>${e(r.company)}</dd>
<dt>Role</dt><dd>${e(r.role)}</dd>
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
<input type="hidden" name="id" value="${e(r.id)}">
<label>Note <textarea name="note" maxlength="2000" rows="2">${e(r.note || "")}</textarea></label>
${slugField}
<div class="buttons">${actions.join(" ")} ${btn("note", "Save note")}</div>
</form>
${renderMail(mails)}
${flash ? `<p class="flash">${e(flash)}</p>` : ""}
${r.status === "invited" ? renderReminder(r, mails, mailOff, nowMs) : ""}
${r.status === "approved" || r.status === "invited" ? `<div class="copy" data-first="${e(r.first_name)}">
<form method="post" action="/admin/invites" class="send">
<input type="hidden" name="id" value="${e(r.id)}">
<label>Owner link (paste it here) <input class="link" name="link" type="url" autocomplete="off" required></label>
${mailOff ? `<p class="off">Sending is off (${e(mailOff)}). Copy the email below and send it yourself.</p>`
    : `<button name="action" value="send_invite" type="submit">Send invite email</button> to ${e(r.email)}`}
</form>
<p>Subject: <b>${e(INVITE_EMAIL_SUBJECT)}</b></p>
<textarea class="mail" readonly rows="12"></textarea>
<button type="button" class="copybtn">Copy invite email</button> <span class="copied"></span>
</div>` : ""}
</article>`;
}

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
  const flashId = Number(url.searchParams.get("r"));
  const flash = Object.hasOwn(SENT_FLASH, url.searchParams.get("sent") || "") ? SENT_FLASH[url.searchParams.get("sent")] : "";
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
.ms-bounced,.ms-complained,.ms-failed{background:#fee2e2}.remind{background:#eff6ff;border-radius:6px;padding:.3rem .7rem;margin:.5rem 0}.flash{background:#fef3c7;border-radius:6px;padding:.3rem .6rem}.off{color:#7a4b00}</style></head><body>
<h1>Invite requests</h1><p>Signed in as ${escapeHtml(auth.email)} · Show: ${nav}</p>
${results.length ? results.map((r) => renderRow(r, mails.get(r.id), mailOff, r.id === flashId ? flash : "", nowMs)).join("\n") : "<p>None.</p>"}
${renderServerMail(await serverMails(env.DB))}
<script nonce="${nonce}">
const TEMPLATE = ${JSON.stringify(INVITE_EMAIL_TEMPLATE).replace(/</g, "\\u003c")};
for (const box of document.querySelectorAll(".copy")) {
  const link = box.querySelector(".link"), mail = box.querySelector(".mail"), done = box.querySelector(".copied");
  const fill = () => { mail.value = TEMPLATE.split("{first_name}").join(box.dataset.first).split("{link}").join(link.value.trim() || "[paste the owner link above]"); };
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

// Send invite email: the request must be approved or invited. Success marks an approved request invited.
async function sendInvite(context, env, id, form, nowMs) {
  const back = (code) => redirect(`/admin/invites?sent=${code}&r=${id}#r${id}`);
  const row = await env.DB.prepare("SELECT id, status, first_name, email, slug FROM invite_requests WHERE id = ?").bind(id).first();
  if (!row) return refused(404);
  if (row.status !== "approved" && row.status !== "invited") return redirect(`/admin/invites#r${id}`);   // stale page
  if (sendingOff(env)) return back("off");
  const link = String(form.get("link") || "").trim();
  if (!linkMatchesSlug(link, row.slug)) return back("host");
  let res;
  try {
    res = await sendTemplate(env, { template: "invite", to: row.email, fields: { first_name: row.first_name, link },
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
  const note = stripFormatChars(String(form.get("note") ?? "").replace(/\r\n?/g, "\n")).trim().slice(0, 2000);
  if (action === "note") {
    if (row.status === "claimed") return redirect(`/admin/invites#r${id}`);   // a trimmed row takes no note
    await env.DB.prepare("UPDATE invite_requests SET note = ? WHERE id = ?").bind(note || null, id).run();
    return redirect(`/admin/invites#r${id}`);
  }
  const t = Object.hasOwn(TRANSITIONS, action) ? TRANSITIONS[action] : null;
  if (!t) return refused(400);
  if (!t.from.includes(row.status)) return redirect(`/admin/invites#r${id}`);   // stale page: no change
  let slug = null;
  if (action === "approve") {
    const s = String(form.get("slug") || "").trim().toLowerCase();
    if (s && !SLUG_RE.test(s)) return refused(400);
    slug = s || null;
  }
  const sets = t.trim ? ["status = ?", "status_changed_at = ?", TRIM_SET] : ["status = ?", "status_changed_at = ?", "note = ?"];
  const args = t.trim ? [t.to, nowIso] : [t.to, nowIso, note || null];
  if (t.stamp) { sets.push(`${t.stamp} = ?`); args.push(nowIso); }
  if (action === "approve") { sets.push("slug = COALESCE(?, slug)"); args.push(slug); }
  await env.DB.prepare(`UPDATE invite_requests SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
    .bind(...args, id, row.status).run();
  if (t.trim) {
    // The trimmed request keeps no address; its emails keep no address hash either (template, status, dates stay).
    try { await env.DB.prepare("UPDATE invite_mail SET address_hash = NULL WHERE request_id = ?").bind(id).run(); }
    catch { /* no invite_mail table yet */ }
  }
  return redirect(`/admin/invites#r${id}`);
}
