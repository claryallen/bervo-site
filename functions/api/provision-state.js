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
//   signed_up   {request_id}                 (CR-SIGNUPSIGNAL.1, Allen 11-23) the Mini saw the owner set a password on
//                                             their server: invite_requests.signed_up_at, once, invited requests only.
//                                             Run-independent (no run_id). Already recorded -> 200 "already". Needs
//                                             migration 0009; before it the column is missing -> 503 not_configured
//                                             (the Mini retries each run).
//                                             CR-ONBOARDEDTAB.1 (Allen 11-23): optional signed_up_at, the time the owner
//                                             set the password (YYYY-MM-DDTHH:MM:SS[.mmm]Z, from users.password_changed_at
//                                             on their server). Clamped: never later than now, never before invited_at
//                                             (else created_at). The first report stores it (no field: now, as before);
//                                             a later report only ever moves a stored date EARLIER ("corrected"; an
//                                             invited or onboarded request), else "already". A bad value -> 400.
// A failed row is never claimable: only the admin page's Retry (failed -> queued) makes it buildable again.
// Signed like /api/account-mail with its own secret (BERVO_PROVISION_SECRET; 5 minutes; each signature once).
import { MAX_BYTES, NOTE_CODES, reply, RUN_ID_RE, STEPS, verifySigned } from "../_lib/provision.js";

const ACTIONS = ["claim", "step", "ready", "failed", "waiting_cap", "stopped", "notes", "signed_up"];
const NO_RUN_ID = ["waiting_cap", "signed_up"];
const SIGNED_UP_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;   // UTC only: never a local time

// CR-ONBOARDEDTAB.1: the reported time, clamped to [invited_at (else created_at), now]; null when not reported.
export function clampSignedUp(reported, row, nowMs) {
  if (reported == null) return null;
  let t = Math.min(Date.parse(reported), nowMs);
  const floor = Date.parse(row?.invited_at || row?.created_at || "");
  if (Number.isFinite(floor)) t = Math.max(t, floor);
  return new Date(t).toISOString();
}

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
  if (!NO_RUN_ID.includes(action) && !(typeof runId === "string" && RUN_ID_RE.test(runId))) return reply(400, { ok: false, result: "bad_run_id" });
  if ((action === "step" || action === "failed" || action === "stopped") && !STEPS.includes(step)) return reply(400, { ok: false, result: "bad_step" });
  const codes = body?.codes;
  if (action === "notes" && !(Array.isArray(codes) && codes.length <= 12 && codes.every((c) => NOTE_CODES.includes(c))))
    return reply(400, { ok: false, result: "bad_codes" });
  const db = env.DB;
  const now = new Date(nowMs).toISOString();
  const buildable = "EXISTS (SELECT 1 FROM invite_requests WHERE id = ? AND status = 'approved' AND slug IS NOT NULL)";
  let changes = 0;
  if (action === "signed_up") {
    const given = body?.signed_up_at;
    if (given != null && !(typeof given === "string" && SIGNED_UP_AT_RE.test(given) && Number.isFinite(Date.parse(given))))
      return reply(400, { ok: false, result: "bad_signed_up_at" });
    let result;
    try {
      const row = await db.prepare("SELECT status, signed_up_at, invited_at, created_at FROM invite_requests WHERE id = ?").bind(id).first();
      const at = clampSignedUp(given ?? null, row, nowMs);
      if (row && !row.signed_up_at) {
        const r = await db.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ? AND status = 'invited' AND signed_up_at IS NULL")
          .bind(at || now, id).run();
        changes = Number(r?.meta?.changes ?? 0);
      }
      if (changes === 1) result = "recorded";
      else {
        const cur = await db.prepare("SELECT status, signed_up_at FROM invite_requests WHERE id = ?").bind(id).first();
        if (!cur || !cur.signed_up_at) result = "not_allowed";
        else if (at && (cur.status === "invited" || cur.status === "claimed") && Date.parse(at) < Date.parse(cur.signed_up_at)) {
          // only ever earlier; the guard on the old value means two reports can never move it back later
          const r = await db.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ? AND signed_up_at = ? AND status IN ('invited', 'claimed')")
            .bind(at, id, cur.signed_up_at).run();
          result = Number(r?.meta?.changes ?? 0) === 1 ? "corrected" : "already";
        } else result = "already";
      }
    } catch {
      return reply(503, { ok: false, result: "not_configured" });   // the 0009 column is missing
    }
    say(JSON.stringify({ event: "provision_state", request_id: id, action, step: null, result }));
    return result === "not_allowed" ? reply(409, { ok: false, result }) : reply(200, { ok: true, result });
  }
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
