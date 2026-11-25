// Tests for CR-INVITEREADY.1 (the "ready in 2–3 days" checkbox on bervo.ai/invite, migration 0013, the admin flag and
// sort, and the trim on Mark onboarded). D1 is node:sqlite with the real migrations; Access and Turnstile are mocked;
// every value is made up.
// Run: node --experimental-default-type=module --test functions/_dev/tests/ready.test.js   (Node 22+, no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as admin from "../../admin/invites.js";
import * as invite from "../../api/invite.js";
import { _resetAccessKeyCache, TRIMMED_COLUMNS, validateInvite } from "../../_lib/invites.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = (n) => readFileSync(path.join(ROOT, "functions/_dev/migrations", n), "utf8");
const NOW = Date.parse("2026-11-24T15:00:00Z");
const ORIGIN = "https://bervo.ai";
const TEAM = "bervo.cloudflareaccess.com";
const AUD = "aud-tag-test";
const BASE_MIGRATIONS = ["0001_invite_requests.sql", "0003_other_email.sql", "0004_computers.sql", "0005_heard_from.sql",
  "0006_drop_company_role.sql", "0002_invite_mail.sql", "0007_provisioning.sql", "0008_texts_mail.sql", "0009_signed_up.sql", "0010_onboarded_label.sql"];

function makeD1({ ready = true } = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const n of BASE_MIGRATIONS) sql.exec(MIG(n));
  if (ready) sql.exec(MIG("0013_ready_soon.sql"));
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    raw: sql,
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
function seed(db, { status = "new", ready = 0, created = "2026-11-20T10:00:00Z", first = "Pat" } = {}) {
  const hasCol = !!db.raw.prepare("SELECT 1 FROM pragma_table_info('invite_requests') WHERE name = 'ready_soon'").get();
  db.raw.prepare("INSERT INTO invite_requests (created_at, first_name, last_name, email, has_assistant, email_providers, phone, plan, " +
    "timezone, about, cohort, privacy_agreed_at, status, status_changed_at" + (hasCol ? ", ready_soon" : "") + ") " +
    "VALUES (?, ?, 'Sample', 'pat@example.com', 'yes', '[\"google\"]', 'android', 'private', 'America/Chicago', 'I run a small firm.', 'public', ?, ?, ?" + (hasCol ? ", ?" : "") + ")")
    .run(...[created, first, created, status, created, ...(hasCol ? [ready] : [])]);
  return Number(db.raw.prepare("SELECT max(id) AS m FROM invite_requests").get().m);
}
const ENV = (db) => ({ DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai",
  TURNSTILE_SECRET: "test-secret", RATE_LIMIT_SALT: "test-salt" });

let KEYS;
async function keys() {
  if (KEYS) return KEYS;
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  KEYS = { kp, jwk: { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "kid1" } };
  return KEYS;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function makeJwt() {
  const k = await keys();
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "kid1", typ: "JWT" }));
  const p = b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: "allen@bervo.ai", exp: Math.floor(NOW / 1000) + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const certsFetch = async () => Response.json({ keys: [(await keys()).jwk] });
