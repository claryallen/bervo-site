// The one sender for Bervo's account emails (CR-WELCOMEEMAIL.1; provider Postmark, Allen 11-11 "yes postmark").
//
// What it sends: account emails only — the invite, the setup reminders and "you're loaded". Never customer
// content, a brief or a notification (customer notices stay on screen + text).
//
// Where it runs: Cloudflare Pages Functions on bervo.ai, next to the admin page. It is the only code that holds
// the Postmark key. The key never goes on a customer server (the same rule as the Photon credential).
//
// Settings (Pages variables/secrets; Allen places every one, nothing here has a value):
//   POSTMARK_SERVER_TOKEN  the Postmark *Server* API token of the "Bervo" server (secret). Sending is off without it.
//   MAIL_REPLY_TO          Allen's bervo.ai mailbox, so replies reach a person. Sending is off without it.
//   MAIL_FROM              optional, default "Bervo <hello@bervo.ai>" (spec decision 2).
//   RATE_LIMIT_SALT        the form's existing salt (secret), also salts the address hash below.
//
// Every message goes on the transactional stream "outbound", plain text only, with open and link tracking off
// (no pixel, no rewritten links). Logged: ONE line per send with the template, a salted hash of the address,
// Postmark's MessageID and the result. Never the address, the link or the body (tests prove it).

export const POSTMARK_URL = "https://api.postmarkapp.com/email";
export const MESSAGE_STREAM = "outbound";
export const DEFAULT_FROM = "Bervo <hello@bervo.ai>";

// The words. INVITE is Allen's approved §5 text (INVITE_FORM_COPY_V1.md, 11-10), moved here unchanged from
// admin/invites.js. Every other template is a [GTM] placeholder (GTM's draft NEXT_USER_WORDS_V1.md §A, not
// approved): render() refuses any text that still carries "[GTM]", so a placeholder can never reach a customer.
export const TEMPLATES = {
  invite: {
    subject: "Your Bervo invite",
    fields: ["first_name", "link"],
    body: [
      "Hi {first_name},",
      "",
      "Thanks for requesting an invite to Bervo. I'm glad to have you.",
      "",
      "Here's your personal setup link:",
      "{link}",
      "",
      "It works once and stays open for 14 days. Setup takes you through connecting your email, choosing how much " +
        "history to load, adding your AI API key and texting the Bervo line. Stopped partway? Sign in with your email " +
        "and password and you'll pick up where you left off.",
      "",
      "Any questions, just reply to this email.",
      "",
      "Allen",
    ].join("\n"),
  },
  // Spec decision 3 (day 3 and day 10 if the invite is not taken up): PENDING ALLEN. The trigger is not built;
  // the words are GTM's unapproved draft. See the report for why the reminder carries no link.
  reminder_day3: {
    subject: "[GTM] Your Bervo setup link",
    fields: ["first_name", "sent_date", "expiry_date"],
    body: "[GTM] Hi {first_name}, a reminder: your setup link is in our email of {sent_date} and stays open until " +
      "{expiry_date}. Allen",
  },
  reminder_day10: {
    subject: "[GTM] Your Bervo link closes {expiry_date}",
    fields: ["first_name", "sent_date", "expiry_date"],
    body: "[GTM] Hi {first_name}, your setup link (our email of {sent_date}) closes on {expiry_date}. Allen",
  },
  // "You're loaded": the trigger (a customer server telling this sender) is PENDING the design decision in the
  // report; the words are GTM's unapproved draft.
  loaded: {
    subject: "[GTM] Bervo is ready",
    fields: ["first_name", "dashboard_link"],
    body: "[GTM] Hi {first_name}, Bervo has read your recent email and your dashboard is ready: {dashboard_link} Allen",
  },
};

// A set-password link as tools/tenant/owner_invite_link.py prints it: https://<host>.bervo.ai/set-password?t=<token>
// (token = secrets.token_urlsafe(32), 43 characters). Nothing else is accepted as {link}.
export const INVITE_LINK_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.bervo\.ai\/set-password\?t=[A-Za-z0-9_-]{32,128}$/;
const DASHBOARD_LINK_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.bervo\.ai\/$/;
const NAME_MAX = 80;
const DATE_RE = /^[A-Za-z0-9 ,]{1,40}$/;
const ADDRESS_RE = /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)+$/;   // invites.js EMAIL_RE

