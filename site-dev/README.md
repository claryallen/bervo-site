# site-dev — tests and the D1 schema for the invite form (not part of the site)

`/site-dev/*`, `/functions/*` and `/functions-lib/*` are redirected away in `_redirects`, because Pages serves this
repository's root as the site.

- **Schema:** `migrations/0001_invite_requests.sql` (paste into the D1 console; safe to run twice).
- **Tests:** `node --experimental-default-type=module --test site-dev/tests/invite.test.js` (Node 22+, no packages;
  D1 is mocked over `node:sqlite` with the real schema).
- **Local run with the real Pages runtime** (optional): copy the site to a scratch folder, add a throwaway
  `wrangler.toml` there with `pages_build_output_dir = "."` and a `DB` D1 binding, put `TURNSTILE_SECRET` /
  `RATE_LIMIT_SALT` in `.dev.vars` (Cloudflare's public Turnstile test keys work), then
  `wrangler d1 execute DB --local --file site-dev/migrations/0001_invite_requests.sql` and `wrangler pages dev .`.
  **Never commit a `wrangler.toml` to this repository:** Pages would then take its bindings from the file instead
  of the dashboard.
