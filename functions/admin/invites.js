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

// The invite email Allen copies and sends himself (v1, no mail provider). Words: daily-dashboard
// docs/marketing/site/INVITE_FORM_COPY_V1.md §5 (approved by Allen 11-10). {first_name} and {link} are filled in on
// the page; the link is pasted by Allen into the box on the page and never leaves his browser (not sent to this
// server, not stored in D1).
export const INVITE_EMAIL_SUBJECT = "Your Bervo invite";
export const INVITE_EMAIL_TEMPLATE = [
  "Hi {first_name},",
  "",
  "Thanks for requesting an invite to Bervo. I'm glad to have you.",
  "",
  "Here's your personal setup link:",
  "{link}",
  "",
  "It works once and stays open for 14 days. Setup takes you through connecting your email, choosing how much " +
    "history to load, adding your AI API key and texting the Bervo line. Stopped partway? Sign in with your email " +
    "and password and you'll pick up where you left off.",
  "",
  "Any questions, just reply to this email.",
  "",
  "Allen",
].join("\n");

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

function renderRow(r) {
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
<p>Customer is live; this request was trimmed to its number, cohort and dates.</p>
<dl><dt>Received</dt><dd>${fmt(r.created_at)}</dd><dt>Cohort</dt><dd>${e(r.cohort)}</dd>
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
<dt>Email provider</dt><dd>${e(r.email_provider)}</dd>
<dt>Phone</dt><dd>${e(r.phone)}</dd>
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
${r.status === "approved" || r.status === "invited" ? `<div class="copy" data-first="${e(r.first_name)}">
<label>Owner link (paste it here; it stays in this browser) <input class="link" type="url" autocomplete="off"></label>
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
  const f = Object.hasOwn(FILTERS, url.searchParams.get("show") || "") ? url.searchParams.get("show") : "open";
  const statuses = FILTERS[f];
  const sql = "SELECT * FROM invite_requests" +
    (statuses ? ` WHERE status IN (${statuses.map(() => "?").join(",")})` : "") + " ORDER BY id DESC LIMIT 300";
  const { results } = await env.DB.prepare(sql).bind(...(statuses || [])).all();
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
.copy{margin-top:.6rem;border-top:1px dashed #ccc;padding-top:.5rem}</style></head><body>
<h1>Invite requests</h1><p>Signed in as ${escapeHtml(auth.email)} · Show: ${nav}</p>
${results.length ? results.map(renderRow).join("\n") : "<p>None.</p>"}
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
  return redirect(`/admin/invites#r${id}`);
}
