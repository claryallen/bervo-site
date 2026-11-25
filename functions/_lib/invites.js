// Shared code for the invite form handler and the admin page (CR-INVITEFLOW.1 part A).
// No secrets live here: TURNSTILE_SECRET, RATE_LIMIT_SALT and the Access settings are Cloudflare Pages
// environment variables/secrets that Allen places; the D1 database is the `DB` binding.

export const ABOUT_MAX = 1000;                 // "Tell us about you and your business" (Allen 11-10)
export const RATE_LIMIT_PER_DAY = 5;           // per salted IP hash per UTC day (spec §A)
export const RATE_KEEP_DAYS = 7;               // salted hashes are dropped after 7 days (spec §A)
export const NOT_NOW_KEEP_DAYS = 90;           // "not now", expired and unanswered (new/approved, never invited) requests are deleted 90 days after their last status change (Allen 11-11)
// Allen 11-10 ("Yes, 90 days") and CR-ONBOARDEDTAB.1 (11-23): an onboarded (stored 'claimed') request keeps only id,
// status, plan, created_at / privacy_agreed_at (the request date) and kept_name / kept_host / kept_email. TRIM_SET nulls
// the form fields (the schema's table CHECK refuses a claimed row that still holds any of them); ONBOARD_ERASE_SET and
// ONBOARD_ERASE_SIGNED_UP erase the other dates and reset cohort (admin/invites.js onboardBatch).
export const TRIMMED_COLUMNS = ["first_name", "last_name", "email", "has_assistant",
  "email_providers", "other_email", "computers", "phone", "heard_from", "heard_detail", "timezone", "about", "referral", "slug", "note"];
export const OTHER_EMAIL_MAX = 40;             // "What other email account(s)?" (shown when Other is ticked; 0003 migration)
export const TRIM_SET = TRIMMED_COLUMNS.map((c) => `${c} = NULL`).join(", ");
// CR-ONBOARDEDTAB.1 (Allen 11-23, "keep first name + initial and address"): Mark onboarded (stored status 'claimed')
// also writes these two, in the same UPDATE as the trim (migration 0010; before it the trim runs without them).
// kept_name = first name + last initial ("Ashley C"); kept_host = the address code ("reh1120" -> reh1120.bervo.ai);
// kept_email = their email address (Allen 11-23, "yes, keep email too").
export const KEPT_COLUMNS = ["kept_name", "kept_host", "kept_email"];
// CR-ONBOARDEDTAB.1 fix round 2 (Allen 11-23, "yes"): an onboarded row keeps ONLY id, status, plan, created_at (the
// request date), privacy_agreed_at (the same moment; NOT NULL) and the three kept fields. In the same UPDATE as the trim
// the other dates are erased and cohort is reset to 'public' (NOT NULL; it must no longer say whether a personal link
// was used). signed_up_at (0009) goes in its own piece so the UPDATE still works on a database without 0009.
export const ONBOARD_ERASE_SET = "approved_at = NULL, invited_at = NULL, status_changed_at = NULL, cohort = 'public'";
export const ONBOARD_ERASE_SIGNED_UP = "signed_up_at = NULL";
// CR-INVITEREADY.1 (migration 0013): the "ready in 2–3 days" answer is dropped with the other trimmed invite fields. It is
// NOT in TRIMMED_COLUMNS because TRIM_SET must keep working on a database without the column; onboardBatch tries it first.
export const ONBOARD_ERASE_READY = "ready_soon = NULL";
export const KEPT_NAME_MAX = 40;               // 0010's CHECK
export const KEPT_HOST_MAX = 63;               // 0010's CHECK (a slug is at most 31)
export const KEPT_EMAIL_MAX = 254;             // 0010's CHECK (the form's own limit)

