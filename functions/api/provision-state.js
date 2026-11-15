// POST /api/provision-state — the Mini's picker records a build's state (CR-AUTOPROVISION.1 A1/A2, decision 3).
//
// Why an endpoint and not a D1 token: the Mini's D1 token stays READ-ONLY. A Cloudflare API token's D1 permission is
// account-wide and cannot be narrowed to a table or a column (functions/_lib/provision.js), so the only writes the
// Mini can make are the ones this code allows:
//   claim       {request_id, run_id}         queued / waiting_cap (or no record yet) -> building, ONLY while the
//                                             request is approved and has a slug. One UPDATE with that condition: two
//                                             runs can never both claim a row (the loser gets 409 not_claimable).
//   step        {request_id, run_id, step}   the step now running (building rows claimed by this run only)
//   ready       {request_id, run_id}         building -> ready
//   failed      {request_id, run_id, step}   building -> failed at <step> (a step NAME; never output text)
//   waiting_cap {request_id}                 queued (or no record yet) -> waiting_cap: the daily cap was reached
//   stopped     {request_id, run_id, step}   building -> stopped before <step>: the request was withdrawn (Not now)
//                                             mid-build (fix round 1 item 3); approving it again makes it claimable
//   notes       {request_id, run_id, codes}  the profile's unattended defaults as fixed codes (NOTE_CODES only)
// A failed row is never claimable: only the admin page's Retry (failed -> queued) makes it buildable again.
// Signed like /api/account-mail with its own secret (BERVO_PROVISION_SECRET; 5 minutes; each signature once).
import { MAX_BYTES, NOTE_CODES, reply, RUN_ID_RE, STEPS, verifySigned } from "../_lib/provision.js";

const ACTIONS = ["claim", "step", "ready", "failed", "waiting_cap", "stopped", "notes"];

export async function onRequestPost(context) {
  const { request, env } = context;
  const nowMs = context.nowMs ?? Date.now();
  const say = context.say || console.log;
  let raw;
  try { raw = await request.text(); } catch { return reply(400, { ok: false, result: "bad_body" }); }
  if (raw.length > MAX_BYTES) return reply(413, { ok: false, result: "too_large" });
  const bad = await verifySigned(request, raw, env, nowMs);
  if (bad) return reply(bad, { ok: false, result: bad === 503 ? "not_configured" : bad === 409 ? "replay" : "unauthorized" });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, result: "bad_body" }); }
  const action = body?.action;
  const id = body?.request_id;
  const runId = body?.run_id;
  const step = body?.step;
  if (!ACTIONS.includes(action)) return reply(400, { ok: false, result: "bad_action" });
  if (!Number.isInteger(id) || id < 1) return reply(400, { ok: false, result: "bad_request_id" });
  if (action !== "waiting_cap" && !(typeof runId === "string" && RUN_ID_RE.test(runId))) return reply(400, { ok: false, result: "bad_run_id" });
  if ((action === "step" || action === "failed" || action === "stopped") && !STEPS.includes(step)) return reply(400, { ok: false, result: "bad_step" });
  const codes = body?.codes;
  if (action === "notes" && !(Array.isArray(codes) && codes.length <= 12 && codes.every((c) => NOTE_CODES.includes(c))))
    return reply(400, { ok: false, result: "bad_codes" });
  const db = env.DB;
  const now = new Date(nowMs).toISOString();
  const buildable = "EXISTS (SELECT 1 FROM invite_requests WHERE id = ? AND status = 'approved' AND slug IS NOT NULL)";
  let changes = 0;
  try {
    if (action === "claim" || action === "waiting_cap") {
      await db.prepare("INSERT OR IGNORE INTO invite_provision (request_id, state, queued_at, updated_at) " +
        "SELECT id, 'queued', ?, ? FROM invite_requests WHERE id = ? AND status = 'approved' AND slug IS NOT NULL").bind(now, now, id).run();
    }
    let st;
    if (action === "claim") {
      st = db.prepare("UPDATE invite_provision SET state = 'building', run_id = ?, step = NULL, started_at = ?, finished_at = NULL, " +
        `updated_at = ? WHERE request_id = ? AND state IN ('queued', 'waiting_cap', 'stopped') AND ${buildable}`).bind(runId, now, now, id, id);
    } else if (action === "waiting_cap") {
      st = db.prepare("UPDATE invite_provision SET state = 'waiting_cap', updated_at = ? " +
        `WHERE request_id = ? AND state IN ('queued', 'waiting_cap', 'stopped') AND ${buildable}`).bind(now, id, id);
    } else if (action === "step") {
      st = db.prepare("UPDATE invite_provision SET step = ?, updated_at = ? WHERE request_id = ? AND state = 'building' AND run_id = ?")
        .bind(step, now, id, runId);
    } else if (action === "notes") {
      st = db.prepare("UPDATE invite_provision SET notes = ?, updated_at = ? WHERE request_id = ? AND state = 'building' AND run_id = ?")
        .bind(JSON.stringify([...new Set(codes)]), now, id, runId);
    } else if (action === "stopped") {
      st = db.prepare("UPDATE invite_provision SET state = 'stopped', step = ?, finished_at = ?, updated_at = ? " +
        "WHERE request_id = ? AND state = 'building' AND run_id = ?").bind(step, now, now, id, runId);
    } else if (action === "ready") {
      st = db.prepare("UPDATE invite_provision SET state = 'ready', step = NULL, finished_at = ?, updated_at = ? " +
        "WHERE request_id = ? AND state = 'building' AND run_id = ?").bind(now, now, id, runId);
    } else {
      st = db.prepare("UPDATE invite_provision SET state = 'failed', step = ?, finished_at = ?, updated_at = ? " +
        "WHERE request_id = ? AND state = 'building' AND run_id = ?").bind(step, now, now, id, runId);
    }
    const r = await st.run();
    changes = Number(r?.meta?.changes ?? 0);
  } catch {
    return reply(503, { ok: false, result: "not_configured" });   // e.g. the 0007 table is missing
  }
  const result = changes === 1 ? (action === "claim" ? "claimed" : "recorded") : "not_allowed";
  say(JSON.stringify({ event: "provision_state", request_id: id, action, step: step ?? null, result }));
  return changes === 1 ? reply(200, { ok: true, result }) : reply(409, { ok: false, result });
}
