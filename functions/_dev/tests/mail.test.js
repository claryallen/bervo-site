// Tests for the account-email sender (CR-WELCOMEEMAIL.1, Postmark): functions/_lib/mail.js, the admin page's Send,
// and the Postmark webhook. Postmark is mocked (no network, no real key; every key below is a made-up string).
// Run: node --experimental-default-type=module --test functions/_dev/tests/mail.test.js   (Node 22+, no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as admin from "../../admin/invites.js";
import * as hook from "../../api/postmark-events.js";
import * as relay from "../../api/account-mail.js";
import { _resetAccessKeyCache, pruneOld } from "../../_lib/invites.js";
import * as mail from "../../_lib/mail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA1 = readFileSync(path.join(ROOT, "functions/_dev/migrations/0001_invite_requests.sql"), "utf8");
const SCHEMA2 = readFileSync(path.join(ROOT, "functions/_dev/migrations/0002_invite_mail.sql"), "utf8");
const NOW = Date.parse("2026-11-12T15:00:00Z");
const ORIGIN = "https://bervo.ai";
const TEAM = "bervo.cloudflareaccess.com";
const AUD = "aud-tag-test";
const FAKE_TOKEN = "fake-postmark-token-for-tests";
const HOOK_SECRET = "fake-webhook-secret-0123456789";
const LINK = "https://zz-test.bervo.ai/set-password?t=" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const ADDRESS = "pat@example.com";

function makeD1({ mailTable = true } = {}) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(SCHEMA1);
  if (mailTable) sql.exec(SCHEMA2);
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    raw: sql,
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
function seed(db, { status = "approved", email = ADDRESS, first = "Pat" } = {}) {
  db.raw.prepare("INSERT INTO invite_requests (created_at, first_name, last_name, email, company, role, has_assistant, " +
    "email_providers, phone, plan, timezone, about, cohort, privacy_agreed_at, status, status_changed_at, approved_at) " +
    "VALUES (?, ?, 'Sample', ?, 'Sample Co', 'Owner', 'yes', '[\"google\"]', 'iphone', 'private', 'America/Chicago', " +
    "'I run a small firm.', 'public', ?, ?, ?, ?)").run("2026-11-11T10:00:00Z", first, email, "2026-11-11T10:00:00Z", status,
    "2026-11-11T11:00:00Z", status === "new" ? null : "2026-11-11T11:00:00Z");
  return Number(db.raw.prepare("SELECT max(id) AS m FROM invite_requests").get().m);
}
const mailRows = (db) => db.raw.prepare("SELECT * FROM invite_mail ORDER BY id").all();
const request = (db, id) => db.raw.prepare("SELECT * FROM invite_requests WHERE id = ?").get(id);
function dumpDb(db) {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  return JSON.stringify(tables.map((t) => db.raw.prepare(`SELECT * FROM "${t}"`).all()));
}

// ---------- a Postmark stand-in ----------
function postmark(mode = "ok", calls = []) {
  let n = 0;
  return async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (String(url) !== "https://api.postmarkapp.com/email") throw new Error("unexpected fetch " + url);
    if (mode === "network") throw new Error("down");
    if (mode === "inactive") return Response.json({ ErrorCode: 406, Message: "inactive" }, { status: 422 });
    if (mode === "badtoken") return Response.json({ ErrorCode: 10, Message: "bad token" }, { status: 401 });
    if (mode === "garbage") return new Response("<html>", { status: 200 });
    n += 1;
    return Response.json({ To: JSON.parse(init.body).To, SubmittedAt: "2026-11-12T15:00:00Z",
      MessageID: `0a129aee-e1cd-480d-b08d-4f48548ff4${String(n).padStart(2, "0")}`, ErrorCode: 0, Message: "OK" });
  };
}
const MAIL_ENV = (db, over = {}) => ({ DB: db, POSTMARK_SERVER_TOKEN: FAKE_TOKEN, MAIL_REPLY_TO: "allen@bervo.ai",
  RATE_LIMIT_SALT: "test-salt", ...over });