// -> { kept_name, kept_host, kept_email } from a full (not yet trimmed) request row; any may be null.
export function keptLabel(row) {
  // fix round 2 (verifier-opus): the FIRST WORD of the first name only, so a full name typed as a first name
  // ("Ashley Clary") never keeps the last name
  const first = stripFormatChars(String(row?.first_name ?? "")).trim().split(/\s+/)[0] || "";
  const initial = [...stripFormatChars(String(row?.last_name ?? "")).trim()][0] || "";
  let name = null;
  if (first) {
    const tail = initial ? ` ${initial.toUpperCase()}` : "";
    name = [...first].slice(0, KEPT_NAME_MAX - [...tail].length).join("").trim() + tail;
  }
  const slug = String(row?.slug ?? "").trim().toLowerCase();
  const host = SLUG_RE.test(slug) && slug.length <= KEPT_HOST_MAX ? slug : null;
  const email = String(row?.email ?? "").trim().toLowerCase();
  const kept_email = email.length >= 3 && email.length <= KEPT_EMAIL_MAX && EMAIL_RE.test(email) ? email : null;
  return { kept_name: name || null, kept_host: host, kept_email };
}
export const MIN_FILL_MS = 2000;               // a form filled faster than this is a bot (spec §A)
export const REFERRALS = ["allen"];            // bervo.ai/invite?from=allen -> "personal invite" (display only)
export const PROVIDERS = ["google", "microsoft", "other"];   // onboarding.py's account providers; stored in this order
export const PLANS = ["standard", "private"];               // "Which plan would you like?" (Standard listed first)
export const COMPUTERS = ["windows", "mac", "none"];         // "Which type of computer(s)?" (Allen 11-11; 0004); "none" = iPad and/or phone only
// "How did you hear about Bervo?" (options approved by Allen 11-11; 0005). Keys are fixed; labels live in the page/admin.
export const HEARD = ["referral", "social", "search", "ai", "media", "ad", "event", "other"];
export const HEARD_DETAIL_FOR = ["referral", "other"];      // these open a required box ("Who referred you?" / "Please tell us where")
export const HEARD_DETAIL_MAX = 200;
export const PHONES = ["iphone", "android"];                 // onboarding.PHONES
export const YES_NO = ["yes", "no"];
export const STATUSES = ["new", "approved", "not_now", "invited", "claimed", "expired"];
export const MAX_BODY_BYTES = 16384;
// Hostnames a Turnstile token may come from (siteverify's `hostname`). TURNSTILE_HOSTNAMES (a Pages variable,
// comma-separated) replaces this list, e.g. for a local run with Cloudflare's public test keys ("example.com").
export const TURNSTILE_HOSTNAMES = ["bervo.ai", "invite-form.bervo-site.pages.dev"];
// Invisible/format characters (Unicode Cf: bidi overrides U+202A-202E and isolates U+2066-2069, zero-width
// U+200B-200F, BOM U+FEFF, soft hyphen ...) are removed from every text field before it is stored, so nothing
// on the admin page or in a profile can read differently from what it is.
const FORMAT_CHARS = /\p{Cf}/gu;

// Same rule as tools/tenant/provision_profile.py ACCESS_EMAIL_RE (applied to the lowercased address), so
// every stored address is one the provisioner accepts as the customer's Cloudflare Access email.
export const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;   // provision_profile.py tenant slug

const LIMITS = { first_name: 80, last_name: 80, email: 254 };   // company/role removed (Allen 11-11; 0006)

export function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Strip control characters (keep newlines in multi-line fields), trim.
function clean(v, multiline = false) {
  if (typeof v !== "string") return "";
  const re = multiline ? /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  let s = v.normalize("NFC").replace(/\r\n?/g, "\n").replace(re, "").replace(FORMAT_CHARS, "");
  return s.trim();
}

