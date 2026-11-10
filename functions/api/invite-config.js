// GET /api/invite-config — the public Turnstile site key for /invite (CR-INVITEFLOW.1 part A).
// TURNSTILE_SITE_KEY is a plain (non-secret) Pages variable, so the page needs no edit per environment.
export async function onRequestGet({ env }) {
  const key = String(env.TURNSTILE_SITE_KEY || "").trim();
  const ok = /^[0-9A-Za-z_-]{10,100}$/.test(key) && env.DB && env.TURNSTILE_SECRET && env.RATE_LIMIT_SALT;
  return new Response(JSON.stringify(ok ? { site_key: key } : { unavailable: true }), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff" },
  });
}