async function adminGet(db, query = "") {
  _resetAccessKeyCache();
  const res = await admin.onRequestGet({ request: new Request(`${ORIGIN}/admin/invites${query}`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } }),
    env: ENV(db), fetchImpl: certsFetch, nowMs: NOW });
  return { status: res.status, body: await res.text() };
}
async function adminPost(db, fields, env = ENV(db)) {
  _resetAccessKeyCache();
  const res = await admin.onRequestPost({ request: new Request(`${ORIGIN}/admin/invites`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": await makeJwt(), Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams(fields).toString() }), env, fetchImpl: certsFetch, nowMs: NOW });
  return { status: res.status, location: res.headers.get("Location") };
}
const row = (db, id) => db.raw.prepare("SELECT * FROM invite_requests WHERE id = ?").get(id);
const ids = (body) => [...body.matchAll(/<article class="req" id="r(\d+)">/g)].map((m) => Number(m[1]));
const art = (body, id) => body.split(`<article class="req" id="r${id}">`)[1]?.split("</article>")[0] || "";
const FLAG = "Ready in 2–3 days";
const LABEL = "This price could work for me, and I'm ready to set up Bervo and start using it in the next 2–3 days.";

const turnstileOk = async () => Response.json({ success: true, action: "invite", hostname: "bervo.ai" });
function fields(over = {}) {
  return { first_name: "Pat", last_name: "Sample", email: "pat@example.com", has_assistant: "yes", email_provider: "google",
    computer: "mac", phone: "iphone", plan: "private", heard_from: "search", about: "I run a small firm.", privacy: "yes",
    tz: "America/Chicago", referral: "", website: "", t: String(NOW - 10000), "cf-turnstile-response": "good-token", ...over };
}
async function post(db, f) {
  const body = new URLSearchParams(f).toString();
  const request = new Request(`${ORIGIN}/api/invite`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded",
    "CF-Connecting-IP": "203.0.113.7", "Content-Length": String(body.length), Origin: ORIGIN } });
  const res = await invite.onRequestPost({ request, env: ENV(db), fetchImpl: turnstileOk, nowMs: NOW });
  return { status: res.status, location: res.headers.get("Location") };
}
const all = (db) => db.raw.prepare("SELECT * FROM invite_requests ORDER BY id").all();

test("R1 the form: one optional, unchecked checkbox with a real label, inside #fs-plan after the plan panels and before 'How did you hear'; exact words incl. the en dash", () => {
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  const m = html.match(/<label class="check ready-soon" for="ready_soon"><input type="checkbox" id="ready_soon" name="ready_soon" value="yes"> <span>([^<]*)<\/span><\/label>/);
  assert.ok(m, "the checkbox markup");
  assert.equal(m[1], LABEL);
  assert.ok(m[1].includes("2\u20133"), "en dash, not a hyphen");
  const tag = html.match(/<input type="checkbox" id="ready_soon"[^>]*>/)[0];
  assert.ok(!/required|checked/.test(tag), "optional and unchecked by default");
  const at = html.indexOf('id="ready_soon"');
  const plans = html.indexOf('<fieldset id="fs-plan">'), fsEnd = html.indexOf("</fieldset>", plans), heard = html.indexOf('for="heard_from"');
  assert.ok(plans < at && at < fsEnd && fsEnd < heard, "inside #fs-plan, before the heard-from question");
  assert.ok(html.indexOf('value="private"') < at, "after the plan panels");
  assert.equal((html.match(/id="ready_soon"/g) || []).length, 1);
  assert.ok(!/colou?r\s*:[^;]*#/.test(html.match(/\.ready-soon[^}]*}/g).join("")), "no hard-coded colour: it inherits the theme tokens");
  const js = readFileSync(path.join(ROOT, "invite.js"), "utf8");
  assert.ok(!/ready_soon/.test(js), "no script needed; an unticked box sends nothing");
});

test("R2 handler with the column: ticked -> 1, unticked -> 0, anything else -> 0; never a reason to refuse", async () => {
  const db = makeD1();
  assert.equal((await post(db, fields({ ready_soon: "yes" }))).location, "/invite-thanks");
  assert.equal((await post(db, fields({ email: "b@example.com" }))).location, "/invite-thanks");
  assert.equal((await post(db, fields({ email: "c@example.com", ready_soon: "on" }))).location, "/invite-thanks");
  assert.equal((await post(db, fields({ email: "d@example.com", ready_soon: "1" }))).location, "/invite-thanks");
  assert.deepEqual(all(db).map((r) => r.ready_soon), [1, 0, 0, 0]);
  assert.equal(validateInvite(new URLSearchParams(fields({ ready_soon: "yes" }))).value.ready_soon, 1);
  assert.equal(validateInvite(new URLSearchParams(fields())).value.ready_soon, 0);
});

test("R3 handler BEFORE the migration: ticked and unticked requests are both stored; no refusal", async () => {
  const db = makeD1({ ready: false });
  assert.ok(!db.raw.prepare("SELECT 1 FROM pragma_table_info('invite_requests') WHERE name = 'ready_soon'").get());
  assert.equal((await post(db, fields({ ready_soon: "yes" }))).location, "/invite-thanks");
  assert.equal((await post(db, fields({ email: "b@example.com" }))).location, "/invite-thanks");
  const rs = all(db);
  assert.equal(rs.length, 2);
  assert.deepEqual(rs.map((r) => r.email), ["pat@example.com", "b@example.com"]);
  assert.ok(rs.every((r) => !("ready_soon" in r)));
});

test("R4 a database error that is not 'no such column' still fails the request visibly (retry), nothing hidden", async () => {
  const db = makeD1();
  db.raw.exec("DROP TABLE invite_requests");
  const r = await post(db, fields({ ready_soon: "yes" }));
  assert.equal(r.location, "/invite?e=retry");
});

test("R5 migration 0013: one line, no comments, default 0 for old rows, only 0/1 or NULL accepted, safe on a table with rows", () => {
  const text = MIG("0013_ready_soon.sql");
  assert.equal(text.trim().split("\n").length, 1, "one line");
  assert.ok(!/--|\/\*/.test(text), "no comments (the D1 console)");
  const db = makeD1({ ready: false });
  const old = seed(db);
  db.raw.exec(text);
  assert.equal(row(db, old).ready_soon, 0, "existing requests read 0");
  const bad = () => db.raw.prepare("UPDATE invite_requests SET ready_soon = 2 WHERE id = ?").run(old);
  assert.throws(bad);
  db.raw.prepare("UPDATE invite_requests SET ready_soon = NULL WHERE id = ?").run(old);
  assert.throws(() => db.raw.exec(text), /duplicate column/);
});

test("R6 admin: flagged requests show 'Ready in 2–3 days' in the card, its summary line and the answers; others do not", async () => {
  const db = makeD1();
  const a = seed(db, { ready: 1 }), b = seed(db, { ready: 0 });
  const page = (await adminGet(db, "?show=new")).body;
  assert.ok(art(page, a).includes(`<span class="badge ready-flag">${FLAG}</span>`));
  assert.ok(art(page, a).match(/<p class="sum">[^]*?Ready in 2–3 days[^]*?<\/p>/));
  assert.ok(art(page, a).includes("<dt>Ready</dt>"));
  assert.ok(!art(page, b).includes(FLAG) && !art(page, b).includes("<dt>Ready</dt>"));
  assert.ok(/\.badge\{background:var\(--amber\);color:var\(--amber-ink\)/.test(page), "flag uses the contrast-checked amber tokens");
});

test("R7 admin sort: in EVERY tab flagged first (newest first), then the rest newest first; counts and membership unchanged", async () => {
  const db = makeD1();
  const made = {};
  for (const status of ["new", "approved", "not_now", "invited", "expired"]) {
    const o = [seed(db, { status, ready: 0 }), seed(db, { status, ready: 1 }), seed(db, { status, ready: 0 }), seed(db, { status, ready: 1 })];
    made[status] = o;   // ids ascend; newest = highest id
  }
  for (const [tab, status] of [["new", "new"], ["not_now", "not_now"], ["expired", "expired"]]) {
    const [a, b, c, d] = made[status];
    assert.deepEqual(ids((await adminGet(db, `?show=${tab}`)).body).filter((i) => made[status].includes(i)), [d, b, c, a], tab);
  }
  const everyTab = ["new", "approved", "built", "invited", "signed_up", "not_now", "expired", "all"];
  for (const tab of everyTab) {
    const got = ids((await adminGet(db, `?show=${tab}`)).body);
    const flags = got.map((i) => row(db, i).ready_soon);
    const firstZero = flags.indexOf(0);
    assert.ok(firstZero === -1 || !flags.slice(firstZero).includes(1), `${tab}: no flagged row after an unflagged one`);
    const sortedWithin = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] > v);
    assert.ok(sortedWithin(got.filter((i) => row(db, i).ready_soon === 1)) && sortedWithin(got.filter((i) => row(db, i).ready_soon === 0)), `${tab}: newest first inside each group`);
  }
  const allTab = ids((await adminGet(db, "?show=all")).body);
  assert.equal(allTab.length, 20);
});

test("R8 admin BEFORE the migration (no column): the page lists, sorts as today and shows no flag", async () => {
  const db = makeD1({ ready: false });
  const a = seed(db), b = seed(db);
  const page = (await adminGet(db, "?show=new")).body;
  assert.deepEqual(ids(page), [b, a]);
  assert.ok(!page.includes("<dt>Ready</dt>") && !page.includes(`">${FLAG}<`));
});

test("R9 Mark onboarded drops the answer with the other trimmed fields (0013 applied), and still works without the column", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", ready: 1, first: "Ashley" });
  db.raw.prepare("UPDATE invite_requests SET slug = 'reh1120', signed_up_at = '2026-11-22T10:00:00Z' WHERE id = ?").run(id);
  assert.equal(row(db, id).ready_soon, 1);
  assert.equal((await adminPost(db, { id: String(id), action: "claimed" })).status, 303);
  const r = row(db, id);
  assert.equal(r.status, "claimed");
  assert.equal(r.ready_soon, null, "dropped");
  assert.deepEqual([r.kept_name, r.kept_host], ["Ashley S", "reh1120"], "the kept fields still work with the new form");
  assert.equal(r.signed_up_at, null);
  const onboarded = (await adminGet(db, "?show=onboarded")).body;
  assert.ok(!onboarded.includes(FLAG), "a claimed request never shows the flag");
  const old = makeD1({ ready: false });
  const oid = seed(old, { status: "invited" });
  old.raw.prepare("UPDATE invite_requests SET slug = 'reh1121', signed_up_at = '2026-11-22T10:00:00Z' WHERE id = ?").run(oid);
  assert.equal((await adminPost(old, { id: String(oid), action: "claimed" })).location, `/admin/invites#r${oid}`);
  assert.equal(row(old, oid).status, "claimed");
});

test("R10 trim coverage: every trimmed invite field AND ready_soon are NULL on an onboarded row; TRIM_SET is unchanged so it works before 0013", () => {
  assert.ok(!TRIMMED_COLUMNS.includes("ready_soon"), "kept out of TRIM_SET on purpose (the batch erases it in its own, step-down piece)");
  const lib = readFileSync(path.join(ROOT, "functions/_lib/invites.js"), "utf8");
  assert.match(lib, /ONBOARD_ERASE_READY = "ready_soon = NULL"/);
  const adminSrc = readFileSync(path.join(ROOT, "functions/admin/invites.js"), "utf8");
  assert.match(adminSrc, /\$\{ONBOARD_ERASE_READY\}, \$\{ONBOARD_ERASE_SIGNED_UP\}/);
});
