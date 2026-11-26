// Tests for automatic server builds (CR-AUTOPROVISION.1): /api/provision-state, /api/provision-link, the stored
// (encrypted) link, the admin page's build state / Send with the delivered link / Retry, and the two auto-send
// switches. D1 is node:sqlite with the real migrations; Postmark and Access are mocked; every secret is made up.
// Run: node --experimental-default-type=module --test functions/_dev/tests/provision.test.js   (Node 22+, no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as admin from "../../admin/invites.js";
import * as linkApi from "../../api/provision-link.js";
import * as stateApi from "../../api/provision-state.js";
import * as prov from "../../_lib/provision.js";
import { _resetAccessKeyCache } from "../../_lib/invites.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = (n) => readFileSync(path.join(ROOT, "functions/_dev/migrations", n), "utf8");
const NOW = Date.parse("2026-11-15T15:00:00Z");
const ORIGIN = "https://bervo.ai";
const TEAM = "bervo.cloudflareaccess.com";
const AUD = "aud-tag-test";
const SECRET = "fake-provision-secret-0123456789abcdef";
const LINK_KEY = "fake-link-key-0123456789abcdef-0123456789";
const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const LINK = `https://zz-test.bervo.ai/set-password?t=${TOKEN}`;
const GO = `https://bervo.ai/go/zz-test/set-password#t=${TOKEN}`;   // CR-LINKPREVIEW.1: what the email carries
const TOKEN2 = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e";
const LINK2 = `https://zz-test.bervo.ai/set-password?t=${TOKEN2}`;
const ADDRESS = "pat@example.com";
const FAKE_PM = "fake-postmark-token-for-tests";

function makeD1() {
  const sql = new DatabaseSync(":memory:");
  for (const n of ["0001_invite_requests.sql", "0003_other_email.sql", "0004_computers.sql", "0005_heard_from.sql",
    "0006_drop_company_role.sql", "0002_invite_mail.sql", "0007_provisioning.sql", "0014_placement.sql"]) sql.exec(MIG(n));
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    raw: sql,
    // D1 runs a batch as one transaction: any failed statement rolls the whole batch back (CR-ONBOARDEDTAB.1)
    async batch(stmts) {
      sql.exec("BEGIN");
      try { const out = []; for (const s of stmts) out.push(await s.run()); sql.exec("COMMIT"); return out; }
      catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
    prepare(q) {
      let args = [];
      const st = {
        bind(...a) { args = norm(a); return st; },
        async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: r.changes } }; },
        async first() { return sql.prepare(q).get(...args) ?? null; },
        async all() { return { success: true, results: sql.prepare(q).all(...args) }; },
      };
      return st;
    },
  };
}
function seed(db, { status = "approved", slug = "zz-test", invitedAt = null } = {}) {
  db.raw.prepare("INSERT INTO invite_requests (created_at, first_name, last_name, email, has_assistant, email_providers, phone, plan, " +
    "timezone, about, cohort, privacy_agreed_at, status, status_changed_at, approved_at, invited_at, slug) " +
    "VALUES (?, 'Pat', 'Sample', ?, 'yes', '[\"google\"]', 'android', 'private', 'America/Chicago', 'I run a small firm.', 'public', ?, ?, ?, ?, ?, ?)")
    .run("2026-11-14T10:00:00Z", ADDRESS, "2026-11-14T10:00:00Z", status, "2026-11-14T11:00:00Z",
      status === "new" ? null : "2026-11-14T11:00:00Z", invitedAt, slug);
  return Number(db.raw.prepare("SELECT max(id) AS m FROM invite_requests").get().m);
}
const reqRow = (db, id) => db.raw.prepare("SELECT * FROM invite_requests WHERE id = ?").get(id);
const provRow = (db, id) => db.raw.prepare("SELECT * FROM invite_provision WHERE request_id = ?").get(id);
const linkRows = (db) => db.raw.prepare("SELECT * FROM invite_links ORDER BY id").all();
function dumpDb(db) {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  return JSON.stringify(tables.map((t) => db.raw.prepare(`SELECT * FROM "${t}"`).all()));
}
function postmark(calls = [], mode = "ok") {
  let n = 0;
  return async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (mode === "down") throw new Error("down");
    n += 1;
    return Response.json({ MessageID: `0a129aee-e1cd-480d-b08d-4f48548ff4${String(n).padStart(2, "0")}`, ErrorCode: 0, Message: "OK" });
  };
}
const ENV = (db, over = {}) => ({ DB: db, BERVO_PROVISION_SECRET: SECRET, BERVO_LINK_KEY: LINK_KEY, POSTMARK_SERVER_TOKEN: FAKE_PM,
  MAIL_REPLY_TO: "allen@bervo.ai", RATE_LIMIT_SALT: "test-salt", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai", ...over });

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))).toString("hex");
}
// The Mini puts a random nonce in every body (provision_client.py), so two identical requests in one second are
// still two signatures; the replay check refuses only the same signed request sent twice.
async function signed(obj, { secret = SECRET, ts = Math.floor(NOW / 1000) } = {}) {
  const raw = JSON.stringify({ ...obj, nonce: crypto.randomUUID() });
  return { raw, headers: { "Content-Type": "application/json", "x-bervo-provision-ts": String(ts), "x-bervo-provision-sig": await hmac(secret, `${ts}.${raw}`) } };
}
async function call(api, pathName, db, req, { env, nowMs = NOW, calls = [], logs = [] } = {}) {
  const res = await api.onRequestPost({ request: new Request(`${ORIGIN}${pathName}`, { method: "POST", headers: req.headers, body: req.raw }),
    env: env || ENV(db), nowMs, mailFetch: postmark(calls), say: (l) => logs.push(l) });
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const link = async (db, body, opts) => call(linkApi, "/api/provision-link", db, await signed(body), opts);
const state = async (db, body, opts) => call(stateApi, "/api/provision-state", db, await signed(body), opts);

// Access (as mail.test.js)
let KEYS;
async function keys() {
  if (KEYS) return KEYS;
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  KEYS = { kp, jwk: { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "kid1" } };
  return KEYS;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function makeJwt(nowMs) {
  const k = await keys();
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "kid1", typ: "JWT" }));
  const p = b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: "allen@bervo.ai", exp: Math.floor(nowMs / 1000) + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const certsFetch = async () => Response.json({ keys: [(await keys()).jwk] });
