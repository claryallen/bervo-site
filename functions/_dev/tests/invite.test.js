// Tests for the invite form handler and the admin page (CR-INVITEFLOW.1 part A, spec "Proving it" 1–2).
// Run: node --experimental-default-type=module --test functions/_dev/tests/invite.test.js   (Node 22+, no packages)
// D1 is mocked over node:sqlite with the real schema in functions/_dev/migrations/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as invite from "../../api/invite.js";
import * as config from "../../api/invite-config.js";
import * as admin from "../../admin/invites.js";
import { _resetAccessKeyCache, ABOUT_MAX, escapeHtml, stripFormatChars, TRIMMED_COLUMNS, validateInvite } from "../../_lib/invites.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA = readFileSync(path.join(ROOT, "functions/_dev/migrations/0001_invite_requests.sql"), "utf8") + "\n" +
  readFileSync(path.join(ROOT, "functions/_dev/migrations/0003_other_email.sql"), "utf8") + "\n" +
  readFileSync(path.join(ROOT, "functions/_dev/migrations/0004_computers.sql"), "utf8") + "\n" +
  readFileSync(path.join(ROOT, "functions/_dev/migrations/0005_heard_from.sql"), "utf8") + "\n" +
  readFileSync(path.join(ROOT, "functions/_dev/migrations/0006_drop_company_role.sql"), "utf8");
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
    const body = { success: ok, action: "invite", hostname: "bervo.ai" };
    if (mode === "wrong-action") body.action = "login";
    if (mode === "no-action") delete body.action;
    if (mode === "wrong-host") body.hostname = "evil.example";
    if (mode === "no-host") delete body.hostname;
    if (mode === "preview-host") body.hostname = "invite-form.bervo-site.pages.dev";
    if (mode === "test-host") body.hostname = "example.com";
    if (mode.startsWith("wrong") || mode.startsWith("no-") || mode.endsWith("-host")) body.success = token === "good-token";
    return Response.json(body);
  };
}

const ENV = (db) => ({ DB: db, TURNSTILE_SECRET: "test-secret", RATE_LIMIT_SALT: "test-salt", TURNSTILE_SITE_KEY: "1x00000000000000000000AA" });

function validFields(over = {}) {
  return {
    first_name: "Pat", last_name: "Sample", email: "Pat@Example.com",
    has_assistant: "yes", email_provider: "google", computer: "mac", phone: "iphone", plan: "private", heard_from: "search", about: "I run a small firm.",
    privacy: "yes", tz: "America/Chicago", referral: "", website: "", t: String(NOW - 10000),
    "cf-turnstile-response": "good-token", ...over,
  };
}

async function post(db, fields, { ip = "203.0.113.7", origin = ORIGIN, mode = "pass", env, nowMs = NOW, calls } = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) sp.append(k, x);
  const body = sp.toString();
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
    { has_assistant: "maybe" }, { privacy: "" }, { first_name: "" }, { last_name: "x".repeat(81) }];
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
  const r = await post(db, validFields({ first_name: evil, last_name: evil, about: evil + "\n\"quoted\" & 'single'", tz: evil, referral: evil }), { ip: "198.51.100.70" });
  assert.equal(r.location, "/invite-thanks");
  // email cannot carry markup (it would fail validation); prove that too
  assert.equal((await post(db, validFields({ email: `${evil}@example.com` }), { ip: "198.51.100.71" })).location, "/invite?e=invalid");
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].last_name, evil);
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
  for (const k of ["first_name", "email", "about", "last_name", "created_at"]) assert.equal(after[0][k], before[0][k]);
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

