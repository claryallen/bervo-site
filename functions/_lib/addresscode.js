// CR-AUTOSLUG.1 (Allen 11-23, "auto-short code with admin override type-in option"): every new server gets an
// automatic address code, <code>.bervo.ai, so its address says nothing about who the customer is.
//
// The code: 6 characters, lowercase letters and digits with the look-alikes 0 o 1 l i left out, first character a
// letter (23 x 31^5, about 656 million codes). Never a reserved name, never a code already in use (the caller passes
// isTaken: D1 slugs here; server profiles on the Mini). The admin may type over the code: a typed address keeps
// today's rule (SLUG_RE) and is refused when it is a reserved name.
//
// The same rules live in daily-dashboard tools/tenant/address_code.py (alphabet, length, first character, reserved
// names, validation); daily-dashboard tools/tenant/test_address_code.py compares the two. Keep them in step.
import { GO_RESERVED } from "./golink.js";
import { SLUG_RE } from "./invites.js";

export const CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz";     // a-z without i l o
export const CODE_DIGITS = "23456789";                     // 0-9 without 0 1
export const CODE_ALPHABET = CODE_LETTERS + CODE_DIGITS;   // 31 characters
export const CODE_LENGTH = 6;
export const CODE_RE = /^[abcdefghjkmnpqrstuvwxyz][abcdefghjkmnpqrstuvwxyz23456789]{5}$/;
// Names that are never a new customer's address: bervo.ai's own names (golink.js GO_RESERVED, which a bervo.ai/go
// link refuses anyway) plus the names this product uses for itself. Customer servers made before CR-AUTOSLUG.1 are
// refused on the Mini (cloudflare_config.json protected_tenants / protected_hostnames), not listed in this public file.
export const ADDRESS_EXTRA_RESERVED = ["my", "demo", "rehearsal", "zero", "tenant-zero", "test", "t01", "t02"];
export const ADDRESS_RESERVED = [...new Set([...GO_RESERVED, ...ADDRESS_EXTRA_RESERVED])].sort();
export const CODE_TRIES = 20;

function cryptoBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

// One character from `chars`, uniform (rejection sampling: a byte at or above the largest multiple of the length is
// drawn again, so no character is more likely than another).
function pick(chars, randomBytes) {
  const limit = 256 - (256 % chars.length);
  for (;;) {
    const b = randomBytes(1)[0];
    if (b < limit) return chars[b % chars.length];
  }
}

// A fresh code (not checked against anything). randomBytes(n) -> Uint8Array; tests pass their own.
export function randomCode(randomBytes = cryptoBytes) {
  let s = pick(CODE_LETTERS, randomBytes);
  while (s.length < CODE_LENGTH) s += pick(CODE_ALPHABET, randomBytes);
  return s;
}

// What is wrong with an address typed (or left) in the box: null when usable, else "empty" | "invalid" | "reserved".
// It is NOT the uniqueness check (that needs D1).
export function addressProblem(value) {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!s) return "empty";
  if (!SLUG_RE.test(s)) return "invalid";
  if (ADDRESS_RESERVED.includes(s)) return "reserved";
  return null;
}

// A code that is not reserved and not taken. isTaken(code) -> boolean (or a Promise of one). null after CODE_TRIES
// clashes in a row (never expected: the caller shows an empty box, and Approve and build then asks for one).
export async function newCode(isTaken = () => false, randomBytes = cryptoBytes, tries = CODE_TRIES) {
  for (let i = 0; i < tries; i++) {
    const c = randomCode(randomBytes);
    if (ADDRESS_RESERVED.includes(c)) continue;
    if (await isTaken(c)) continue;
    return c;
  }
  return null;
}

// Every address already in D1: request slugs, and the servers the "you're loaded" emails name (a claimed request is
// trimmed, so its slug is gone; its server's name stays in invite_mail.tenant). Lowercased Set.
export async function takenAddresses(db) {
  const out = new Set();
  const { results } = await db.prepare("SELECT slug FROM invite_requests WHERE slug IS NOT NULL").all();
  for (const r of results || []) out.add(String(r.slug).toLowerCase());
  try {
    const m = await db.prepare("SELECT DISTINCT tenant FROM invite_mail WHERE tenant IS NOT NULL").all();
    for (const r of m.results || []) out.add(String(r.tenant).toLowerCase());
  } catch { /* the 0002 table is not there yet */ }
  return out;
}

// Is `slug` in use by any request other than `exceptId`, or by a server named in invite_mail?
export async function addressTaken(db, slug, exceptId) {
  const r = await db.prepare("SELECT 1 AS x FROM invite_requests WHERE slug = ? AND id <> ? LIMIT 1").bind(slug, exceptId).first();
  if (r) return true;
  try {
    const m = await db.prepare("SELECT 1 AS x FROM invite_mail WHERE tenant = ? LIMIT 1").bind(slug).first();
    if (m) return true;
  } catch { /* the 0002 table is not there yet */ }
  return false;
}
