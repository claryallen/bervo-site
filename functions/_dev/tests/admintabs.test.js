// Tests for CR-ADMINTABS.1 (the admin page's tabs by stage) and CR-SIGNUPSIGNAL.1's bervo.ai side (/api/provision-state
// action signed_up, migration 0009, "Signed up <time>" on the card, reminders stop). D1 is node:sqlite with the real
// migrations; Access is mocked; every secret is made up.
// Run: node --experimental-default-type=module --test functions/_dev/tests/admintabs.test.js   (Node 22+, no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as admin from "../../admin/invites.js";
import * as stateApi from "../../api/provision-state.js";
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
function makeD1({ signedUp = true } = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const n of BASE_MIGRATIONS) sql.exec(MIG(n));
  if (signedUp) sql.exec(MIG("0009_signed_up.sql"));
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    raw: sql,
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

const ENV = (db, over = {}) => ({ DB: db, BERVO_PROVISION_SECRET: SECRET, BERVO_LINK_KEY: "fake-link-key-0123456789abcdef-0123456789",
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
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))).toString("hex");
}
async function state(db, body) {
  const raw = JSON.stringify({ ...body, nonce: crypto.randomUUID() });
  const ts = Math.floor(NOW / 1000);
  const res = await stateApi.onRequestPost({ request: new Request(`${ORIGIN}/api/provision-state`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-bervo-provision-ts": String(ts), "x-bervo-provision-sig": await hmac(SECRET, `${ts}.${raw}`) }, body: raw }),
    env: ENV(db), nowMs: NOW, say: () => {} });
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const ids = (body) => [...body.matchAll(/<article class="req" id="r(\d+)">/g)].map((m) => Number(m[1]));
const art = (body, id) => body.split(`<article class="req" id="r${id}">`)[1]?.split("</article>")[0] || "";

// ---------- per-tab membership: every status x build state ----------
const STATUSES = ["new", "approved", "not_now", "invited", "expired"];
const BUILDS = [null, "queued", "waiting_cap", "building", "ready", "failed", "stopped"];
function expectedTabs(status, build, signedUp) {
  const stage = status === "approved" ? (build === "ready" ? "built" : "approved")
    : status === "invited" ? (signedUp ? "signed_up" : "invited") : status;
  const needs = stage === "new" || stage === "built" || stage === "signed_up"
    || (status === "approved" && (build === "failed" || build === "stopped"));
  return { stage, needs };
}

test("T1 every status x build state (and signed up) lives in exactly one stage tab, plus All; Needs you holds new, built, failed/stopped builds and signed-up requests", async () => {
  const db = makeD1();
  const cases = [];
  for (const status of STATUSES) {
    for (const build of BUILDS) {
      for (const signedUp of status === "invited" ? [false, true] : [false]) {
        const id = seed(db, { status, slug: build ? `zz${cases.length}` : null });
        if (build) setProv(db, id, build);
        if (signedUp) db.raw.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ?").run("2026-11-22T10:00:00Z", id);
        cases.push({ id, status, build, signedUp });
      }
    }
  }
  const cid = claimed(db);
  cases.push({ id: cid, status: "claimed", build: null, signedUp: false });
  const tabs = ["needs", "new", "approved", "built", "invited", "signed_up", "not_now", "expired", "claimed", "all"];
  const got = {};
  for (const t of tabs) got[t] = new Set(ids((await adminGet(db, `?show=${t}`)).body));
  for (const c of cases) {
    const { stage, needs } = expectedTabs(c.status, c.build, c.signedUp);
    const label = `${c.status}/${c.build}/${c.signedUp ? "signed" : "-"}`;
    for (const t of ["new", "approved", "built", "invited", "signed_up", "not_now", "expired", "claimed"])
      assert.equal(got[t].has(c.id), t === stage, `${label} in ${t}?`);
    assert.equal(got.needs.has(c.id), needs, `${label} in Needs you?`);
    assert.ok(got.all.has(c.id), `${label} in All`);
  }
});

test("T2 Needs you is the default; ?show=open (old links) opens it; a bounced or failed email puts an invited/approved request there", async () => {
  const db = makeD1();
  const a = seed(db, { status: "invited", slug: "zz-a", invitedAt: "2026-11-21T10:00:00Z" });
  const b = seed(db, { status: "invited", slug: "zz-b", invitedAt: "2026-11-21T10:00:00Z" });
  const c = seed(db, { status: "invited", slug: "zz-c", invitedAt: "2026-11-21T10:00:00Z" });
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'bounced', '2026-11-21T10:00:00Z')").run(a);
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'failed', '2026-11-21T10:00:00Z')").run(b);
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'delivered', '2026-11-21T10:00:00Z')").run(c);
  const def = (await adminGet(db)).body;
  assert.ok(def.includes("<b>Needs you (2)</b>"), "default tab, with its count");
  assert.deepEqual(ids(def).sort(), [a, b].sort());
  assert.ok(art(def, a).includes("An email to them bounced") && art(def, b).includes("The last email was not sent"));
  const old = (await adminGet(db, "?show=open")).body;
  assert.ok(old.includes("<b>Needs you (2)</b>") && ids(old).length === 2, "old ?show=open link");
  assert.ok((await adminGet(db, "?show=nonsense")).body.includes("<b>Needs you (2)</b>"));
});