test("the invite email is the approved copy; the owner link reaches the server only with Send (CR-WELCOMEEMAIL.1)", async () => {
  assert.equal(admin.INVITE_EMAIL_SUBJECT, "Your Bervo invite");
  assert.ok(admin.INVITE_EMAIL_TEMPLATE.startsWith("Hi {first_name},\n\nThanks for requesting an invite to Bervo. I'm glad to have you."));
  assert.match(admin.INVITE_EMAIL_TEMPLATE, /Here's your personal setup link:\n\{link\}\n/);
  assert.match(admin.INVITE_EMAIL_TEMPLATE, /It works once and stays open for 14 days\./);
  assert.ok(admin.INVITE_EMAIL_TEMPLATE.endsWith("Any questions, just reply to this email.\n\nAllen"));
  assert.ok(!/\[GTM/.test(admin.INVITE_EMAIL_TEMPLATE));
  const src = readFileSync(path.join(ROOT, "functions/admin/invites.js"), "utf8");
  // CR-WELCOMEEMAIL.1 changed this on purpose: the link box now sits in the Send form (name="link"), so Send posts it
  // for that one email. It is never stored or logged (mail.test.js M3, M6); Copy still fills it in the browser only.
  assert.match(src, /<form method="post" action="\/admin\/invites" class="send">\n<input type="hidden" name="id" value="\$\{e\(r\.id\)\}">\n<label>Owner link \(paste it here\) <input class="link" name="link" type="url" autocomplete="off" required>/);
});

test("approved copy on the page (INVITE_FORM_COPY_V1 §1-4): labels, radios, help, counter, errors; no placeholders left", () => {
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  const js = readFileSync(path.join(ROOT, "invite.js"), "utf8");
  const thanks = readFileSync(path.join(ROOT, "invite-thanks.html"), "utf8");
  for (const f of ["invite.html", "invite.js", "invite-thanks.html", "invite-thanks.js", "functions/admin/invites.js"]) {
    assert.ok(!/\[GTM/.test(readFileSync(path.join(ROOT, f), "utf8")), f + " still has a [GTM] placeholder");
  }
  for (const t of ["Privacy First. Business First.", "<h1>Request an invite</h1>",
    "Bervo is built for business owners and executives. Tell us a little about yourself and we'll be in touch, usually within two business days.",
    ">Preferred email<", "The address you'd like to sign in with.",
    "<legend>Do you have an assistant?</legend>", "Your assistant can have their own sign-in to Bervo.",
    "<legend>Email provider(s)</legend>", "Google (Gmail or Google Workspace)", "Microsoft 365 or Exchange",
    "<legend>Which phone do you use?</legend>", "Tell us about you and your business",
    "You can also ask any question here. We'll get back to you.</span><textarea", ">0 of 1,000<", ">Request an Invite</button>",
    "We couldn't send your request. Please check your connection and try again."]) assert.ok(html.includes(t), t);
  assert.ok(!/work email/i.test(html), "nothing on screen says work email");
  const radios = (name) => [...html.matchAll(new RegExp(`<label><input type="radio" name="${name}" value="([a-z]+)"`, "g"))].map((m) => m[1]);
  assert.deepEqual(radios("has_assistant"), ["yes", "no"]);
  const boxes = [...html.matchAll(/<label><input type="checkbox" name="email_provider" value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(boxes, ["google", "microsoft", "other"]);
  assert.deepEqual(radios("phone"), ["iphone", "android"]);
  assert.deepEqual(radios("phone"), ["iphone", "android"]);
  assert.ok(!/approval from your email admin|small print/i.test(html), "no Microsoft small print on this form");
  for (const t of ["Please fill this in.", "Please enter a full email address, like name@company.com.", "Please choose one.",
    "Please keep this to 1,000 characters.", "Please agree to the Privacy Policy to send your request.", "Sending…", " of 1,000"])
    assert.ok(js.includes(t), t);
  for (const t of ["We've received your request. We read each one ourselves and will reply by email, usually within two business days.",
    "In the meantime, learn more about Bervo.", '<a href="/">Bervo Home →</a>']) assert.ok(thanks.includes(t), t);
  const tjs = readFileSync(path.join(ROOT, "invite-thanks.js"), "utf8");
  assert.match(tjs, /textContent = "Thanks, " \+ n \+ "\."/);
  assert.ok(!/innerHTML/.test(tjs + js), "names never go in as markup");
  // the first name travels in sessionStorage, never in the redirect address
  const handler = readFileSync(path.join(ROOT, "functions/api/invite.js"), "utf8");
  assert.ok(!/invite-thanks\?/.test(handler));
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
  const ty = blocks.find((b) => b.startsWith("/invite-thanks\n"));
  assert.ok(ty, "an /invite-thanks block");
  assert.match(ty, /^\s+! Content-Security-Policy$/m);
  assert.match(ty, /script-src 'self';/);
  assert.match(ty, /form-action 'none'/);
  assert.ok(!/challenges\.cloudflare\.com|connect-src/.test(ty));
});

test("validateInvite unit: trims, lowercases email, strips control characters", () => {
  const r = validateInvite(validFields({ first_name: "  Pat\u0007 ", email: " PAT@EXAMPLE.COM " }));
  assert.ok(r.ok);
  assert.equal(r.value.first_name, "Pat");
  assert.equal(r.value.email, "pat@example.com");
});

// ---------- fix round 1 ----------
test("Turnstile: action must be exactly 'invite' and hostname on the allowlist", async () => {
  const db = makeD1();
  let i = 0;
  for (const mode of ["no-action", "wrong-action", "wrong-host", "no-host", "test-host"]) {
    const r = await post(db, validFields(), { mode, ip: "198.51.100." + (100 + i++) });
    assert.equal(r.location, "/invite-thanks", mode);
  }
  assert.equal(rows(db).length, 0, "none stored");
  assert.equal((await post(db, validFields(), { mode: "preview-host", ip: "198.51.100.120" })).location, "/invite-thanks");
  assert.equal(rows(db).length, 1, "the preview host is allowed");
  // TURNSTILE_HOSTNAMES replaces the list (local runs with Cloudflare's test keys report example.com)
  const env = { ...ENV(db), TURNSTILE_HOSTNAMES: "example.com" };
  await post(db, validFields(), { mode: "test-host", ip: "198.51.100.121", env });
  assert.equal(rows(db).length, 2);
  await post(db, validFields(), { mode: "pass", ip: "198.51.100.122", env });
  assert.equal(rows(db).length, 2, "bervo.ai not allowed when the override names only example.com");
});

test("bidi, zero-width and other format characters are stripped from every text field", async () => {
  const db = makeD1();
  const cf = ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069",
    "\u200B", "\u200C", "\u200D", "\u200E", "\u200F", "\uFEFF", "\u00AD", "\u2060", "\u061C"].join("");
  const r = await post(db, validFields({ first_name: "Pa" + cf + "t", last_name: cf + "Sample",
    about: "Hi\u2066 there\u2069" + cf, email: "pat\u200B@example.com", tz: "Europe/\u200BLondon" }), { ip: "198.51.100.130" });
  assert.equal(r.location, "/invite-thanks");
  const row = rows(db)[0];
  assert.equal(row.first_name, "Pat");
  assert.equal(row.last_name, "Sample");
  assert.equal(row.about, "Hi there");
  assert.equal(row.email, "pat@example.com");
  assert.equal(row.timezone, "Europe/London");
  const all = JSON.stringify(rows(db));
  assert.ok(!/\p{Cf}/u.test(all), "no format character stored");
  // a field made only of format characters counts as empty
  assert.equal((await post(db, validFields({ first_name: cf }), { ip: "198.51.100.131" })).location, "/invite?e=invalid");
  // the admin note too
  await adminPost(db, { id: "1", action: "note", note: "ok\u202Eevil" }, { jwt: await makeJwt({}) });
  assert.equal(rows(db)[0].note, "okevil");
  assert.equal(stripFormatChars("a\u200Bb"), "ab");
});

test("non-site files live under functions/ (Pages does not serve that directory); nothing extra at the root", () => {
  const root = readdirSync(ROOT).filter((n) => !n.startsWith(".git"));
  const allowed = new Set(["404.html", "_headers", "_redirects", "download", "functions", "index.html", "invite-thanks.html",
    "invite.html", "invite.js", "invite-thanks.js", "privacy.html", "terms.html", ".well-known"]);
  assert.deepEqual(root.filter((n) => !allowed.has(n)), [], "unexpected files at the served root");
  for (const f of ["functions/_lib/invites.js", "functions/_dev/tests/invite.test.js"]) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/export\s+(async\s+)?(function|const|let)\s+onRequest/.test(src), `${f} must not define a route`);
  }
});

test("cohort: a request from the personal link is 'private', every other 'public'", async () => {
  const db = makeD1();
  await post(db, validFields({ referral: "allen" }), { ip: "198.51.100.140" });
  await post(db, validFields({ referral: "" }), { ip: "198.51.100.141" });
  await post(db, validFields({ referral: "bob" }), { ip: "198.51.100.142" });
  assert.deepEqual(rows(db).map((r) => [r.referral, r.cohort]), [["allen", "private"], [null, "public"], [null, "public"]]);
});

// ---------- retention (Allen 11-10, "Yes, 90 days") ----------
test("Mark claimed trims the row to id, cohort, status and dates in the same update; the page shows only those", async () => {
  const db = await seeded();
  const jwt = await makeJwt({});
  await adminPost(db, { id: "1", action: "approve", slug: "ann-s", note: "n" }, { jwt });
  await adminPost(db, { id: "1", action: "claimed" }, { jwt });
  assert.equal(rows(db)[0].status, "approved", "claimed only from invited");
  await adminPost(db, { id: "1", action: "invited" }, { jwt });
  const before = rows(db)[0];
  await adminPost(db, { id: "1", action: "claimed" }, { jwt });
  const r = rows(db)[0];
  assert.equal(r.status, "claimed");
  for (const c of ["first_name", "last_name", "email", "has_assistant", "email_providers", "other_email", "computers", "phone",
    "heard_from", "heard_detail", "timezone", "about", "referral", "slug", "note"]) assert.equal(r[c], null, c);
  assert.equal(r.cohort, "private");
  for (const c of ["id", "created_at", "privacy_agreed_at", "approved_at", "invited_at", "plan"]) assert.equal(r[c], before[c], c);
  assert.equal(r.plan, "private", "the plan is kept with cohort");
  assert.equal(r.status_changed_at, new Date(NOW).toISOString());
  assert.deepEqual(rows(db)[1].first_name, "Ben", "the other row untouched");
  await adminPost(db, { id: "1", action: "note", note: "late" }, { jwt });
  assert.equal(rows(db)[0].note, null, "a trimmed row takes no note");
  const page = await adminGet(db, { jwt, query: "?show=claimed" });
  assert.ok(page.body.includes("trimmed") && !page.body.includes("Ann") && !page.body.includes("example.com"));
});

test("schema: a claimed row cannot hold request data, and an unclaimed row must", () => {
  const db = makeD1();
  const ins = "INSERT INTO invite_requests (created_at, first_name, last_name, email, has_assistant, email_providers, phone, plan, about, cohort, privacy_agreed_at, status) VALUES ('t','A','B','a@b.co','yes','[\"google\"]','iphone','private','x','public','t', ?)";
  assert.throws(() => db.raw.prepare(ins).run("claimed"), /CHECK/);
  db.raw.prepare(ins).run("invited");
  assert.throws(() => db.raw.prepare("UPDATE invite_requests SET status='claimed' WHERE id=1").run(), /CHECK/);
  assert.throws(() => db.raw.prepare("UPDATE invite_requests SET about=NULL WHERE id=1").run(), /CHECK/);
});

test("expired and not-now rows are deleted 90 days after that status; claimed and others kept", async () => {
  const db = await seeded();
  const jwt = await makeJwt({});
  for (let i = 0; i < 3; i++) await post(db, validFields({ first_name: "X" + i }), { ip: "198.51.100." + (150 + i) });
  const old = new Date(NOW - 91 * 86400000).toISOString(), recent = new Date(NOW - 89 * 86400000).toISOString();
  db.raw.prepare("UPDATE invite_requests SET status='expired', status_changed_at=? WHERE id=1").run(old);
  db.raw.prepare("UPDATE invite_requests SET status='expired', status_changed_at=? WHERE id=2").run(recent);
  db.raw.prepare("UPDATE invite_requests SET status='invited', status_changed_at=? WHERE id=3").run(old);
  db.raw.prepare("UPDATE invite_requests SET status='not_now', status_changed_at=? WHERE id=4").run(old);
  await adminGet(db, { jwt });
  assert.deepEqual(rows(db).map((r) => r.id), [2, 3, 5]);
  await adminPost(db, { id: "3", action: "expired" }, { jwt });
  assert.equal(rows(db).find((r) => r.id === 3).status, "expired");
});

test("unanswered requests (new, approved) are deleted 90 days after their last change; invited kept (Allen 11-11)", async () => {
  const db = await seeded();
  const jwt = await makeJwt({});
  for (let i = 0; i < 4; i++) await post(db, validFields({ first_name: "U" + i }), { ip: "198.51.100." + (170 + i) });
  const old = new Date(NOW - 91 * 86400000).toISOString(), recent = new Date(NOW - 89 * 86400000).toISOString();
  db.raw.prepare("UPDATE invite_requests SET status='new', status_changed_at=? WHERE id=1").run(old);
  db.raw.prepare("UPDATE invite_requests SET status='new', status_changed_at=? WHERE id=2").run(recent);
  db.raw.prepare("UPDATE invite_requests SET status='approved', status_changed_at=? WHERE id=3").run(old);
  db.raw.prepare("UPDATE invite_requests SET status='invited', status_changed_at=? WHERE id=4").run(old);
  await adminGet(db, { jwt });
  assert.deepEqual(rows(db).map((r) => r.id), [2, 4, 5, 6]);
});

// ---------- /invite page script: nothing red at load, fail closed on press (GTM check of preview 0d44c1b0) ----------
import vm from "node:vm";

function pageSandbox({ config, search = "", onPlan } = {}) {
  const els = {};
  const mk = (id, extra = {}) => (els[id] = { id, value: "", hidden: false, disabled: false, textContent: "", checked: false,
    listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, closest() { return errHolder(id); }, ...extra });
  const errs = {};
  const errHolder = (id) => ({ querySelector: () => (errs[id] ||= { textContent: "" }) });
  for (const id of ["t", "tz", "referral", "first_name", "last_name", "email", "about", "about-count",
    "privacy", "privacy-err", "submit", "fs-has_assistant", "fs-email_provider", "fs-phone", "fs-plan", "ep-other",
    "other-wrap", "other_email", "fs-computer", "cp-windows", "cp-mac", "cp-none", "heard_from", "heard-wrap",
    "heard_detail", "heard-detail-label"]) mk(id);
  mk("send-err", { hidden: true });            // the page ships it with the hidden attribute
  let token = null;
  const radios = {};
  const form = mk("invite-form", {
    querySelector(sel) {
      if (sel.includes("cf-turnstile-response")) return token;
      const pv = sel.match(/name=plan\]\[value="(\w+)"\]/);
      if (pv) return { set checked(v) { if (v && onPlan) onPlan(pv[1]); } };
      const m = sel.match(/name=(\w+)\]:checked/);
      return m && radios[m[1]] ? {} : null;
    },
  });
  const scripts = [];
  const window = {};
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: () => ({}),
    head: { appendChild: (s) => scripts.push(s) },
  };
  window.turnstile = { render: () => { token = { value: "tok" }; } };
  const fetch = async () => ({ json: async () => (config ? { site_key: "0x4AAAAAAA" } : { unavailable: true }) });
  const ctx = { window, document, location: { search }, URLSearchParams, Intl, Date, String, fetch };
  window.document = document;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, "invite.js"), "utf8"), ctx);
  return { els, errs, form, radios, scripts, window, fill() {
    for (const id of ["first_name", "last_name", "about"]) els[id].value = "x";
    els.email.value = "a@b.co"; els.privacy.checked = true; els.heard_from.value = "search";
    Object.assign(radios, { has_assistant: 1, email_provider: 1, computer: 1, phone: 1, plan: 1 });
  } };
}
async function loadTurnstile(p) {           // the Turnstile script's onload callback, then let fetch settle
  await p.window.bervoTurnstileReady();
  await new Promise((r) => setTimeout(r, 0));
}
function press(p) {
  let prevented = false;
  p.els["invite-form"].listeners.submit({ preventDefault() { prevented = true; } });
  return prevented;
}

