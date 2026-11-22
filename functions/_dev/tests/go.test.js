// Tests for CR-LINKPREVIEW.1: https://bervo.ai/go/<label>/<page> (functions/go/[[path]].js, functions/_lib/golink.js,
// /go.js) and the friendly links in bervo.ai's emails / the admin Copy box.
// Run: node --experimental-default-type=module --test functions/_dev/tests/go.test.js   (Node 22+, no packages)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

import * as go from "../../_lib/golink.js";
import * as route from "../../go/[[path]].js";
import * as admin from "../../admin/invites.js";
import * as mail from "../../_lib/mail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";   // made up, 43 url-safe characters
const GO_JS = readFileSync(path.join(ROOT, "go.js"), "utf8");

const get = (p, method = "GET") => (method === "HEAD" ? route.onRequestHead : route.onRequestGet)({ request: new Request("https://bervo.ai" + p, { method }) });

// ---------- the route ----------
test("G1 label rule: [a-z0-9-]{1,40}, lower-cased; reserved names and anything else -> 404", async () => {
  for (const p of ["/go/cetta", "/go/cetta/", "/go/zz-test2/mobile", "/go/CETTA/mobile", "/go/" + "a".repeat(40)]) {
    assert.equal((await get(p)).status, 200, p);
  }
  for (const p of ["/go", "/go/", "/go/" + "a".repeat(41), "/go/ce.tta", "/go/ce%2Ftta", "/go/cetta.bervo.ai", "/go/ce_tta",
    "/go/%2e%2e", "/go/..", "/go/www", "/go/connect", "/go/bervo", "/go/api", "/go/admin", "/go/go", "/go/brand",
    "/go/evil.example", "/go/@evil.example"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get("Cache-Control"), "no-store", p);
    assert.ok(!(await r.text()).includes("bervo-go"), p);
  }
  for (const name of go.GO_RESERVED) assert.equal((await get("/go/" + name)).status, 404, name);
});

