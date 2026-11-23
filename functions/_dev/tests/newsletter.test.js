// Tests for CR-NEWSLETTER.1 (bervo.ai side): migration 0012, the relayed choice (/api/newsletter), Postmark's broadcast
// webhook (/api/newsletter-events), the one-click unsubscribe page and the admin Newsletter tab. D1 is node:sqlite with
// the real migrations; Access is mocked; every secret is made up.
// Run: node --experimental-default-type=module --test functions/_dev/tests/newsletter.test.js   (Node 22+, no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as api from "../../api/newsletter.js";
import * as events from "../../api/newsletter-events.js";
import * as unsubPage from "../../newsletter/unsubscribe.js";
import * as admin from "../../admin/newsletter.js";
import * as invitesAdmin from "../../admin/invites.js";
import * as nl from "../../_lib/newsletter.js";
import { _resetAccessKeyCache } from "../../_lib/invites.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = (n) => readFileSync(path.join(ROOT, "functions/_dev/migrations", n), "utf8");
const NOW = Date.parse("2026-11-23T15:00:00Z");
const ORIGIN = "https://bervo.ai";
const TEAM = "bervo.cloudflareaccess.com";
const AUD = "aud-tag-test";
const RELAY = ["fake", "relay", "secret", "0123456789abcdef0123"].join("-");
const UNSUB = ["fake", "unsub", "secret", "0123456789abcdef0123"].join("-");
const HOOK = ["fake", "hook", "secret", "0123"].join("-");
const BASE = ["0001_invite_requests.sql", "0003_other_email.sql", "0004_computers.sql", "0005_heard_from.sql",
  "0006_drop_company_role.sql", "0002_invite_mail.sql", "0007_provisioning.sql", "0008_texts_mail.sql",
  "0009_signed_up.sql", "0010_onboarded_label.sql"];

