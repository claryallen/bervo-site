// Tests for the invite form handler and the admin page (CR-INVITEFLOW.1 part A, spec "Proving it" 1–2).
// Run: node --experimental-default-type=module --test site-dev/tests/   (Node 22+, no packages needed)
// D1 is mocked over node:sqlite with the real schema in site-dev/migrations/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as invite from "../../functions/api/invite.js";
import * as config from "../../functions/api/invite-config.js";
import * as admin from "../../functions/admin/invites.js";
import { _resetAccessKeyCache, ABOUT_MAX, escapeHtml, validateInvite } from "../../functions-lib/invites.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA = readFileSync(path.join(ROOT, "site-dev/migrations/0001_invite_requests.sql"), "utf8");
const NOW = Date.parse("2026-11-12T15:00:00Z");
const ORIGIN = "https://bervo.ai";
const TEAM = "bervo.cloudflareaccess.com";
const AUD = "aud-tag-test";

// ---------- a D1 stand-in over node:sqlite ----------
function makeD1() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(SCHEMA);
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const db = {
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
  return db;
}
const rows = (db) => db.raw.prepare("SELECT * FROM invite_requests ORDER BY id").all();

// ---------- Turnstile stand-in ----------
function turnstileFetch(mode = "pass", calls = []) {
  return async (url, init) => {
    calls.push(String(url));
    if (!String(url).startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) throw new Error("unexpected fetch " + url);
    if (mode === "network") throw new Error("down");
    if (mode === "http500") return new Response("x", { status: 500 });
    const token = init.body.get("response");
    const ok = mode === "pass" && token === "good-token";
    return Response.json({ success: ok, action: mode === "wrong-action" ? "login" : "invite" });
  };
}

const ENV = (db) => ({ DB: db, TURNSTILE_SECRET: "test-secret", RATE_LIMIT_SALT: "test-salt", TURNSTILE_SITE_KEY: "1x00000000000000000000AA" });

function validFields(over = {}) {
  return {
    first_name: "Pat", last_name: "Sample", email: "Pat@Example.com", company: "Sample Co", role: "Owner",
    has_assistant: "yes", email_provider: "google", phone: "iphone", about: "I run a small firm.",
    privacy: "yes", tz: "America/Chicago", referral: "", website: "", t: String(NOW - 10000),
    "cf-turnstile-response": "good-token", ...over,
  };
}

async function post(db, fields, { ip = "203.0.113.7", origin = ORIGIN, mode = "pass", env, nowMs = NOW, calls } = {}) {
  const body = new URLSearchParams(fields).toString();
  const headers = { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip, "Content-Length": String(body.length) };
  if (origin) headers.Origin = origin;
  const request = new Request(`${ORIGIN}/api/invite`, { method: "POST", headers, body });
  const res = await invite.onRequestPost({ request, env: env || ENV(db), fetchImpl: turnstileFetch(mode, calls || []), nowMs });
  return { status: res.status, location: res.headers.get("Location") };
}

// ---------- form: Proving it 1 ----------
test("valid request stores one row and shows the thank-you page", async () => {
  const db = makeD1();
  const r = await post(db, validFields());
  assert.equal(r.status, 303);
  assert.equal(r.location, "/invite-thanks");
  const all = rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].email, "pat@example.com");
  assert.equal(all[0].status, "new");
  assert.equal(all[0].cohort, "public");
  assert.equal(all[0].timezone, "America/Chicago");
  assert.equal(all[0].referral, null);
  assert.equal(all[0].about, "I run a small firm.");
});

test("honeypot: same thank-you, nothing stored", async () => {
  const db = makeD1();
  const r = await post(db, validFields({ website: "http://spam.example" }));
  assert.equal(r.location, "/invite-thanks");
  assert.equal(rows(db).length, 0);
});

test("too fast (< 2 s), missing or future fill time: same thank-you, nothing stored", async () => {
  const db = makeD1();
  for (const t of [String(NOW - 500), "", "abc", String(NOW + 120000)]) {
    const r = await post(db, validFields({ t }), { ip: "198.51.100." + t.length });
    assert.equal(r.location, "/invite-thanks", `t=${t}`);
  }
  assert.equal(rows(db).length, 0);
});