test("at load nothing red shows and the button is normal, with and without config", async () => {
  for (const config of [true, false]) {
    const p = pageSandbox({ config });
    assert.equal(p.els["send-err"].hidden, true, `before Turnstile loads (config=${config})`);
    assert.equal(p.els.submit.disabled, false);
    await loadTurnstile(p);
    assert.equal(p.els["send-err"].hidden, true, `after config answered (config=${config})`);
    assert.equal(p.els.submit.disabled, false, `button normal (config=${config})`);
    assert.equal(p.els.submit.textContent, "");    // the label stays whatever the page says
  }
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.match(html, /<p class="err" id="send-err" hidden>/);
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  assert.ok(!/<button type="submit" id="submit" disabled/.test(html));
});

test("no config: a complete form pressed sends nothing and shows the could-not-send line (fails closed)", async () => {
  const p = pageSandbox({ config: false });
  await loadTurnstile(p);
  p.fill();
  assert.equal(press(p), true, "submit prevented");
  assert.equal(p.els["send-err"].hidden, false, "error shown on press");
  assert.equal(p.els.submit.textContent, "", "not switched to Sending…");
});

test("config present: a complete form pressed is sent, 'Sending…'; an incomplete one shows field errors only", async () => {
  const p = pageSandbox({ config: true });
  await loadTurnstile(p);
  assert.equal(press(p), true, "empty form prevented");
  assert.equal(p.els["send-err"].hidden, true, "field errors, not the send line");
  assert.equal(p.errs.first_name.textContent, "Please fill this in.");
  p.fill();
  assert.equal(press(p), false, "sent");
  assert.equal(p.els.submit.textContent, "Sending…");
  assert.equal(p.els["send-err"].hidden, true);
});

