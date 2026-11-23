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
  // CR-ONBOARDEDTAB.1: a signed-up request is no longer under Needs you
  const needs = stage === "new" || stage === "built"
    || (status === "approved" && (build === "failed" || build === "stopped"));
  return { stage, needs };
}

test("T1 every status x build state (and signed up) lives in exactly one stage tab, plus All; each request that needsYou() flags shows its warning line in its own tab and the tab label carries a marker (CR-ADMINTABS.2: no Needs you tab)", async () => {
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
  cases.push({ id: cid, status: "onboarded", build: null, signedUp: false });
  const tabs = ["new", "approved", "built", "invited", "signed_up", "not_now", "expired", "onboarded", "all"];
  const got = {};
  for (const t of tabs) got[t] = new Set(ids((await adminGet(db, `?show=${t}`)).body));
  for (const c of cases) {
    const { stage, needs } = expectedTabs(c.status, c.build, c.signedUp);
    const label = `${c.status}/${c.build}/${c.signedUp ? "signed" : "-"}`;
    for (const t of ["new", "approved", "built", "invited", "signed_up", "not_now", "expired", "onboarded"])
      assert.equal(got[t].has(c.id), t === stage, `${label} in ${t}?`);
    const card = art((await adminGet(db, `?show=${stage}`)).body, c.id);
    assert.equal(card.includes("Needs you:</b>"), needs, `${label} warning line on its card`);
    assert.ok(got.all.has(c.id), `${label} in All`);
  }
  // every request needing Allen is counted in its tab's label marker
  for (const [t, want] of [["new", 1], ["built", 1]]) {
    const n = cases.filter((c) => expectedTabs(c.status, c.build, c.signedUp).stage === t).length;
    assert.ok((await adminGet(db)).body.includes(`${t === "new" ? "New" : "Ready"} (${n})`), `${t} label count`);
  }
});

test("T2 New is the default; ?show=open and ?show=needs (old links) open it; a bounced or failed email shows on the invited card and in the Invited label", async () => {
  const db = makeD1();
  const a = seed(db, { status: "invited", slug: "zz-a", invitedAt: "2026-11-21T10:00:00Z" });
  const b = seed(db, { status: "invited", slug: "zz-b", invitedAt: "2026-11-21T10:00:00Z" });
  const c = seed(db, { status: "invited", slug: "zz-c", invitedAt: "2026-11-21T10:00:00Z" });
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'bounced', '2026-11-21T10:00:00Z')").run(a);
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'failed', '2026-11-21T10:00:00Z')").run(b);
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'delivered', '2026-11-21T10:00:00Z')").run(c);
  const def = (await adminGet(db)).body;
  assert.ok(def.includes("<b>New (0)</b>") && ids(def).length === 0, "default tab is New");
  assert.ok(def.includes('<a href="/admin/invites?show=invited">Invited (3, 1 bounced, 1 not sent)</a>'), "label markers");
  const inv = (await adminGet(db, "?show=invited")).body;
  assert.deepEqual(ids(inv).sort(), [a, b, c].sort());
  assert.ok(art(inv, a).includes("An email to them bounced") && art(inv, b).includes("The last email was not sent"));
  assert.ok(!art(inv, c).includes("Needs you:</b>"));
  for (const q of ["?show=open", "?show=needs", "?show=nonsense"]) {
    const old = (await adminGet(db, q)).body;
    assert.ok(old.includes("<b>New (0)</b>") && ids(old).length === 0, `${q} opens New`);
  }
});

