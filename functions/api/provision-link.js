// POST /api/provision-link — the Mini hands bervo.ai the owner's one-time link (CR-AUTOPROVISION.1 C1/C2).
//
// The path: the Mini's picker (daily-dashboard tools/tenant/auto_provision.py) runs new_customer.sh unattended; its
// owner step runs owner_invite_link.py --deliver, which makes the token on the Mini, stores only its hash on the new
// server, and POSTs the link here once, signed (functions/_lib/provision.js: BERVO_PROVISION_SECRET, 5 minutes, each
// signature once). The day-3 / day-10 reminders come the same way with a fresh link (kind reminder3 / reminder10).
//
// Checks: the request exists; an invite link needs it approved or invited, a reminder link needs it invited; the
// request has a slug and the link is https://<slug>.bervo.ai/set-password?t=<token> (linkMatchesSlug + the strict
// INVITE_LINK_RE). Then:
//   * AUTO_SEND_INVITE (invite) / AUTO_SEND_REMINDERS (reminders) "on": the email is sent now (a reminder only when
//     it is the one due); nothing is stored when it went out. Both default off (Allen 11-15).
//   * otherwise, or when that send did not go out: the link is stored ENCRYPTED (AES-GCM, BERVO_LINK_KEY) with its
//     expiry, and the admin page shows "link ready" with a Send button. It is deleted when its email is sent and on
//     expiry. The link is never logged and never put in any page.
// Body: {"request_id": <int>, "kind": "invite" | "reminder3" | "reminder10", "link": "<https://…>"}.
import { INVITE_LINK_RE, linkMatchesSlug } from "../_lib/mail.js";
import { autoSendOn, dropExpiredLinks, KINDS, linkKeyReady, MAX_BYTES, reply, sendLinkEmail, storeLink, verifySigned } from "../_lib/provision.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const nowMs = context.nowMs ?? Date.now();
  const say = context.say || console.log;
  let raw;
  try { raw = await request.text(); } catch { return reply(400, { ok: false, result: "bad_body" }); }
  if (raw.length > MAX_BYTES) return reply(413, { ok: false, result: "too_large" });
  // Fail closed before anything else: a link is never accepted when it could not be stored encrypted.
  if (!(await linkKeyReady(env))) return reply(503, { ok: false, result: "not_configured" });
  const bad = await verifySigned(request, raw, env, nowMs);
  if (bad) return reply(bad, { ok: false, result: bad === 503 ? "not_configured" : bad === 409 ? "replay" : "unauthorized" });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, result: "bad_body" }); }
  const id = body?.request_id;
  const kind = body?.kind;
  const link = typeof body?.link === "string" ? body.link : "";
  if (!Number.isInteger(id) || id < 1) return reply(400, { ok: false, result: "bad_request_id" });
  if (!KINDS.includes(kind)) return reply(400, { ok: false, result: "bad_kind" });
  if (!INVITE_LINK_RE.test(link)) return reply(400, { ok: false, result: "bad_link" });
  const row = await env.DB.prepare("SELECT id, status, first_name, email, slug, phone, computers, timezone FROM invite_requests WHERE id = ?")
    .bind(id).first();
  const log = (result) => say(JSON.stringify({ event: "provision_link", request_id: id, kind, result }));
  if (!row) { log("not_found"); return reply(404, { ok: false, result: "not_found" }); }
  const okState = kind === "invite" ? ["approved", "invited"] : ["invited"];
  if (!okState.includes(row.status)) { log("wrong_state"); return reply(409, { ok: false, result: "wrong_state" }); }
  if (!row.slug || !linkMatchesSlug(link, row.slug)) { log("wrong_host"); return reply(400, { ok: false, result: "wrong_host" }); }
  await dropExpiredLinks(env.DB, nowMs);
  let sentWhy = null;
  if (autoSendOn(env, kind)) {
    sentWhy = await sendLinkEmail({ db: env.DB, env, row, kind, link, nowMs, fetchImpl: context.mailFetch || fetch, say });
    if (sentWhy === "ok") { log("sent"); return reply(200, { ok: true, result: "sent" }); }
  }
  const expires = await storeLink(env.DB, env, id, kind, link, nowMs);
  log(sentWhy ? `stored_after_${sentWhy}` : "stored");
  return reply(200, { ok: true, result: "stored", expires_at: expires, ...(sentWhy ? { auto_send: sentWhy } : {}) });
}