export class MailError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fieldOk(name, v) {
  if (typeof v !== "string") return false;
  if (/[\u0000-\u001F\u007F]/.test(v) || /\p{Cf}/u.test(v)) return false;     // no line breaks, no hidden marks
  if (name === "link") return INVITE_LINK_RE.test(v);
  if (name === "dashboard_link") return DASHBOARD_LINK_RE.test(v);
  if (name === "first_name") return v.trim().length > 0 && v.length <= NAME_MAX;
  if (name.endsWith("_date")) return DATE_RE.test(v);
  return false;
}

// -> { subject, text }. Throws MailError("unknown_template" | "bad_field:<name>" | "placeholder").
export function render(template, fields) {
  const t = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : null;
  if (!t) throw new MailError("unknown_template");
  for (const f of t.fields) if (!fieldOk(f, fields?.[f])) throw new MailError(`bad_field:${f}`);
  const fill = (s) => s.replace(/\{([a-z_]+)\}/g, (m, k) => (t.fields.includes(k) ? fields[k] : m));
  const subject = fill(t.subject);
  const text = fill(t.body);
  if (subject.includes("[GTM]") || text.includes("[GTM]")) throw new MailError("placeholder");
  if (/\{[a-z_]+\}/.test(subject + text)) throw new MailError("unfilled");
  return { subject, text };
}

// -> null when sending is possible, else why not (shown on the admin page; Copy is the fallback).
export function sendingOff(env) {
  if (!env || !String(env.POSTMARK_SERVER_TOKEN || "").trim()) return "the Postmark key is not set";
  if (!ADDRESS_RE.test(String(env.MAIL_REPLY_TO || "").trim().toLowerCase())) return "the reply-to address is not set";
  if (!String(env.RATE_LIMIT_SALT || "")) return "the salt is not set";
  if (!env.DB) return "the database is not connected";
  return null;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A salted hash of the address, 16 hex characters: enough to tell two sends to one address apart in the log,
// not the address.
export async function addressHash(salt, address) {
  return (await sha256Hex(`${salt}|mail|${String(address).trim().toLowerCase()}`)).slice(0, 16);
}

function logLine(say, o) {
  // The only log this module writes. Keys are fixed; values are a template name, a hash, an id and a word.
  say(JSON.stringify({ event: "account_mail", template: o.template, to_hash: o.to_hash, message_id: o.message_id ?? null,
    result: o.result, error_code: o.error_code ?? null }));
}

// Send one email. -> { ok, status: "sent"|"failed", message_id, error_code, why }.
// Records one invite_mail row (never the address or the body) and logs one line. Throws MailError before any
// network call when the template, a field or the settings are wrong (nothing recorded, nothing sent).
export async function sendTemplate(env, { template, to, fields, requestId, nowMs = Date.now(), fetchImpl = fetch,
  say = console.log }) {
  const off = sendingOff(env);
  if (off) throw new MailError("off");
  const address = String(to || "").trim().toLowerCase();
  if (!ADDRESS_RE.test(address) || address.length > 254) throw new MailError("bad_address");
  if (!Number.isInteger(requestId) || requestId < 1) throw new MailError("bad_request_id");
  const { subject, text } = render(template, fields);
  const toHash = await addressHash(env.RATE_LIMIT_SALT, address);
  const payload = {
    From: String(env.MAIL_FROM || "").trim() || DEFAULT_FROM,
    To: address,
    ReplyTo: String(env.MAIL_REPLY_TO).trim(),
    Subject: subject,
    TextBody: text,
    MessageStream: MESSAGE_STREAM,
    Tag: template,
    TrackOpens: false,
    TrackLinks: "None",
  };
  let status = "failed", messageId = null, errorCode = null, why = null;
  try {
    const res = await fetchImpl(POSTMARK_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json",
        "X-Postmark-Server-Token": String(env.POSTMARK_SERVER_TOKEN).trim() },
      body: JSON.stringify(payload),
    });
    let out = null;
    try { out = await res.json(); } catch { out = null; }
    const code = out && Number.isInteger(out.ErrorCode) ? out.ErrorCode : null;
    const mid = out && typeof out.MessageID === "string" && /^[A-Za-z0-9-]{1,64}$/.test(out.MessageID) ? out.MessageID : null;
    if (res.ok && code === 0 && mid) {
      status = "sent"; messageId = mid;
    } else {
      errorCode = code ?? res.status;
      why = POSTMARK_ERRORS[errorCode] || `Postmark refused it (code ${errorCode})`;
    }
  } catch {
    errorCode = -1; why = "Postmark could not be reached";
  }
  const nowIso = new Date(nowMs).toISOString();
  await env.DB.prepare("INSERT INTO invite_mail (request_id, template, address_hash, message_id, status, error_code, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)").bind(requestId, template, toHash, messageId, status, errorCode, nowIso).run();
  logLine(say, { template, to_hash: toHash, message_id: messageId, result: status, error_code: errorCode });
  return { ok: status === "sent", status, message_id: messageId, error_code: errorCode, why };
}