// ---------- Access token helpers (as invite.test.js) ----------
let KEYS;
async function keys() {
  if (KEYS) return KEYS;
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  KEYS = { kp, jwk: { ...jwk, kid: "kid1" } };
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
const certsFetch = async (url) => {
  if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error("unexpected fetch " + url);
  return Response.json({ keys: [(await keys()).jwk] });
};
const ADMIN_ENV = (db, over = {}) => ({ ...MAIL_ENV(db), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai", ...over });

async function adminGet(db, { env, query = "" } = {}) {
  _resetAccessKeyCache();
  const res = await admin.onRequestGet({ request: new Request(`${ORIGIN}/admin/invites${query}`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } }),
    env: env || ADMIN_ENV(db), fetchImpl: certsFetch, nowMs: NOW });
  return { status: res.status, body: await res.text() };
}
async function adminPost(db, fields, { env, mailFetch, logs = [], origin = ORIGIN, site = "same-origin" } = {}) {
  _resetAccessKeyCache();
  const headers = { "Content-Type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": await makeJwt() };
  if (origin) headers.Origin = origin;
  if (site) headers["Sec-Fetch-Site"] = site;
  const res = await admin.onRequestPost({ request: new Request(`${ORIGIN}/admin/invites`, { method: "POST", headers, body: new URLSearchParams(fields).toString() }),
    env: env || ADMIN_ENV(db), fetchImpl: certsFetch, mailFetch: mailFetch || postmark(), say: (l) => logs.push(l), nowMs: NOW });
  return { status: res.status, location: res.headers.get("Location") };
}
async function hookPost(db, rec, { auth = `postmark:${HOOK_SECRET}`, env, logs = [] } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = "Basic " + Buffer.from(auth).toString("base64");
  const res = await hook.onRequestPost({ request: new Request(`${ORIGIN}/api/postmark-events`, { method: "POST", headers, body: JSON.stringify(rec) }),
    env: env || { DB: db, POSTMARK_WEBHOOK_SECRET: HOOK_SECRET }, say: (l) => logs.push(l), nowMs: NOW + 60000 });
  return { status: res.status, body: await res.text() };
}

// ---------- the module ----------
test("M1 render: the invite is Allen's approved §5 text with the name and link filled in; bad fields refused", () => {
  const { subject, text } = mail.render("invite", { first_name: "Pat", link: LINK });
  assert.equal(subject, "Your Bervo invite");
  assert.ok(text.startsWith("Hi Pat,\n") && text.includes("\n" + LINK + "\n") && text.endsWith("\nAllen"));
  assert.ok(!/\{[a-z_]+\}/.test(text));
  assert.equal(admin.INVITE_EMAIL_TEMPLATE, mail.TEMPLATES.invite.body, "the Copy fallback uses the same words");
  const bad = [
    "http://zz-test.bervo.ai/set-password?t=" + "x".repeat(43),
    "https://evil.example/set-password?t=" + "x".repeat(43),
    "https://bervo.ai.evil.example/set-password?t=" + "x".repeat(43),
    "https://zz-test.bervo.ai/login?t=" + "x".repeat(43),
    LINK + "\nBcc: someone@example.com",
    LINK + "&next=https://evil.example",
    "https://zz-test.bervo.ai/set-password?t=short",
  ];
  for (const link of bad) assert.throws(() => mail.render("invite", { first_name: "Pat", link }), { code: "bad_field:link" }, link);
  assert.throws(() => mail.render("invite", { first_name: "Pat\nBcc: x", link: LINK }), { code: "bad_field:first_name" });
  assert.throws(() => mail.render("invite", { first_name: "Pat‮", link: LINK }), { code: "bad_field:first_name" });
  assert.throws(() => mail.render("nope", {}), { code: "unknown_template" });
});

test("M2 Allen's approved words (NEXT_USER_WORDS_V1 §A, 11-11), word for word; no placeholder left; [GTM] still refused", () => {
  const inv = mail.render("invite", { first_name: "Pat", link: LINK }).text;
  assert.equal(inv, `Hi Pat,\n\nThanks for requesting an invite to Bervo. I'm glad to have you.\n\nHere's your personal setup link:\n${LINK}\n\n` +
    "You'll need about 20 minutes, your phone, and the sign-in for the email account you want Bervo to read.\n\n" +
    "It works once and stays open for 14 days. Setup takes you through connecting your email, choosing how much history to load, " +
    "adding your AI API key and texting the Bervo line. Stopped partway? Sign in with your email and password and you'll pick up " +
    "where you left off.\n\nAny questions, just reply to this email.\n\nAllen");
  const r3 = mail.render("reminder_day3", { first_name: "Pat", link: LINK, expiry_date: "November 25" });
  assert.equal(r3.subject, "Your Bervo setup link");
  assert.equal(r3.text, `Hi Pat,\n\nJust a reminder that your Bervo setup is waiting. Here's a fresh link (the one in my earlier email no longer works):\n${LINK}\n\n` +
    "It stays open until November 25. If now isn't a good time, reply and I'll send a new one when you're ready.\n\nAllen");
  const r10 = mail.render("reminder_day10", { first_name: "Pat", link: LINK, expiry_date: "December 2" });
  assert.equal(r10.subject, "Still want to set up Bervo?");
  assert.equal(r10.text, `Hi Pat,\n\nHere's a new setup link, in case the earlier ones got buried:\n${LINK}\n\n` +
    "It stays open until December 2. If you'd rather start later, reply and I'll send one then.\n\nAllen");
  const ld = mail.render("loaded", { first_name: "Pat", start_date: "October 12", dashboard_link: "https://zz-test.bervo.ai/" });
  assert.equal(ld.subject, "Bervo is ready");
  assert.equal(ld.text, "Hi Pat,\n\nBervo has read your email back to October 12, and your dashboard is ready:\nhttps://zz-test.bervo.ai/\n\n" +
    "Start with Today. It shows your briefing, your schedule and anything waiting on you. Your first morning brief will be on your " +
    "dashboard tomorrow morning.\n\nIf anything looks wrong, use Feedback at the top of the dashboard, or text Bervo.\n\nAllen");
  for (const t of Object.values(mail.TEMPLATES)) assert.ok(!(t.subject + t.body).includes("[GTM"));
  assert.throws(() => mail.render("loaded", { first_name: "Pat", start_date: "October 12", dashboard_link: "https://zz-test.bervo.ai/x" }), { code: "bad_field:dashboard_link" });
  assert.throws(() => mail.render("loaded", { first_name: "Pat", start_date: "Oct\n12", dashboard_link: "https://zz-test.bervo.ai/" }), { code: "bad_field:start_date" });
  const saved = mail.TEMPLATES.loaded.subject;
  mail.TEMPLATES.loaded.subject = "[GTM] draft";
  try { assert.throws(() => mail.render("loaded", { first_name: "Pat", start_date: "October 12", dashboard_link: "https://zz-test.bervo.ai/" }), { code: "placeholder" }); }
  finally { mail.TEMPLATES.loaded.subject = saved; }
});

test("M3 send: Postmark gets the right message; D1 and the log hold no address, link, body or key", async () => {
  const db = makeD1();
  const id = seed(db);
  const calls = [], logs = [];
  const r = await mail.sendTemplate(MAIL_ENV(db), { template: "invite", to: "Pat@Example.com", fields: { first_name: "Pat", link: LINK },
    requestId: id, nowMs: NOW, fetchImpl: postmark("ok", calls), say: (l) => logs.push(l) });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.init.headers["X-Postmark-Server-Token"], FAKE_TOKEN);
  assert.deepEqual(Object.keys(c.body).sort(), ["From", "MessageStream", "ReplyTo", "Subject", "Tag", "TextBody", "To", "TrackLinks", "TrackOpens"]);
  assert.equal(c.body.From, "Bervo <hello@bervo.ai>");
  assert.equal(c.body.ReplyTo, "allen@bervo.ai");
  assert.equal(c.body.To, ADDRESS);
  assert.equal(c.body.MessageStream, "outbound");
  assert.equal(c.body.TrackOpens, false);
  assert.equal(c.body.TrackLinks, "None");
  assert.ok(!("HtmlBody" in c.body), "plain text only: no HTML, so no pixel");
  const rows = mailRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "sent");
  assert.equal(rows[0].template, "invite");
  assert.match(rows[0].address_hash, /^[0-9a-f]{16}$/);
  assert.equal(rows[0].address_hash, await mail.addressHash("test-salt", ADDRESS));
  assert.equal(rows[0].message_id, r.message_id);
  // (the seeded request row itself holds the address by design; the email record and the log must not)
  const kept = JSON.stringify(rows) + "\n" + logs.join("\n");
  for (const secret of [ADDRESS, LINK.split("t=")[1], FAKE_TOKEN, "Thanks for requesting", "Your Bervo invite", "Pat"])
    assert.ok(!kept.toLowerCase().includes(secret.toLowerCase()), secret);
  assert.ok(!dumpDb(db).includes(LINK.split("t=")[1]) && !dumpDb(db).includes(FAKE_TOKEN));
  assert.equal(logs.length, 1);
  const line = JSON.parse(logs[0]);
  assert.deepEqual(Object.keys(line), ["event", "template", "to_hash", "message_id", "result", "error_code"]);
  assert.equal(line.result, "sent");
  assert.ok(!logs[0].includes("@") && !logs[0].includes("bervo.ai") && !logs[0].includes("Allen"));
});

