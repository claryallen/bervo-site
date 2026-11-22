-- CR-POSTREH1121.1 item 4 (Allen 11-21): two more account emails, sent once per customer server when setup completes:
-- texts_mac and texts_android ("how to add your texts"). invite_mail's template CHECK lists the allowed names and
-- SQLite can't change a CHECK, so the table is rebuilt (the 0006 pattern): create the new shape, copy every row,
-- swap it in, re-create the indexes. Run once, after 0007, BEFORE the code that sends the new templates is published.
-- Not safe to run twice (check first:
-- SELECT sql FROM sqlite_master WHERE name='invite_mail' must not already list 'texts_mac').
CREATE TABLE invite_mail_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER,
  tenant        TEXT CHECK (tenant IS NULL OR length(tenant) BETWEEN 1 AND 31),
  template      TEXT NOT NULL CHECK (template IN ('invite', 'reminder_day3', 'reminder_day10', 'loaded',
                                                  'texts_mac', 'texts_android')),
  address_hash  TEXT CHECK (address_hash IS NULL OR length(address_hash) = 16),
  message_id    TEXT CHECK (message_id IS NULL OR length(message_id) <= 64),
  status        TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'delivered', 'bounced', 'complained')),
  error_code    INTEGER,
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 40),
  created_at    TEXT NOT NULL,
  event_at      TEXT,
  CHECK ((request_id IS NULL) <> (tenant IS NULL))
);
INSERT INTO invite_mail_new (id, request_id, tenant, template, address_hash, message_id, status, error_code, detail,
                             created_at, event_at)
  SELECT id, request_id, tenant, template, address_hash, message_id, status, error_code, detail, created_at, event_at
  FROM invite_mail;
DROP TABLE invite_mail;
ALTER TABLE invite_mail_new RENAME TO invite_mail;
CREATE INDEX IF NOT EXISTS invite_mail_request ON invite_mail (request_id, id);
CREATE INDEX IF NOT EXISTS invite_mail_message ON invite_mail (message_id);
CREATE UNIQUE INDEX IF NOT EXISTS invite_mail_once_per_tenant ON invite_mail (tenant, template)
  WHERE tenant IS NOT NULL AND status <> 'failed';