test("T3 one nonce script on every tab; the copy-it-yourself box is always folded under 'Send it yourself instead'; no em dashes", async () => {
  const db = makeD1();
  const ap = seed(db, { status: "approved", slug: "zz-ap" });
  const bu = seed(db, { status: "approved", slug: "zz-bu" }); setProv(db, bu, "ready");
  const inv = seed(db, { status: "invited", slug: "zz-in", invitedAt: "2026-11-21T10:00:00Z" });
  seed(db, { status: "new" }); seed(db, { status: "not_now" }); claimed(db);
  for (const t of ["new", "approved", "built", "invited", "signed_up", "not_now", "expired", "onboarded", "all", "server_emails"]) {
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

test("T4 cards: a summary line always shown; form answers + about + note fold, open only on New; compact one-line rows on Deferred / Expired / Claimed / All", async () => {
  const db = makeD1();
  const n = seed(db, { status: "new" });
  const ap = seed(db, { status: "approved", slug: "zz-ap" });
  const nn = seed(db, { status: "not_now" });
  for (const [t, id, open] of [["new", n, true], ["approved", ap, false]]) {
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

test("S3 a signed-up request: 'Signed up <time>' on the card, under Signed up (not Needs you), Mark onboarded first; reminders stop", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-19T10:00:00Z" });
  const before = art((await adminGet(db, "?show=invited")).body, id);
  assert.ok(before.includes("Day-3 reminder due"), "day 4, not signed up: the reminder is due");
  await state(db, { action: "signed_up", request_id: id });
  const page = (await adminGet(db, "?show=signed_up")).body;
  const a = art(page, id);
  assert.ok(a.includes(`<b>Signed up ${new Date(NOW).toISOString().replace("T", " ").slice(0, 16)} UTC</b>`), "Signed up <time>");
  assert.ok(!a.includes("Needs you:</b>"), "no Needs you line");
  const buttons = a.split('<div class="buttons">')[1].split("</div>")[0];
  assert.ok(buttons.indexOf('value="claimed"') < buttons.indexOf('value="expired"') && buttons.startsWith('<button name="action" value="claimed"'), "Mark onboarded first");
  assert.ok(!a.includes("Day-3 reminder due"), "no reminder once signed up");
  assert.ok(a.includes('<p class="timeline">Reminders stopped (signed up)</p>'), "the reminder line");
  assert.ok(!ids((await adminGet(db)).body).includes(id), "not in Needs you");
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

test("T8 a signed-up request with an old bounce: no warning, no marker on Invited (CR-ONBOARDEDTAB.1; it waits in Signed up)", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-19T10:00:00Z" });
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'reminder_day3', 'bounced', '2026-11-22T10:00:00Z')").run(id);
  assert.ok(art((await adminGet(db, "?show=invited")).body, id).includes("An email to them bounced"), "before: the bounce");
  assert.ok((await adminGet(db)).body.includes("Invited (1, 1 bounced)"), "before: the label marker");
  db.raw.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ?").run("2026-11-23T10:00:00Z", id);
  assert.ok((await adminGet(db)).body.includes("Invited (0)"), "no marker once signed up");
  const a = art((await adminGet(db, "?show=signed_up")).body, id);
  assert.ok(!a.includes("Needs you:</b>") && !a.includes("An email to them bounced"));
});

test("T9 every row button has a tooltip (Mark onboarded and Mark expired included)", async () => {
  const db = makeD1();
  seed(db, { status: "new" }); seed(db, { status: "approved", slug: "zz-a" });
  seed(db, { status: "invited", slug: "zz-i", invitedAt: "2026-11-21T10:00:00Z" });
  const s = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-21T10:00:00Z" });
  db.raw.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ?").run("2026-11-22T10:00:00Z", s);
  const body = (await adminGet(db, "?show=all")).body;
  const btns = [...body.matchAll(/<button name="action" value="([a-z_]+)"[^>]*>/g)];
  assert.ok(btns.some((m) => m[1] === "claimed") && btns.some((m) => m[1] === "expired"));
  for (const m of btns) assert.ok(/ title="[^"]+"/.test(m[0]), m[0]);
});

// ---------- CR-ONBOARDEDTAB.1: Onboarded (was Claimed), keep only First L + address + email + plan + request date ----------
async function adminPost(db, fields, env = ENV(db)) {
  _resetAccessKeyCache();
  const res = await admin.onRequestPost({ request: new Request(`${ORIGIN}/admin/invites`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": await makeJwt(), Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams(fields).toString() }), env, fetchImpl: certsFetch, nowMs: NOW });
  return { status: res.status, location: res.headers.get("Location") };
}
const ONBOARD_TIP = "This customer is onboarded. Erases their form details and dates on bervo.ai; keeps their first name and last initial, Bervo address, email address, plan and request date.";
const TRIMMED = ["first_name", "last_name", "email", "has_assistant", "email_providers", "other_email", "computers", "phone",
  "heard_from", "heard_detail", "timezone", "about", "referral", "slug", "note"];
const ERASED_DATES = ["approved_at", "invited_at", "signed_up_at", "status_changed_at"];
const row = (db, id) => db.raw.prepare("SELECT * FROM invite_requests WHERE id = ?").get(id);
const count = (db, table, id) => Number(db.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id = ?`).get(id).n);
function records(db, id) {   // an email record, a build record and a waiting link for this request
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, address_hash, created_at) VALUES (?, 'invite', 'delivered', 'abcdef0123456789', '2026-11-21T10:00:00Z')").run(id);
  setProv(db, id, "ready");
  db.raw.prepare("INSERT INTO invite_links (request_id, kind, iv, ct, created_at, expires_at) VALUES (?, 'reminder3', 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBB', ?, ?)")
    .run(id, new Date(NOW).toISOString(), new Date(NOW + 86400000).toISOString());
}

test("O1 the tab is 'Onboarded' (old ?show=claimed links land there); the button is 'Mark onboarded' with its tooltip; no 'Claimed' / 'Mark claimed' words left", async () => {
  const db = makeD1();
  const s = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-21T10:00:00Z" });
  db.raw.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ?").run("2026-11-22T10:00:00Z", s);
  const i = seed(db, { status: "invited", slug: "zz-i", invitedAt: "2026-11-21T10:00:00Z" });
  const c = claimed(db);
  const old = (await adminGet(db, "?show=claimed")).body;
  assert.ok(old.includes("<b>Onboarded (1)</b>") && ids(old).includes(c), "old link opens Onboarded");
  assert.ok((await adminGet(db, "?show=onboarded")).body.includes("<b>Onboarded (1)</b>"));
  for (const t of ["needs", "all", "signed_up", "invited", "onboarded"]) {
    const body = (await adminGet(db, `?show=${t}`)).body;
    assert.ok(!/Claimed|Mark claimed|claimed\b(?!")/.test(body.replace(/value="claimed"/g, "")), `${t}: no 'claimed' wording`);
  }
  for (const id of [s, i]) {
    const a = art((await adminGet(db, "?show=all")).body, id);
    assert.ok(a.includes(`<button name="action" value="claimed" type="submit" title="${ONBOARD_TIP}">Mark onboarded</button>`), `#${id}`);
  }
});

test("O2 Mark onboarded (0009 + 0010): keeps ONLY id, status, plan, the request date, First L, address and email; every form field and other date erased, cohort reset; the card", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "reh1120", invitedAt: "2026-11-20T11:00:00Z", first: "Ashley", last: "clary" });
  db.raw.prepare("UPDATE invite_requests SET signed_up_at = ?, note = 'private note', other_email = 'x', referral = 'allen', cohort = 'private' WHERE id = ?").run("2026-11-20T14:06:31.000Z", id);
  const before = row(db, id);
  const res = await adminPost(db, { id: String(id), action: "claimed" });
  assert.deepEqual([res.status, res.location], [303, `/admin/invites#r${id}`]);
  const r = row(db, id);
  const kept = Object.entries(r).filter(([, v]) => v !== null).map(([k]) => k).sort();
  assert.deepEqual(kept, ["created_at", "id", "kept_email", "kept_host", "kept_name", "plan", "privacy_agreed_at", "status", "cohort"].sort(),
    "the only non-empty columns (cohort is NOT NULL: reset to 'public')");
  assert.deepEqual([r.status, r.cohort, r.kept_name, r.kept_host, r.kept_email], ["claimed", "public", "Ashley C", "reh1120", "pat@example.com"]);
  for (const c of [...TRIMMED, ...ERASED_DATES]) assert.equal(r[c], null, c);
  for (const c of ["id", "created_at", "plan", "privacy_agreed_at"]) assert.equal(r[c], before[c], c);
  const page = (await adminGet(db, "?show=onboarded")).body;
  const a = art(page, id);
  assert.ok(a.includes(`<p class="sum">Ashley C · reh1120.bervo.ai · requested 2026-11-20 10:00 UTC</p>`), a);
  assert.ok(a.includes("#" + id + " · Ashley C <span class=\"status s-onboarded\">onboarded</span>"));
  assert.ok(a.includes(`<p class="notice">${ONBOARD_TIP}</p>`), "the notice: the tooltip's words, listing only what is kept");
  assert.ok(a.includes("<dl><dt>Requested</dt><dd>2026-11-20 10:00 UTC</dd><dt>Plan</dt><dd>Dedicated $99/mo</dd></dl>"), "no other date, no cohort");
  for (const w of ["Onboarded</dt>", "Signed up", "Approved", "Invited", "Cohort", "onboarded 20", "signed up 20", " UTC UTC", "> UTC"]) assert.ok(!a.includes(w), w);
  const sum = a.match(/<p class="sum">.*?<\/p>/)[0], h2 = a.match(/<h2>.*?<\/h2>/)[0];
  assert.ok(!sum.includes("example.com") && !h2.includes("example.com"), "the email is not on the summary line or heading");
  assert.ok(a.includes('<details class="answers"><summary>Email address</summary><p><!--email_off-->pat@example.com<!--/email_off--></p></details>'), "only inside the folded details");
  assert.ok(!page.includes("Sample") && !page.includes("private note") && !page.includes("small firm"), "nothing else from the form");
  assert.ok(page.includes(`<details class="row"><summary>#${id} · Ashley C · <span class="status s-onboarded">onboarded</span> · Dedicated $99/mo · 2026-11-20 10:00 UTC</summary>`), "compact row: the request date");
  assert.equal((page.match(/<script/g) || []).length, 1); assert.ok(!page.includes("—"));
});

test("O3 older databases: before 0010 the trim + date erase run without kept fields ('(trimmed)'); before 0009 too", async () => {
  for (const [label, opts] of [["no 0010", { kept: false }], ["no 0009, no 0010", { signedUp: false }]]) {
    const db = makeD1(opts);
    const id = seed(db, { status: "invited", slug: "zz-o", invitedAt: "2026-11-20T11:00:00Z" });
    records(db, id);
    assert.equal((await adminPost(db, { id: String(id), action: "claimed" })).status, 303, label);
    const r = row(db, id);
    assert.equal(r.status, "claimed", label);
    for (const c of [...TRIMMED, "approved_at", "invited_at", "status_changed_at"]) assert.equal(r[c], null, `${label}: ${c}`);
    assert.ok(!("kept_name" in r), label);
    assert.deepEqual([count(db, "invite_mail", id), count(db, "invite_provision", id), count(db, "invite_links", id)], [0, 0, 0], `${label}: records deleted`);
    const a = art((await adminGet(db, "?show=onboarded")).body, id);
    assert.ok(a.includes("(trimmed)") && a.includes('<p class="sum">requested 2026-11-20 10:00 UTC</p>') && !a.includes("Email address")
      && a.includes('<p class="notice">This customer is onboarded. Erases their form details and dates on bervo.ai; keeps their plan and request date.</p>'), `${label}: ${a}`);
  }
});

test("O4 0010: three nullable columns, refused on any row that is not onboarded and over their lengths; not safe to run twice", () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-c", invitedAt: "2026-11-20T11:00:00Z" });
  for (const c of ["kept_name", "kept_host", "kept_email"])
    assert.throws(() => db.raw.prepare(`UPDATE invite_requests SET ${c} = 'abc' WHERE id = ?`).run(id), /CHECK/, c);
  const c = claimed(db);
  db.raw.prepare("UPDATE invite_requests SET kept_name = 'Pat S', kept_host = 'zz-c', kept_email = 'a@b.co' WHERE id = ?").run(c);
  assert.throws(() => db.raw.prepare("UPDATE invite_requests SET kept_name = ? WHERE id = ?").run("x".repeat(41), c), /CHECK/);
  assert.throws(() => db.raw.prepare("UPDATE invite_requests SET kept_email = ? WHERE id = ?").run("x".repeat(255), c), /CHECK/);
  assert.throws(() => db.raw.exec(MIG("0010_onboarded_label.sql")), /duplicate column name: kept_name/);
  const stmts = MIG("0010_onboarded_label.sql").split("\n").filter((l) => l.trim() && !l.startsWith("--"));
  assert.equal(stmts.length, 3);
  assert.ok(stmts.every((l) => l.startsWith("ALTER TABLE invite_requests ADD COLUMN kept_")));
});

test("O5 signed_up_at: stored on the first report, clamped to [invited_at, now]; later reports only ever move it earlier; an onboarded request (no dates) answers 409 not_allowed and stays empty; a bad value refused", async () => {
  const db = makeD1();
  const inv = "2026-11-20T11:00:00Z";
  const mk = () => seed(db, { status: "invited", slug: `zz${Math.random().toString(36).slice(2, 8)}`, invitedAt: inv });
  const at = (id) => row(db, id).signed_up_at;
  let id = mk();
  let r = await state(db, { action: "signed_up", request_id: id, signed_up_at: "2026-11-20T14:06:31Z" });
  assert.deepEqual([r.status, r.body.result, at(id)], [200, "recorded", "2026-11-20T14:06:31.000Z"]);
  r = await state(db, { action: "signed_up", request_id: id, signed_up_at: "2026-11-21T09:00:00Z" });
  assert.deepEqual([r.body.result, at(id)], ["already", "2026-11-20T14:06:31.000Z"], "never later");
  r = await state(db, { action: "signed_up", request_id: id, signed_up_at: "2026-11-20T12:00:00Z" });
  assert.deepEqual([r.body.result, at(id)], ["corrected", "2026-11-20T12:00:00.000Z"], "earlier: corrected");
  r = await state(db, { action: "signed_up", request_id: id, signed_up_at: "2026-11-19T00:00:00Z" });
  assert.deepEqual([r.body.result, at(id)], ["corrected", "2026-11-20T11:00:00.000Z"], "never before invited_at");
  r = await state(db, { action: "signed_up", request_id: id });
  assert.deepEqual([r.body.result, at(id)], ["already", "2026-11-20T11:00:00.000Z"], "no field: unchanged");
  id = mk();
  r = await state(db, { action: "signed_up", request_id: id, signed_up_at: "2027-01-01T00:00:00Z" });
  assert.deepEqual([r.body.result, at(id)], ["recorded", new Date(NOW).toISOString()], "never in the future");
  id = mk();
  r = await state(db, { action: "signed_up", request_id: id });
  assert.deepEqual([r.body.result, at(id)], ["recorded", new Date(NOW).toISOString()], "no field: today's behavior (now)");
  // onboarded: every date erased; a late report (with or without a time) is refused cleanly and writes nothing
  id = mk();
  db.raw.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ?").run("2026-11-23T14:06:00.000Z", id);
  await adminPost(db, { id: String(id), action: "claimed" });
  for (const body of [{ signed_up_at: "2026-11-20T14:06:31Z" }, {}]) {
    r = await state(db, { action: "signed_up", request_id: id, ...body });
    assert.deepEqual([r.status, r.body.result, at(id), row(db, id).status], [409, "not_allowed", null, "claimed"], JSON.stringify(body));
  }
  const id2 = mk();
  for (const bad of ["2026-11-20 14:06:31", "2026-11-20T14:06:31", "2026-11-20T09:06:31-05:00", "yesterday", 5, "2026-13-45T99:99:99Z"]) {
    r = await state(db, { action: "signed_up", request_id: id2, signed_up_at: bad });
    assert.deepEqual([r.status, r.body.result], [400, "bad_signed_up_at"], String(bad));
  }
  assert.equal(at(id2), null, "a refused value changes nothing");
  const ap = seed(db, { status: "approved", slug: "zz-ap" });
  r = await state(db, { action: "signed_up", request_id: ap, signed_up_at: "2026-11-21T00:00:00Z" });
  assert.deepEqual([r.status, r.body.result, at(ap)], [409, "not_allowed", null]);
});

test("O6 a signed-up card: the invite email status, then 'Reminders stopped (signed up)' instead of the dates", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-s", invitedAt: "2026-11-21T10:00:00Z" });
  db.raw.prepare("INSERT INTO invite_mail (request_id, template, status, created_at) VALUES (?, 'invite', 'delivered', '2026-11-21T10:00:00Z')").run(id);
  db.raw.prepare("UPDATE invite_requests SET signed_up_at = ? WHERE id = ?").run("2026-11-22T10:00:00Z", id);
  const a = art((await adminGet(db, "?show=signed_up")).body, id);
  assert.ok(a.includes('<p class="timeline">Invite email: <span class="ms ms-delivered">delivered</span> · Reminders stopped (signed up)</p>'), a);
  assert.ok(!a.includes("Day-3 reminder") && !a.includes("Invitation ends"));
});

test("O7 Mark onboarded deletes this request's email records, build record and waiting links in the same batch; other requests' and server emails stay", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-a", invitedAt: "2026-11-20T11:00:00Z" });
  const other = seed(db, { status: "invited", slug: "zz-b", invitedAt: "2026-11-20T11:00:00Z" });
  records(db, id); records(db, other);
  db.raw.prepare("INSERT INTO invite_mail (tenant, template, status, created_at) VALUES ('zz-t', 'loaded', 'sent', '2026-11-22T10:00:00Z')").run();
  const batches = [];
  const env = ENV(db);
  const realBatch = db.batch.bind(db);
  env.DB = { ...db, batch: async (s) => { batches.push(s.length); return realBatch(s); } };
  await adminPost(db, { id: String(id), action: "claimed" }, env);
  assert.deepEqual(batches, [4], "one batch: the UPDATE + three deletes");
  assert.deepEqual([count(db, "invite_mail", id), count(db, "invite_provision", id), count(db, "invite_links", id)], [0, 0, 0]);
  assert.deepEqual([count(db, "invite_mail", other), count(db, "invite_provision", other), count(db, "invite_links", other)], [1, 1, 1], "another request untouched");
  assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM invite_mail WHERE tenant = 'zz-t'").get().n), 1, "server emails stay");
});