export function validTimeZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// -> { ok: true, value: {...} } or { ok: false, errors: [field, ...] }
export function validateInvite(form) {
  const get = (k) => (form && typeof form.get === "function" ? form.get(k) : form?.[k]);
  const getAll = (k) => (form && typeof form.getAll === "function" ? form.getAll(k)
    : [].concat(form?.[k] ?? []));
  const errors = [];
  const v = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    const s = clean(get(k));
    if (!s || s.length > max) errors.push(k);
    v[k] = s;
  }
  v.email = v.email.toLowerCase();
  if (!errors.includes("email") && !EMAIL_RE.test(v.email)) errors.push("email");
  const pick = (k, allowed) => {
    const s = clean(get(k)).toLowerCase();
    if (!allowed.includes(s)) errors.push(k);
    v[k] = s;
  };
  pick("has_assistant", YES_NO);
  // Email provider(s): checkboxes, at least one; stored as a JSON array in PROVIDERS order (no duplicates).
  const chosen = new Set(getAll("email_provider").map((x) => clean(x).toLowerCase()));
  if (!chosen.size || [...chosen].some((x) => !PROVIDERS.includes(x))) errors.push("email_provider");
  v.email_providers = JSON.stringify(PROVIDERS.filter((x) => chosen.has(x)));
  // Allen 11-11: ticking Other opens "What other email account(s)?" (required while shown; ignored otherwise).
  if (chosen.has("other")) {
    const o = clean(get("other_email"));
    if (!o || o.length > OTHER_EMAIL_MAX) errors.push("other_email");
    v.other_email = o;
  } else {
    v.other_email = null;
  }
  // Computer(s): checkboxes, at least one, stored in COMPUTERS order; "none" never alongside a computer.
  const comps = new Set(getAll("computer").map((x) => clean(x).toLowerCase()));
  if (!comps.size || [...comps].some((x) => !COMPUTERS.includes(x)) || (comps.has("none") && comps.size > 1)) errors.push("computer");
  v.computers = JSON.stringify(COMPUTERS.filter((x) => comps.has(x)));
  pick("phone", PHONES);
  pick("plan", PLANS);
  pick("heard_from", HEARD);
  if (HEARD_DETAIL_FOR.includes(v.heard_from)) {
    const d = clean(get("heard_detail"));
    if (!d || d.length > HEARD_DETAIL_MAX) errors.push("heard_detail");
    v.heard_detail = d;
  } else {
    v.heard_detail = null;
  }
  const about = clean(get("about"), true);
  if (!about || about.length > ABOUT_MAX) errors.push("about");
  v.about = about;
  if (get("privacy") !== "yes") errors.push("privacy");
  const tz = clean(get("tz"));
  v.timezone = validTimeZone(tz) ? tz : null;            // never a reason to refuse; provisioning asks later
  const ref = clean(get("referral")).toLowerCase();
  v.referral = REFERRALS.includes(ref) ? ref : null;     // allowlisted; display only
  v.ready_soon = get("ready_soon") === "yes" ? 1 : 0;    // optional checkbox (CR-INVITEREADY.1); never a reason to refuse
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function utcDay(ms, offsetDays = 0) {
  return new Date(ms + offsetDays * 86400000).toISOString().slice(0, 10);
}

