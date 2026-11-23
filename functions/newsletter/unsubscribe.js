// /newsletter/unsubscribe?t=<token> — the one-click unsubscribe link for Bervo news and announcements (CR-NEWSLETTER.1).
//
// GET shows a page with one Unsubscribe button (a GET never changes anything: mail scanners open links on their own).
// POST unsubscribes: the page's button, or a mail program's one-click request (RFC 8058: body
// "List-Unsubscribe=One-Click"). The token is functions/_lib/newsletter.js unsubToken (the address is never in the link).
// Every answer is the same whether or not the token matched anyone, so the page tells nobody who is on the list.
import { emailForToken, NotSetUp, TOKEN_RE, unsubscribe, unsubSecret } from "../_lib/newsletter.js";

function page(inner, status = 200) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Bervo news</title>
<style>:root{--bg:#fff;--fg:#1b1b1b;--muted:#666;--btn:#1b1b1b;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--fg:#e8e8e8;--muted:#9a9a9a;--btn:#e8e8e8;--btnfg:#0d0d0d;color-scheme:dark}}
body{max-width:560px;margin:3rem auto;padding:0 16px;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
p{color:var(--muted)}button{font:inherit;padding:.5rem 1.1rem;border:0;border-radius:6px;background:var(--btn);color:var(--btnfg);cursor:pointer}</style>
</head><body><h1>Bervo news and announcements</h1>${inner}</body></html>`;
  return new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}

const DONE = "<p>You're unsubscribed. You won't get Bervo news and announcements anymore.</p>" +
  "<p>Notices about your Bervo service itself (billing, policy changes, security) still come to your account email.</p>";
const BROKEN = "<p>This unsubscribe link isn't complete. Copy the whole link from the email, or reply to any Bervo email and we'll take you off the list.</p>";

export async function onRequestGet(context) {
  const t = new URL(context.request.url).searchParams.get("t") || "";
  if (!TOKEN_RE.test(t)) return page(BROKEN, 400);
  return page(`<p>Stop getting Bervo news and announcements at this address?</p>
<form method="post" action="/newsletter/unsubscribe?t=${t}"><button type="submit" name="confirm" value="1" title="Stop Bervo news and announcements at this address. Notices about your Bervo service still come.">Unsubscribe</button></form>`);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const t = new URL(request.url).searchParams.get("t") || "";
  if (!TOKEN_RE.test(t)) return page(BROKEN, 400);
  const secret = unsubSecret(env);
  if (!secret || !env.DB) return page("<p>Unsubscribing isn't available right now. Reply to any Bervo email and we'll take you off the list.</p>", 503);
  let result = "unknown";
  try {
    const email = await emailForToken(env.DB, secret, t);
    if (email) result = await unsubscribe(env.DB, email, null, context.nowMs ?? Date.now());
  } catch (e) {
    // never claim "unsubscribed" when nothing could be written (table missing, D1 error)
    if (e instanceof NotSetUp) return page("<p>Unsubscribing isn't available right now. Reply to any Bervo email and we'll take you off the list.</p>", 503);
    return page("<p>Something went wrong. Please try again, or reply to any Bervo email.</p>", 500);
  }
  (context.say || console.log)(JSON.stringify({ event: "newsletter_unsubscribe_link", result }));
  return page(DONE);
}