test("after a server refusal (?e=retry) the line shows: that is a failed send", () => {
  const p = pageSandbox({ config: true, search: "?e=retry" });
  assert.equal(p.els["send-err"].hidden, false);
});

test("/invite and /invite-thanks: only same-origin script files, no inline script or handlers", () => {
  for (const f of ["invite.html", "invite-thanks.html"]) {
    const html = readFileSync(path.join(ROOT, f), "utf8");
    const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(tags.length, 1, f);
    assert.match(tags[0][1], /^ src="\/invite(-thanks)?\.js(\?v=\d+)?"$/, f);   // ?v=N: cache-busting version only
    assert.equal(tags[0][2].trim(), "", f + ": no inline code");
    assert.ok(!/\son[a-z]+=/i.test(html), f + ": no inline event handlers");
    assert.ok(!/javascript:/i.test(html), f);
  }
  const h = readFileSync(path.join(ROOT, "_headers"), "utf8");
  const ty = h.split(/\n(?=\/)/).find((b) => b.startsWith("/invite-thanks\n"));
  const csp = ty.match(/Content-Security-Policy: (.*)/)[1];
  assert.equal(csp.match(/script-src [^;]*/)[0], "script-src 'self'");
  assert.ok(!/unsafe-inline'[^;]*;?\s*$/.test(csp.match(/script-src [^;]*/)[0]) && !/nonce|unsafe-eval|https?:/.test(csp));
});

// ---------- round 3 copy (Allen 11-10): plan, provider(s), every field required ----------
test("plan: required, allowlisted, stored and shown; Standard listed first", async () => {
  const db = makeD1();
  assert.equal((await post(db, validFields({ plan: "standard" }), { ip: "198.51.100.160" })).location, "/invite-thanks");
  assert.equal((await post(db, validFields({ plan: "private" }), { ip: "198.51.100.161" })).location, "/invite-thanks");
  for (const [i, bad] of ["", "enterprise", "<script>"].entries())
    assert.equal((await post(db, validFields({ plan: bad }), { ip: "198.51.100." + (162 + i) })).location, "/invite?e=invalid", bad);
  const f = validFields(); delete f.plan;
  assert.equal((await post(db, f, { ip: "198.51.100.166" })).location, "/invite?e=invalid", "missing plan");
  assert.deepEqual(rows(db).map((r) => r.plan), ["standard", "private"]);
  assert.throws(() => db.raw.prepare("UPDATE invite_requests SET plan='gold' WHERE id=1").run(), /CHECK/);
  const page = await adminGet(db, { jwt: await makeJwt({}) });
  assert.ok(page.body.includes("<dt>Plan</dt><dd>Standard $49/mo</dd>") && page.body.includes("<dd>Private $99/mo</dd>"));
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.ok(html.indexOf('value="standard"') < html.indexOf('value="private"'), "Standard first");
  assert.ok(html.indexOf('name="phone" value="android"') < html.indexOf("<legend>Which plan would you like?</legend>"), "after the phone question");
  for (const t of ['<label class="plan"><input type="radio" name="plan" value="standard" required><span><b>Standard $49/mo</b> <span class="help">Private server space. Add texts, voice, assistants anytime. Upgrade to Private anytime. AI key costs additional. Bervo is free until January 5, 2027. Cancel anytime.</span></span></label>',
    '<label class="plan"><input type="radio" name="plan" value="private"><span><b>Private $99/mo</b> <span class="help">Private server. Includes texts, voice, and your first assistant. Downgrade to Standard anytime. AI key costs additional. Bervo is free until January 5, 2027. Cancel anytime.</span></span></label>'])
    assert.ok(html.includes(t), "radio left of the bold name and grey line: " + t.slice(0, 60));
});

test("?plan= pre-selects only standard or private", () => {
  for (const [q, want] of [["?plan=private", "private"], ["?plan=Standard", "standard"], ["?plan=gold", null], ["", null]]) {
    const picked = [];
    const p = pageSandbox({ config: true, search: q, onPlan: (v) => picked.push(v) });
    assert.deepEqual(picked, want ? [want] : [], q);
    void p;
  }
});

test("email provider(s): any of the three, at least one, stored as a fixed-order JSON list", async () => {
  const db = makeD1();
  await post(db, validFields({ email_provider: ["other", "google"], other_email: "Yahoo" }), { ip: "198.51.100.170" });
  await post(db, validFields({ email_provider: ["microsoft", "microsoft"] }), { ip: "198.51.100.171" });
  await post(db, validFields({ email_provider: ["google", "microsoft", "other"], other_email: "AOL" }), { ip: "198.51.100.172" });
  assert.deepEqual(rows(db).map((r) => r.email_providers), ['["google","other"]', '["microsoft"]', '["google","microsoft","other"]']);
  const none = validFields(); delete none.email_provider;
  assert.equal((await post(db, none, { ip: "198.51.100.173" })).location, "/invite?e=invalid");
  assert.equal((await post(db, validFields({ email_provider: ["google", "yahoo"] }), { ip: "198.51.100.174" })).location, "/invite?e=invalid");
  assert.equal(rows(db).length, 3);
  assert.throws(() => db.raw.prepare(`UPDATE invite_requests SET email_providers='["yahoo"]' WHERE id=1`).run(), /CHECK/);
  assert.throws(() => db.raw.prepare(`UPDATE invite_requests SET email_providers='["other","google"]' WHERE id=1`).run(), /CHECK/);
  const page = await adminGet(db, { jwt: await makeJwt({}) });
  assert.ok(page.body.includes("<dd>Google, Other</dd>") && page.body.includes("<dd>Google, Microsoft 365 or Exchange, Other</dd>"));
});

test("every field required on the server: each one missing alone is refused, nothing stored", async () => {
  const db = makeD1();
  let i = 0;
  for (const k of ["first_name", "last_name", "email", "has_assistant", "email_provider", "computer", "phone", "plan", "heard_from", "about", "privacy"]) {
    const f = validFields(); delete f[k];
    assert.equal((await post(db, f, { ip: "198.51.100." + (180 + i++) })).location, "/invite?e=invalid", k);
  }
  assert.equal(rows(db).length, 0);
});

test("every field required on the page: an empty press puts the approved line under each field; no asterisks", async () => {
  const p = pageSandbox({ config: true });
  await loadTurnstile(p);
  press(p);
  const want = { first_name: "Please fill this in.", last_name: "Please fill this in.", email: "Please fill this in.",
    "fs-has_assistant": "Please choose one.",
    "fs-email_provider": "Please choose at least one.", "fs-computer": "Please choose at least one.", heard_from: "Please choose one.", "fs-phone": "Please choose one.", "fs-plan": "Please choose one.",
    about: "Please fill this in." };
  for (const [k, msg] of Object.entries(want)) assert.equal(p.errs[k]?.textContent, msg, k);
  assert.equal(p.els["privacy-err"].textContent, "Please agree to the Privacy Policy to send your request.");
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.ok(!/\*|required-mark|aria-required/.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), "no asterisks");
});

