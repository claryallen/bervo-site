// Shared code for automatic server builds (CR-AUTOPROVISION.1, Allen 11-15: "Approve is the go").
//
// The Mini's picker (daily-dashboard tools/tenant/auto_provision.py) builds the server for an approved request
// and talks to bervo.ai through two SIGNED endpoints, both modelled on /api/account-mail with their OWN secret:
//   /api/provision-state  the build's state (claim, step, ready, failed, waiting_cap). The Mini's D1 token stays
//                         read-only: a Cloudflare API token's D1 permission is account-wide ("D1 Edit: Grants write
//                         access to D1", developers.cloudflare.com/fundamentals/api/reference/permissions, read
//                         11-15) and cannot be narrowed to a table or column, so every write goes through here,
//                         where the code allows exactly these state changes and nothing else.
//   /api/provision-link   the owner's one-time link (owner_invite_link.py --deliver), stored ENCRYPTED until Allen
//                         presses Send (or sent at once when AUTO_SEND_INVITE / AUTO_SEND_REMINDERS is on).
//
// Settings (Pages; Allen places every one, nothing here has a value):
//   BERVO_PROVISION_SECRET  32+ characters, the same value as the Mini's 600 file. Without it: 503.
//   BERVO_LINK_KEY          32+ characters, a separate secret: the AES-GCM key for stored links. Without it the link
//                           endpoint answers 503 (a link is never stored in plain text).
//   AUTO_SEND_INVITE        "on" sends the invite email the moment the link arrives. Default off (Allen 11-15:
//                           the email waits for his Send at first).
//   AUTO_SEND_REMINDERS     "on" sends a due day-3 / day-10 reminder the moment its fresh link arrives. Default off.
// Signature: x-bervo-provision-ts = unix seconds; x-bervo-provision-sig = hex HMAC-SHA256(secret, "<ts>.<raw body>").
// Accepted within 5 minutes of ts, and each signature only once (provision_nonces, a primary key).

import { linkMatchesSlug, MailError, reminderDue, reminderExpiryDate, sendingOff, sendTemplate } from "./mail.js";

export const WINDOW_S = 300;
export const NONCE_KEEP_S = 600;
export const MAX_BYTES = 4096;
export const LINK_TTL_MS = 14 * 86400000 - 3600000;   // the server's link lives 14 days from issue; stated an hour short
export const STATES = ["queued", "building", "ready", "failed", "waiting_cap", "stopped"];
// Fix round 1 item 2: invite_to_profile.py's unattended defaults as fixed codes (tools/tenant/invite_to_profile.py
// NOTE_CODES, the same set: the tests compare them). Shown on the admin page beside the build, before Send.
export const NOTE_WORDS = {
  mac_unknown: "The request predates the computer question: Mac uploads set OFF (ask whether they have a Mac).",
  tz_defaulted: "No usable time zone on the form: set to America/New_York (they can change it on /welcome).",
  plan_standard: "Plan Standard: built as a dedicated server for now (Standard is not built yet).",
  plan_missing: "No usable plan on the request: none written.",
  cohort_unsupported: "Cohort not written (an older provisioner).",
  no_provider: "No email provider ticked: no mail source set up.",
  provider_other: "\"Other\" email provider ticked: no mail source set up for it (what they wrote is on their server's setup answers).",
  providers_multi: "Several email providers ticked: the sign-in email's provider is set up; they connect the others on /welcome.",
  android: "Android: their texts come through the Bervo app for Android.",
  iphone_no_mac: "iPhone without a Mac: their own texts can't come in (the invite email already says so).",
  ipad_only: "iPad and/or phone only: setup on those devices is not tested yet.",
  pronouns_default: "Pronouns are not on the form: set to \"they\".",
};
export const NOTE_CODES = Object.keys(NOTE_WORDS);
// new_customer.sh's steps, plus the picker's own: profile (invite_to_profile.py), approval_check (the unattended
// check refused), scan (the secret scan failed the log), timeout (the wall-clock limit), interrupted (the Mini
// stopped mid-build). Kept in step with 0007_provisioning.sql and auto_provision.py (tests check both).
export const STEPS = ["profile", "approval_check", "droplet", "ssh", "phase0", "phase1", "phase2", "phase2b", "phase3",
  "phase4", "phase4b", "phase5", "phase6", "line", "owner", "health", "scan", "timeout", "interrupted"];
