// POST /api/newsletter-events — Postmark's webhook for the BROADCAST message stream (CR-NEWSLETTER.1, Allen 11-23).
//
// Postmark posts here when someone on the newsletter stream unsubscribes (its own one-click link or the List-Unsubscribe
// header: RecordType "SubscriptionChange" with SuppressSending true, address in `Recipient`) or marks a newsletter as
// spam (RecordType "SpamComplaint", address in `Email`). Either one records the opt-out on bervo.ai (the row becomes a
// suppression entry: email + opted_out_at only); the owner's server turns its switch off the next time it asks
// (/api/newsletter action "status", hourly). A reactivation (SuppressSending false) is ignored: it never re-subscribes
// anyone; only the person can, from their own Settings. Every other record type is ignored.
//
// Auth: the same HTTP Basic scheme as /api/postmark-events (user "postmark", password = Pages secret
// POSTMARK_WEBHOOK_SECRET), so the webhook URL is https://postmark:<secret>@bervo.ai/api/newsletter-events.
// Nothing from the payload is stored except the address's opt-out time; nothing is logged but the record type and result.
import { authorized } from "./postmark-events.js";
import { normEmail, NotSetUp, unsubscribe } from "../_lib/newsletter.js";

const MAX_BYTES = 65536;

function reply(status, body = "") {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// -> { email, at } when this record is an opt-out, else null.
export function optOutOf(rec) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.RecordType === "SubscriptionChange" && rec.SuppressSending === true) {
    const email = normEmail(rec.Recipient);
    return email ? { email, at: rec.ChangedAt } : null;
  }
  if (rec.RecordType === "SpamComplaint") {
    const email = normEmail(rec.Email);
    return email ? { email, at: rec.BouncedAt } : null;
  }
  return null;
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
  const out = optOutOf(rec);
  let result = "ignored";
  if (out) {
    try { result = await unsubscribe(env.DB, out.email, out.at, context.nowMs ?? Date.now()); }
    catch (e) { return reply(e instanceof NotSetUp ? 503 : 500); }   // Postmark retries a failed delivery
  }
  const say = context.say || console.log;
  say(JSON.stringify({ event: "newsletter_webhook", record: typeof rec?.RecordType === "string" ? rec.RecordType.slice(0, 20) : null, result }));
  return reply(200, result);
}
