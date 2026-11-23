// Tests for CR-ADMINMOBILE.1 (admin page: phone-friendly, accessible; CSS and markup only). Helpers copied from admintabs.test.js.
// Run: node --experimental-default-type=module --test functions/_dev/tests/adminmobile.test.js
// Set ADMIN_DUMP_DIR=<dir> to also write the rendered pages there for a browser check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as admin from "../../admin/invites.js";

import { reminderDue } from "../../_lib/mail.js";
import { _resetAccessKeyCache } from "../../_lib/invites.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = (n) => readFileSync(path.join(ROOT, "functions/_dev/migrations", n), "utf8");
const NOW = Date.parse("2026-11-23T15:00:00Z");
const ORIGIN = "https://bervo.ai";
const TEAM = "bervo.cloudflareaccess.com";
const AUD = "aud-tag-test";
const SECRET = "fake-provision-secret-0123456789abcdef";
const BASE_MIGRATIONS = ["0001_invite_requests.sql", "0003_other_email.sql", "0004_computers.sql", "0005_heard_from.sql",
  "0006_drop_company_role.sql", "0002_invite_mail.sql", "0007_provisioning.sql", "0008_texts_mail.sql"];

// D1 stand-in. maxParams: D1 refuses a query with more than 100 bound parameters; the stand-in does too.
function makeD1({ signedUp = true, kept = true } = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const n of BASE_MIGRATIONS) sql.exec(MIG(n));
  if (signedUp) sql.exec(MIG("0009_signed_up.sql"));
  if (signedUp && kept) sql.exec(MIG("0010_onboarded_label.sql"));
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
        bind(...a) { if (a.length > 100) throw new Error("too many SQL variables"); args = norm(a); return st; },
        async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: r.changes } }; },
        async first() { return sql.prepare(q).get(...args) ?? null; },
        async all() { return { success: true, results: sql.prepare(q).all(...args) }; },
      };
      return st;
    },
  };
}
function seed(db, { status = "new", slug = null, invitedAt = null, first = "Pat", last = "Sample" } = {}) {
  db.raw.prepare("INSERT INTO invite_requests (created_at, first_name, last_name, email, has_assistant, email_providers, phone, plan, " +
    "timezone, about, cohort, privacy_agreed_at, status, status_changed_at, approved_at, invited_at, slug) " +
    "VALUES (?, ?, ?, 'pat@example.com', 'yes', '[\"google\"]', 'android', 'private', 'America/Chicago', 'I run a small firm.', 'public', ?, ?, ?, ?, ?, ?)")
    .run("2026-11-20T10:00:00Z", first, last, "2026-11-20T10:00:00Z", status, "2026-11-20T11:00:00Z",
      status === "new" || status === "not_now" ? null : "2026-11-20T11:00:00Z", invitedAt, slug);
  return Number(db.raw.prepare("SELECT max(id) AS m FROM invite_requests").get().m);
}
function claimed(db) {
  db.raw.prepare("INSERT INTO invite_requests (created_at, plan, cohort, privacy_agreed_at, status, status_changed_at) " +
    "VALUES ('2026-11-01T10:00:00Z', 'private', 'public', '2026-11-01T10:00:00Z', 'claimed', '2026-11-10T10:00:00Z')").run();
  return Number(db.raw.prepare("SELECT max(id) AS m FROM invite_requests").get().m);
}
const setProv = (db, id, state, step = "phase4") => db.raw.prepare(
  "INSERT OR REPLACE INTO invite_provision (request_id, state, step, updated_at) VALUES (?, ?, ?, ?)").run(id, state, step, new Date(NOW).toISOString());

const LKEY = ["fake", "link", "key", "0123456789abcdef", "0123456789"].join("-");   // built at run time (G1)
const ENV = (db, over = {}) => ({ DB: db, BERVO_PROVISION_SECRET: SECRET, BERVO_LINK_KEY: LKEY,
  POSTMARK_SERVER_TOKEN: ["fake", "pm", "tabs"].join("-"), MAIL_REPLY_TO: "allen@bervo.ai", RATE_LIMIT_SALT: "test-salt",
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: "allen@bervo.ai", ...over });

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

import { mkdirSync, writeFileSync } from "node:fs";