export const BUILD_STEPS = ["droplet", "ssh", "phase0", "phase1", "phase2", "phase2b", "phase3", "phase4", "phase4b",
  "phase5", "phase6", "line", "owner", "health"];
export const KINDS = ["invite", "reminder3", "reminder10"];
export const KIND_TEMPLATE = { invite: "invite", reminder3: "reminder_day3", reminder10: "reminder_day10" };
export const TEMPLATE_KIND = { invite: "invite", reminder_day3: "reminder3", reminder_day10: "reminder10" };
export const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const enc = new TextEncoder();

export function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// -> 0 (good) or an HTTP status: 503 not configured, 401 bad/old signature, 409 a replay.
export async function verifySigned(request, raw, env, nowMs) {
  const secret = String(env.BERVO_PROVISION_SECRET || "");
  if (secret.length < 32 || !env.DB) return 503;
  const ts = request.headers.get("x-bervo-provision-ts") || "";
  const sig = (request.headers.get("x-bervo-provision-sig") || "").toLowerCase();
  if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return 401;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > WINDOW_S) return 401;
  if (!sameHex(await hmacHex(secret, `${ts}.${raw}`), sig)) return 401;
  // Each signature once: a captured request replayed inside the window is refused.
  const sigHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(sig)));
  const nowIso = new Date(nowMs).toISOString();
  try {
    await env.DB.prepare("DELETE FROM provision_nonces WHERE created_at < ?").bind(new Date(nowMs - NONCE_KEEP_S * 1000).toISOString()).run();
    await env.DB.prepare("INSERT INTO provision_nonces (sig_hash, created_at) VALUES (?, ?)").bind(sigHash, nowIso).run();
  } catch (e) {
    return /UNIQUE|PRIMARY/i.test(String(e?.message || "")) ? 409 : 503;   // 503: the 0007 table is not there yet
  }
  return 0;
}

