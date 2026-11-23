// /admin/newsletter — the "Newsletter" tab of Allen's admin page (CR-NEWSLETTER.1, Allen 11-23).
//
// Who can reach it: the same Cloudflare Access application on bervo.ai/admin as /admin/invites, and the same token
// check in this function (checkAccess). Shows: how many are subscribed, the list (address, source, date), the
// unsubscribed addresses (suppression entries: address + date only), "Add" for an existing customer's address
// (decision 3, Allen 11-23: source admin; refused for an address that unsubscribed), an Unsubscribe button per row,
// and "Export CSV" (subscribed only, with each person's one-click unsubscribe link) for sending.
// Sending itself is not here in v1: export, then send through Postmark's broadcast stream (see the build report).
// Invite-request data is never read by this page.
import { checkAccess, escapeHtml, redirect } from "../_lib/invites.js";
import { adminAdd, exportCsv, listAll, normEmail, NotSetUp, unsubscribe, unsubSecret } from "../_lib/newsletter.js";

const FLASH = {
  added: "Added.", already: "Already subscribed: nothing changed.",
  suppressed: "Not added: that address unsubscribed. Only they can turn it back on, in Settings on their Bervo server.",
  bad: "Not added: that is not an email address.", removed: "Unsubscribed.", unchanged: "Nothing changed.",
  nosecret: "Export needs the Pages secret NEWSLETTER_UNSUB_SECRET (every exported row carries its unsubscribe link).",
};

function page(body, status = 200) {
  return new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" } });
}
function refused(status) { return page(`<!doctype html><meta charset="utf-8"><title>Not available</title><p>Not available.</p>`, status); }
function em(v) { return `<!--email_off-->${escapeHtml(v)}<!--/email_off-->`; }
function fmt(iso) { return iso ? escapeHtml(String(iso).replace("T", " ").slice(0, 16) + " UTC") : ""; }
const SOURCE_WORDS = { setup: "their setup choice", admin: "added by you" };

export async function onRequestGet(context) {
  const { request, env } = context;
  const nowMs = context.nowMs ?? Date.now();
  const auth = await checkAccess(request, env, context.fetchImpl || fetch, nowMs);
  if (!auth.ok) return refused(auth.status);
  if (!env.DB) return refused(503);
  const url = new URL(request.url);
  let rows = null;
  try { rows = await listAll(env.DB); } catch (e) { if (!(e instanceof NotSetUp)) throw e; }
  if (url.searchParams.get("export") === "csv" && rows) {
    const secret = unsubSecret(env);
    if (!secret) return redirect("/admin/newsletter?msg=nosecret");
    return new Response(await exportCsv(rows, secret, url.origin), { headers: {
      "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="bervo-newsletter-${new Date(nowMs).toISOString().slice(0, 10)}.csv"` } });
  }
  const msg = Object.hasOwn(FLASH, url.searchParams.get("msg") || "") ? FLASH[url.searchParams.get("msg")] : "";
  const subs = (rows || []).filter((r) => r.status === "subscribed");
  const outs = (rows || []).filter((r) => r.status === "unsubscribed");
  const e = escapeHtml;
  const subList = subs.length ? `<table><tr><th>Address</th><th>From</th><th>Since</th><th></th></tr>${subs.map((r) =>
    `<tr><td>${em(r.email)}</td><td>${e(SOURCE_WORDS[r.source] || r.source)}</td><td>${fmt(r.opted_in_at)}</td><td>` +
    `<form method="post" action="/admin/newsletter"><input type="hidden" name="email" value="${e(r.email)}">` +
    `<button name="action" value="unsubscribe" type="submit" title="Take this address off the list. It is kept as unsubscribed (address and date only), so it is never re-added by mistake.">Unsubscribe</button></form></td></tr>`).join("")}</table>`
    : "<p>No one yet.</p>";
  const outList = outs.length ? `<details><summary>Unsubscribed (${outs.length}): kept as address and date only, so they are never re-added</summary><ul>${
    outs.map((r) => `<li>${em(r.email)} · ${fmt(r.opted_out_at)}</li>`).join("")}</ul></details>` : "";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Newsletter · Bervo admin</title>
<style>:root{--bg:#fff;--fg:#1b1b1b;--muted:#666;--line:#ddd;--yellow:#fef3c7;--link:#0645ad}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2a2a2a;--yellow:#33290f;--link:#6aa9dc;color-scheme:dark}}
a{color:var(--link)}body{max-width:900px;margin:1.5rem auto;padding:0 1rem;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:.3rem .4rem;text-align:left;overflow-wrap:anywhere}th{color:var(--muted);font-weight:normal}
.flash{background:var(--yellow);border-radius:6px;padding:.3rem .6rem}.muted{color:var(--muted)}input[type=email]{width:min(22rem,100%);font:inherit}</style></head><body>
<h1>Newsletter</h1><p>Signed in as ${em(auth.email)} · <a href="/admin/invites">Invite requests</a></p>
${msg ? `<p class="flash">${e(msg)}</p>` : ""}
${rows ? `<p><b>${subs.length} subscribed</b>${outs.length ? ` · ${outs.length} unsubscribed` : ""} · <a href="/admin/newsletter?export=csv">Export CSV</a> (subscribed only, with each person's unsubscribe link)</p>
<form method="post" action="/admin/newsletter"><label>Add an existing customer who asked to be included
<input type="email" name="email" required autocomplete="off" spellcheck="false"></label>
<button name="action" value="add" type="submit" title="Adds this address as 'added by you'. Every newsletter still carries a one-click unsubscribe.">Add</button></form>
<p class="muted">Customers choose for themselves at setup ("A few preferences") and in Settings. Use Add only for someone who asked you. Notices about the service itself (billing, policy changes, outages, security) go to every customer's account email, not through this list.</p>
<h2>Subscribed</h2>${subList}${outList}`
    : "<p>The newsletter table is not set up yet: paste <code>functions/_dev/migrations/0012_newsletter.sql</code> into the D1 console.</p>"}
</body></html>`;
  return page(body);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const nowMs = context.nowMs ?? Date.now();
  const auth = await checkAccess(request, env, context.fetchImpl || fetch, nowMs);
  if (!auth.ok) return refused(auth.status);
  if (!env.DB) return refused(503);
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== url.origin || (site && site !== "same-origin")) return refused(403);   // CSRF, as /admin/invites
  let form;
  try { form = await request.formData(); } catch { return refused(400); }
  const action = String(form.get("action") || "");
  const email = normEmail(String(form.get("email") || ""));
  if (action !== "add" && action !== "unsubscribe") return refused(400);
  if (!email) return redirect("/admin/newsletter?msg=bad");
  try {
    if (action === "add") return redirect(`/admin/newsletter?msg=${await adminAdd(env.DB, email, nowMs)}`);
    const r = await unsubscribe(env.DB, email, null, nowMs);
    return redirect(`/admin/newsletter?msg=${r === "unsubscribed" ? "removed" : "unchanged"}`);
  } catch (e) {
    if (e instanceof NotSetUp) return redirect("/admin/newsletter");
    throw e;
  }
}
