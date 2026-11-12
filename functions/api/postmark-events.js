// POST /api/postmark-events — Postmark's webhook for the account emails (CR-WELCOMEEMAIL.1 step 2).
//
// Postmark posts Delivery, Bounce and SpamComplaint records here; each marks the matching invite_mail row
// (by MessageID) delivered / bounced / complained, which the admin page shows. A bounce or complaint stops the
// reminders (functions/_lib/mail.js reminderDue). Nothing is ever re-sent from here.
//
// Postmark does not sign webhooks; it supports HTTP Basic auth in the webhook URL
// (https://<user>:<password>@bervo.ai/api/postmark-events). Settings (Pages secret, Allen places it):
//   POSTMARK_WEBHOOK_SECRET  the password in that URL (user name "postmark"). Without it: 503 for everything.
// The payload carries the address, subject and bounce text; none of it is stored or logged, only the record
// type, MessageID and (for a bounce) its Type word.
import { applyEvent } from "../_lib/mail.js";

const MAX_BYTES = 65536;

function reply(status, body = "") {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function sameSecret(a, b) {
  // Constant-time compare via fixed-length digests.
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

export async function authorized(request, env) {
  const secret = String(env.POSTMARK_WEBHOOK_SECRET || "");
  if (secret.length < 16) return { ok: false, status: 503 };
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return { ok: false, status: 401 };
  let decoded = "";
  try { decoded = atob(h.slice(6).trim()); } catch { return { ok: false, status: 401 }; }
  const i = decoded.indexOf(":");
  if (i < 0) return { ok: false, status: 401 };
  const userOk = await sameSecret(decoded.slice(0, i), "postmark");
  const passOk = await sameSecret(decoded.slice(i + 1), secret);
  return userOk && passOk ? { ok: true } : { ok: false, status: 401 };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await authorized(request, env);
  if (!auth.ok) return reply(auth.status, auth.status === 401 ? "unauthorized" : "not configured");
  if (!env.DB) return reply(503, "not configured");
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BYTES) return reply(413);
  let text;
  try { text = await request.text(); } catch { return reply(400); }
  if (text.length > MAX_BYTES) return reply(413);
  let rec;
  try { rec = JSON.parse(text); } catch { return reply(400); }
  let result = "ignored";
  try { result = await applyEvent(env.DB, rec, context.nowMs ?? Date.now()); }
  catch { return reply(500); }                 // Postmark retries a failed delivery; a missing table lands here
  const say = context.say || console.log;
  say(JSON.stringify({ event: "account_mail_webhook", record: typeof rec?.RecordType === "string" ? rec.RecordType.slice(0, 20) : null,
    message_id: typeof rec?.MessageID === "string" ? rec.MessageID.slice(0, 64) : null, result }));
  // 200 for every authorized record, applied or not, so Postmark does not retry what we chose to ignore.
  return reply(200, result);
}

