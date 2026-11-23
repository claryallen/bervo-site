-- CR-NEWSLETTER.1 (Allen 11-23, "Yes, build it"): the Bervo news and announcements list. One row per address and
-- nothing else: no name, no tenant, no request id, no IP. Invite-request data never feeds this table.
--
--   subscribed    email, source ('setup' = the owner ticked the box on their server's "A few preferences" screen or
--                 turned the Settings switch on; 'admin' = Allen added an existing customer who asked him), opted_in_at.
--   unsubscribed  the suppression entry (decision 2, Allen 11-23): ONLY email + opted_out_at, so nobody is re-added by
--                 mistake. source and opted_in_at are erased in the same write (the CHECK below enforces it).
--
-- Allen pastes this into the D1 console (bervo-invites; preview database first, then production) BEFORE publishing the
-- code that uses it. Safe to run twice (IF NOT EXISTS). Without it every newsletter endpoint answers 503 / "not set up"
-- and the admin Newsletter page says the table is missing; nothing else on the site changes.
-- Check after: SELECT sql FROM sqlite_master WHERE name = 'newsletter';
CREATE TABLE IF NOT EXISTS newsletter (
  email        TEXT PRIMARY KEY CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email) AND instr(email, '@') > 1),
  status       TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  source       TEXT CHECK (source IS NULL OR source IN ('setup', 'admin')),
  opted_in_at  TEXT,
  opted_out_at TEXT,
  CHECK ((status = 'subscribed' AND source IS NOT NULL AND opted_in_at IS NOT NULL AND opted_out_at IS NULL)
      OR (status = 'unsubscribed' AND source IS NULL AND opted_in_at IS NULL AND opted_out_at IS NOT NULL))
);