// Postmark API error codes worth a plain sentence on the admin page (postmarkapp.com/developer/api/overview,
// read 11-11). 429 is an HTTP status (rate limit), used when the reply carries no ErrorCode.
export const POSTMARK_ERRORS = {
  10: "the Postmark key was refused",
  300: "Postmark refused the message as invalid",
  406: "the address is inactive at Postmark (an earlier bounce or complaint)",
  412: "the Postmark account is still pending approval (it only sends to the From address's own domain)",
  429: "Postmark rate limit",
};

// ---------- what Postmark tells us (webhook) ----------
const RANK = { failed: 0, sent: 1, delivered: 2, bounced: 3, complained: 4 };
const RECORD_STATUS = { Delivery: "delivered", Bounce: "bounced", SpamComplaint: "complained" };

// Apply one webhook record. -> "applied" | "ignored" (unknown type, unknown message, or weaker than what we have).
export async function applyEvent(db, rec, nowMs = Date.now()) {
  const to = rec && Object.hasOwn(RECORD_STATUS, rec.RecordType) ? RECORD_STATUS[rec.RecordType] : null;
  const mid = rec && typeof rec.MessageID === "string" && /^[A-Za-z0-9-]{1,64}$/.test(rec.MessageID) ? rec.MessageID : null;
  if (!to || !mid) return "ignored";
  const row = await db.prepare("SELECT id, status FROM invite_mail WHERE message_id = ? ORDER BY id DESC LIMIT 1").bind(mid).first();
  if (!row || (RANK[row.status] ?? 0) >= RANK[to]) return "ignored";
  const detail = to === "bounced" && typeof rec.Type === "string" && /^[A-Za-z]{1,40}$/.test(rec.Type) ? rec.Type : null;
  await db.prepare("UPDATE invite_mail SET status = ?, detail = ?, event_at = ? WHERE id = ?")
    .bind(to, detail, new Date(nowMs).toISOString(), row.id).run();
  return "applied";
}

// ---------- reminders (spec decision 3, PENDING ALLEN: the rule only; nothing calls it yet) ----------
export const REMINDER_DAYS = { reminder_day3: 3, reminder_day10: 10 };

// Which reminder is due for one invite, or null. mails = that request's invite_mail rows.
// Due when: the request is still 'invited' (not claimed, expired or withdrawn), an invite email was accepted,
// no email to it ever bounced or drew a complaint, the day has come, that reminder was never sent, and the
// 14-day link has not run out. No automatic resend of anything that failed.
export function reminderDue(request, mails, nowMs) {
  if (!request || request.status !== "invited") return null;
  const list = mails || [];
  if (list.some((m) => m.status === "bounced" || m.status === "complained")) return null;
  const invites = list.filter((m) => m.template === "invite" && m.status !== "failed");
  if (!invites.length) return null;
  const sentMs = Math.max(...invites.map((m) => Date.parse(m.created_at)));
  const age = (nowMs - sentMs) / 86400000;
  if (age >= 14) return null;
  for (const t of ["reminder_day10", "reminder_day3"]) {
    if (age >= REMINDER_DAYS[t]) {
      const done = list.some((m) => m.template === t && Date.parse(m.created_at) >= sentMs);
      return done ? null : t;
    }
  }
  return null;
}
