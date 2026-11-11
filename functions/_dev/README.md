# bervo.ai

Static pages for bervo.ai (terms, privacy, landing, the Request an Invite form). Deployed by Cloudflare Pages from
this repository.

**Why this file lives here, not at the repository root:** Pages serves the repository root as the site, and a
`_redirects` rule does not protect a file (an encoded slash, `/a%2Fb`, bypassed it on the preview, 2026-11-10).
Pages does not serve the `functions/` directory as static files, and its Functions builder only makes routes from
files that export `onRequest…`. So everything that is not part of the site lives under `functions/`:

- `functions/_lib/invites.js` — code shared by the invite handler and the admin page (no route).
- `functions/_dev/migrations/0001_invite_requests.sql` — the D1 schema (paste into the D1 console; safe to run twice).
- `functions/_dev/migrations/0002_invite_mail.sql` — the account-email records (CR-WELCOMEEMAIL.1; run after 0001).
- `functions/_lib/mail.js` — the one sender for account emails (Postmark; key = Pages secret `POSTMARK_SERVER_TOKEN`,
  plus `MAIL_REPLY_TO`, optional `MAIL_FROM`). `functions/api/postmark-events.js` is Postmark's webhook
  (Basic auth, Pages secret `POSTMARK_WEBHOOK_SECRET`). `functions/api/account-mail.js` takes the router's signed
  "you're loaded" request (Pages secret `BERVO_MAIL_RELAY_SECRET`, the same value as the router's). Tests:
  `functions/_dev/tests/mail.test.js` (Postmark mocked).
- `functions/_dev/tests/invite.test.js` — tests: `node --experimental-default-type=module --test functions/_dev/tests/invite.test.js`
  (Node 22+, no packages; D1 is mocked over `node:sqlite` with the real schema). It exports nothing, so it is never a route.

Never put a non-site file at the repository root, and **never commit a `wrangler.toml`** (Pages would then take its
bindings from the file instead of the dashboard).

Local run with the real Pages runtime (optional): copy the site to a scratch folder, add a throwaway `wrangler.toml`
there with `pages_build_output_dir = "."` and a `DB` D1 binding, put `TURNSTILE_SECRET` / `RATE_LIMIT_SALT` (and
`TURNSTILE_HOSTNAMES=example.com`, the hostname Cloudflare's public test keys report) in `.dev.vars`, then
`wrangler d1 execute DB --local --file functions/_dev/migrations/0001_invite_requests.sql` and `wrangler pages dev .`.
Note: Cloudflare's public test keys return no `action`, so with them every request is treated as a Turnstile failure
(thank-you page, nothing stored); that is the strict check working. `wrangler pages dev` also serves `functions/` as
files locally; the real Pages does not (checked on the preview).