function populate(db) {
  const a = seed(db, { status: "new", first: "Alexandria", last: "Longsurnamewithoutbreaks" });
  const b = seed(db, { status: "approved", slug: "k7m2qx" }); setProv(db, b, "ready");
  const c = seed(db, { status: "approved", slug: "zz9999" }); setProv(db, c, "failed");
  const d = seed(db, { status: "invited", slug: "inv123", invitedAt: "2026-11-10T10:00:00Z" });
  const e = seed(db, { status: "not_now" });
  db.raw.prepare("UPDATE invite_requests SET referral = 'allen' WHERE id = ?").run(a);
  return { a, b, c, d, e };
}
const PAGES = ["new", "not_now", "approved", "built", "invited", "all", "server_emails"];

test("M1 every input and textarea is tied to a label (for/id), ids unique, on every tab", async () => {
  const db = makeD1(); populate(db);
  for (const tab of PAGES) {
    const { body } = await adminGet(db, `?show=${tab}`);
    const ids = [...body.matchAll(/<(?:input|textarea)\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/type="hidden"/.test(t) && !/enter-guard/.test(t));
    const seen = new Set();
    for (const t of ids) {
      const id = (t.match(/\sid="([^"]+)"/) || [])[1];
      assert.ok(id, `${tab}: input without id: ${t.slice(0, 80)}`);
      assert.ok(!seen.has(id), `${tab}: duplicate id ${id}`); seen.add(id);
      assert.ok(new RegExp(`<label[^>]*\\sfor="${id}"`).test(body), `${tab}: no <label for="${id}">`);
    }
  }
  const all = (await adminGet(db, "?show=all")).body;
  assert.ok(/for="slug-\d+"/.test(all) || /for="note-\d+"/.test(all), "labels exist");
});

test("M2 the active tab has aria-current=page (exactly one); the nav is named; other tabs are links without it", async () => {
  const db = makeD1(); populate(db);
  for (const tab of PAGES) {
    const { body } = await adminGet(db, `?show=${tab}`);
    const nav = body.split('<nav class="tabs" aria-label="Request stages">')[1].split("</nav>")[0];
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1, tab);
    assert.ok(!/<a [^>]*aria-current/.test(nav), tab);
  }
});

test("M3 the Needs you line is announced (role=status)", async () => {
  const db = makeD1(); populate(db);
  const { body } = await adminGet(db, "?show=new");
  assert.ok(/<p class="need" role="status"><b>Needs you:/.test(body));
});

test("M4 text fields are 16px or more (iOS does not zoom on focus); buttons 44px; focus ring; phone rules at 600px", async () => {
  const db = makeD1(); populate(db);
  const { body } = await adminGet(db, "?show=new");
  const css = body.split("<style>")[1].split("</style>")[0];
  assert.match(css, /input,textarea,select\{font-size:16px\}/);
  assert.match(css, /button\{min-height:44px;min-width:44px/);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--focus\)/);
  const phone = css.split("@media (max-width:600px){")[1];
  assert.ok(phone, "a max-width:600px block");
  assert.match(phone, /dl\{grid-template-columns:1fr/);
  assert.match(phone, /\.buttons\{flex-direction:column/);
  assert.match(phone, /\.buttons button\{width:100%\}/);
  assert.match(phone, /\.tabs a,\.tabs b\{[^}]*min-height:44px/);
  assert.match(css, /dl\{display:grid;grid-template-columns:10rem 1fr/, "wide screens keep the 10rem column");
  assert.match(css, /button\[value="not_now"\][^{]*\{margin-left:1rem/, "Not now set apart");
});

test("M5 no behavior change: the same action buttons and values on the New tab, and the focus color is set for dark", async () => {
  const db = makeD1(); populate(db);
  const { body } = await adminGet(db, "?show=new");
  for (const v of ["approve_only", "approve_build", "not_now", "note"]) assert.ok(body.includes(`value="${v}"`), v);
  assert.match(body, /:root\[data-theme="dark"\]\{--focus:#8ec1f0\}/);
});

test("M6 (dump) render pages for the browser check when ADMIN_DUMP_DIR is set", async () => {
  const dir = process.env.ADMIN_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const db = makeD1(); populate(db);
  const ins = (rid, tenant, status) => db.raw.prepare("INSERT INTO invite_mail (request_id, tenant, template, status, created_at) VALUES (?, ?, ?, ?, '2026-11-22T10:00:00Z')").run(rid, tenant, tenant ? "loaded" : "invite", status);
  ins(null, "t01", "delivered"); ins(null, "t02", "failed"); ins(4, null, "bounced"); ins(4, null, "delivered");
  for (const tab of PAGES) writeFileSync(`${dir}/${tab}.html`, (await adminGet(db, `?show=${tab}`)).body);
});
