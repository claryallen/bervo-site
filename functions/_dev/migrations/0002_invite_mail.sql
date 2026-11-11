-- D1 schema for the account emails Bervo sends through Postmark (CR-WELCOMEEMAIL.1).
-- Allen pastes this into the D1 console after 0001 (production and preview databases). Safe to run twice.
--
-- One row per email sent (or tried). Never the address and never the body: only a salted hash of the address
-- (functions/_lib/mail.js addressHash), the template name, Postmark's MessageID and what happened to it.
-- Retention: a request's rows go with it (deleted when the request is deleted; address_hash cleared when the
-- request is trimmed on "claimed"); a server's "loaded" row keeps its hash 90 days, then the hash is cleared
-- (the row stays as the once-only record). See functions/_lib/invites.js pruneOld and the admin page.

CREATE TABLE IF NOT EXISTS invite_mail (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER,                                -- invite_requests.id (invite, reminders)
  tenant        TEXT CHECK (tenant IS NULL OR length(tenant) BETWEEN 1 AND 31),   -- the customer server ("loaded")
  template      TEXT NOT NULL CHECK (template IN ('invite', 'reminder_day3', 'reminder_day10', 'loaded')),
  address_hash  TEXT CHECK (address_hash IS NULL OR length(address_hash) = 16),
  message_id    TEXT CHECK (message_id IS NULL OR length(message_id) <= 64),   -- Postmark MessageID
  -- sent: Postmark accepted it · failed: not accepted (error_code says why) · delivered / bounced / complained:
  -- from Postmark's webhook. complained > bounced > delivered > sent (a later, weaker event never overwrites).
  status        TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'delivered', 'bounced', 'complained')),
  error_code    INTEGER,                                -- Postmark ErrorCode on failure; -1 = could not reach it
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 40),   -- bounce Type, e.g. HardBounce
  created_at    TEXT NOT NULL,                          -- UTC ISO-8601
  event_at      TEXT,                                   -- the last webhook event's time
  CHECK ((request_id IS NULL) <> (tenant IS NULL))      -- an email belongs to a request or to a server, not both
);
CREATE INDEX IF NOT EXISTS invite_mail_request ON invite_mail (request_id, id);
CREATE INDEX IF NOT EXISTS invite_mail_message ON invite_mail (message_id);
-- "You're loaded" goes once per customer server (Allen 11-11): a second accepted one cannot be recorded.
CREATE UNIQUE INDEX IF NOT EXISTS invite_mail_once_per_tenant ON invite_mail (tenant, template)
  WHERE tenant IS NOT NULL AND status <> 'failed';