// ---------- "What other email account(s)?" (Allen 11-11) ----------
test("Other ticked: the other-account answer is required, stored, shown to the admin and trimmed on claimed", async () => {
  const db = makeD1();
  await post(db, validFields({ email_provider: ["google", "other"], other_email: "" }), { ip: "198.51.100.200" });
  assert.equal(rows(db).length, 0, "Other without an answer is refused");
  await post(db, validFields({ email_provider: ["google", "other"], other_email: "x".repeat(41) }), { ip: "198.51.100.201" });
  assert.equal(rows(db).length, 0, "41 characters refused");
  await post(db, validFields({ email_provider: ["google", "other"], other_email: "  Yahoo, AOL\u202e " }), { ip: "198.51.100.202" });
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].other_email, "Yahoo, AOL", "trimmed, format characters removed");
  assert.equal(rows(db)[0].email_providers, '["google","other"]');
  const page = (await adminGet(db, { jwt: await makeJwt({}) })).body;
  assert.match(page, /Other email account\(s\)<\/dt><dd>Yahoo, AOL<\/dd>/);
  assert.ok(TRIMMED_COLUMNS.includes("other_email"));
});

test("Other not ticked: any other-account text is ignored (never stored)", async () => {
  const db = makeD1();
  await post(db, validFields({ email_provider: "google", other_email: "sneaky" }), { ip: "198.51.100.203" });
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].other_email, null);
});

