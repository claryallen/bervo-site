// The Bervo news and announcements list (CR-NEWSLETTER.1, Allen 11-23). Shared by the relayed choice
// (api/newsletter.js), Postmark's broadcast-stream webhook (api/newsletter-events.js), the one-click unsubscribe page
// (newsletter/unsubscribe.js) and the admin page (admin/newsletter.js). No route.
//
// The table (migration 0012): email, status subscribed/unsubscribed, source setup/admin, opted_in_at, opted_out_at.
// An unsubscribed row is a suppression entry: only the email and opted_out_at (decision 2, Allen 11-23).
//
// One ordering rule for every change: a change carries its own time, and a change older than the row's newest time is
// ignored ("stale"). So a customer server's delayed retry of an old opt-in never undoes a later unsubscribe, while the
// owner turning the Settings switch back on later does re-subscribe them (their own, newer choice).
// Allen's "Add" (source admin) never re-adds an unsubscribed address: only the person can, from their own Settings.
import { EMAIL_RE } from "./invites.js";

export const SOURCES = ["setup", "admin"];
const FUTURE_SLACK_MS = 5 * 60 * 1000;

export class NotSetUp extends Error {}

export function normEmail(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s.length >= 3 && s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

// A change's time as ISO; a time in the future (beyond 5 minutes of clock skew) or unreadable becomes now.
export function changeTime(at, nowMs) {
  const t = typeof at === "string" && at.length <= 40 ? Date.parse(at) : NaN;
  if (!Number.isFinite(t) || t > nowMs + FUTURE_SLACK_MS) return new Date(nowMs).toISOString();
  return new Date(t).toISOString();
}

function missingTable(e) { return /no such table: newsletter/i.test(String(e && e.message || e)); }

async function rowFor(db, email) {
  try {
    return await db.prepare("SELECT email, status, source, opted_in_at, opted_out_at FROM newsletter WHERE email = ?").bind(email).first();
  } catch (e) {
    if (missingTable(e)) throw new NotSetUp("newsletter table missing");
    throw e;
  }
}

function newest(row) { return row ? (row.status === "subscribed" ? row.opted_in_at : row.opted_out_at) : null; }

// -> { status: "subscribed"|"unsubscribed"|"none", changed_at }
export async function statusOf(db, email) {
  const row = await rowFor(db, email);
  return row ? { status: row.status, changed_at: newest(row) } : { status: "none", changed_at: null };
}

async function writeSubscribed(db, email, source, at) {
  await db.prepare("INSERT INTO newsletter (email, status, source, opted_in_at, opted_out_at) VALUES (?, 'subscribed', ?, ?, NULL) " +
    "ON CONFLICT(email) DO UPDATE SET status = 'subscribed', source = excluded.source, opted_in_at = excluded.opted_in_at, opted_out_at = NULL")
    .bind(email, source, at).run();
}

async function writeUnsubscribed(db, email, at) {
  // the suppression entry: source and opted_in_at erased in the same write
  await db.prepare("INSERT INTO newsletter (email, status, source, opted_in_at, opted_out_at) VALUES (?, 'unsubscribed', NULL, NULL, ?) " +
    "ON CONFLICT(email) DO UPDATE SET status = 'unsubscribed', source = NULL, opted_in_at = NULL, opted_out_at = excluded.opted_out_at")
    .bind(email, at).run();
}

// The owner's own choice, relayed from their server (setup screen or Settings switch).
// subscribed=false for an address not on the list stores a suppression entry (see the build report: so Allen's Add
// can never add someone who said no at setup).
// Fix round 1 (verifier-opus): a "no" ALWAYS wins. It is never stale: a "no" made while bervo.ai was down and
// delivered after Allen's Add still unsubscribes (stamped now, so the row's newest time moves forward). Only a "yes"
// can be stale (older than an unsubscribe or an Add already on record).
// -> { result: "subscribed"|"unsubscribed"|"unchanged"|"stale", status, changed_at }
export async function applyOwnerChoice(db, { email, subscribed, at, nowMs }) {
  const when = changeTime(at, nowMs);
  const row = await rowFor(db, email);
  const last = newest(row);
  if (!subscribed) {
    if (row && row.status === "unsubscribed") return { result: "unchanged", status: "unsubscribed", changed_at: last };
    const out = row && last && when < last ? new Date(nowMs).toISOString() : when;
    await writeUnsubscribed(db, email, out);
    return { result: "unsubscribed", status: "unsubscribed", changed_at: out };
  }
  if (row && last && when < last) return { result: "stale", ...(await statusOf(db, email)) };
  if (row && row.status === "subscribed") return { result: "unchanged", status: "subscribed", changed_at: last };
  await writeSubscribed(db, email, "setup", when);
  return { result: "subscribed", status: "subscribed", changed_at: when };
}

// Fix round 1 (verifier-opus): the address must be THIS server's owner on record. The router names the tenant from the
// server's own token and signs it; this checks that the email is the one bervo.ai holds for that tenant: the invite
// request's email while it carries the tenant's address code (slug), or kept_email once onboarded (kept_host). A
// read-only equality test: nothing from invite_requests is copied into the newsletter table (test N11).
// Servers built before the invite form (tenant zero, t01, t02, the demos) have no such record: refused ("not_bound"),
// and Allen's Add is the way onto the list for those owners (decision 3).
export async function ownerMatches(db, tenant, email) {
  try {
    const hit = await db.prepare("SELECT 1 AS x FROM invite_requests WHERE (slug = ? AND lower(email) = ?) OR " +
      "(status = 'claimed' AND kept_host = ? AND lower(kept_email) = ?) LIMIT 1").bind(tenant, email, tenant, email).first();
    return !!hit;
  } catch {
    try {   // before migration 0010 (no kept_* columns)
      return !!(await db.prepare("SELECT 1 AS x FROM invite_requests WHERE slug = ? AND lower(email) = ? LIMIT 1").bind(tenant, email).first());
    } catch { return false; }
  }
}

// An unsubscribe from the one-click page, Postmark (unsubscribe / spam complaint) or Allen's Unsubscribe button.
// Only an address already on the list (subscribed) is changed; an unknown address stores nothing.
// -> "unsubscribed" | "unchanged" | "unknown" | "stale"
export async function unsubscribe(db, email, at, nowMs) {
  const when = changeTime(at, nowMs);
  const row = await rowFor(db, email);
  if (!row) return "unknown";
  if (row.status === "unsubscribed") return "unchanged";
  if (when < row.opted_in_at) return "stale";
  await writeUnsubscribed(db, email, when);
  return "unsubscribed";
}

// Allen's Add (decision 3): an existing customer's address, source admin. Never over a suppression entry.
// -> "added" | "already" | "suppressed"
export async function adminAdd(db, email, nowMs) {
  const row = await rowFor(db, email);
  if (row && row.status === "subscribed") return "already";
  if (row && row.status === "unsubscribed") return "suppressed";
  await writeSubscribed(db, email, "admin", new Date(nowMs).toISOString());
  return "added";
}

export async function listAll(db) {
  try {
    const { results } = await db.prepare("SELECT email, status, source, opted_in_at, opted_out_at FROM newsletter ORDER BY status, email").all();
    return results;
  } catch (e) {
    if (missingTable(e)) throw new NotSetUp("newsletter table missing");
    throw e;
  }
}

// ---------- the one-click unsubscribe link ----------
// https://bervo.ai/newsletter/unsubscribe?t=<token>; token = the first 32 hex characters of
// HMAC-SHA256(NEWSLETTER_UNSUB_SECRET, "unsub|<email>"). The address is never in the link; the page finds the row by
// computing the token for each subscribed address (the list is small). Secret: Pages secret NEWSLETTER_UNSUB_SECRET
// (32+ characters, Allen places it). Without it there are no links and the CSV export is refused.
export const TOKEN_RE = /^[0-9a-f]{32}$/;

export function unsubSecret(env) {
  const s = String(env?.NEWSLETTER_UNSUB_SECRET || "");
  return s.length >= 32 ? s : null;
}

export async function unsubToken(secret, email) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsub|${email}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function emailForToken(db, secret, token) {
  if (!TOKEN_RE.test(token || "")) return null;
  let results;
  try { ({ results } = await db.prepare("SELECT email FROM newsletter WHERE status = 'subscribed'").all()); }
  catch (e) { if (missingTable(e)) throw new NotSetUp("newsletter table missing"); throw e; }
  for (const r of results) if ((await unsubToken(secret, r.email)) === token) return r.email;
  return null;
}

export function unsubLink(origin, token) { return `${origin}/newsletter/unsubscribe?t=${token}`; }

// CSV for sending (subscribed only): email, source, opted_in_at, unsubscribe_url. A value starting with = + - @ is
// prefixed with ' so a spreadsheet never runs it as a formula (an address cannot start with those, but the rule holds).
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(rows, secret, origin) {
  const lines = ["email,source,opted_in_at,unsubscribe_url"];
  for (const r of rows) {
    if (r.status !== "subscribed") continue;
    lines.push([r.email, r.source, r.opted_in_at, unsubLink(origin, await unsubToken(secret, r.email))].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