test("G2 page allowlist; anything else -> that server's home; the target is always https://<label>.bervo.ai", async () => {
  const cases = {
    "/go/cetta": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
    "/go/cetta/": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
    "/go/cetta/mobile": ["https://cetta.bervo.ai/mobile", go.SIGNIN_TITLE],
    "/go/cetta/welcome": ["https://cetta.bervo.ai/welcome", go.SETUP_TITLE],
    "/go/cetta/welcome?step=texts": ["https://cetta.bervo.ai/welcome?step=texts", go.SETUP_TITLE],
    "/go/cetta/welcome?step=key": ["https://cetta.bervo.ai/welcome", go.SETUP_TITLE],
    "/go/cetta/set-password": ["https://cetta.bervo.ai/set-password", go.SETUP_TITLE],
    ["/go/cetta/set-password?t=" + TOKEN]: ["https://cetta.bervo.ai/set-password", go.SETUP_TITLE],
    "/go/cetta/admin": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
    "/go/cetta/mobile/x": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
    "/go/cetta//evil.example": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
    "/go/cetta/https://evil.example": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
    "/go/cetta/api/x?next=https://evil.example": ["https://cetta.bervo.ai/", go.SIGNIN_TITLE],
  };
  for (const [p, [target, title]] of Object.entries(cases)) {
    const html = await (await get(p)).text();
    assert.ok(html.includes(`<meta name="bervo-go" content="${target.replace(/&/g, "&amp;")}"`), p);
    assert.ok(html.includes(`<title>${title}</title>`) && html.includes(`<meta property="og:title" content="${title}">`), p);
    const hrefs = [...html.matchAll(/(?:href|content)="(https?:[^"]*)"/g)].map((m) => m[1]);
    for (const h of hrefs) assert.ok(/^https:\/\/([a-z0-9-]{1,40}\.)?bervo\.ai\//.test(h), `${p}: ${h}`);
    assert.ok(!html.includes(TOKEN), p + ": a token in the query is never echoed");
  }
  assert.equal(go.resolveGo("https://bervo.ai/go/cetta/welcome?step=texts").title, "Setup - Bervo Dashboard");
  assert.equal(go.resolveGo("https://bervo.ai/go/cetta/mobile").title, "Sign in - Bervo Dashboard");
});

test("G3 the page: preview tags, one same-origin script, no inline code, the token only for set-password (fragment)", async () => {
  const html = await (await get("/go/cetta/set-password")).text();
  assert.ok(html.includes('<meta property="og:site_name" content="Bervo">'));
  assert.ok(html.includes('<meta property="og:image" content="https://bervo.ai/brand/bervo-b.png">'));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(tags.length, 1);
  assert.equal(tags[0][1], ' src="/go.js"');
  assert.equal(tags[0][2], "");
  assert.ok(!/\son[a-z]+=/i.test(html) && !/javascript:/i.test(html));
  assert.ok(html.includes('data-token="fragment"'));
  assert.ok(!(await (await get("/go/cetta/mobile")).text()).includes("data-token"));
  assert.ok(!/[–—]/.test(html), "no en or em dash");
  assert.ok(html.includes("Opening your Bervo setup page...") && (await (await get("/go/cetta")).text()).includes("Opening your Bervo sign-in page..."));
});

test("G4 headers: the site's security headers, script-src 'self' only here, a short public cache; HEAD has no body", async () => {
  const r = await get("/go/cetta/mobile");
  assert.equal(r.headers.get("Content-Security-Policy"),
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(r.headers.get("X-Frame-Options"), "DENY");
  assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(r.headers.get("Permissions-Policy"), /camera=\(\)/);
  assert.equal(r.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(r.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("Set-Cookie"), null);
  const h = await get("/go/cetta/mobile", "HEAD");
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "");
  const headers = readFileSync(path.join(ROOT, "_headers"), "utf8");
  const blocks = headers.split(/\n(?=\/)/);
  const star = blocks.find((b) => b.startsWith("/*\n"));
  assert.ok(!/script-src/.test(star), "the site-wide policy still has no script-src");
  const gb = blocks.find((b) => b.startsWith("/go/*\n"));
  assert.ok(gb && /^\s+! Content-Security-Policy$/m.test(gb) && gb.includes("script-src 'self';"));
  assert.match(headers, /\/go\.js\n  Cache-Control: no-cache/);
});

test("G5 Phase 0 leftovers are gone: no go-test pages, header block or redirect", () => {
  assert.ok(!readFileSync(path.join(ROOT, "_headers"), "utf8").includes("go-test"));
  assert.ok(!readFileSync(path.join(ROOT, "_redirects"), "utf8").includes("go-test"));
  assert.throws(() => readFileSync(path.join(ROOT, "go-test/b.html")));
});

// ---------- /go.js ----------
function runGo(target, hash, tokenMode) {
  const replaced = [];
  const meta = target === null ? null : { getAttribute: (k) => (k === "content" ? target : k === "data-token" ? tokenMode : null) };
  const ctx = { document: { querySelector: () => meta }, location: { hash, replace: (u) => replaced.push(u) } };
  vm.runInNewContext(GO_JS, ctx);
  return replaced;
}

test("G6 /go.js: moves the fragment token to ?t= on the server, only for set-password; refuses any other target", () => {
  assert.deepEqual(runGo("https://cetta.bervo.ai/set-password", "#t=" + TOKEN, "fragment"), ["https://cetta.bervo.ai/set-password?t=" + TOKEN]);
  assert.deepEqual(runGo("https://cetta.bervo.ai/set-password", "", "fragment"), ["https://cetta.bervo.ai/set-password"]);
  for (const bad of ["#t=short", "#t=" + TOKEN + "&x=1", "#t=" + TOKEN + "#", "#x=" + TOKEN, "#t=<script>" + TOKEN])
    assert.deepEqual(runGo("https://cetta.bervo.ai/set-password", bad, "fragment"), ["https://cetta.bervo.ai/set-password"], bad);
  assert.deepEqual(runGo("https://cetta.bervo.ai/mobile", "#t=" + TOKEN, null), ["https://cetta.bervo.ai/mobile"], "no token on other pages");
  assert.deepEqual(runGo("https://cetta.bervo.ai/", "", null), ["https://cetta.bervo.ai/"]);
  assert.deepEqual(runGo("https://cetta.bervo.ai/welcome?step=texts", "", null), ["https://cetta.bervo.ai/welcome?step=texts"]);
  for (const bad of ["https://evil.example/", "https://cetta.bervo.ai.evil.example/", "http://cetta.bervo.ai/", "https://a.b.bervo.ai/",
    "https://cetta.bervo.ai/admin", "https://cetta.bervo.ai/welcome?step=x", "javascript:alert(1)", "//evil.example", ""])
    assert.deepEqual(runGo(bad, "", null), [], bad);
  assert.deepEqual(runGo(null, "", null), []);
});

// ---------- the link builder (mirrors daily-dashboard friendly_link.py) ----------
test("G7 friendlyLink: shapes, direct for other hosts word for word, null for unusable hosts", () => {
  const f = go.friendlyLink;
  assert.equal(f("cetta.bervo.ai", ""), "https://bervo.ai/go/cetta");
  assert.equal(f("cetta.bervo.ai", "mobile"), "https://bervo.ai/go/cetta/mobile");
  assert.equal(f("cetta.bervo.ai", "welcome?step=texts"), "https://bervo.ai/go/cetta/welcome?step=texts");
  assert.equal(f("cetta.bervo.ai", "set-password", TOKEN), "https://bervo.ai/go/cetta/set-password#t=" + TOKEN);
  assert.equal(f(" Cetta.Bervo.AI/ ", "mobile"), "https://bervo.ai/go/cetta/mobile");
  assert.equal(f("cetta.bervo.ai", "nope"), "https://bervo.ai/go/cetta");
  for (const [h, want] of [["x.tail6aeff2.ts.net", "https://x.tail6aeff2.ts.net/mobile"], ["zero.bervo.ai:8000", "https://zero.bervo.ai:8000/mobile"],
    ["api.zero.bervo.ai", "https://api.zero.bervo.ai/mobile"], ["bervo.ai", "https://bervo.ai/mobile"], ["www.bervo.ai", "https://www.bervo.ai/mobile"],
    ["connect.bervo.ai", "https://connect.bervo.ai/mobile"], ["rehearsal.bervo.ai", "https://rehearsal.bervo.ai/mobile"],
    ["evilbervo.ai", "https://evilbervo.ai/mobile"], ["bervo.ai.evil.example", "https://bervo.ai.evil.example/mobile"]])
    assert.equal(f(h, "mobile"), want, h);
  assert.equal(f("x.tail6aeff2.ts.net", "set-password", TOKEN), "https://x.tail6aeff2.ts.net/set-password?t=" + TOKEN);
  assert.ok(f("cetta.bervo.ai", "set-password", "bad&token#" + "a".repeat(20)).startsWith("https://cetta.bervo.ai/"));
  for (const h of [null, "", " ", "has space.bervo.ai", "https://x.bervo.ai", 42]) assert.equal(f(h, "mobile"), null, String(h));
});

test("G8 friendlyFromDirect: the server's direct links become friendly; anything else unchanged", () => {
  const d = go.friendlyFromDirect;
  assert.equal(d("https://zz-test.bervo.ai/set-password?t=" + TOKEN), "https://bervo.ai/go/zz-test/set-password#t=" + TOKEN);
  assert.equal(d("https://zz-test.bervo.ai/"), "https://bervo.ai/go/zz-test");
  assert.equal(d("https://zz-test.bervo.ai/welcome?step=texts"), "https://bervo.ai/go/zz-test/welcome?step=texts");
  assert.equal(d("https://zz-test.bervo.ai/mobile"), "https://bervo.ai/go/zz-test/mobile");
  for (const same of ["https://zz-test.bervo.ai/set-password?t=" + TOKEN + "&x=1", "https://zz-test.bervo.ai/x", "http://zz-test.bervo.ai/",
    "https://rehearsal.bervo.ai/", "https://zz-test.bervo.ai:8443/", "not a url", "https://u:p@zz-test.bervo.ai/", "https://zz-test.bervo.ai/#x"])
    assert.equal(d(same), same, same);
});

test("G9 emails: invite / reminders / loaded / texts carry the friendly link; the words around it are unchanged", () => {
  const LINK = "https://zz-test.bervo.ai/set-password?t=" + TOKEN;
  const GO = "https://bervo.ai/go/zz-test/set-password#t=" + TOKEN;
  for (const [tpl, f] of [["invite", { first_name: "Pat", link: LINK }], ["reminder_day3", { first_name: "Pat", link: LINK, expiry_date: "November 25" }],
    ["reminder_day10", { first_name: "Pat", link: LINK, expiry_date: "December 2" }]]) {
    const t = mail.render(tpl, f).text;
    assert.ok(t.includes("\n" + GO + "\n\n" + mail.CLOUDFLARE_SIGNIN_NOTE + "\n"), tpl);
    assert.ok(!t.includes("?t="), tpl + ": the token is never in a query in the email");
    assert.equal(t, mail.TEMPLATES[tpl].body.replace("{first_name}", "Pat").replace("{link}", GO).replace("{expiry_date}", f.expiry_date || ""), tpl);
  }
  assert.ok(mail.render("loaded", { first_name: "Pat", start_date: "October 12", dashboard_link: "https://zz-test.bervo.ai/" }).text
    .includes("ready:\nhttps://bervo.ai/go/zz-test\n"));
  assert.ok(mail.render("texts_mac", { first_name: "Pat", texts_link: "https://zz-test.bervo.ai/welcome?step=texts" }).text
    .includes("1. Open your texts page: https://bervo.ai/go/zz-test/welcome?step=texts\n"));
  assert.ok(mail.render("texts_android", { first_name: "Pat", dashboard_link: "https://zz-test.bervo.ai/" }).text
    .includes("1. Open your dashboard: https://bervo.ai/go/zz-test\n"));
  // the input check is unchanged: a friendly link is not accepted as the server's link
  assert.throws(() => mail.render("invite", { first_name: "Pat", link: GO }), { code: "bad_field:link" });
});

test("G10 admin Copy box: the embedded builder is golink.js's own, and gives the same link as the Send button's email", () => {
  const s = admin.COPY_LINK_SCRIPT;
  assert.ok(!s.includes("</"), "nothing that can close the <script> early");
  const ctx = { URL };
  vm.runInNewContext(s + "\nthis.out = [friendlyFromDirect(a), friendlyFromDirect(b), friendlyFromDirect(c), friendlyLink(h, 'mobile')];",
    Object.assign(ctx, { a: "https://zz-test.bervo.ai/set-password?t=" + TOKEN, b: "https://rehearsal.bervo.ai/set-password?t=" + TOKEN,
      c: "junk", h: "connect.bervo.ai" }));
  assert.deepEqual([...ctx.out], ["https://bervo.ai/go/zz-test/set-password#t=" + TOKEN, "https://rehearsal.bervo.ai/set-password?t=" + TOKEN,
    "junk", "https://connect.bervo.ai/mobile"]);
});