test("page: the other-account box shows only while Other is ticked, and is required then", async () => {
  const p = pageSandbox({ config: true });
  assert.equal(p.els["other-wrap"].hidden, true, "hidden at load");
  assert.equal(p.els.other_email.disabled, true, "not sent while hidden");
  p.els["ep-other"].checked = true; p.els["ep-other"].listeners.change();
  assert.equal(p.els["other-wrap"].hidden, false, "shown when Other is ticked");
  assert.equal(p.els.other_email.disabled, false);
  await loadTurnstile(p);
  p.fill();
  assert.equal(press(p), true, "empty other-account answer blocks the send");
  p.els.other_email.value = "Yahoo";
  assert.equal(press(p), false, "with an answer the form is sent");
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.match(html, /What other email account\(s\)\? \(e\.g\. Yahoo, AOL\)/);
  assert.equal((html.match(/AI key costs additional\. Bervo is free until January 5, 2027\. Cancel anytime\./g) || []).length, 2);
});

// ---------- "Which type of computer(s) do you use?" (Allen 11-11) ----------
test("computer(s): any of Windows/Mac, or Neither alone; required; stored in fixed order; shown; trimmed", async () => {
  const db = makeD1();
  await post(db, validFields({ computer: ["mac", "windows"] }), { ip: "198.51.100.210" });
  await post(db, validFields({ computer: "none" }), { ip: "198.51.100.211" });
  assert.deepEqual(rows(db).map((r) => r.computers), ['["windows","mac"]', '["none"]']);
  const none = validFields(); delete none.computer;
  for (const [i, bad] of [none, validFields({ computer: ["none", "mac"] }), validFields({ computer: "ipad" })].entries())
    assert.equal((await post(db, bad, { ip: "198.51.100." + (212 + i) })).location, "/invite?e=invalid", "refused " + i);
  assert.equal(rows(db).length, 2);
  assert.throws(() => db.raw.prepare(`UPDATE invite_requests SET computers='["mac","windows"]' WHERE id=1`).run(), /CHECK/);
  const page = (await adminGet(db, { jwt: await makeJwt({}) })).body;
  assert.ok(page.includes("<dt>Computer(s)</dt><dd>Windows PC, Mac</dd>") && page.includes("<dd>Neither (iPad and/or phone only)</dd>"));
  assert.ok(TRIMMED_COLUMNS.includes("computers"));
});