test("M4 sending off (no key / no reply-to / no salt): refused before any network call, nothing recorded", async () => {
  for (const over of [{ POSTMARK_SERVER_TOKEN: "" }, { POSTMARK_SERVER_TOKEN: undefined }, { MAIL_REPLY_TO: "" }, { MAIL_REPLY_TO: "not an address" }, { RATE_LIMIT_SALT: "" }]) {
    const db = makeD1();
    const id = seed(db);
    const calls = [];
    await assert.rejects(mail.sendTemplate(MAIL_ENV(db, over), { template: "invite", to: ADDRESS, fields: { first_name: "Pat", link: LINK },
      requestId: id, nowMs: NOW, fetchImpl: postmark("ok", calls), say: () => {} }), { code: "off" });
    assert.equal(calls.length, 0);
    assert.equal(mailRows(db).length, 0);
    assert.ok(mail.sendingOff(MAIL_ENV(db, over)));
  }
});

test("M5 Postmark refuses or is down: a failed row with the code; nothing claims it was sent; no retry", async () => {
  for (const [mode, code] of [["inactive", 406], ["badtoken", 10], ["network", -1], ["garbage", 200]]) {
    const db = makeD1();
    const id = seed(db);
    const calls = [];
    const r = await mail.sendTemplate(MAIL_ENV(db), { template: "invite", to: ADDRESS, fields: { first_name: "Pat", link: LINK },
      requestId: id, nowMs: NOW, fetchImpl: postmark(mode, calls), say: () => {} });
    assert.equal(r.ok, false, mode);
    assert.equal(calls.length, 1, "one try only");
    const rows = mailRows(db);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].error_code, code);
    assert.equal(rows[0].message_id, null);
  }
});