async function adminGet(db, { env, nowMs = NOW, query = "?show=all" } = {}) {   // CR-ADMINTABS.1: every card (the old default listed every open one)
  _resetAccessKeyCache();
  const res = await admin.onRequestGet({ request: new Request(`${ORIGIN}/admin/invites${query}`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt(nowMs) } }),
    env: env || ENV(db), fetchImpl: certsFetch, nowMs });
  return res.text();
}
async function adminPost(db, fields, { env, nowMs = NOW, calls = [], logs = [] } = {}) {
  _resetAccessKeyCache();
  const res = await admin.onRequestPost({ request: new Request(`${ORIGIN}/admin/invites`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": await makeJwt(nowMs), Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams(fields).toString() }), env: env || ENV(db), fetchImpl: certsFetch, mailFetch: postmark(calls), say: (l) => logs.push(l), nowMs });
  return res.headers.get("Location") || "";
}
function inviteSent(db, id, daysAgo) {
  const at = new Date(NOW - daysAgo * 86400000).toISOString();
  db.raw.prepare("UPDATE invite_requests SET status = 'invited', invited_at = ? WHERE id = ?").run(at, id);
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, address_hash, message_id, status, created_at) VALUES (?, 'invite', 'abcdef0123456789', 'm-1', 'sent', ?)").run(id, at);
}

// ---------- signatures ----------
test("S1 signed endpoints: no/short secret 503, wrong key / old / malformed 401, a replay of a good request 409", async () => {
  const db = makeD1(); const id = seed(db);
  const body = { action: "claim", request_id: id, run_id: "run-aaaaaaaa" };
  for (const api of [stateApi, linkApi]) {
    const p = api === stateApi ? "/api/provision-state" : "/api/provision-link";
    assert.equal((await call(api, p, db, await signed(body), { env: ENV(db, { BERVO_PROVISION_SECRET: "" }) })).status, 503);
    assert.equal((await call(api, p, db, await signed(body), { env: ENV(db, { BERVO_PROVISION_SECRET: "short" }) })).status, 503);
    assert.equal((await call(api, p, db, await signed(body, { secret: "x".repeat(40) }))).status, 401);
    assert.equal((await call(api, p, db, await signed(body, { ts: Math.floor(NOW / 1000) - 301 }))).status, 401);
    const t = await signed(body); t.raw = t.raw.replace("claim", "ready");
    assert.equal((await call(api, p, db, t)).status, 401, "a changed body fails the signature");
  }
  const once = await signed(body);
  assert.equal((await call(stateApi, "/api/provision-state", db, once)).status, 200);
  const again = await call(stateApi, "/api/provision-state", db, once);
  assert.deepEqual([again.status, again.body.result], [409, "replay"]);
});

// ---------- state ----------
test("S2 claim: one run only; step/ready/failed only by the claiming run; failed is never claimable until Retry", async () => {
  const db = makeD1(); const id = seed(db);
  let r = await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" });
  assert.deepEqual([r.status, r.body.result, provRow(db, id).state], [200, "claimed", "building"]);
  r = await state(db, { action: "claim", request_id: id, run_id: "run-bbbbbbbb" });
  assert.deepEqual([r.status, r.body.result], [409, "not_allowed"], "a second run never claims a building row");
  assert.equal((await state(db, { action: "step", request_id: id, run_id: "run-bbbbbbbb", step: "phase3" })).status, 409);
  assert.equal((await state(db, { action: "step", request_id: id, run_id: "run-aaaaaaaa", step: "phase4b" })).status, 200);
  assert.equal(provRow(db, id).step, "phase4b");
  assert.equal((await state(db, { action: "step", request_id: id, run_id: "run-aaaaaaaa", step: "rm -rf" })).body.result, "bad_step");
  assert.equal((await state(db, { action: "failed", request_id: id, run_id: "run-aaaaaaaa", step: "phase4b" })).status, 200);
  assert.deepEqual([provRow(db, id).state, provRow(db, id).step], ["failed", "phase4b"]);
  r = await state(db, { action: "claim", request_id: id, run_id: "run-cccccccc" });
  assert.equal(r.status, 409, "a failed row is not retried by the picker");
  // the admin page shows it and Retry clears it
  const page = await adminGet(db);
  assert.ok(page.includes("failed at phase4b") && page.includes('value="retry_build"'), "failed at <step> + Retry");
  assert.match(await adminPost(db, { id: String(id), action: "retry_build" }), /sent=retried/);
  assert.deepEqual([provRow(db, id).state, provRow(db, id).step], ["queued", "phase4b"]);
  assert.ok(provRow(db, id).retry_requested_at);
  r = await state(db, { action: "claim", request_id: id, run_id: "run-cccccccc" });
  assert.equal(r.body.result, "claimed");
  assert.equal((await state(db, { action: "ready", request_id: id, run_id: "run-cccccccc" })).status, 200);
  assert.equal(provRow(db, id).state, "ready");
  assert.equal((await state(db, { action: "claim", request_id: id, run_id: "run-dddddddd" })).status, 409, "ready is final");
});

test("S3 claim refused unless approved with a slug; waiting_cap shows on the page and stays claimable", async () => {
  const db = makeD1();
  const fresh = seed(db, { status: "new" });
  const noSlug = seed(db, { slug: null });
  assert.equal((await state(db, { action: "claim", request_id: fresh, run_id: "run-aaaaaaaa" })).status, 409);
  assert.equal((await state(db, { action: "claim", request_id: noSlug, run_id: "run-aaaaaaaa" })).status, 409);
  assert.equal(provRow(db, fresh), undefined, "nothing recorded for a request that is not buildable");
  const id = seed(db);
  assert.equal((await state(db, { action: "waiting_cap", request_id: id })).status, 200);
  assert.equal(provRow(db, id).state, "waiting_cap");
  let page = await adminGet(db);
  assert.ok(page.includes("waiting: daily cap"));
  assert.ok(page.includes("no slug"), "an approved request without a slug says it is not built automatically");
  assert.equal((await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" })).body.result, "claimed");
  await state(db, { action: "step", request_id: id, run_id: "run-aaaaaaaa", step: "phase4b" });
  page = await adminGet(db);
  assert.ok(page.includes("building, step 9 of 14 (phase4b)"), "building step N of 14");
  assert.equal((await state(db, { action: "nope", request_id: id, run_id: "run-aaaaaaaa" })).body.result, "bad_action");
  assert.equal((await state(db, { action: "claim", request_id: id, run_id: "x" })).body.result, "bad_run_id");
});

test("S4 the step list is the same in the code and the migration", () => {
  const sqlSteps = [...MIG("0007_provisioning.sql").match(/step IN \(([^)]*)\)/s)[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlSteps, prov.STEPS);
  assert.deepEqual(prov.BUILD_STEPS, prov.STEPS.filter((s) => !["profile", "approval_check", "scan", "timeout", "interrupted"].includes(s)));
});

// ---------- links ----------
test("L1 a delivered link is stored encrypted: not in any D1 column, not in a log, not in the page; the page says ready", async () => {
  const db = makeD1(); const id = seed(db); const logs = []; const calls = [];
  const r = await link(db, { request_id: id, kind: "invite", link: LINK }, { logs, calls });
  assert.deepEqual([r.status, r.body.result], [200, "stored"]);
  assert.equal(calls.length, 0, "AUTO_SEND_INVITE unset: no email on arrival");
  const dump = dumpDb(db);
  assert.equal([dump.includes(TOKEN), dump.includes(LINK), dump.includes("set-password")].filter(Boolean).length, 0);
  assert.equal(logs.join("\n").includes(TOKEN), false);
  assert.equal(JSON.stringify(r.body).includes(TOKEN), false);
  const rows = linkRows(db);
  assert.equal(rows.length, 1);
  assert.equal(await prov.decryptLink(ENV(db), id, "invite", rows[0].iv, rows[0].ct), LINK, "decrypts with the key");
  assert.equal(await prov.decryptLink(ENV(db), id + 1, "invite", rows[0].iv, rows[0].ct), null, "bound to its request (AAD)");
  assert.equal(await prov.decryptLink(ENV(db, { BERVO_LINK_KEY: "y".repeat(40) }), id, "invite", rows[0].iv, rows[0].ct), null);
  const page = await adminGet(db);
  assert.ok(page.includes("Invite link ready") && page.includes('value="send_invite_stored"'));
  assert.equal(page.includes(TOKEN), false, "never in the page HTML");
  // a newer delivery replaces the older
  await link(db, { request_id: id, kind: "invite", link: LINK2 });
  assert.equal(linkRows(db).length, 1);
  assert.equal((await prov.readLink(db, ENV(db), id, "invite", NOW)).link, LINK2);
});

test("L2 link refusals: no link key 503 (nothing stored), wrong host, no slug, wrong state, unknown request, bad link/kind", async () => {
  const db = makeD1(); const id = seed(db);
  let r = await link(db, { request_id: id, kind: "invite", link: LINK }, { env: ENV(db, { BERVO_LINK_KEY: "" }) });
  assert.deepEqual([r.status, linkRows(db).length], [503, 0]);
  r = await link(db, { request_id: id, kind: "invite", link: `https://other.bervo.ai/set-password?t=${TOKEN}` });
  assert.deepEqual([r.status, r.body.result], [400, "wrong_host"]);
  const noSlug = seed(db, { slug: null });
  assert.equal((await link(db, { request_id: noSlug, kind: "invite", link: LINK })).body.result, "wrong_host");
  const fresh = seed(db, { status: "new" });
  assert.deepEqual(Object.values(await link(db, { request_id: fresh, kind: "invite", link: LINK })).map((x) => x.result ?? x), [409, "wrong_state"]);
  assert.equal((await link(db, { request_id: id, kind: "reminder3", link: LINK })).body.result, "wrong_state", "a reminder needs an invited request");
  assert.equal((await link(db, { request_id: 999, kind: "invite", link: LINK })).status, 404);
  assert.equal((await link(db, { request_id: id, kind: "invite", link: LINK.replace("https", "http") })).body.result, "bad_link");
  assert.equal((await link(db, { request_id: id, kind: "loaded", link: LINK })).body.result, "bad_kind");
  assert.equal(linkRows(db).length, 0);
});

test("L3 Send with the delivered link: one email with that link, the link deleted, the request invited; sending again finds no link", async () => {
  const db = makeD1(); const id = seed(db);
  await link(db, { request_id: id, kind: "invite", link: LINK });
  const calls = [];
  assert.match(await adminPost(db, { id: String(id), action: "send_invite_stored" }, { calls }), /sent=ok/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.TextBody.includes(GO) && !calls[0].body.TextBody.includes(LINK) && calls[0].body.Tag === "invite");
  assert.equal(linkRows(db).length, 0, "deleted the moment the email is sent");
  assert.equal(reqRow(db, id).status, "invited");
  assert.match(await adminPost(db, { id: String(id), action: "send_invite_stored" }, { calls }), /sent=nolink/);
  assert.equal(calls.length, 1);
});

test("L4 a link that expired is gone: not sendable and deleted from D1", async () => {
  const db = makeD1(); const id = seed(db);
  await link(db, { request_id: id, kind: "invite", link: LINK });
  const later = NOW + 14 * 86400000;
  assert.equal(await prov.readLink(db, ENV(db), id, "invite", later), null);
  assert.equal(linkRows(db).length, 0);
  await link(db, { request_id: id, kind: "invite", link: LINK });
  await adminGet(db, { nowMs: later });                      // pruneOld on page load
  assert.equal(linkRows(db).length, 0);
});

test("L5 a link never outlives an open request: Not now deletes it", async () => {
  const db = makeD1(); const id = seed(db);
  await link(db, { request_id: id, kind: "invite", link: LINK });
  await adminPost(db, { id: String(id), action: "not_now" });
  assert.equal(linkRows(db).length, 0);
});

// ---------- the two switches ----------
test("A1 AUTO_SEND_INVITE: off/unset never sends on arrival; on sends the invite at once (nothing stored) and never a reminder", async () => {
  for (const v of [undefined, "", "off", "0"]) {
    const db = makeD1(); const id = seed(db); const calls = [];
    await link(db, { request_id: id, kind: "invite", link: LINK }, { env: ENV(db, { AUTO_SEND_INVITE: v }), calls });
    assert.deepEqual([calls.length, linkRows(db).length], [0, 1], `AUTO_SEND_INVITE=${v}`);
  }
  let db = makeD1(); let id = seed(db); let calls = [];
  const r = await link(db, { request_id: id, kind: "invite", link: LINK }, { env: ENV(db, { AUTO_SEND_INVITE: "on" }), calls });
  assert.deepEqual([r.body.result, calls.length, linkRows(db).length, reqRow(db, id).status], ["sent", 1, 0, "invited"]);
  assert.ok(calls[0].body.TextBody.includes(GO));
  // on, but a reminder arrives: AUTO_SEND_INVITE never sends a reminder
  db = makeD1(); id = seed(db); inviteSent(db, id, 3.5); calls = [];
  await link(db, { request_id: id, kind: "reminder3", link: LINK }, { env: ENV(db, { AUTO_SEND_INVITE: "on" }), calls });
  assert.deepEqual([calls.length, linkRows(db).length], [0, 1]);
  // on, but Postmark is down: the link is stored for Allen's Send
  db = makeD1(); id = seed(db); calls = [];
  const down = await linkApi.onRequestPost({ request: new Request(`${ORIGIN}/api/provision-link`, { method: "POST", ...(await (async () => { const s = await signed({ request_id: id, kind: "invite", link: LINK }); return { headers: s.headers, body: s.raw }; })()) }),
    env: ENV(db, { AUTO_SEND_INVITE: "on" }), nowMs: NOW, mailFetch: postmark(calls, "down"), say: () => {} });
  const dj = JSON.parse(await down.text());
  assert.deepEqual([dj.result, dj.auto_send, linkRows(db).length, reqRow(db, id).status], ["stored", "failed", 1, "approved"]);
});

test("A2 AUTO_SEND_REMINDERS: off never sends; on sends only the due reminder, never an invite, and stores one not due", async () => {
  let db = makeD1(); let id = seed(db); inviteSent(db, id, 3.5); let calls = [];
  await link(db, { request_id: id, kind: "reminder3", link: LINK }, { calls });
  assert.deepEqual([calls.length, linkRows(db).length], [0, 1], "unset: stored");
  let page = await adminGet(db);
  assert.ok(page.includes("Fresh link ready") && page.includes('value="send_reminder_stored"') && !page.includes(TOKEN));
  // Allen's Send with the delivered reminder link
  assert.match(await adminPost(db, { id: String(id), action: "send_reminder_stored", kind: "reminder3" }, { calls }), /sent=reminder/);
  assert.deepEqual([calls.length, calls[0].body.Tag, linkRows(db).length], [1, "reminder_day3", 0]);
  // a reminder Allen sends days after its link arrived states the link's real closing date (minted + 13 days), not now + 13
  db = makeD1(); id = seed(db); inviteSent(db, id, 3.5); calls = [];
  await link(db, { request_id: id, kind: "reminder3", link: LINK });
  const later = NOW + 4 * 86400000;
  assert.match(await adminPost(db, { id: String(id), action: "send_reminder_stored", kind: "reminder3" }, { calls, nowMs: later }), /sent=reminder/);
  assert.ok(calls[0].body.TextBody.includes("It stays open until November 28."), calls[0].body.TextBody);
  // on: sent at once
  db = makeD1(); id = seed(db); inviteSent(db, id, 3.5); calls = [];
  let r = await link(db, { request_id: id, kind: "reminder3", link: LINK }, { env: ENV(db, { AUTO_SEND_REMINDERS: "on" }), calls });
  assert.deepEqual([r.body.result, calls.length, linkRows(db).length], ["sent", 1, 0]);
  assert.ok(calls[0].body.TextBody.includes(GO) && calls[0].body.Tag === "reminder_day3");
  // on, but the day-10 link arrives on day 3.5: not due -> stored, not sent
  db = makeD1(); id = seed(db); inviteSent(db, id, 3.5); calls = [];
  r = await link(db, { request_id: id, kind: "reminder10", link: LINK }, { env: ENV(db, { AUTO_SEND_REMINDERS: "on" }), calls });
  assert.deepEqual([r.body.result, r.body.auto_send, calls.length], ["stored", "notdue", 0]);
  // on, an invite arrives: AUTO_SEND_REMINDERS never sends the invite
  db = makeD1(); id = seed(db); calls = [];
  await link(db, { request_id: id, kind: "invite", link: LINK }, { env: ENV(db, { AUTO_SEND_REMINDERS: "on" }), calls });
  assert.deepEqual([calls.length, linkRows(db).length], [0, 1]);
});

test("G1 no value next to BERVO_PROVISION_SECRET or BERVO_LINK_KEY in any tracked file (only this test's made-up ones)", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    if (/\.(pkg|png|jpg|ico|pdf|woff2?)$/i.test(f) || f.endsWith("provision.test.js")) continue;
    let text;
    try { text = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    for (const ln of text.split("\n")) {
      if (/(BERVO_PROVISION_SECRET|BERVO_LINK_KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/.test(ln)) assert.fail(`${f}: a value next to a provision secret`);
    }
  }
});

// ---------- fix round 1 ----------
import * as mail from "../../_lib/mail.js";

test("F1 Not now mid-build: stopped before <step> shows on the page; not claimable while not approved; Approve again continues", async () => {
  const db = makeD1(); const id = seed(db);
  await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" });
  await state(db, { action: "step", request_id: id, run_id: "run-aaaaaaaa", step: "phase5" });
  db.raw.prepare("UPDATE invite_requests SET status = 'not_now' WHERE id = ?").run(id);   // Allen presses Not now
  assert.equal((await state(db, { action: "stopped", request_id: id, run_id: "run-bbbbbbbb", step: "phase5" })).status, 409, "only the claiming run");
  assert.equal((await state(db, { action: "stopped", request_id: id, run_id: "run-aaaaaaaa", step: "phase5" })).status, 200);
  assert.deepEqual([provRow(db, id).state, provRow(db, id).step], ["stopped", "phase5"]);
  const page = await adminGet(db, { query: "?show=not_now" });
  assert.ok(page.includes("stopped before phase5") && page.includes("Nothing was torn down"), "shown on a not-now row too");
  assert.equal((await state(db, { action: "claim", request_id: id, run_id: "run-cccccccc" })).status, 409, "not approved: not claimable");
  db.raw.prepare("UPDATE invite_requests SET status = 'approved' WHERE id = ?").run(id);
  assert.equal((await state(db, { action: "claim", request_id: id, run_id: "run-cccccccc" })).body.result, "claimed");
});

test("F2 notes: only the fixed codes are stored (never text) and the admin page shows their words before Send", async () => {
  const db = makeD1(); const id = seed(db);
  await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" });
  for (const bad of [["tz_defaulted", "Yahoo, AOL"], "tz_defaulted", Array(13).fill("android"), [{ code: "android" }]]) {
    assert.equal((await state(db, { action: "notes", request_id: id, run_id: "run-aaaaaaaa", codes: bad })).body.result, "bad_codes");
  }
  assert.equal((await state(db, { action: "notes", request_id: id, run_id: "run-bbbbbbbb", codes: ["android"] })).status, 409);
  assert.equal((await state(db, { action: "notes", request_id: id, run_id: "run-aaaaaaaa", codes: ["tz_defaulted", "pronouns_default", "tz_defaulted"] })).status, 200);
  assert.equal(provRow(db, id).notes, '["tz_defaulted","pronouns_default"]');
  const page = await adminGet(db);
  assert.ok(page.includes("set to America/New_York") && !page.includes("set to &quot;they&quot;") && page.includes("check before Send"), "the pronoun note is stored but not shown (Allen 11-23)");
});

test("F3 one reminder clock: mail.reminderDue passes every shared case (reminder_cases.json; the Mini runs the same file)", () => {
  const t = JSON.parse(readFileSync(path.join(ROOT, "functions/_dev/tests/reminder_cases.json"), "utf8"));
  const base = Date.parse(t.base);
  for (const c of t.cases) {
    const mails = c.mails.map((m) => ({ template: m.template, status: m.status, created_at: new Date(base + m.at_days * 86400000).toISOString() }));
    assert.equal(mail.reminderDue(c.request, mails, base + c.age * 86400000), c.due, c.name);
  }
});

test("F4 the day-10 link replaces a stored, never-sent day-3 link (at most one pending)", async () => {
  const db = makeD1(); const id = seed(db); inviteSent(db, id, 3.5);
  await link(db, { request_id: id, kind: "reminder3", link: LINK });
  await link(db, { request_id: id, kind: "reminder10", link: LINK2 });
  assert.deepEqual(linkRows(db).map((r) => r.kind), ["reminder10"]);
});

test("F5 the note codes are the same set as the Mini's invite_to_profile.py NOTE_CODES (when the sibling checkout is there)", () => {
  let src;
  for (const dir of ["beta-3.21-autoprovision", "daily-dashboard"]) {
    try { src = readFileSync(path.join(ROOT, "..", dir, "tools", "tenant", "invite_to_profile.py"), "utf8"); break; } catch { /* next */ }
  }
  if (!src) return;
  const py = [...src.match(/NOTE_CODES = \(([^)]*)\)/s)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(py, prov.NOTE_CODES);
});

test("PR1 CR-PROVREGION.2: migration 0014 is one nullable column on invite_provision and nothing else", () => {
  const sqlText = MIG("0014_placement.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
  assert.match(sqlText, /^ALTER TABLE invite_provision ADD COLUMN placement TEXT CHECK \(placement IS NULL OR length\(placement\) <= 120\);$/);
});

test("G2 migration: 0007 is the one and final shape (stopped + notes in the CREATE); no other migration touches these tables", () => {
  const m7 = MIG("0007_provisioning.sql");
  assert.match(m7, /state IN \('queued', 'building', 'ready', 'failed', 'waiting_cap', 'stopped'\)/);
  assert.match(m7, /\bnotes\s+TEXT CHECK/);
  const others = execFileSync("git", ["ls-files", "functions/_dev/migrations"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.endsWith("0007_provisioning.sql") && !f.endsWith("0014_placement.sql"));
  // CR-ONBOARDEDTAB.1 fix round 3: 0011 (a one-time data sweep) DELETEs rows from invite_provision / invite_links;
  // what stays forbidden is any SCHEMA statement on these tables outside 0007.
  for (const f of others) {
    const sqlText = readFileSync(path.join(ROOT, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.ok(!/\b(CREATE|ALTER|DROP)\b[^;]*\b(invite_provision|invite_links|provision_nonces)\b/i.test(sqlText), f);
  }
});

// ---------- Allen 11-23: one Send once the Mini's link is ready ----------
test("SD2 with a delivered link: one live Send, first in the card; the paste box and Copy always fold under 'Send it yourself instead' (CR-ADMINTABS.1); no Mark invited; every row button has a tooltip", async () => {
  const db = makeD1(); const id = seed(db);
  const fold = '<details class="other"><summary>Send it yourself instead</summary><div class="copy"';
  const before = await adminGet(db);
  assert.ok(before.includes('value="invited"') && before.includes(fold), "no link yet: Mark invited shown; the paste box is folded anyway");
  await link(db, { request_id: id, kind: "invite", link: LINK });
  const page = await adminGet(db);
  assert.ok(page.includes('value="send_invite_stored"'), "the Mini's Send is there");
  assert.ok(page.indexOf('value="send_invite_stored"') < page.indexOf('class="act">'), "first in the card, before the row buttons");
  assert.ok(page.includes(fold), "paste box + Copy folded");
  const inFold = page.slice(page.indexOf(fold)).split("</details>")[0];
  assert.ok(inFold.includes('value="send_invite"') && inFold.includes('class="copybtn"'), "the paste-box Send and Copy are inside the fold");
  assert.ok(!page.includes('value="invited"'), "no Mark invited when Send can do it");
  assert.ok(/value="not_now" type="submit" title="[^"]+"/.test(page) && /value="note" type="submit" title="Save the note only; nothing else changes."/.test(page), "tooltips");
});

test("SD3 the pronoun default note is never shown on the admin page (Allen 11-23); other notes still are", async () => {
  const db = makeD1(); const id = seed(db);
  await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" });
  await state(db, { action: "notes", request_id: id, run_id: "run-aaaaaaaa", codes: ["pronouns_default"] });
  let page = await adminGet(db);
  assert.ok(!page.includes("Pronouns are not on the form") && !page.includes("Set up with these defaults"), "only the pronoun code: no list at all");
  await state(db, { action: "notes", request_id: id, run_id: "run-aaaaaaaa", codes: ["plan_standard", "pronouns_default"] });
  page = await adminGet(db);
  assert.ok(page.includes("Plan Standard: built as a dedicated server") && !page.includes("Pronouns are not on the form"));
});

// ---------- CR-PROVREGION.2: the fallback placement ----------
const PLACED = async (placement, codes = ["placement_fallback"]) => {
  const db = makeD1(); const id = seed(db);
  await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" });
  const r = await state(db, { action: "notes", request_id: id, run_id: "run-aaaaaaaa", codes, placement });
  return { db, id, r };
};

test("PR2 placement_fallback is a known code and the note words exist for it", () => {
  assert.ok(prov.NOTE_CODES.includes("placement_fallback"));
  assert.ok(typeof prov.NOTE_WORDS.placement_fallback === "string" && prov.NOTE_WORDS.placement_fallback.length > 0);
  assert.ok(!/[\u2014\u2013]/.test(prov.NOTE_WORDS.placement_fallback));
});

test("PR3 a valid placement is stored beside the codes (usd int, or null)", async () => {
  let { db, id, r } = await PLACED({ region: "nyc1", size: "s-2vcpu-4gb", usd: 24 });
  assert.equal(r.status, 200);
  assert.equal(provRow(db, id).notes, '["placement_fallback"]');
  assert.deepEqual(JSON.parse(provRow(db, id).placement), { region: "nyc1", size: "s-2vcpu-4gb", usd: 24 });
  ({ db, id, r } = await PLACED({ region: "sfo3", size: "s-4vcpu-8gb", usd: null }));
  assert.deepEqual(JSON.parse(provRow(db, id).placement), { region: "sfo3", size: "s-4vcpu-8gb", usd: null });
});

test("PR4 an invalid placement is dropped silently and the codes are kept (200)", async () => {
  const bads = [
    { region: "NYC1", size: "s-2vcpu-4gb", usd: 24 }, { region: "ny", size: "s-2vcpu-4gb", usd: 24 },
    { region: "nyc1; drop", size: "s-2vcpu-4gb", usd: 24 }, { region: "nyc1", size: "S_2", usd: 24 },
    { region: "nyc1", size: "s-2vcpu-4gb", usd: 0 }, { region: "nyc1", size: "s-2vcpu-4gb", usd: 10000 },
    { region: "nyc1", size: "s-2vcpu-4gb", usd: 24.5 }, { region: "nyc1", size: "s-2vcpu-4gb", usd: "24" },
    { region: "nyc1", size: "s-2vcpu-4gb" }, { region: "nyc1", usd: 24 }, "nyc1", ["nyc1"], 7, null,
    { region: "nyc1", size: "a".repeat(41), usd: 24 }, { region: "abcdefghi", size: "s-2vcpu-4gb", usd: 24 },
  ];
  for (const bad of bads) {
    const { db, id, r } = await PLACED(bad);
    assert.equal(r.status, 200, JSON.stringify(bad));
    assert.equal(provRow(db, id).notes, '["placement_fallback"]', JSON.stringify(bad));
    assert.equal(provRow(db, id).placement, null, JSON.stringify(bad));
  }
  const { db, id } = await PLACED(undefined);
  assert.equal(provRow(db, id).placement, null);
});

test("PR5 the admin page shows the size sentence, or the region sentence when only the region changed", async () => {
  let { db } = await PLACED({ region: "nyc1", size: "s-4vcpu-8gb", usd: 28 });
  let page = await adminGet(db);
  assert.ok(page.includes("Built in NYC1 on the $28 size (the usual size wasn&#39;t available)."), page.match(/Built in[^<]*/)?.[0]);
  assert.ok(!page.includes("fallback region or size"), "the generic words give way to the sentence");
  ({ db } = await PLACED({ region: "sfo3", size: "s-2vcpu-4gb", usd: 24 }));
  page = await adminGet(db);
  assert.ok(page.includes("Built in SFO3 (the usual region wasn&#39;t available)."));
  ({ db } = await PLACED({ region: "nyc1", size: "s-4vcpu-8gb", usd: null }));
  assert.ok((await adminGet(db)).includes("Built in NYC1 on the s-4vcpu-8gb size (the usual size wasn&#39;t available)."));
  assert.ok(!/[\u2014\u2013]/.test(placementLineOf({ region: "nyc1", size: "s-4vcpu-8gb", usd: 28 })));
});
const placementLineOf = (p) => prov.placementLine(JSON.stringify(p));

test("PR6 a tampered stored placement is escaped or dropped, never raw HTML", async () => {
  const { db, id } = await PLACED({ region: "nyc1", size: "s-4vcpu-8gb", usd: 28 });
  db.raw.prepare("UPDATE invite_provision SET placement = ? WHERE request_id = ?").run('{"region":"<script>x</script>","size":"s-2vcpu-4gb","usd":1}', id);
  let page = await adminGet(db);
  assert.ok(!page.includes("<script>x"), "never raw");
  assert.ok(page.includes("Server:") && page.includes("fallback region or size"), "invalid row: the page still renders, with the generic words");
  db.raw.prepare("UPDATE invite_provision SET placement = ? WHERE request_id = ?").run("not json", id);
  page = await adminGet(db);
  assert.ok(page.includes("Server:") && page.includes("fallback region or size"));
  assert.equal(prov.placementLine('{"region":"nyc1","size":"s-2vcpu-4gb","usd":1}'), "Built in NYC1 (the usual region wasn't available).");
});

test("PR7 a stored note row with a code the page has no words for cannot break the page; no code, no placement line", async () => {
  const { db, id } = await PLACED({ region: "nyc1", size: "s-4vcpu-8gb", usd: 28 });
  db.raw.prepare("UPDATE invite_provision SET notes = ? WHERE request_id = ?").run('["brand_new_code","android",7,null,{"a":1}]', id);
  let page = await adminGet(db);
  assert.ok(page.includes("Server:") && page.includes("Android"), "known words still shown");
  assert.ok(!page.includes("brand_new_code") && !page.includes("Built in"), "unknown code skipped; placement shows only with the code");
  db.raw.prepare("UPDATE invite_provision SET notes = ? WHERE request_id = ?").run('{"not":"an array"}', id);
  assert.ok((await adminGet(db)).includes("Server:"));
});

test("PR8 before migration 0014 is applied: the page still lists the build and notes still store the codes", async () => {
  const db = makeD1(); const id = seed(db);
  db.raw.exec("ALTER TABLE invite_provision DROP COLUMN placement");
  await state(db, { action: "claim", request_id: id, run_id: "run-aaaaaaaa" });
  const r = await state(db, { action: "notes", request_id: id, run_id: "run-aaaaaaaa", codes: ["placement_fallback", "android"], placement: { region: "nyc1", size: "s-4vcpu-8gb", usd: 28 } });
  assert.equal(r.status, 200);
  assert.equal(provRow(db, id).notes, '["placement_fallback","android"]');
  const page = await adminGet(db);
  assert.ok(page.includes("building") && page.includes("fallback region or size"));
});