test("page: computer question before the phone question; Neither and a computer can't both be ticked; scripts versioned", () => {
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.ok(html.indexOf("Which type of computer(s) do you use?") < html.indexOf("Which phone do you use?"));
  for (const t of ["> Windows PC</label>", "> MacBook, iMac or Mac mini</label>", "> Neither (iPad and/or phone only)</label>"]) assert.ok(html.includes(t), t);
  assert.match(html, /<script src="\/invite\.js\?v=\d+"><\/script>/);
  const headers = readFileSync(path.join(ROOT, "_headers"), "utf8");
  assert.match(headers, /\/invite\.js\n  Cache-Control: no-cache/);
  const p = pageSandbox({ config: true });
  p.els["cp-mac"].checked = true; p.els["cp-mac"].listeners.change();
  p.els["cp-none"].checked = true; p.els["cp-none"].listeners.change();
  assert.equal(p.els["cp-mac"].checked, false, "Neither clears Mac");
  p.els["cp-windows"].checked = true; p.els["cp-windows"].listeners.change();
  assert.equal(p.els["cp-none"].checked, false, "a computer clears Neither");
});

// ---------- "How did you hear about Bervo?" (options approved by Allen 11-11) ----------
test("how you heard: required, allowlisted; Referred/Other need a detail; detail ignored otherwise; shown; trimmed", async () => {
  const db = makeD1();
  await post(db, validFields({ heard_from: "ai" }), { ip: "198.51.100.220" });
  await post(db, validFields({ heard_from: "referral", heard_detail: "  Pat S\u200b " }), { ip: "198.51.100.221" });
  await post(db, validFields({ heard_from: "other", heard_detail: "A friend's newsletter" }), { ip: "198.51.100.222" });
  await post(db, validFields({ heard_from: "event", heard_detail: "ignored" }), { ip: "198.51.100.223" });
  assert.deepEqual(rows(db).map((r) => [r.heard_from, r.heard_detail]),
    [["ai", null], ["referral", "Pat S"], ["other", "A friend's newsletter"], ["event", null]]);
  const missing = validFields(); delete missing.heard_from;
  for (const [i, bad] of [missing, validFields({ heard_from: "tv" }), validFields({ heard_from: "referral", heard_detail: "" }),
    validFields({ heard_from: "other", heard_detail: "x".repeat(201) })].entries())
    assert.equal((await post(db, bad, { ip: "198.51.100." + (224 + i) })).location, "/invite?e=invalid", "refused " + i);
  assert.equal(rows(db).length, 4);
  const page = (await adminGet(db, { jwt: await makeJwt({}) })).body;
  assert.ok(page.includes("<dt>How they heard</dt><dd>Referred by someone: Pat S</dd>"));
  assert.ok(page.includes("<dd>AI told me (ChatGPT, Claude, Gemini, etc.)</dd>"));
  assert.ok(TRIMMED_COLUMNS.includes("heard_from") && TRIMMED_COLUMNS.includes("heard_detail"));
});