// Counts this request against the address's daily allowance. The address itself is never stored:
// only SHA-256(salt | day | ip), and rows older than RATE_KEEP_DAYS are deleted here.
export async function countRequest(db, salt, ip, nowMs) {
  const day = utcDay(nowMs);
  const hash = await sha256Hex(`${salt}|${day}|${ip || "unknown"}`);
  await db.prepare("DELETE FROM invite_rate WHERE day < ?").bind(utcDay(nowMs, -RATE_KEEP_DAYS)).run();
  const row = await db.prepare(
    "INSERT INTO invite_rate (ip_hash, day, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(hash, day).first();
  return Number(row?.count ?? 1);
}

export async function pruneOld(db, nowMs) {
  await db.prepare("DELETE FROM invite_rate WHERE day < ?").bind(utcDay(nowMs, -RATE_KEEP_DAYS)).run();
  const cutoff = new Date(nowMs - NOT_NOW_KEEP_DAYS * 86400000).toISOString();
  await db.prepare("DELETE FROM invite_requests WHERE status IN ('new', 'approved', 'not_now', 'expired') AND status_changed_at < ?")
    .bind(cutoff).run();
  // CR-WELCOMEEMAIL.1: an email record goes with its request (and clears its address hash once trimmed).
  // CR-ONBOARDEDTAB.1 fix round 3 (privacy 1.15 draft: "we delete each record 90 days after the email is sent"): every
  // email record, account emails by server (loaded / texts_*) and request emails alike, is deleted 90 days after its
  // created_at (the send time). Nothing on bervo.ai keeps a marker after that. A second account email for the same
  // server is still prevented by the customer server (_meta.load_email_at / _meta.texts_email_at, written once) and by
  // the router (account_mail.json, per tenant and template); see the build report.
  try {
    await db.prepare("DELETE FROM invite_mail WHERE request_id IS NOT NULL AND request_id NOT IN (SELECT id FROM invite_requests)").run();
    await db.prepare("DELETE FROM invite_mail WHERE created_at < ?").bind(cutoff).run();
    await db.prepare("UPDATE invite_mail SET address_hash = NULL WHERE address_hash IS NOT NULL AND request_id IN " +
      "(SELECT id FROM invite_requests WHERE status = 'claimed')").run();
  } catch { /* the 0002 table is not there yet */ }
  // CR-AUTOPROVISION.1: a build record and a waiting link go with their request; a link also goes on expiry and the
  // moment the request is no longer approved/invited (claimed, expired, not now).
  try {
    await db.prepare("DELETE FROM invite_links WHERE expires_at <= ? OR request_id NOT IN " +
      "(SELECT id FROM invite_requests WHERE status IN ('approved', 'invited'))").bind(new Date(nowMs).toISOString()).run();
    await db.prepare("DELETE FROM invite_provision WHERE request_id NOT IN (SELECT id FROM invite_requests)").run();
  } catch { /* the 0007 tables are not there yet */ }
}

export function stripFormatChars(v) { return String(v ?? "").replace(FORMAT_CHARS, ""); }

// Turnstile server-side check. -> "pass" | "fail" | "error" (could not reach Cloudflare).
// Passes only when success is true, the action is exactly "invite" and the hostname is on the allowlist.
export async function verifyTurnstile(token, secret, ip, fetchImpl = fetch, hostnames = TURNSTILE_HOSTNAMES) {
  if (typeof token !== "string" || !token || token.length > 4096) return "fail";
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  let res;
  try {
    res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  } catch {
    return "error";
  }
  if (!res.ok) return "error";
  let out;
  try { out = await res.json(); } catch { return "error"; }
  const hosts = (hostnames || []).map((h) => String(h).toLowerCase());
  if (out && out.success === true && out.action === "invite" &&
      typeof out.hostname === "string" && hosts.includes(out.hostname.toLowerCase())) return "pass";
  return "fail";
}

// Allen 11-10: a request from his personal link (referral 'allen') is the private beta; every other is public.
export function cohortFor(referral) { return referral === "allen" ? "private" : "public"; }

export async function insertInvite(db, v, nowIso) {
  const cols = "created_at, first_name, last_name, email, has_assistant, " +
    "email_providers, other_email, computers, phone, plan, heard_from, heard_detail, timezone, about, referral, cohort, privacy_agreed_at, status, status_changed_at";
  const args = [nowIso, v.first_name, v.last_name, v.email, v.has_assistant, v.email_providers,
    v.other_email ?? null, v.computers ?? null, v.phone, v.plan, v.heard_from ?? null, v.heard_detail ?? null, v.timezone, v.about, v.referral, cohortFor(v.referral), nowIso];
  const q = (c, extra) => `INSERT INTO invite_requests (${c}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?${extra})`;
  // CR-INVITEREADY.1: the answer is written only when it is "yes" (the column defaults to 0), and a database without
  // migration 0013 stores the request without it rather than refusing the request.
  if (v.ready_soon === 1) {
    try {
      return await db.prepare(q(cols + ", ready_soon", ", 1")).bind(...args, nowIso).run();
    } catch (e) {
      if (!/no such column|has no column/i.test(String(e && e.message || e))) throw e;
    }
  }
  return db.prepare(q(cols, "")).bind(...args, nowIso).run();
}

// ---------- Cloudflare Access JWT (defence in depth behind the Access application) ----------

function b64urlBytes(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

let _jwks = { at: 0, team: "", keys: [] };

async function accessKeys(team, fetchImpl, nowMs) {
  if (_jwks.team === team && nowMs - _jwks.at < 600000 && _jwks.keys.length) return _jwks.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("certs unavailable");
  const body = await res.json();
  _jwks = { at: nowMs, team, keys: Array.isArray(body.keys) ? body.keys : [] };
  return _jwks.keys;
}

export function _resetAccessKeyCache() { _jwks = { at: 0, team: "", keys: [] }; }

export function splitList(v) {
  return String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// -> { ok: true, email } or { ok: false, status, why }. Fails closed when anything is missing.
export async function checkAccess(request, env, fetchImpl = fetch, nowMs = Date.now()) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").trim().toLowerCase();
  const auds = splitList(env.ACCESS_AUD);
  const admins = splitList(env.ADMIN_EMAILS);
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !auds.length || !admins.length) {
    return { ok: false, status: 503, why: "admin access is not configured" };
  }
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, why: "no Access token" };
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch {
    return { ok: false, status: 403, why: "malformed Access token" };
  }
  if (header.alg !== "RS256" || !header.kid) return { ok: false, status: 403, why: "unexpected token algorithm" };
  let keys;
  try { keys = await accessKeys(team, fetchImpl, nowMs); } catch {
    return { ok: false, status: 503, why: "could not fetch Access keys" };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, status: 403, why: "unknown signing key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { valid = false; }
  if (!valid) return { ok: false, status: 403, why: "bad signature" };
  const now = Math.floor(nowMs / 1000);
  const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!tokenAud.some((a) => auds.includes(String(a).toLowerCase()))) return { ok: false, status: 403, why: "wrong audience" };
  if (payload.iss !== `https://${team}`) return { ok: false, status: 403, why: "wrong issuer" };
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, status: 403, why: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, status: 403, why: "not yet valid" };
  const email = String(payload.email || "").toLowerCase();
  if (!email || !admins.includes(email)) return { ok: false, status: 403, why: "not an admin" };
  return { ok: true, email };
}

export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}