test("sixth request in a day from one address: same thank-you, not stored; another address unaffected; next day resets", async () => {
  const db = makeD1();
  for (let i = 0; i < 5; i++) assert.equal((await post(db, validFields({ first_name: "P" + i }))).location, "/invite-thanks");
  assert.equal(rows(db).length, 5);
  assert.equal((await post(db, validFields({ first_name: "Sixth" }))).location, "/invite-thanks");
  assert.equal(rows(db).length, 5, "sixth not stored");
  await post(db, validFields({ first_name: "Other" }), { ip: "198.51.100.9" });
  assert.equal(rows(db).length, 6, "a different address still gets in");
  await post(db, validFields({ first_name: "Tomorrow", t: String(NOW + 86400000 - 10000) }), { nowMs: NOW + 86400000 });
  assert.equal(rows(db).length, 7, "the allowance resets the next UTC day");
});

test("the IP address is never stored; only salted day hashes, dropped after 7 days", async () => {
  const db = makeD1();
  db.raw.prepare("INSERT INTO invite_rate (ip_hash, day, count) VALUES ('old', '2026-11-04', 3)").run();
  db.raw.prepare("INSERT INTO invite_rate (ip_hash, day, count) VALUES ('keep', '2026-11-06', 1)").run();
  await post(db, validFields(), { ip: "203.0.113.77" });
  const rate = db.raw.prepare("SELECT * FROM invite_rate ORDER BY day").all();
  assert.deepEqual(rate.map((r) => r.ip_hash).filter((h) => h === "old"), [], "8-day-old hash deleted");
  assert.ok(rate.some((r) => r.ip_hash === "keep"), "6-day-old hash kept");
  const dump = JSON.stringify(db.raw.prepare("SELECT * FROM invite_rate").all()) + JSON.stringify(rows(db));
  assert.ok(!dump.includes("203.0.113.77"), "raw IP not in any table");
  assert.ok(rate.some((r) => /^[0-9a-f]{64}$/.test(r.ip_hash) && r.day === "2026-11-12"));
});

test("Turnstile fail or wrong action: same thank-you, nothing stored; Turnstile unreachable: back to the form", async () => {
  const db = makeD1();
  assert.equal((await post(db, validFields({ "cf-turnstile-response": "forged" }))).location, "/invite-thanks");
  assert.equal((await post(db, validFields({ "cf-turnstile-response": "" }), { ip: "198.51.100.1" })).location, "/invite-thanks");
  assert.equal((await post(db, validFields(), { mode: "wrong-action", ip: "198.51.100.2" })).location, "/invite-thanks");
  assert.equal((await post(db, validFields(), { mode: "network", ip: "198.51.100.3" })).location, "/invite?e=retry");
  assert.equal((await post(db, validFields(), { mode: "http500", ip: "198.51.100.4" })).location, "/invite?e=retry");
  assert.equal(rows(db).length, 0);
});

test("about box: required, exactly 1,000 characters accepted, 1,001 refused", async () => {
  const db = makeD1();
  assert.equal(ABOUT_MAX, 1000);
  assert.equal((await post(db, validFields({ about: "a".repeat(1000) }), { ip: "198.51.100.10" })).location, "/invite-thanks");
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].about.length, 1000);
  assert.equal((await post(db, validFields({ about: "a".repeat(1001) }), { ip: "198.51.100.11" })).location, "/invite?e=invalid");
  assert.equal((await post(db, validFields({ about: "   " }), { ip: "198.51.100.12" })).location, "/invite?e=invalid");
  assert.equal(rows(db).length, 1);
  // the page enforces the same limit client-side
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.match(html, /<textarea id="about" name="about" required maxlength="1000"/);
});

test("validation: bad email, unknown choice, missing privacy box -> back to the form, nothing stored", async () => {
  const db = makeD1();
  const bad = [{ email: "not-an-email" }, { email: "a@b" }, { email_provider: "yahoo" }, { phone: "nokia" },
    { has_assistant: "maybe" }, { privacy: "" }, { first_name: "" }, { company: "x".repeat(121) }];
  let i = 0;
  for (const b of bad) {
    const r = await post(db, validFields(b), { ip: "198.51.100." + (20 + i++) });
    assert.equal(r.location, "/invite?e=invalid", JSON.stringify(b));
  }
  assert.equal(rows(db).length, 0);
});