function makeD1({ newsletter = true } = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const n of BASE) sql.exec(MIG(n));
  if (newsletter) sql.exec(MIG("0012_newsletter.sql"));
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
const rows = (db) => db.raw.prepare("SELECT * FROM newsletter ORDER BY email").all().map((r) => ({ ...r }));
const ENV = (db, over = {}) => ({ DB: db, BERVO_MAIL_RELAY_SECRET: RELAY, NEWSLETTER_UNSUB_SECRET: UNSUB, POSTMARK_WEBHOOK_SECRET: HOOK,
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai", ...over });

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))).toString("hex");
}
async function relay(db, body, { secret = RELAY, ts = Math.floor(NOW / 1000), env = {}, logs = [] } = {}) {
  const raw = JSON.stringify(body);
  const res = await api.onRequestPost({ request: new Request(`${ORIGIN}/api/newsletter`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-bervo-relay-ts": String(ts), "x-bervo-relay-sig": await hmac(secret, `${ts}.${raw}`) }, body: raw }),
    env: ENV(db, env), nowMs: NOW, say: (l) => logs.push(l) });
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const SET = (email, subscribed, at = "2026-11-23T14:00:00Z") => ({ tenant: "zmich", action: "set", email, subscribed, at });

// ---------- migration ----------
test("N1 migration 0012: only email/status/source/opted_in_at/opted_out_at; a suppression row can hold nothing but email + opted_out_at; safe twice", () => {
  const db = makeD1();
  db.raw.exec(MIG("0012_newsletter.sql"));          // twice
  const cols = db.raw.prepare("PRAGMA table_info(newsletter)").all().map((c) => c.name);
  assert.deepEqual(cols, ["email", "status", "source", "opted_in_at", "opted_out_at"]);
  const ins = (s) => () => db.raw.exec(s);
  assert.throws(ins("INSERT INTO newsletter VALUES ('a@b.co','unsubscribed','setup',NULL,'2026-01-01')"), /CHECK/);
  assert.throws(ins("INSERT INTO newsletter VALUES ('a@b.co','unsubscribed',NULL,'2026-01-01','2026-01-01')"), /CHECK/);
  assert.throws(ins("INSERT INTO newsletter VALUES ('a@b.co','subscribed',NULL,'2026-01-01',NULL)"), /CHECK/);
  assert.throws(ins("INSERT INTO newsletter VALUES ('a@b.co','subscribed','invite','2026-01-01',NULL)"), /CHECK/);
  assert.throws(ins("INSERT INTO newsletter VALUES ('A@b.co','subscribed','setup','2026-01-01',NULL)"), /CHECK/);
  db.raw.exec("INSERT INTO newsletter VALUES ('a@b.co','subscribed','admin','2026-01-01',NULL)");
  db.raw.exec("INSERT INTO newsletter VALUES ('c@b.co','unsubscribed',NULL,NULL,'2026-01-01')");
  assert.equal(rows(db).length, 2);
  // the numbering: 0012 follows 0011 and nothing else claims 0012
  const names = readdirSync(path.join(ROOT, "functions/_dev/migrations"));
  assert.deepEqual(names.filter((n) => n.startsWith("0012")), ["0012_newsletter.sql"]);
});

// ---------- the relayed choice ----------
test("N2 relay: a signed opt-in stores email + source setup + opted_in_at; nothing else (no tenant); the address is never logged", async () => {
  const db = makeD1(); const logs = [];
  const r = await relay(db, SET("Pat@Example.com", true), { logs });
  assert.equal(r.status, 200); assert.equal(r.body.result, "subscribed");
  assert.deepEqual(rows(db), [{ email: "pat@example.com", status: "subscribed", source: "setup", opted_in_at: "2026-11-23T14:00:00.000Z", opted_out_at: null }]);
  assert.ok(logs.length && logs.every((l) => !/pat@|example\.com/i.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("zmich")));
  const s = await relay(db, { tenant: "zmich", action: "status", email: "pat@example.com" });
  assert.deepEqual([s.body.status, s.body.changed_at], ["subscribed", "2026-11-23T14:00:00.000Z"]);
});

test("N3 relay refuses: wrong secret, old timestamp, no secret (503), bad tenant/email/action/choice, missing table (503)", async () => {
  const db = makeD1();
  assert.equal((await relay(db, SET("p@x.co", true), { secret: RELAY + "x" })).status, 401);
  assert.equal((await relay(db, SET("p@x.co", true), { ts: Math.floor(NOW / 1000) - 600 })).status, 401);
  assert.equal((await relay(db, SET("p@x.co", true), { env: { BERVO_MAIL_RELAY_SECRET: "" } })).status, 503);
  assert.equal((await relay(db, { ...SET("p@x.co", true), tenant: "Bad Tenant" })).body.result, "bad_tenant");
  assert.equal((await relay(db, SET("not-an-address", true))).body.result, "bad_email");
  assert.equal((await relay(db, { ...SET("p@x.co", true), action: "delete" })).body.result, "bad_action");
  assert.equal((await relay(db, { ...SET("p@x.co", true), subscribed: "yes" })).body.result, "bad_choice");
  assert.equal(rows(db).length, 0);
  const bare = makeD1({ newsletter: false });
  assert.equal((await relay(bare, SET("p@x.co", true))).status, 503);
});

test("N4 ordering: an opt-out keeps only email + opted_out_at; a stale (older) retry never undoes it; the owner's newer choice re-subscribes", async () => {
  const db = makeD1();
  await relay(db, SET("p@x.co", true, "2026-11-20T10:00:00Z"));
  assert.equal((await relay(db, SET("p@x.co", false, "2026-11-21T10:00:00Z"))).body.result, "unsubscribed");
  assert.deepEqual(rows(db), [{ email: "p@x.co", status: "unsubscribed", source: null, opted_in_at: null, opted_out_at: "2026-11-21T10:00:00.000Z" }]);
  // the server's delayed retry of the old opt-in
  assert.equal((await relay(db, SET("p@x.co", true, "2026-11-20T10:00:00Z"))).body.result, "stale");
  assert.equal(rows(db)[0].status, "unsubscribed");
  // the owner turns it back on in Settings later
  assert.equal((await relay(db, SET("p@x.co", true, "2026-11-22T10:00:00Z"))).body.result, "subscribed");
  assert.equal(rows(db)[0].source, "setup");
  // a time in the future counts as now
  const r = await relay(db, SET("q@x.co", true, "2030-01-01T00:00:00Z"));
  assert.equal(r.body.changed_at, new Date(NOW).toISOString());
});

test("N5 a 'no' at setup for an address never on the list stores a suppression entry (address + date only)", async () => {
  const db = makeD1();
  assert.equal((await relay(db, SET("d@x.co", false))).body.result, "unsubscribed");
  assert.deepEqual(rows(db), [{ email: "d@x.co", status: "unsubscribed", source: null, opted_in_at: null, opted_out_at: "2026-11-23T14:00:00.000Z" }]);
  assert.equal((await relay(db, SET("d@x.co", false, "2026-11-23T14:30:00Z"))).body.result, "unchanged");
});

// ---------- Postmark broadcast webhook ----------
async function hook(db, rec, { auth = `Basic ${Buffer.from(`postmark:${HOOK}`).toString("base64")}`, logs = [] } = {}) {
  const raw = JSON.stringify(rec);
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  const res = await events.onRequestPost({ request: new Request(`${ORIGIN}/api/newsletter-events`, { method: "POST", headers, body: raw }),
    env: ENV(db), nowMs: NOW, say: (l) => logs.push(l) });
  return { status: res.status, body: await res.text() };
}

test("N6 webhook: SubscriptionChange (SuppressSending true) and SpamComplaint unsubscribe; reactivation and other records are ignored; Basic auth required", async () => {
  const db = makeD1();
  await relay(db, SET("a@x.co", true)); await relay(db, SET("b@x.co", true)); await relay(db, SET("c@x.co", true));
  assert.equal((await hook(db, { RecordType: "SubscriptionChange", Recipient: "a@x.co", SuppressSending: true, ChangedAt: "2026-11-23T14:30:00Z",
    SuppressionReason: "ManualSuppression", MessageStream: "broadcast" }, { auth: null })).status, 401);
  assert.equal((await hook(db, { RecordType: "SubscriptionChange", Recipient: "a@x.co", SuppressSending: true, ChangedAt: "2026-11-23T14:30:00Z",
    SuppressionReason: "ManualSuppression", MessageStream: "broadcast" }, { auth: `Basic ${Buffer.from("postmark:wrong").toString("base64")}` })).status, 401);
  const logs = [];
  let r = await hook(db, { RecordType: "SubscriptionChange", Recipient: "A@x.co", SuppressSending: true, ChangedAt: "2026-11-23T14:30:00Z",
    SuppressionReason: "ManualSuppression", MessageStream: "broadcast" }, { logs });
  assert.deepEqual([r.status, r.body], [200, "unsubscribed"]);
  r = await hook(db, { RecordType: "SpamComplaint", Email: "b@x.co", BouncedAt: "2026-11-23T14:31:00Z", MessageStream: "broadcast" }, { logs });
  assert.deepEqual([r.status, r.body], [200, "unsubscribed"]);
  r = await hook(db, { RecordType: "SubscriptionChange", Recipient: "c@x.co", SuppressSending: false, MessageStream: "broadcast" }, { logs });
  assert.equal(r.body, "ignored");
  r = await hook(db, { RecordType: "Delivery", Recipient: "c@x.co", MessageStream: "broadcast" }, { logs });
  assert.equal(r.body, "ignored");
  r = await hook(db, { RecordType: "SubscriptionChange", Recipient: "nobody@x.co", SuppressSending: true, MessageStream: "broadcast" }, { logs });
  assert.equal(r.body, "unknown");
  assert.deepEqual(rows(db).map((x) => [x.email, x.status, x.opted_out_at]), [
    ["a@x.co", "unsubscribed", "2026-11-23T14:30:00.000Z"], ["b@x.co", "unsubscribed", "2026-11-23T14:31:00.000Z"], ["c@x.co", "subscribed", null]]);
  assert.ok(!rows(db).some((x) => x.email === "nobody@x.co"), "an unknown address stores nothing");
  assert.ok(logs.every((l) => !/@x\.co/.test(l)), logs.join("\n"));
  // the server learns it on its next status ask
  const s = await relay(db, { tenant: "zmich", action: "status", email: "a@x.co" });
  assert.equal(s.body.status, "unsubscribed");
});

// ---------- one-click unsubscribe page ----------
async function unsubGet(db, t) {
  const res = await unsubPage.onRequestGet({ request: new Request(`${ORIGIN}/newsletter/unsubscribe?t=${t}`), env: ENV(db), nowMs: NOW });
  return { status: res.status, body: await res.text(), csp: res.headers.get("Content-Security-Policy") };
}
async function unsubPost(db, t, body = "confirm=1", env = {}) {
  const res = await unsubPage.onRequestPost({ request: new Request(`${ORIGIN}/newsletter/unsubscribe?t=${t}`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }), env: ENV(db, env), nowMs: NOW, say: () => {} });
  return { status: res.status, body: await res.text() };
}

test("N7 unsubscribe link: GET changes nothing; POST (button or RFC 8058 one-click) unsubscribes; the address is never in the link; same page for an unknown token", async () => {
  const db = makeD1();
  await relay(db, SET("p@x.co", true)); await relay(db, SET("q@x.co", true));
  const t = await nl.unsubToken(UNSUB, "p@x.co");
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.ok(!nl.unsubLink(ORIGIN, t).includes("p@x.co"));
  const g = await unsubGet(db, t);
  assert.equal(g.status, 200); assert.match(g.body, /<form method="post"/); assert.match(g.csp, /form-action 'self'/);
  assert.equal(rows(db).find((r) => r.email === "p@x.co").status, "subscribed");
  const p = await unsubPost(db, t, "List-Unsubscribe=One-Click");
  assert.equal(p.status, 200); assert.match(p.body, /You're unsubscribed/);
  assert.equal(rows(db).find((r) => r.email === "p@x.co").status, "unsubscribed");
  assert.equal(rows(db).find((r) => r.email === "q@x.co").status, "subscribed");
  const unknown = await unsubPost(db, "0".repeat(32));
  assert.equal(unknown.body, p.body, "an unknown token answers exactly like a real one");
  assert.equal((await unsubGet(db, "nope")).status, 400);
  assert.equal((await unsubPost(db, t, "confirm=1", { NEWSLETTER_UNSUB_SECRET: "" })).status, 503);
  const bare = makeD1({ newsletter: false });
  const nb = await unsubPost(bare, t);
  assert.equal(nb.status, 503); assert.doesNotMatch(nb.body, /You're unsubscribed/);
});

// ---------- admin Newsletter tab ----------
let KEYS;
async function keys() {
  if (KEYS) return KEYS;
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  KEYS = { kp, jwk: { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "kid1" } };
  return KEYS;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function makeJwt(email = "allen@bervo.ai") {
  const k = await keys();
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "kid1", typ: "JWT" }));
  const p = b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email, exp: Math.floor(NOW / 1000) + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k.kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const certsFetch = async () => Response.json({ keys: [(await keys()).jwk] });
async function adminGet(db, query = "", { jwt, env = {} } = {}) {
  _resetAccessKeyCache();
  const headers = {};
  if (jwt !== null) headers["Cf-Access-Jwt-Assertion"] = jwt || await makeJwt();
  const res = await admin.onRequestGet({ request: new Request(`${ORIGIN}/admin/newsletter${query}`, { headers }), env: ENV(db, env), fetchImpl: certsFetch, nowMs: NOW });
  return { status: res.status, body: await res.text(), headers: res.headers };
}
async function adminPost(db, fields, { origin = ORIGIN } = {}) {
  _resetAccessKeyCache();
  const res = await admin.onRequestPost({ request: new Request(`${ORIGIN}/admin/newsletter`, { method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await makeJwt(), Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString() }), env: ENV(db), fetchImpl: certsFetch, nowMs: NOW });
  return { status: res.status, location: res.headers.get("Location") };
}

test("N8 admin: Access required; count + list; Add (source admin) refuses an unsubscribed address; Unsubscribe keeps a suppression entry; CSRF refused", async () => {
  const db = makeD1();
  assert.equal((await adminGet(db, "", { jwt: null })).status, 403);
  assert.equal((await adminGet(db, "", { jwt: await makeJwt("someone@else.com") })).status, 403);
  await relay(db, SET("p@x.co", true)); await relay(db, SET("gone@x.co", false));
  let g = await adminGet(db);
  assert.equal(g.status, 200); assert.match(g.body, /<b>1 subscribed<\/b> · 1 unsubscribed/);
  assert.match(g.body, /their setup choice/);
  assert.equal((await adminPost(db, { action: "add", email: "Friend@X.co" })).location, "/admin/newsletter?msg=added");
  assert.deepEqual(rows(db).find((r) => r.email === "friend@x.co"), { email: "friend@x.co", status: "subscribed", source: "admin", opted_in_at: new Date(NOW).toISOString(), opted_out_at: null });
  assert.equal((await adminPost(db, { action: "add", email: "friend@x.co" })).location, "/admin/newsletter?msg=already");
  assert.equal((await adminPost(db, { action: "add", email: "gone@x.co" })).location, "/admin/newsletter?msg=suppressed");
  assert.equal(rows(db).find((r) => r.email === "gone@x.co").status, "unsubscribed");
  assert.equal((await adminPost(db, { action: "add", email: "nope" })).location, "/admin/newsletter?msg=bad");
  assert.equal((await adminPost(db, { action: "unsubscribe", email: "friend@x.co" })).location, "/admin/newsletter?msg=removed");
  assert.deepEqual(rows(db).find((r) => r.email === "friend@x.co"), { email: "friend@x.co", status: "unsubscribed", source: null, opted_in_at: null, opted_out_at: new Date(NOW).toISOString() });
  assert.equal((await adminPost(db, { action: "add", email: "z@x.co" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(rows(db).some((r) => r.email === "z@x.co"), false);
  g = await adminGet(db);
  assert.match(g.body, /<b>1 subscribed<\/b> · 2 unsubscribed/);
});

test("N9 admin export: CSV of subscribed only with a working unsubscribe link each; refused without the unsubscribe secret; formula-safe", async () => {
  const db = makeD1();
  await relay(db, SET("p@x.co", true)); await relay(db, SET("gone@x.co", false));
  await adminPost(db, { action: "add", email: "friend@x.co" });
  const r = await adminGet(db, "?export=csv");
  assert.equal(r.status, 200); assert.match(r.headers.get("Content-Type"), /text\/csv/);
  assert.match(r.headers.get("Content-Disposition"), /attachment; filename="bervo-newsletter-2026-11-23\.csv"/);
  const lines = r.body.trim().split("\r\n");
  assert.equal(lines[0], "email,source,opted_in_at,unsubscribe_url");
  assert.equal(lines.length, 3);
  assert.ok(!r.body.includes("gone@x.co"));
  const pLine = lines.find((l) => l.startsWith("p@x.co,"));
  const link = pLine.split(",")[3];
  assert.ok(link.startsWith(`${ORIGIN}/newsletter/unsubscribe?t=`));
  await unsubPost(db, new URL(link).searchParams.get("t"));
  assert.equal(rows(db).find((x) => x.email === "p@x.co").status, "unsubscribed");
  const no = await adminGet(db, "?export=csv", { env: { NEWSLETTER_UNSUB_SECRET: "" } });
  assert.equal(no.status, 303);
  const csv = await nl.exportCsv([{ email: "=cmd@x.co", status: "subscribed", source: "admin", opted_in_at: "t" }], UNSUB, ORIGIN);
  assert.match(csv, /^email.*\r\n'=cmd@x\.co,/);
});

test("N10 admin page before migration 0012 says so (no crash); the invites page links to the Newsletter tab", async () => {
  const bare = makeD1({ newsletter: false });
  const g = await adminGet(bare);
  assert.equal(g.status, 200); assert.match(g.body, /0012_newsletter\.sql/);
  _resetAccessKeyCache();
  const res = await invitesAdmin.onRequestGet({ request: new Request(`${ORIGIN}/admin/invites`, { headers: { "Cf-Access-Jwt-Assertion": await makeJwt() } }),
    env: ENV(bare), fetchImpl: certsFetch, nowMs: NOW });
  assert.match(await res.text(), /<a href="\/admin\/newsletter">Newsletter<\/a>/);
});

test("N11 invite-request data never feeds the list: no newsletter file reads invite_requests, and the invite handlers never touch newsletter", () => {
  const files = ["functions/_lib/newsletter.js", "functions/api/newsletter.js", "functions/api/newsletter-events.js",
    "functions/newsletter/unsubscribe.js", "functions/admin/newsletter.js"];
  for (const f of files) assert.doesNotMatch(readFileSync(path.join(ROOT, f), "utf8"), /invite_requests|kept_email/, f);
  for (const f of ["functions/api/invite.js", "functions/admin/invites.js", "functions/_lib/invites.js", "functions/_lib/provision.js"])
    assert.doesNotMatch(readFileSync(path.join(ROOT, f), "utf8"), /FROM newsletter|INTO newsletter|UPDATE newsletter/, f);
});