test("T3 one nonce script on every tab; the copy-it-yourself box is always folded under 'Send it yourself instead'; no em dashes", async () => {
  const db = makeD1();
  const ap = seed(db, { status: "approved", slug: "zz-ap" });
  const bu = seed(db, { status: "approved", slug: "zz-bu" }); setProv(db, bu, "ready");
  const inv = seed(db, { status: "invited", slug: "zz-in", invitedAt: "2026-11-21T10:00:00Z" });
  seed(db, { status: "new" }); seed(db, { status: "not_now" }); claimed(db);
  for (const t of ["needs", "new", "approved", "built", "invited", "signed_up", "not_now", "expired", "claimed", "all", "server_emails"]) {
    const { status, body } = await adminGet(db, `?show=${t}`);
    assert.equal(status, 200, t);
    assert.equal((body.match(/<script/g) || []).length, 1, `${t}: only the page's own nonce script`);
    assert.ok(!body.includes("—"), `${t}: no em dash`);
    for (const id of ids(body)) {
      const a = art(body, id);
      if (a.includes('class="copy"')) assert.ok(a.includes('<details class="other"><summary>Send it yourself instead</summary><div class="copy"'), `${t} #${id}: folded`);
    }
  }
  const all = (await adminGet(db, "?show=all")).body;
  for (const id of [ap, bu, inv]) assert.ok(art(all, id).includes('<details class="other"><summary>Send it yourself instead</summary>'), `#${id} has the fold`);
});

test("T4 cards: a summary line always shown; form answers + about + note fold, open only on New and Needs you; compact one-line rows on Not now / Expired / Claimed / All", async () => {
  const db = makeD1();
  const n = seed(db, { status: "new" });
  const ap = seed(db, { status: "approved", slug: "zz-ap" });
  const nn = seed(db, { status: "not_now" });
  for (const [t, id, open] of [["needs", n, true], ["new", n, true], ["approved", ap, false]]) {
    const a = art((await adminGet(db, `?show=${t}`)).body, id);
    assert.ok(a.includes('<p class="sum">Dedicated $99/mo · America/Chicago · '), `${t}: summary line`);
    assert.ok(a.includes(`<details class="answers"${open ? " open" : ""}><summary>`), `${t}: answers ${open ? "open" : "closed"}`);
    const fold = a.split('<details class="answers"')[1].split("</details>")[0];
    assert.ok(fold.includes("I run a small firm.") && fold.includes('name="note"') && fold.includes("pat@example.com"), `${t}: answers, about and note inside`);
  }
  const nnPage = (await adminGet(db, "?show=not_now")).body;
  assert.ok(nnPage.includes(`<details class="row"><summary>#${nn} · Pat Sample · `), "compact row");
  assert.ok(!(await adminGet(db, "?show=new")).body.includes('<details class="row">'), "New is not compact");
});

test("T5 Server emails: the account-email list only on its own tab", async () => {
  const db = makeD1();
  seed(db, { status: "new" });
  db.raw.prepare("INSERT INTO invite_mail (tenant, template, status, created_at) VALUES ('zz-t', 'loaded', 'sent', '2026-11-22T10:00:00Z')").run();
  assert.ok(!(await adminGet(db)).body.includes("Account emails by server"));
  assert.ok(!(await adminGet(db, "?show=all")).body.includes("Account emails by server"));
  const se = (await adminGet(db, "?show=server_emails")).body;
  assert.ok(se.includes("Account emails by server") && ids(se).length === 0);
});

test("T6 Built: approved + build ready; Send invite email (delivered link) first in the card", async () => {
  const db = makeD1();
  const id = seed(db, { status: "approved", slug: "zz-bu" }); setProv(db, id, "ready");
  db.raw.prepare("INSERT INTO invite_links (request_id, kind, iv, ct, created_at, expires_at) VALUES (?, 'invite', 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBB', ?, ?)")
    .run(id, new Date(NOW).toISOString(), new Date(NOW + 86400000).toISOString());
  const a = art((await adminGet(db, "?show=built")).body, id);
  assert.ok(a.includes("Needs you:</b> Server ready: send the invite email."));
  assert.ok(a.indexOf('value="send_invite_stored"') > -1 && a.indexOf('value="send_invite_stored"') < a.indexOf('class="act">'), "first");
});