// ---------- the admin page ----------
test("M6 Send on the admin page: sends once, marks the request invited, shows 'sent'; the link is kept nowhere", async () => {
  const db = makeD1();
  const id = seed(db);
  const calls = [], logs = [];
  const r = await adminPost(db, { id: String(id), action: "send_invite", link: LINK }, { mailFetch: postmark("ok", calls), logs });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/admin/invites?sent=ok&r=${id}#r${id}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.To, ADDRESS);
  assert.ok(calls[0].body.TextBody.includes(LINK));
  const req = request(db, id);
  assert.equal(req.status, "invited");
  assert.equal(req.invited_at, new Date(NOW).toISOString());
  assert.ok(!dumpDb(db).includes(LINK.split("t=")[1]), "the link is not in D1");
  assert.ok(!logs.join("").includes(LINK.split("t=")[1]) && !logs.join("").includes(ADDRESS));
  const page = await adminGet(db, { query: `?sent=ok&r=${id}` });
  assert.equal(page.status, 200);
  assert.match(page.body, /Invite email: <span class="ms ms-sent">sent<\/span>/);
  assert.ok(page.body.includes("Invite email sent."));
  assert.ok(!page.body.includes(LINK.split("t=")[1]), "the link is not echoed back");
  // a second Send (e.g. a new link) is allowed while invited and is recorded as a second email
  await adminPost(db, { id: String(id), action: "send_invite", link: LINK }, { mailFetch: postmark("ok", calls) });
  assert.equal(calls.length, 2);
  assert.equal(mailRows(db).length, 2);
});

test("M7 Send is offered and Copy stays: sending on -> Send button + Copy; sending off -> no Send, an 'off' note, Copy", async () => {
  const db = makeD1();
  seed(db);
  const on = await adminGet(db);
  assert.ok(on.body.includes('value="send_invite"') && on.body.includes("Copy invite email"));
  const off = await adminGet(db, { env: ADMIN_ENV(db, { POSTMARK_SERVER_TOKEN: "" }) });
  assert.equal(off.status, 200);
  assert.ok(!off.body.includes('value="send_invite"'));
  assert.ok(off.body.includes("Sending is off (the Postmark key is not set)"));
  assert.ok(off.body.includes("Copy invite email") && off.body.includes("const TEMPLATE ="), "Copy still works with no key");
  assert.equal((off.body.match(/<script/g) || []).length, 1);
});