test("missing configuration -> 'not available', nothing stored; config endpoint 503", async () => {
  const db = makeD1();
  const r = await post(db, validFields(), { env: { DB: db, TURNSTILE_SECRET: "", RATE_LIMIT_SALT: "s" } });
  assert.equal(r.location, "/invite?e=unavailable");
  assert.equal(rows(db).length, 0);
  const c1 = await config.onRequestGet({ env: { DB: db } });
  assert.equal(c1.status, 503);
  const c2 = await config.onRequestGet({ env: ENV(db) });
  assert.equal(c2.status, 200);
  assert.deepEqual(await c2.json(), { site_key: "1x00000000000000000000AA" });
});

test("cross-site post (foreign Origin): same thank-you, nothing stored", async () => {
  const db = makeD1();
  assert.equal((await post(db, validFields(), { origin: "https://evil.example" })).location, "/invite-thanks");
  assert.equal(rows(db).length, 0);
});

test("non-POST methods get 405", async () => {
  const res = await invite.onRequest({ request: new Request(`${ORIGIN}/api/invite`), env: {} });
  assert.equal(res.status, 405);
});

test("referral is allowlisted: from=allen stored, anything else dropped", async () => {
  const db = makeD1();
  await post(db, validFields({ referral: "allen" }), { ip: "198.51.100.40" });
  await post(db, validFields({ referral: "ALLEN" }), { ip: "198.51.100.41" });
  await post(db, validFields({ referral: "bob" }), { ip: "198.51.100.42" });
  await post(db, validFields({ referral: "<script>alert(1)</script>" }), { ip: "198.51.100.43" });
  assert.deepEqual(rows(db).map((r) => r.referral), ["allen", "allen", null, null]);
});

test("time zone: kept when valid, dropped (not refused) when not", async () => {
  const db = makeD1();
  await post(db, validFields({ tz: "Europe/London" }), { ip: "198.51.100.50" });
  await post(db, validFields({ tz: "Not/AZone" }), { ip: "198.51.100.51" });
  await post(db, validFields({ tz: "<script>" }), { ip: "198.51.100.52" });
  assert.deepEqual(rows(db).map((r) => r.timezone), ["Europe/London", null, null]);
});

// ---------- admin: Access token helpers ----------
let KEYS;
async function keys() {
  if (KEYS) return KEYS;
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  KEYS = { kp, other, jwk: { ...jwk, kid: "kid1" } };
  return KEYS;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function makeJwt(claims, { signWith } = {}) {
  const k = await keys();
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "kid1", typ: "JWT" }));
  const p = b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: "allen@bervo.ai", exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000), ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (signWith || k.kp).privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
