// POST /api/account-mail — the router asks bervo.ai to send a customer's "you're loaded" email
// (CR-WELCOMEEMAIL.1, Allen 11-11 Q1 (a)).
//
// The path: the customer's server (onboarding_load.py, when its newest 30 days are summarized) → bervo_router
// (/v1/account-mail, the server's own tenant token; the router names the tenant from the TOKEN and allows one
// per tenant) → here, signed with the relay secret → Postmark (functions/_lib/mail.js). The Postmark key stays
// a Pages secret; a customer server never holds it, and never holds the relay secret either (only the router does).
//
// Settings (Pages secret, Allen places it; the same value goes into the router's environment):
//   BERVO_MAIL_RELAY_SECRET  32+ characters. Without it: 503 for everything.
// Signature: x-bervo-relay-ts = unix seconds; x-bervo-relay-sig = hex HMAC-SHA256(secret, "<ts>.<raw body>").
// Accepted within 5 minutes of ts. A replay inside that window cannot send twice: one "loaded" email per tenant
// (checked before sending, and a unique index in D1).
//
// Only the "loaded" template comes this way. The body's address, name, date and link are checked by
// mail.render (names: no control/format characters; link: https://<host>.bervo.ai/ only; date: words and digits).
// Nothing from the body is logged except the tenant and the result; the address only as mail.js's salted hash.
import { MailError, sendingOff, sendTemplate, TENANT_RE } from "../_lib/mail.js";

const MAX_BYTES = 8192;
const WINDOW_S = 300;

function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyRelay(request, raw, env, nowMs) {
  const secret = String(env.BERVO_MAIL_RELAY_SECRET || "");
  if (secret.length < 32) return 503;
  const ts = request.headers.get("x-bervo-relay-ts") || "";
  const sig = (request.headers.get("x-bervo-relay-sig") || "").toLowerCase();
  if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return 401;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > WINDOW_S) return 401;
  return sameHex(await hmacHex(secret, `${ts}.${raw}`), sig) ? 0 : 401;
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
  if (body.template !== "loaded") return reply(400, { ok: false, result: "bad_template" });
  if (!env.DB) return reply(503, { ok: false, result: "not_configured" });
  const done = await env.DB.prepare("SELECT 1 FROM invite_mail WHERE tenant = ? AND template = 'loaded' AND status <> 'failed' LIMIT 1")
    .bind(tenant).first().catch(() => null);
  if (done) {
    say(JSON.stringify({ event: "account_mail_relay", tenant, result: "already_sent" }));
    return reply(200, { ok: true, result: "already_sent" });
  }
  if (sendingOff(env)) return reply(503, { ok: false, result: "sending_off" });
  const f = body.fields || {};
  let res;
  try {
    res = await sendTemplate(env, { template: "loaded", to: body.to, tenant, nowMs, fetchImpl: context.mailFetch || fetch, say,
      fields: { first_name: f.first_name, start_date: f.start_date, dashboard_link: f.dashboard_link } });
  } catch (e) {
    if (e instanceof MailError && e.code !== "off") {          // round 3: every refusal of the content is a 400, never retried
      say(JSON.stringify({ event: "account_mail_relay", tenant, result: e.code }));
      return reply(400, { ok: false, result: e.code });
    }
    if (/UNIQUE/i.test(String(e?.message || ""))) return reply(200, { ok: true, result: "already_sent" });   // a race
    return reply(500, { ok: false, result: "error" });
  }
  say(JSON.stringify({ event: "account_mail_relay", tenant, result: res.status }));
  return res.ok ? reply(200, { ok: true, result: "sent", message_id: res.message_id })
    : reply(502, { ok: false, result: "postmark_refused", error_code: res.error_code });
}