test("M8 Send refused: sending off, a bad link, a request not approved, a cross-site post — nothing goes to Postmark", async () => {
  const db = makeD1();
  const id = seed(db);
  const calls = [];
  let r = await adminPost(db, { id: String(id), action: "send_invite", link: LINK }, { env: ADMIN_ENV(db, { POSTMARK_SERVER_TOKEN: "" }), mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=off&r=${id}#r${id}`);
  r = await adminPost(db, { id: String(id), action: "send_invite", link: "https://evil.example/set-password?t=" + "x".repeat(43) }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=link&r=${id}#r${id}`);
  const fresh = seed(db, { status: "new" });
  r = await adminPost(db, { id: String(fresh), action: "send_invite", link: LINK }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites#r${fresh}`);
  r = await adminPost(db, { id: String(id), action: "send_invite", link: LINK }, { mailFetch: postmark("ok", calls), origin: "https://evil.example", site: "cross-site" });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(mailRows(db).length, 0);
  assert.equal(request(db, id).status, "approved");
});

test("M9 Postmark refuses on Send: 'failed' shown, the request stays approved, Copy remains", async () => {
  const db = makeD1();
  const id = seed(db);
  const r = await adminPost(db, { id: String(id), action: "send_invite", link: LINK }, { mailFetch: postmark("inactive") });
  assert.equal(r.location, `/admin/invites?sent=failed&r=${id}#r${id}`);
  assert.equal(request(db, id).status, "approved");
  const page = await adminGet(db, { query: `?sent=failed&r=${id}` });
  assert.match(page.body, /ms-failed">failed<\/span>.*code 406/);
  assert.ok(page.body.includes("Copy invite email"));
});

test("M10 before Allen runs the 0002 migration: the page still works and Send fails closed", async () => {
  const db = makeD1({ mailTable: false });
  const id = seed(db);
  const page = await adminGet(db);
  assert.equal(page.status, 200);
  const calls = [];
  const r = await adminPost(db, { id: String(id), action: "send_invite", link: LINK }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=failed&r=${id}#r${id}`);
  assert.equal(request(db, id).status, "approved", "not marked invited");
  await pruneOld(db, NOW);
});

// ---------- the webhook ----------
test("M11 webhook auth: no secret set -> 503; missing or wrong Basic auth -> 401; nothing changes", async () => {
  const db = makeD1();
  const id = seed(db);
  await mail.sendTemplate(MAIL_ENV(db), { template: "invite", to: ADDRESS, fields: { first_name: "Pat", link: LINK }, requestId: id, nowMs: NOW, fetchImpl: postmark(), say: () => {} });
  const mid = mailRows(db)[0].message_id;
  const rec = { RecordType: "Bounce", MessageID: mid, Type: "HardBounce", Email: ADDRESS };
  assert.equal((await hookPost(db, rec, { env: { DB: db } })).status, 503);
  assert.equal((await hookPost(db, rec, { env: { DB: db, POSTMARK_WEBHOOK_SECRET: "short" } })).status, 503);
  assert.equal((await hookPost(db, rec, { auth: null })).status, 401);
  assert.equal((await hookPost(db, rec, { auth: "postmark:wrong-secret-0123456789" })).status, 401);
  assert.equal((await hookPost(db, rec, { auth: `someone:${HOOK_SECRET}` })).status, 401);
  assert.equal(mailRows(db)[0].status, "sent");
});

test("M12 webhook: delivered, bounced (shown on the admin page, stops reminders), complained; never downgraded; payload not kept", async () => {
  const db = makeD1();
  const id = seed(db);
  await adminPost(db, { id: String(id), action: "send_invite", link: LINK });
  const mid = mailRows(db)[0].message_id;
  const logs = [];
  assert.equal((await hookPost(db, { RecordType: "Delivery", MessageID: mid, Recipient: ADDRESS }, { logs })).body, "applied");
  assert.equal(mailRows(db)[0].status, "delivered");
  const bounce = { RecordType: "Bounce", MessageID: mid, Type: "HardBounce", TypeCode: 1, Email: ADDRESS, Subject: "Your Bervo invite",
    Description: "The server was unable to deliver your message", Details: "smtp; 550 5.1.1 user unknown " + ADDRESS };
  assert.equal((await hookPost(db, bounce, { logs })).body, "applied");
  let row = mailRows(db)[0];
  assert.equal(row.status, "bounced");
  assert.equal(row.detail, "HardBounce");
  assert.equal(row.event_at, new Date(NOW + 60000).toISOString());
  assert.equal((await hookPost(db, { RecordType: "Delivery", MessageID: mid }, { logs })).body, "ignored", "a late Delivery does not undo a bounce");
  assert.equal(mailRows(db)[0].status, "bounced");
  const page = await adminGet(db);
  assert.match(page.body, /ms-bounced">bounced \(HardBounce\)<\/span>/);
  assert.equal(mail.reminderDue(request(db, id), mailRows(db), NOW + 4 * 86400000), null, "a bounce stops reminders");
  assert.equal((await hookPost(db, { RecordType: "SpamComplaint", MessageID: mid, Email: ADDRESS }, { logs })).body, "applied");
  assert.equal(mailRows(db)[0].status, "complained");
  // unknown message id / record type / junk: 200 and ignored (Postmark does not retry), nothing changes
  assert.equal((await hookPost(db, { RecordType: "Delivery", MessageID: "ffffffff-0000-0000-0000-000000000000" })).body, "ignored");
  assert.equal((await hookPost(db, { RecordType: "Open", MessageID: mid })).body, "ignored");
  assert.equal((await hookPost(db, { RecordType: "Bounce", MessageID: "'; DROP TABLE invite_mail; --" })).body, "ignored");
  const stored = JSON.stringify(mailRows(db)) + logs.join("\n");   // the request row holds the address by design
  for (const s of [ADDRESS, "550 5.1.1", "unable to deliver"]) assert.ok(!stored.includes(s), s);
});

// ---------- reminders (decision 3 pending: the rule only) ----------
test("M13 reminderDue: day 3, day 10, once each; never after a bounce/complaint, a claim, the 14 days, or with no accepted invite", () => {
  const day = 86400000;
  const sent = "2026-11-12T15:00:00.000Z";
  const req = { status: "invited" };
  const inv = [{ template: "invite", status: "delivered", created_at: sent }];
  assert.equal(mail.reminderDue(req, inv, NOW + 2.9 * day), null);
  assert.equal(mail.reminderDue(req, inv, NOW + 3 * day), "reminder_day3");
  const after3 = [...inv, { template: "reminder_day3", status: "sent", created_at: "2026-11-15T15:00:00.000Z" }];
  assert.equal(mail.reminderDue(req, after3, NOW + 5 * day), null);
  assert.equal(mail.reminderDue(req, after3, NOW + 10 * day), "reminder_day10");
  const after10 = [...after3, { template: "reminder_day10", status: "sent", created_at: "2026-11-22T15:00:00.000Z" }];
  assert.equal(mail.reminderDue(req, after10, NOW + 11 * day), null);
  assert.equal(mail.reminderDue(req, inv, NOW + 14 * day), null, "the link has run out");
  assert.equal(mail.reminderDue({ status: "claimed" }, inv, NOW + 3 * day), null);
  assert.equal(mail.reminderDue(req, [{ template: "invite", status: "failed", created_at: sent }], NOW + 3 * day), null);
  assert.equal(mail.reminderDue(req, [{ ...inv[0], status: "bounced" }], NOW + 3 * day), null);
  assert.equal(mail.reminderDue(req, [...inv, { template: "reminder_day3", status: "complained", created_at: sent }], NOW + 10 * day), null);
});

// ---------- retention ----------
test("M14 retention: Mark claimed clears the email rows' address hash; a deleted request takes its email rows with it", async () => {
  const db = makeD1();
  const id = seed(db);
  await adminPost(db, { id: String(id), action: "send_invite", link: LINK });
  assert.ok(mailRows(db)[0].address_hash);
  await adminPost(db, { id: String(id), action: "claimed" });
  assert.equal(request(db, id).status, "claimed");
  assert.equal(mailRows(db)[0].address_hash, null);
  assert.equal(mailRows(db)[0].template, "invite");
  const other = seed(db, { email: "lee@example.com", first: "Lee" });
  await adminPost(db, { id: String(other), action: "send_invite", link: LINK });
  db.raw.prepare("UPDATE invite_requests SET status = 'expired', status_changed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(other);
  await pruneOld(db, NOW);
  assert.equal(request(db, other), undefined);
  assert.deepEqual(mailRows(db).map((m) => m.request_id), [id]);
});

// ---------- no key in the repository ----------
test("M15 no Postmark key or webhook secret is in any tracked file; no wrangler.toml", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(!files.some((f) => path.basename(f) === "wrangler.toml"));
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const f of files) {
    if (/\.(pkg|png|jpg|ico|pdf|woff2?)$/i.test(f)) continue;
    let text;
    try { text = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    for (const ln of text.split("\n")) {
      if (/(POSTMARK_(SERVER_TOKEN|WEBHOOK_SECRET)|BERVO_MAIL_RELAY_SECRET)\s*[=:]\s*["']?[A-Za-z0-9-]{8,}/.test(ln) && !f.endsWith("mail.test.js"))
        assert.fail(`${f}: a value next to a mail secret`);
      if (/postmark/i.test(ln) && uuid.test(ln) && !f.endsWith("mail.test.js")) assert.fail(`${f}: a UUID on a Postmark line`);
      if (/X-Postmark-Server-Token["']?\s*:\s*["'][^"']/.test(ln)) assert.fail(`${f}: a literal token header`);
    }
  }
  const src = readFileSync(path.join(ROOT, "functions/_lib/mail.js"), "utf8");
  assert.match(src, /"X-Postmark-Server-Token": String\(env\.POSTMARK_SERVER_TOKEN\)\.trim\(\)/, "the key is read from the Pages secret only");
});

// ---------- reminders on the admin page (Allen 11-11: a button when due; a fresh link) ----------
async function invitedAt(db, id, whenMs) {
  await adminPost(db, { id: String(id), action: "send_invite", link: LINK });
  db.raw.prepare("UPDATE invite_mail SET created_at = ? WHERE request_id = ?").run(new Date(whenMs).toISOString(), id);
}

test("M16 reminder button: hidden before day 3; shown on day 3 with the fresh-link instructions; sends day 3 then day 10 once each", async () => {
  const db = makeD1();
  const id = seed(db);
  const day = 86400000;
  await invitedAt(db, id, NOW - 2 * day);
  assert.ok(!(await adminGet(db)).body.includes('value="send_reminder"'), "not due on day 2");
  const calls = [];
  let r = await adminPost(db, { id: String(id), action: "send_reminder", link: LINK }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=notdue&r=${id}#r${id}`);
  assert.equal(calls.length, 0);
  db.raw.prepare("UPDATE invite_mail SET created_at = ? WHERE request_id = ?").run(new Date(NOW - 3 * day).toISOString(), id);
  const page = await adminGet(db);
  assert.ok(page.body.includes("Day-3 reminder due.") && page.body.includes("owner_invite_link.py") && page.body.includes("the earlier one stops working"));
  assert.ok(page.body.includes('value="send_reminder"'));
  const FRESH = LINK.replace("A1b2", "Z9y8");
  r = await adminPost(db, { id: String(id), action: "send_reminder", link: FRESH }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=reminder&r=${id}#r${id}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.Subject, "Your Bervo setup link");
  assert.ok(calls[0].body.TextBody.includes(FRESH) && calls[0].body.TextBody.includes("no longer works"));
  assert.ok(calls[0].body.TextBody.includes("It stays open until November 25."), "now + 13 days, request time zone (America/Chicago)");
  assert.equal(calls[0].body.To, ADDRESS);
  // a second press the same day: not due any more
  r = await adminPost(db, { id: String(id), action: "send_reminder", link: FRESH }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=notdue&r=${id}#r${id}`);
  // day 10
  db.raw.prepare("UPDATE invite_mail SET created_at = ? WHERE template = 'invite'").run(new Date(NOW - 10 * day).toISOString());
  db.raw.prepare("UPDATE invite_mail SET created_at = ? WHERE template = 'reminder_day3'").run(new Date(NOW - 7 * day).toISOString());
  assert.ok((await adminGet(db)).body.includes("Day-10 reminder due."));
  r = await adminPost(db, { id: String(id), action: "send_reminder", link: FRESH }, { mailFetch: postmark("ok", calls) });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.Subject, "Still want to set up Bervo?");
  assert.ok(!dumpDb(db).includes(FRESH.split("t=")[1]), "the fresh link is not stored");
  assert.deepEqual(mailRows(db).map((m) => m.template), ["invite", "reminder_day3", "reminder_day10"]);
});

test("M17 reminder refused: bounced invite, claimed request, bad link, sending off; nothing reaches Postmark", async () => {
  const day = 86400000;
  const calls = [];
  const db = makeD1();
  const id = seed(db);
  await invitedAt(db, id, NOW - 3 * day);
  db.raw.prepare("UPDATE invite_mail SET status = 'bounced', detail = 'HardBounce'").run();
  assert.ok(!(await adminGet(db)).body.includes('value="send_reminder"'), "a bounce stops reminders");
  let r = await adminPost(db, { id: String(id), action: "send_reminder", link: LINK }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=notdue&r=${id}#r${id}`);
  db.raw.prepare("UPDATE invite_mail SET status = 'delivered', detail = NULL").run();
  r = await adminPost(db, { id: String(id), action: "send_reminder", link: "https://evil.example/set-password?t=" + "x".repeat(43) }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=link&r=${id}#r${id}`);
  r = await adminPost(db, { id: String(id), action: "send_reminder", link: LINK }, { env: ADMIN_ENV(db, { POSTMARK_SERVER_TOKEN: "" }), mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=off&r=${id}#r${id}`);
  await adminPost(db, { id: String(id), action: "claimed" });
  r = await adminPost(db, { id: String(id), action: "send_reminder", link: LINK }, { mailFetch: postmark("ok", calls) });
  assert.equal(r.location, `/admin/invites?sent=notdue&r=${id}#r${id}`);
  assert.equal(calls.length, 0);
});

test("M18 reminderExpiryDate: now + 13 days in the request's zone (UTC when unknown or invalid)", () => {
  const t = Date.parse("2026-11-12T03:30:00Z");                      // still Nov 11 in Chicago
  assert.equal(mail.reminderExpiryDate(t, "America/Chicago"), "November 24");
  assert.equal(mail.reminderExpiryDate(t, null), "November 25");
  assert.equal(mail.reminderExpiryDate(t, "Not/AZone"), "November 25");
});

// ---------- the relay: router -> bervo.ai (Allen 11-11 Q1 (a)) ----------
const RELAY_SECRET = "fake-relay-secret-0123456789abcdef0123";
async function signed(body, { secret = RELAY_SECRET, ts = Math.floor(NOW / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${raw}`))).toString("hex");
  return { raw, headers: { "Content-Type": "application/json", "x-bervo-relay-ts": String(ts), "x-bervo-relay-sig": sig } };
}
const LOADED = (over = {}) => ({ tenant: "zz-test", template: "loaded", to: "Pat@Example.com",
  fields: { first_name: "Pat", start_date: "October 12", dashboard_link: "https://zz-test.bervo.ai/" }, ...over });
async function relayPost(db, req, { env, calls = [], logs = [] } = {}) {
  const res = await relay.onRequestPost({ request: new Request(`${ORIGIN}/api/account-mail`, { method: "POST", headers: req.headers, body: req.raw }),
    env: env || MAIL_ENV(db, { BERVO_MAIL_RELAY_SECRET: RELAY_SECRET }), mailFetch: postmark("ok", calls), say: (l) => logs.push(l), nowMs: NOW });
  return { status: res.status, body: await res.json() };
}

test("M19 relay: a signed 'loaded' request sends the approved email once per server; the record is the server's, not a request's", async () => {
  const db = makeD1();
  const calls = [], logs = [];
  let r = await relayPost(db, await signed(LOADED()), { calls, logs });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.To, ADDRESS);
  assert.equal(calls[0].body.Subject, "Bervo is ready");
  assert.ok(calls[0].body.TextBody.includes("back to October 12") && calls[0].body.TextBody.includes("https://zz-test.bervo.ai/"));
  const row = mailRows(db)[0];
  assert.equal(row.tenant, "zz-test");
  assert.equal(row.request_id, null);
  assert.equal(row.template, "loaded");
  r = await relayPost(db, await signed(LOADED()), { calls, logs });
  assert.equal(r.body.result, "already_sent");
  assert.equal(calls.length, 1, "once per server");
  const kept = JSON.stringify(mailRows(db)) + logs.join("\n");
  for (const x of [ADDRESS, "Pat", "October 12"]) assert.ok(!kept.toLowerCase().includes(x.toLowerCase()), x);
  // a different server is its own once
  await relayPost(db, await signed(LOADED({ tenant: "zz-other" })), { calls });
  assert.equal(calls.length, 2);
  // shown on the admin page
  const page = await adminGet(db);
  assert.match(page.body, /Account emails by server/);
  assert.match(page.body, /zz-test · &quot;You&#39;re loaded&quot; email: <span class="ms ms-sent">sent/);
});

test("M20 relay refused: no secret, bad/old/forged signature, other templates, bad fields, sending off; failed send can be retried", async () => {
  const db = makeD1();
  const calls = [];
  const env = MAIL_ENV(db, { BERVO_MAIL_RELAY_SECRET: RELAY_SECRET });
  assert.equal((await relayPost(db, await signed(LOADED()), { env: MAIL_ENV(db), calls })).status, 503);
  assert.equal((await relayPost(db, await signed(LOADED()), { env: MAIL_ENV(db, { BERVO_MAIL_RELAY_SECRET: "short" }), calls })).status, 503);
  assert.equal((await relayPost(db, await signed(LOADED(), { secret: "x".repeat(40) }), { env, calls })).status, 401);
  assert.equal((await relayPost(db, await signed(LOADED(), { ts: Math.floor(NOW / 1000) - 301 }), { env, calls })).status, 401);
  const tampered = await signed(LOADED());
  tampered.raw = tampered.raw.replace("zz-test\"", "zz-evil\"");
  assert.equal((await relayPost(db, tampered, { env, calls })).status, 401, "the tenant is covered by the signature");
  assert.equal((await relayPost(db, { raw: JSON.stringify(LOADED()), headers: { "Content-Type": "application/json" } }, { env, calls })).status, 401);
  assert.equal((await relayPost(db, await signed(LOADED({ template: "invite" })), { env, calls })).body.result, "bad_template");
  assert.equal((await relayPost(db, await signed(LOADED({ tenant: "Bad Tenant" })), { env, calls })).body.result, "bad_tenant");
  assert.equal((await relayPost(db, await signed(LOADED({ to: "not-an-address" })), { env, calls })).body.result, "bad_address");
  assert.equal((await relayPost(db, await signed(LOADED({ fields: { first_name: "Pat", start_date: "October 12", dashboard_link: "https://evil.example/" } })), { env, calls })).body.result, "bad_field:dashboard_link");
  assert.equal((await relayPost(db, await signed(LOADED()), { env: { ...env, POSTMARK_SERVER_TOKEN: "" }, calls })).body.result, "sending_off");
  assert.equal(calls.length, 0);
  // Postmark refuses once (a 'failed' row); the next relay try sends
  const res = await relay.onRequestPost({ request: new Request(`${ORIGIN}/api/account-mail`, { method: "POST", ...(await (async () => { const x = await signed(LOADED()); return { headers: x.headers, body: x.raw }; })()) }),
    env, mailFetch: postmark("inactive"), say: () => {}, nowMs: NOW });
  assert.equal(res.status, 502);
  const ok = await relayPost(db, await signed(LOADED()), { env, calls });
  assert.equal(ok.body.result, "sent");
  assert.deepEqual(mailRows(db).map((m) => m.status), ["failed", "sent"]);
});

test("M21 retention: a server's 'loaded' row keeps its hash 90 days, then only the once-only record stays", async () => {
  const db = makeD1();
  await relayPost(db, await signed(LOADED()));
  db.raw.prepare("UPDATE invite_mail SET created_at = '2026-08-01T00:00:00Z'").run();
  await pruneOld(db, NOW);
  const row = mailRows(db)[0];
  assert.equal(row.address_hash, null);
  assert.equal(row.tenant, "zz-test");
  const calls = [];
  assert.equal((await relayPost(db, await signed(LOADED()), { calls })).body.result, "already_sent");
  assert.equal(calls.length, 0);
});
