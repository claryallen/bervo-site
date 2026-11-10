// Shared code for the invite form handler and the admin page (CR-INVITEFLOW.1 part A).
// No secrets live here: TURNSTILE_SECRET, RATE_LIMIT_SALT and the Access settings are Cloudflare Pages
// environment variables/secrets that Allen places; the D1 database is the `DB` binding.

export const ABOUT_MAX = 1000;                 // "Tell us about you and your business" (Allen 11-10)
export const RATE_LIMIT_PER_DAY = 5;           // per salted IP hash per UTC day (spec §A)
export const RATE_KEEP_DAYS = 7;               // salted hashes are dropped after 7 days (spec §A)
export const NOT_NOW_KEEP_DAYS = 90;           // "not now" and expired requests are deleted 90 days after that status
// Allen 11-10 ("Yes, 90 days"): once the customer is live (claimed) a request keeps only id, cohort, status and
// dates, plus the plan they chose (like cohort). TRIM_SET nulls everything else; the schema's table CHECK refuses a claimed row that still holds any of it.
export const TRIMMED_COLUMNS = ["first_name", "last_name", "email", "company", "role", "has_assistant",
  "email_providers", "phone", "timezone", "about", "referral", "slug", "note"];
export const TRIM_SET = TRIMMED_COLUMNS.map((c) => `${c} = NULL`).join(", ");
export const MIN_FILL_MS = 2000;               // a form filled faster than this is a bot (spec §A)
export const REFERRALS = ["allen"];            // bervo.ai/invite?from=allen -> "personal invite" (display only)
export const PROVIDERS = ["google", "microsoft", "other"];   // onboarding.py's account providers; stored in this order
export const PLANS = ["standard", "private"];               // "Which plan would you like?" (Standard listed first)
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

const LIMITS = { first_name: 80, last_name: 80, email: 254, company: 120, role: 120 };

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
  pick("phone", PHONES);
  pick("plan", PLANS);
  const about = clean(get("about"), true);
  if (!about || about.length > ABOUT_MAX) errors.push("about");
  v.about = about;
  if (get("privacy") !== "yes") errors.push("privacy");
  const tz = clean(get("tz"));
  v.timezone = validTimeZone(tz) ? tz : null;            // never a reason to refuse; provisioning asks later
  const ref = clean(get("referral")).toLowerCase();
  v.referral = REFERRALS.includes(ref) ? ref : null;     // allowlisted; display only
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
  await db.prepare("DELETE FROM invite_requests WHERE status IN ('not_now', 'expired') AND status_changed_at < ?")
    .bind(cutoff).run();
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
  return db.prepare(
    "INSERT INTO invite_requests (created_at, first_name, last_name, email, company, role, has_assistant, " +
    "email_providers, phone, plan, timezone, about, referral, cohort, privacy_agreed_at, status, status_changed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)"
  ).bind(nowIso, v.first_name, v.last_name, v.email, v.company, v.role, v.has_assistant, v.email_providers,
    v.phone, v.plan, v.timezone, v.about, v.referral, cohortFor(v.referral), nowIso, nowIso).run();
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