export function autoSendOn(env, kind) {
  const v = String((kind === "invite" ? env.AUTO_SEND_INVITE : env.AUTO_SEND_REMINDERS) || "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

// ---------- links, encrypted at rest ----------
async function linkKey(env) {
  const secret = String(env.BERVO_LINK_KEY || "");
  if (secret.length < 32) return null;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`bervo-link-key|${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function linkKeyReady(env) { return (await linkKey(env)) !== null; }

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aad = (requestId, kind) => enc.encode(`invite_links|${requestId}|${kind}`);

export async function encryptLink(env, requestId, kind, link) {
  const key = await linkKey(env);
  if (!key) throw new Error("no link key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(requestId, kind) }, key, enc.encode(link));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decryptLink(env, requestId, kind, iv, ct) {
  const key = await linkKey(env);
  if (!key) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: aad(requestId, kind) }, key, unb64(ct));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

// Store (or replace) the waiting link for one request and kind. -> expires_at.
export async function storeLink(db, env, requestId, kind, link, nowMs) {
  const { iv, ct } = await encryptLink(env, requestId, kind, link);
  const expires = new Date(nowMs + LINK_TTL_MS).toISOString();
  await db.prepare("INSERT INTO invite_links (request_id, kind, iv, ct, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(request_id, kind) DO UPDATE SET iv = excluded.iv, ct = excluded.ct, created_at = excluded.created_at, " +
    "expires_at = excluded.expires_at").bind(requestId, kind, iv, ct, new Date(nowMs).toISOString(), expires).run();
  return expires;
}

export async function dropExpiredLinks(db, nowMs) {
  try { await db.prepare("DELETE FROM invite_links WHERE expires_at <= ?").bind(new Date(nowMs).toISOString()).run(); }
  catch { /* no 0007 table yet */ }
}

// The waiting link in plain text (for the one email being sent) with when it arrived, or null (none, expired, or
// unreadable). -> { link, issuedMs }
export async function readLink(db, env, requestId, kind, nowMs) {
  await dropExpiredLinks(db, nowMs);
  let row = null;
  try { row = await db.prepare("SELECT iv, ct, created_at FROM invite_links WHERE request_id = ? AND kind = ?").bind(requestId, kind).first(); }
  catch { return null; }
  if (!row) return null;
  const link = await decryptLink(env, requestId, kind, row.iv, row.ct);
  return link ? { link, issuedMs: Date.parse(row.created_at) } : null;
}

export async function deleteLink(db, requestId, kind) {
  try { await db.prepare("DELETE FROM invite_links WHERE request_id = ? AND kind = ?").bind(requestId, kind).run(); }
  catch { /* no 0007 table yet */ }
}

// For the admin page: Map(id -> provision row) and Map(id -> {kind: expires_at}). Never selects iv/ct.
export async function provisionFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { results } = await db.prepare(`SELECT request_id, state, step, queued_at, started_at, finished_at, retry_requested_at, notes, updated_at ` +
      `FROM invite_provision WHERE request_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    for (const r of results) out.set(r.request_id, r);
  } catch { /* no 0007 table yet */ }
  return out;
}

export async function linksFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { results } = await db.prepare(`SELECT request_id, kind, expires_at FROM invite_links WHERE request_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all();
    for (const r of results) { if (!out.has(r.request_id)) out.set(r.request_id, {}); out.get(r.request_id)[r.kind] = r.expires_at; }
  } catch { /* no 0007 table yet */ }
  return out;
}

// ---------- sending an email with a delivered link ----------
// One email (invite or the due reminder) with `link`. -> "ok" | "off" | "host" | "link" | "notdue" | "state" | "failed".
// The same rules as the admin page's paste-and-Send (functions/admin/invites.js sendInvite / sendReminder): the link
// must be on the request's own host, a reminder only when reminderDue() names that reminder, and a sent invite marks
// an approved request invited. Nothing here logs the link (mail.js logs a template, an address hash and a result).

// issuedMs: when the link was minted (it arrived here moments later). A reminder states the link's closing date from
// it, so a reminder Allen sends days after the link arrived never promises a date later than the link really lasts.
export async function sendLinkEmail({ db, env, row, kind, link, nowMs, issuedMs = nowMs, fetchImpl = fetch, say = console.log }) {
  if (sendingOff(env)) return "off";
  if (!row.slug || !linkMatchesSlug(link, row.slug)) return "host";
  const template = KIND_TEMPLATE[kind];
  let fields;
  if (kind === "invite") {
    if (row.status !== "approved" && row.status !== "invited") return "state";
    fields = { first_name: row.first_name, link, phone: row.phone, computers: row.computers };
  } else {
    let mails = [];
    try { mails = (await db.prepare("SELECT * FROM invite_mail WHERE request_id = ? ORDER BY id DESC").bind(row.id).all()).results; }
    catch { return "failed"; }
    if (reminderDue(row, mails, nowMs) !== template) return "notdue";
    fields = { first_name: row.first_name, link, expiry_date: reminderExpiryDate(Math.min(issuedMs, nowMs), row.timezone) };
  }
  let res;
  try {
    res = await sendTemplate(env, { template, to: row.email, fields, requestId: row.id, nowMs, fetchImpl, say });
  } catch (e) {
    if (e instanceof MailError && e.code === "bad_field:link") return "link";
    return e instanceof MailError && e.code === "off" ? "off" : "failed";
  }
  if (!res.ok) return "failed";
  if (kind === "invite" && row.status === "approved") {
    const nowIso = new Date(nowMs).toISOString();
    await db.prepare("UPDATE invite_requests SET status = 'invited', status_changed_at = ?, invited_at = ? WHERE id = ? AND status = 'approved'")
      .bind(nowIso, nowIso, row.id).run();
  }
  return "ok";
}