test("page: the approved options in order after the plan; the detail box opens only for Referred/Other", async () => {
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  const labels = ["Choose one", "Referred by someone", "Social Media", "Web Search (Google, etc.)", "AI told me (ChatGPT, Claude, Gemini, etc.)",
    "An article, podcast or newsletter", "An online ad", "An event or talk", "Other"];
  const sel = html.slice(html.indexOf('<select id="heard_from"'), html.indexOf("</select>"));
  assert.deepEqual([...sel.matchAll(/<option value="[^"]*">([^<]*)<\/option>/g)].map((m) => m[1]), labels);
  assert.ok(html.indexOf("Which plan would you like?") < html.indexOf("How did you hear about Bervo?"));
  assert.ok(html.indexOf("How did you hear about Bervo?") < html.indexOf("Tell us about you and your business"));
  const p = pageSandbox({ config: true });
  assert.equal(p.els["heard-wrap"].hidden, true);
  for (const [v, box] of [["referral", "Who referred you?"], ["other", "Please tell us where"]]) {
    p.els.heard_from.value = v; p.els.heard_from.listeners.change();
    assert.equal(p.els["heard-wrap"].hidden, false, v);
    assert.equal(p.els["heard-detail-label"].textContent, box);
  }
  p.els.heard_from.value = "social"; p.els.heard_from.listeners.change();
  assert.equal(p.els["heard-wrap"].hidden, true);
  assert.equal(p.els.heard_detail.disabled, true);
  await loadTurnstile(p);
  p.fill(); p.els.heard_from.value = "referral"; p.els.heard_from.listeners.change();
  assert.equal(press(p), true, "Referred with no name blocks the send");
  p.els.heard_detail.value = "Pat";
  assert.equal(press(p), false, "with a name it is sent");
});

test("company and role are not asked, not stored and not shown (Allen 11-11)", async () => {
  const html = readFileSync(path.join(ROOT, "invite.html"), "utf8");
  assert.ok(!/name="company"|name="role"|>Company<|>Your role</.test(html));
  const db = makeD1();
  await post(db, validFields({ company: "Sample Co", role: "Owner" }), { ip: "198.51.100.240" });
  assert.equal(rows(db).length, 1, "extra fields are ignored, the request is stored");
  assert.ok(!("company" in rows(db)[0]) && !("role" in rows(db)[0]), "no such columns");
  const page = (await adminGet(db, { jwt: await makeJwt({}) })).body;
  assert.ok(!page.includes("<dt>Company</dt>") && !page.includes("<dt>Role</dt>"));
});