test("O8 any D1 error other than a missing column/table fails Mark onboarded visibly and changes nothing (never a silent plain trim)", async () => {
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-f", invitedAt: "2026-11-20T11:00:00Z" });
  records(db, id);
  const before = row(db, id);
  const env = ENV(db);
  let calls = 0;
  env.DB = { ...db, batch: async () => { calls += 1; throw new Error("D1_ERROR: database is locked: SQLITE_BUSY"); },
    prepare: (q) => { const st = db.prepare(q); if (/^UPDATE invite_requests/.test(q)) st.run = async () => { throw new Error("a plain UPDATE must not run"); }; return st; } };
  const res = await adminPost(db, { id: String(id), action: "claimed" }, env);
  assert.deepEqual([res.status, res.location], [303, `/admin/invites?sent=onboard_failed&r=${id}#r${id}`]);
  assert.equal(calls, 1, "no retry in another form");
  assert.deepEqual(row(db, id), before, "the row is unchanged");
  assert.deepEqual([count(db, "invite_mail", id), count(db, "invite_provision", id), count(db, "invite_links", id)], [1, 1, 1], "records unchanged");
  const a = art((await adminGet(db, `?sent=onboard_failed&r=${id}`)).body, id);
  assert.ok(a.includes("Not marked onboarded: bervo.ai could not save it, so nothing changed. Try again."), "the message on its card");
  // a real failure inside the batch (a constraint) rolls the whole batch back
  db.raw.exec("CREATE TRIGGER no_del BEFORE DELETE ON invite_links BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  const res2 = await adminPost(db, { id: String(id), action: "claimed" });
  assert.equal(res2.location, `/admin/invites?sent=onboard_failed&r=${id}#r${id}`);
  assert.deepEqual(row(db, id), before, "rolled back: still invited, nothing trimmed");
  assert.deepEqual([count(db, "invite_mail", id), count(db, "invite_provision", id)], [1, 1], "rolled back: records kept");
});

test("O9 kept_name is the FIRST WORD of the first name + the last initial (a full name typed as the first name never keeps the last name)", async () => {
  const { keptLabel } = await import("../../_lib/invites.js");
  for (const [first, last, want] of [["Ashley", "clary", "Ashley C"], ["Ashley Clary", "Clary", "Ashley C"], ["  Mary​ Ann  Smith ", "Jones", "Mary J"],
    ["A".repeat(80), "Zed", "A".repeat(38) + " Z"], ["Ann", "", "Ann"], ["", "Zed", null]])
    assert.equal(keptLabel({ first_name: first, last_name: last }).kept_name, want, JSON.stringify(first));
  const db = makeD1();
  const id = seed(db, { status: "invited", slug: "zz-w", invitedAt: "2026-11-20T11:00:00Z", first: "Ashley Clary", last: "Clary" });
  await adminPost(db, { id: String(id), action: "claimed" });
  assert.equal(row(db, id).kept_name, "Ashley C");
  assert.ok(!(await adminGet(db, "?show=onboarded")).body.includes("Clary"));
});

test("O10 0011 (the one-time sweep of requests onboarded under the old trim): dates erased, cohort reset, their records deleted; others untouched; kept_* stay NULL; safe to run twice", () => {
  const db = makeD1();
  const SWEEP = MIG("0011_sweep_claimed.sql");
  // an old-trim onboarded row: dates, cohort private, email/build/link records
  const old = claimed(db);
  db.raw.prepare("UPDATE invite_requests SET approved_at = '2026-11-02T10:00:00Z', invited_at = '2026-11-03T10:00:00Z', signed_up_at = '2026-11-04T10:00:00Z', cohort = 'private' WHERE id = ?").run(old);
  records(db, old);
  const open = seed(db, { status: "invited", slug: "zz-open", invitedAt: "2026-11-20T11:00:00Z" });
  records(db, open);
  db.raw.prepare("INSERT INTO invite_mail (tenant, template, status, created_at) VALUES ('zz-t', 'loaded', 'sent', '2026-11-22T10:00:00Z')").run();
  const openBefore = row(db, open);
  // the preview SELECTs (comment lines starting "-- SELECT") run and return counts only
  const previews = SWEEP.split("\n").filter((l) => l.startsWith("-- SELECT")).map((l) => l.slice(3));
  assert.equal(previews.length, 2);
  const p1 = db.raw.prepare(previews[0]).get(), p2 = db.raw.prepare(previews[1]).get();
  assert.deepEqual({ ...p1 }, { onboarded: 1, with_dates_or_cohort: 1 });
  assert.deepEqual({ ...p2 }, { email_records: 1, build_records: 1, links: 1 });
  db.raw.exec(SWEEP);
  const r = row(db, old);
  for (const c of ["approved_at", "invited_at", "signed_up_at", "status_changed_at", "kept_name", "kept_host", "kept_email"]) assert.equal(r[c], null, c);
  assert.deepEqual([r.status, r.cohort, r.plan, r.created_at], ["claimed", "public", "private", "2026-11-01T10:00:00Z"]);
  assert.deepEqual([count(db, "invite_mail", old), count(db, "invite_provision", old), count(db, "invite_links", old)], [0, 0, 0]);
  assert.deepEqual(row(db, open), openBefore, "an open request untouched");
  assert.deepEqual([count(db, "invite_mail", open), count(db, "invite_provision", open), count(db, "invite_links", open)], [1, 1, 1]);
  assert.equal(Number(db.raw.prepare("SELECT count(*) AS n FROM invite_mail WHERE tenant = 'zz-t'").get().n), 1, "server emails untouched (their own 90-day rule)");
  const after = JSON.stringify(db.raw.prepare("SELECT * FROM invite_requests ORDER BY id").all());
  db.raw.exec(SWEEP);
  assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM invite_requests ORDER BY id").all()), after, "a second run changes nothing");
  assert.deepEqual({ ...db.raw.prepare(previews[0]).get() }, { onboarded: 1, with_dates_or_cohort: 0 });
  const stmts = SWEEP.split("\n").filter((l) => l.trim() && !l.startsWith("--"));
  assert.ok(stmts.every((l) => /^(UPDATE|DELETE|  )/.test(l)), "only UPDATE / DELETE statements; no schema change");
});

test("A1 tab order and names (CR-ADMINTABS.2); no Needs you tab; query keys unchanged", async () => {
  assert.deepEqual(admin.TABS.map(([, l]) => l), ["New", "Deferred", "Build waiting", "Ready", "Invited", "Signed up", "Onboarded", "Expired", "All", "Emails"]);
  assert.deepEqual(admin.TABS.map(([k]) => k), ["new", "not_now", "approved", "built", "invited", "signed_up", "onboarded", "expired", "all", "server_emails"]);
  const db = makeD1();
  const body = (await adminGet(db)).body;
  const nav = body.split('<nav class="tabs">')[1].split("</nav>")[0];
  assert.ok(!/Needs you/.test(nav) && !/Not now|Server emails|Approved|Built\b|Ready to send|Invite sent|Emails sent/.test(nav), "no old tab names");
});

test("A2 tab label markers: Build waiting (2, 1 failed), Ready (1), New count; all tabs lose none", async () => {
  const db = makeD1();
  const f = seed(db, { status: "approved", slug: "zz-f" }); setProv(db, f, "failed");
  const w = seed(db, { status: "approved", slug: "zz-w" }); setProv(db, w, "building");
  const r = seed(db, { status: "approved", slug: "zz-r" }); setProv(db, r, "ready");
  const s2 = seed(db, { status: "approved", slug: "zz-s" }); setProv(db, s2, "stopped");
  seed(db, { status: "new" });
  const body = (await adminGet(db)).body;
  assert.ok(body.includes("Build waiting (3, 1 failed, 1 stopped)"), "build waiting marker");
  assert.ok(body.includes("Ready (1)") && body.includes("<b>New (1)</b>"));
  assert.ok(body.includes("Deferred (0)") && body.includes("Signed up (0)"));
});

test("A3 the pointer line appears only when New is empty and another tab needs Allen, and names that tab", async () => {
  const db = makeD1();
  assert.ok(!(await adminGet(db)).body.includes("Nothing new to approve"), "nothing needs Allen: no pointer");
  const id = seed(db, { status: "approved", slug: "zz-f" }); setProv(db, id, "failed");
  const body = (await adminGet(db)).body;
  assert.ok(body.includes("Nothing new to approve. Build waiting has a request that needs you.") && body.includes('href="/admin/invites?show=approved"'));
  assert.ok(!(await adminGet(db, "?show=approved")).body.includes("Nothing new to approve"), "only on New");
  seed(db, { status: "new" });
  assert.ok(!(await adminGet(db)).body.includes("Nothing new to approve"), "New not empty: no pointer");
  assert.ok(!/\[GTM/.test(readFileSync(path.join(ROOT, "functions/admin/invites.js"), "utf8")));
});

test("A4 Build waiting also counts a bounced / not-sent email (Allen 11-23), in needsYou()'s order", async () => {
  const { tabMarker } = await import("../../admin/invites.js");
  const rows = [
    { r: { status: "approved" }, prov: { state: "failed" }, mails: [{ status: "bounced" }] },   // build failure wins
    { r: { status: "approved" }, prov: { state: "queued" }, mails: [{ status: "bounced" }] },
    { r: { status: "approved" }, prov: null, mails: [{ status: "failed" }] },
    { r: { status: "approved" }, prov: { state: "building" }, mails: [] },
  ];
  assert.equal(tabMarker("approved", rows), "4, 1 failed, 1 bounced, 1 not sent");
  assert.equal(tabMarker("built", rows.slice(0, 1)), "1");
});