test("T7 300 requests: the page reads them in chunks under D1's 100-parameter limit", async () => {
  const db = makeD1();
  for (let i = 0; i < 150; i++) seed(db, { status: "invited", slug: `zz${i}`, invitedAt: "2026-11-21T10:00:00Z" });
  const { status, body } = await adminGet(db, "?show=invited");
  assert.equal(status, 200);
  assert.equal(ids(body).length, 150);
});

// ---------- CR-SIGNUPSIGNAL.1: signed up ----------
test("S1 signed_up: recorded once on an invited request (no run id needed), then 'already'; refused for other statuses", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-21T10:00:00Z" });
  const other = seed(db, { status: "approved", slug: "zz-o" });
  let r = await state(db, { action: "signed_up", request_id: id });
  assert.deepEqual([r.status, r.body.result], [200, "recorded"]);
  assert.equal(db.raw.prepare("SELECT signed_up_at FROM invite_requests WHERE id = ?").get(id).signed_up_at, new Date(NOW).toISOString());
  r = await state(db, { action: "signed_up", request_id: id });
  assert.deepEqual([r.status, r.body.result], [200, "already"], "a repeat is fine and changes nothing");
  r = await state(db, { action: "signed_up", request_id: other });
  assert.deepEqual([r.status, r.body.result], [409, "not_allowed"]);
  assert.equal(db.raw.prepare("SELECT signed_up_at FROM invite_requests WHERE id = ?").get(other).signed_up_at, null);
  r = await state(db, { action: "signed_up", request_id: 999 });
  assert.equal(r.status, 409);
});

test("S2 before migration 0009: the endpoint answers 503 not_configured and the page still draws (no sign-ups shown)", async () => {
  const db = makeD1({ signedUp: false });
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-21T10:00:00Z" });
  const r = await state(db, { action: "signed_up", request_id: id });
  assert.deepEqual([r.status, r.body.result], [503, "not_configured"]);
  for (const t of ["needs", "invited", "signed_up", "all"]) assert.equal((await adminGet(db, `?show=${t}`)).status, 200, t);
  assert.deepEqual(ids((await adminGet(db, "?show=invited")).body), [id]);
  assert.deepEqual(ids((await adminGet(db, "?show=signed_up")).body), []);
});

test("S3 a signed-up request: 'Signed up <time>' on the card, under Signed up and Needs you, Mark claimed first; reminders stop", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-19T10:00:00Z" });
  const before = art((await adminGet(db, "?show=invited")).body, id);
  assert.ok(before.includes("Day-3 reminder due"), "day 4, not signed up: the reminder is due");
  await state(db, { action: "signed_up", request_id: id });
  const page = (await adminGet(db, "?show=signed_up")).body;
  const a = art(page, id);
  assert.ok(a.includes(`<b>Signed up ${new Date(NOW).toISOString().replace("T", " ").slice(0, 16)} UTC</b>`), "Signed up <time>");
  assert.ok(a.includes("Needs you:</b> Signed up: press Mark claimed"));
  const buttons = a.split('<div class="buttons">')[1].split("</div>")[0];
  assert.ok(buttons.indexOf('value="claimed"') < buttons.indexOf('value="expired"') && buttons.startsWith('<button name="action" value="claimed"'), "Mark claimed first");
  assert.ok(!a.includes("Day-3 reminder due"), "no reminder once signed up");
  assert.ok(ids((await adminGet(db)).body).includes(id), "in Needs you");
  assert.ok(!ids((await adminGet(db, "?show=invited")).body).includes(id), "no longer under Invited");
  const row = db.raw.prepare("SELECT * FROM invite_requests WHERE id = ?").get(id);
  assert.equal(reminderDue(row, [], NOW), null);
  assert.equal(reminderDue({ ...row, signed_up_at: null }, [], NOW), "reminder_day3");
});

test("S4 Invited shows the reminder dates and when the invitation ends", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-21T10:00:00Z" });
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'delivered', '2026-11-21T10:00:00Z')").run(id);
  const a = art((await adminGet(db, "?show=invited")).body, id);
  assert.ok(a.includes('Invite email: <span class="ms ms-delivered">delivered</span> · Day-3 reminder 2026-11-24 10:00 UTC · Day-10 reminder 2026-12-01 10:00 UTC · Invitation ends 2026-12-05 10:00 UTC'), a.match(/<p class="timeline">.*?<\/p>/)?.[0]);
});

test("S5 0009 adds one nullable date column and nothing else", () => {
  const sqlText = MIG("0009_signed_up.sql").split("\n").filter((l) => !l.startsWith("--") && l.trim()).join(" ");
  assert.equal(sqlText.trim(), "ALTER TABLE invite_requests ADD COLUMN signed_up_at TEXT;");
});
