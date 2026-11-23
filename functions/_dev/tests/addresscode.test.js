// Tests for the automatic address code (CR-AUTOSLUG.1). Unit tests here; the admin page's use of it is tested in
// invite.test.js (it needs that file's D1 stand-in and Access tokens).
// Run: node --experimental-default-type=module --test functions/_dev/tests/addresscode.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import * as ac from "../../_lib/addresscode.js";
import { GO_RESERVED } from "../../_lib/golink.js";
import { SLUG_RE } from "../../_lib/invites.js";

// randomBytes stand-in that plays back fixed bytes (then repeats them).
function bytes(seq) {
  let i = 0;
  return (n) => Uint8Array.from({ length: n }, () => seq[i++ % seq.length]);
}

test("A1 alphabet: lowercase letters and digits without 0 o 1 l i; 23 letters, 8 digits", () => {
  assert.equal(ac.CODE_LETTERS.length, 23);
  assert.equal(ac.CODE_DIGITS, "23456789");
  assert.equal(ac.CODE_ALPHABET.length, 31);
  for (const ch of "0o1li") assert.ok(!ac.CODE_ALPHABET.includes(ch), ch);
  assert.equal(new Set(ac.CODE_ALPHABET).size, 31, "no repeats");
  assert.equal(ac.CODE_LENGTH, 6);
});

test("A2 1000 real codes: 6 characters, first a letter, only the alphabet, each a valid slug", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const c = ac.randomCode();
    assert.match(c, ac.CODE_RE);
    assert.equal(c.length, 6);
    assert.ok(ac.CODE_LETTERS.includes(c[0]), c);
    assert.ok([...c].every((ch) => ac.CODE_ALPHABET.includes(ch)), c);
    assert.match(c, SLUG_RE, "every code is a slug the Mini accepts");
    seen.add(c);
  }
  assert.ok(seen.size > 990, "codes vary: " + seen.size);
});

test("A3 uniform pick: a byte above the last full multiple is drawn again, never folded", () => {
  // 23 letters: limit 253 (256 - 256 % 23). Byte 254 is rejected, then 1 -> letters[1] = 'b'. Alphabet 31: limit 248.
  // 250 rejected, 0 -> 'a', 22 -> 'z', 23 -> '2', 30 -> '9', 31 -> 'a'.
  assert.equal(ac.randomCode(bytes([254, 1, 250, 0, 22, 23, 30, 31])), "baz29a");
  // first character can never be a digit even for a byte that maps to a digit in the full alphabet
  assert.ok(ac.CODE_LETTERS.includes(ac.randomCode(bytes([23, 0, 0, 0, 0, 0]))[0]));
});

test("A4 reserved names: golink's list plus the product's own names; a code that is reserved is never returned", async () => {
  for (const n of GO_RESERVED) assert.ok(ac.ADDRESS_RESERVED.includes(n), n);
  for (const n of ["my", "demo", "rehearsal", "zero", "tenant-zero", "test", "connect", "www", "admin", "t01", "t02"]) {
    assert.ok(ac.ADDRESS_RESERVED.includes(n), n);
  }
  // "status" and "assets" fit the code alphabet and length: the generator must skip them.
  assert.ok(ac.CODE_RE.test("status") && ac.CODE_RE.test("assets"));
  const L = ac.CODE_LETTERS, A = ac.CODE_ALPHABET;
  const enc = (word) => [...word].map((ch, i) => (i === 0 ? L : A).indexOf(ch));
  const c = await ac.newCode(() => false, bytes([...enc("status"), ...enc("k7m2qx")]));
  assert.equal(c, "k7m2qx", "status skipped, the next code taken");
});

test("A5 clash retry: a taken code is skipped; all tries taken -> null", async () => {
  const L = ac.CODE_LETTERS, A = ac.CODE_ALPHABET;
  const enc = (word) => [...word].map((ch, i) => (i === 0 ? L : A).indexOf(ch));
  const asked = [];
  const c = await ac.newCode(async (x) => { asked.push(x); return x === "abcdef"; }, bytes([...enc("abcdef"), ...enc("k7m2qx")]));
  assert.equal(c, "k7m2qx");
  assert.deepEqual(asked, ["abcdef", "k7m2qx"]);
  assert.equal(await ac.newCode(() => true), null);
  let n = 0;
  await ac.newCode(() => { n++; return true; });
  assert.equal(n, ac.CODE_TRIES);
});

test("A6 typed address (override): today's slug rule, reserved names refused", () => {
  const cases = { "": "empty", "   ": "empty", "k7m2qx": null, "K7M2QX": null, " pat-s ": null, "pat": null,
    "a": null, "9lives": null, "-pat": "invalid", "pat_s": "invalid", "pat.s": "invalid", "Bad Slug!": "invalid",
    ["a".repeat(31)]: null, ["a".repeat(32)]: "invalid", "connect": "reserved", "www": "reserved", "my": "reserved",
    "admin": "reserved", "demo": "reserved", "rehearsal": "reserved", "status": "reserved", "zero": "reserved" };
  for (const [v, want] of Object.entries(cases)) assert.equal(ac.addressProblem(v), want, JSON.stringify(v));
  assert.equal(ac.addressProblem(null), "empty");
  assert.equal(ac.addressProblem(42), "empty");
});
