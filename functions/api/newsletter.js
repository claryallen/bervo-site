// POST /api/newsletter — a customer server's newsletter choice, relayed by the router (CR-NEWSLETTER.1, Allen 11-23).
//
// The path: the owner ticks (or unticks) "Send me Bervo news and announcements" on /welcome's "A few preferences", or
// flips the same switch in Settings → their server (newsletter_optin.py) → bervo_router /v1/newsletter (the server's
// own tenant token; the router names the tenant from the TOKEN) → here, signed with the same relay secret as
// /api/account-mail (BERVO_MAIL_RELAY_SECRET; x-bervo-relay-ts + x-bervo-relay-sig = hex HMAC-SHA256(secret,
// "<ts>.<raw body>"), within 5 minutes). A customer server never holds the relay secret.
//
// Body: { tenant, action: "set", email, subscribed: true|false, at: ISO }  -> { ok, result, status, changed_at }
//       { tenant, action: "status", email }                              -> { ok, status, changed_at }
// "status" is how a server learns of an unsubscribe made from an email (one-click page or Postmark) and turns its
// switch off. The tenant is checked and logged, never stored. The address is never logged.
import { verifyRelay } from "./account-mail.js";
import { TENANT_RE } from "../_lib/mail.js";
import { applyOwnerChoice, normEmail, NotSetUp, statusOf } from "../_lib/newsletter.js";

const MAX_BYTES = 4096;

function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const nowMs = context.nowMs ?? Date.now();
  const say = context.say || console.log;
  let raw;
  try { raw = await request.text(); } catch { return reply(400, { ok: false, result: "bad_body" }); }
  if (raw.length > MAX_BYTES) return reply(413, { ok: false, result: "too_large" });
  const bad = await verifyRelay(request, raw, env, nowMs);
  if (bad) return reply(bad, { ok: false, result: bad === 503 ? "not_configured" : "unauthorized" });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, result: "bad_body" }); }
  const tenant = typeof body?.tenant === "string" ? body.tenant : "";
  if (!TENANT_RE.test(tenant)) return reply(400, { ok: false, result: "bad_tenant" });
  const email = normEmail(body.email);
  if (!email) return reply(400, { ok: false, result: "bad_email" });
  if (body.action !== "set" && body.action !== "status") return reply(400, { ok: false, result: "bad_action" });
  if (body.action === "set" && typeof body.subscribed !== "boolean") return reply(400, { ok: false, result: "bad_choice" });
  if (!env.DB) return reply(503, { ok: false, result: "not_configured" });
  try {
    if (body.action === "status") {
      const s = await statusOf(env.DB, email);
      say(JSON.stringify({ event: "newsletter_relay", tenant, action: "status", result: s.status }));
      return reply(200, { ok: true, result: "status", ...s });
    }
    const r = await applyOwnerChoice(env.DB, { email, subscribed: body.subscribed, at: body.at, nowMs });
    say(JSON.stringify({ event: "newsletter_relay", tenant, action: "set", result: r.result }));
    return reply(200, { ok: true, ...r });
  } catch (e) {
    if (e instanceof NotSetUp) return reply(503, { ok: false, result: "not_configured" });
    say(JSON.stringify({ event: "newsletter_relay", tenant, action: body.action, result: "error" }));
    return reply(500, { ok: false, result: "error" });
  }
}