function certsFetch(calls = []) {
  return async (url) => {
    calls.push(String(url));
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error("unexpected fetch " + url);
    return Response.json({ keys: [(await keys()).jwk] });
  };
}
const ADMIN_ENV = (db) => ({ DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai" });

async function adminGet(db, { jwt, env, query = "", calls } = {}) {
  _resetAccessKeyCache();
  const headers = jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {};
  const res = await admin.onRequestGet({ request: new Request(`${ORIGIN}/admin/invites${query}`, { headers }), env: env || ADMIN_ENV(db), fetchImpl: certsFetch(calls), nowMs: NOW });
  return { status: res.status, body: await res.text(), headers: res.headers };
}
async function adminPost(db, fields, { jwt, origin = ORIGIN, site = "same-origin", calls } = {}) {
  _resetAccessKeyCache();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  if (origin) headers.Origin = origin;
  if (site) headers["Sec-Fetch-Site"] = site;
  const res = await admin.onRequestPost({ request: new Request(`${ORIGIN}/admin/invites`, { method: "POST", headers, body: new URLSearchParams(fields).toString() }), env: ADMIN_ENV(db), fetchImpl: certsFetch(calls), nowMs: NOW });
  return { status: res.status, location: res.headers.get("Location"), body: await res.text() };
}

async function seeded() {
  const db = makeD1();
  await post(db, validFields({ first_name: "Ann", referral: "allen" }), { ip: "198.51.100.60" });
  await post(db, validFields({ first_name: "Ben" }), { ip: "198.51.100.61" });
  return db;
}

// ---------- admin: Proving it 2 ----------
test("admin without an Access token -> 403 and no request data in the page", async () => {
  const db = await seeded();
  const r = await adminGet(db);
  assert.equal(r.status, 403);
  assert.ok(!r.body.includes("Ann") && !r.body.includes("example.com"));
  const p = await adminPost(db, { id: "1", action: "approve" });
  assert.equal(p.status, 403);
  assert.equal(rows(db)[0].status, "new");
});

test("admin with a forged, expired, wrong-audience, wrong-issuer or non-admin token -> 403", async () => {
  const db = await seeded();
  const k = await keys();
  const cases = [
    await makeJwt({}, { signWith: k.other }),
    await makeJwt({ exp: Math.floor(NOW / 1000) - 10 }),
    await makeJwt({ aud: ["someone-else"] }),
    await makeJwt({ iss: "https://evil.cloudflareaccess.com" }),
    await makeJwt({ email: "someone@example.com" }),
    "not.a.jwt",
  ];
  for (const jwt of cases) {
    const r = await adminGet(db, { jwt });
    assert.equal(r.status, 403, jwt.slice(0, 30));
    assert.ok(!r.body.includes("Ann"));
  }
});

test("admin not configured -> 503 (fails closed), even with a valid token", async () => {
  const db = await seeded();
  const jwt = await makeJwt({});
  for (const env of [{ DB: db }, { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { DB: db, ACCESS_TEAM_DOMAIN: "evil.example", ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai" }]) {
    const r = await adminGet(db, { jwt, env });
    assert.equal(r.status, 503);
    assert.ok(!r.body.includes("Ann"));
  }
});

test("admin with Allen's token: lists requests, full about text, personal-invite mark, strict headers", async () => {
  const db = await seeded();
  const r = await adminGet(db, { jwt: await makeJwt({}) });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("Ann") && r.body.includes("Ben"));
  assert.equal((r.body.match(/Personal invite/g) || []).length, 1);
  assert.ok(r.body.includes("I run a small firm."));
  const csp = r.headers.get("Content-Security-Policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  const long = makeD1();
  await post(long, validFields({ about: "z".repeat(1000) }), { ip: "198.51.100.62" });
  const r2 = await adminGet(long, { jwt: await makeJwt({}) });
  assert.ok(r2.body.includes("z".repeat(1000)), "about shown in full");
});

test("escaping: <script> in every field is stored as text and shown escaped on the admin page", async () => {
  const db = makeD1();
  const evil = "<script>alert(1)</script>";
  const r = await post(db, validFields({ first_name: evil, last_name: evil, company: evil, role: evil, about: evil + "\n\"quoted\" & 'single'", tz: evil, referral: evil }), { ip: "198.51.100.70" });
  assert.equal(r.location, "/invite-thanks");
  // email cannot carry markup (it would fail validation); prove that too
  assert.equal((await post(db, validFields({ email: `${evil}@example.com` }), { ip: "198.51.100.71" })).location, "/invite?e=invalid");
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].company, evil);
  await adminPost(db, { id: "1", action: "note", note: evil }, { jwt: await makeJwt({}) });
  const page = await adminGet(db, { jwt: await makeJwt({}) });
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes("<script>alert"), "no raw script tag from the data");
  assert.equal((page.body.match(/<script/g) || []).length, 1, "only the page's own nonce script");
  assert.ok(page.body.includes(escapeHtml(evil)));
  assert.ok(page.body.includes("&quot;quoted&quot; &amp; &#39;single&#39;"));
});

test("Approve changes only that D1 row; Not now, Mark invited and transitions; nothing else is called", async () => {
  const db = await seeded();
  const jwt = await makeJwt({});
  const calls = [];
  const before = rows(db);
  const a = await adminPost(db, { id: "1", action: "approve", slug: "ann-s", note: "call first" }, { jwt, calls });
  assert.equal(a.status, 303);
  const after = rows(db);
  assert.equal(after[0].status, "approved");
  assert.equal(after[0].slug, "ann-s");
  assert.equal(after[0].note, "call first");
  assert.equal(after[0].approved_at, new Date(NOW).toISOString());
  assert.deepEqual(after[1], before[1], "the other row is untouched");
  for (const k of ["first_name", "email", "about", "company", "created_at"]) assert.equal(after[0][k], before[0][k]);
  assert.ok(calls.every((u) => u === `https://${TEAM}/cdn-cgi/access/certs`), "only the Access key fetch: " + calls);
  // invited only from approved
  await adminPost(db, { id: "2", action: "invited" }, { jwt });
  assert.equal(rows(db)[1].status, "new");
  await adminPost(db, { id: "1", action: "invited" }, { jwt });
  assert.equal(rows(db)[0].status, "invited");
  assert.ok(rows(db)[0].invited_at);
  await adminPost(db, { id: "2", action: "not_now" }, { jwt });
  assert.equal(rows(db)[1].status, "not_now");
  // bad slug refused, nothing changes
  const bad = await adminPost(db, { id: "2", action: "approve", slug: "Bad Slug!" }, { jwt });
  assert.equal(bad.status, 400);
  assert.equal(rows(db)[1].status, "not_now");
  // unknown action, unknown id
  assert.equal((await adminPost(db, { id: "2", action: "delete" }, { jwt })).status, 400);
  assert.equal((await adminPost(db, { id: "99", action: "approve" }, { jwt })).status, 404);
});

test("admin POST from another site (CSRF) -> 403, no change", async () => {
  const db = await seeded();
  const jwt = await makeJwt({});
  assert.equal((await adminPost(db, { id: "1", action: "approve" }, { jwt, origin: "https://evil.example" })).status, 403);
  assert.equal((await adminPost(db, { id: "1", action: "approve" }, { jwt, origin: null })).status, 403);
  assert.equal((await adminPost(db, { id: "1", action: "approve" }, { jwt, site: "cross-site" })).status, 403);
  assert.equal(rows(db)[0].status, "new");
});

test("'not now' rows are deleted 90 days after the decision; others kept", async () => {
  const db = await seeded();
  db.raw.prepare("UPDATE invite_requests SET status='not_now', status_changed_at=? WHERE id=1").run(new Date(NOW - 91 * 86400000).toISOString());
  db.raw.prepare("UPDATE invite_requests SET status='not_now', status_changed_at=? WHERE id=2").run(new Date(NOW - 89 * 86400000).toISOString());
  await adminGet(db, { jwt: await makeJwt({}) });
  assert.deepEqual(rows(db).map((r) => r.id), [2]);
});

test("the invite email template is a [GTM] placeholder and the owner link never reaches the server", async () => {
  assert.match(admin.INVITE_EMAIL_TEMPLATE, /\[GTM/);
  assert.match(admin.INVITE_EMAIL_TEMPLATE, /\{link\}/);
  const src = readFileSync(path.join(ROOT, "functions/admin/invites.js"), "utf8");
  // the link input has no name attribute (so it is never submitted) and sits outside every <form>
  assert.match(src, /<input class="link" type="url" autocomplete="off">/);
});

// ---------- headers ----------
test("_headers: /invite gets its own CSP (old one detached); every other page keeps form-action 'none'", () => {
  const h = readFileSync(path.join(ROOT, "_headers"), "utf8");
  const blocks = h.split(/\n(?=\/)/);
  const star = blocks.find((b) => b.startsWith("/*\n"));
  assert.match(star, /form-action 'none'/);
  assert.match(star, /default-src 'none'/);
  const inv = blocks.find((b) => b.startsWith("/invite\n"));
  assert.ok(inv, "an /invite block");
  assert.match(inv, /^\s+! Content-Security-Policy$/m);
  assert.match(inv, /form-action 'self'/);
  assert.match(inv, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(inv, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(inv, /connect-src 'self'/);
  assert.equal((h.match(/form-action 'self'/g) || []).length, 1, "only /invite may post");
});

test("validateInvite unit: trims, lowercases email, strips control characters", () => {
  const r = validateInvite(validFields({ first_name: "  Pat\u0007 ", email: " PAT@EXAMPLE.COM " }));
  assert.ok(r.ok);
  assert.equal(r.value.first_name, "Pat");
  assert.equal(r.value.email, "pat@example.com");
});
