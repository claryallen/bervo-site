// POST /api/invite — the bervo.ai "Request an Invite" form handler (CR-INVITEFLOW.1 part A).
//
// Bindings and settings (Cloudflare Pages → Settings; placed by Allen, never in this repo):
//   DB                D1 binding: the invite database (functions/_dev/migrations/0001_invite_requests.sql)
//   TURNSTILE_SECRET  secret: the Turnstile widget's secret key
//   TURNSTILE_HOSTNAMES  optional variable: comma-separated hostnames a token may come from (default in _lib)
//   RATE_LIMIT_SALT   secret: a long random string; the IP address is only ever stored as
//                     SHA-256(salt | day | ip), and those rows are deleted after 7 days
//
// Order: config → same-origin → size → rate limit → honeypot → fill time → Turnstile → validation → store.
// A rate-limited, honeypot, too-fast or Turnstile-failed request gets the same thank-you page as a stored one
// and stores nothing (no oracle). Only a real validation problem (which the browser normally catches first)
// sends the person back to the form.
import {
  countRequest, insertInvite, MAX_BODY_BYTES, MIN_FILL_MS, RATE_LIMIT_PER_DAY, redirect, TURNSTILE_HOSTNAMES,
  validateInvite, verifyTurnstile,
} from "../_lib/invites.js";

const THANKS = "/invite-thanks";

export async function onRequestPost(context) {
  const { request, env } = context;
  const fetchImpl = context.fetchImpl || fetch;      // test seam
  const nowMs = context.nowMs ?? Date.now();          // test seam
  if (!env.DB || !env.TURNSTILE_SECRET || !env.RATE_LIMIT_SALT) return redirect("/invite?e=unavailable");

  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return redirect(THANKS);

  const len = Number(request.headers.get("Content-Length") || "0");
  if (len > MAX_BODY_BYTES) return redirect("/invite?e=invalid");
  const ctype = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ctype.startsWith("application/x-www-form-urlencoded") && !ctype.startsWith("multipart/form-data")) {
    return redirect("/invite?e=invalid");
  }
  let form;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return redirect("/invite?e=invalid");
    form = ctype.startsWith("multipart/form-data")
      ? await new Request(request.url, { method: "POST", headers: { "Content-Type": ctype }, body: text }).formData()
      : new URLSearchParams(text);
  } catch {
    return redirect("/invite?e=invalid");
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const count = await countRequest(env.DB, env.RATE_LIMIT_SALT, ip, nowMs);
  if (count > RATE_LIMIT_PER_DAY) return redirect(THANKS);

  if ((form.get("website") || "") !== "") return redirect(THANKS);          // honeypot

  const tRaw = String(form.get("t") || "");
  const started = /^\d{13}$/.test(tRaw) ? Number(tRaw) : NaN;          // ms since 1970, set by /invite.js
  if (!Number.isFinite(started) || nowMs - started < MIN_FILL_MS || started > nowMs + 60000) return redirect(THANKS);

  const hostEnv = String(env.TURNSTILE_HOSTNAMES || "").split(",").map((h) => h.trim()).filter(Boolean);
  const ts = await verifyTurnstile(form.get("cf-turnstile-response"), env.TURNSTILE_SECRET, ip, fetchImpl,
    hostEnv.length ? hostEnv : TURNSTILE_HOSTNAMES);
  if (ts === "error") return redirect("/invite?e=retry");
  if (ts !== "pass") return redirect(THANKS);

  const checked = validateInvite(form);
  if (!checked.ok) return redirect("/invite?e=invalid");

  try {
    await insertInvite(env.DB, checked.value, new Date(nowMs).toISOString());
  } catch {
    return redirect("/invite?e=retry");
  }
  return redirect(THANKS);
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
