-- Removes company and role from invite requests (Allen 11-11: Bervo is personal to the owner, not tied to one
-- company; not asking is more private). SQLite can't drop a table CHECK, so the table is rebuilt: create the new
-- shape, copy every row (all columns except company/role), swap it in, re-create the index. Run once, after 0005,
-- BEFORE the code that stops sending company/role is published. Not safe to run twice (the copy names company).
CREATE TABLE invite_requests_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL,
  first_name        TEXT CHECK (first_name IS NULL OR length(first_name) BETWEEN 1 AND 80),
  last_name         TEXT CHECK (last_name IS NULL OR length(last_name) BETWEEN 1 AND 80),
  email             TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  has_assistant     TEXT CHECK (has_assistant IS NULL OR has_assistant IN ('yes', 'no')),
  email_providers   TEXT CHECK (email_providers IS NULL OR email_providers IN (
                      '["google"]', '["microsoft"]', '["other"]', '["google","microsoft"]',
                      '["google","other"]', '["microsoft","other"]', '["google","microsoft","other"]')),
  other_email       TEXT CHECK (other_email IS NULL OR length(other_email) BETWEEN 1 AND 40),
  computers         TEXT CHECK (computers IS NULL OR computers IN ('["windows"]', '["mac"]', '["windows","mac"]', '["none"]')),
  phone             TEXT CHECK (phone IS NULL OR phone IN ('iphone', 'android')),
  plan              TEXT NOT NULL CHECK (plan IN ('standard', 'private')),
  heard_from        TEXT CHECK (heard_from IS NULL OR heard_from IN ('referral', 'social', 'search', 'ai', 'media', 'ad', 'event', 'other')),
  heard_detail      TEXT CHECK (heard_detail IS NULL OR length(heard_detail) BETWEEN 1 AND 200),
  timezone          TEXT CHECK (timezone IS NULL OR length(timezone) <= 64),
  about             TEXT CHECK (about IS NULL OR length(about) BETWEEN 1 AND 1000),
  referral          TEXT CHECK (referral IS NULL OR referral IN ('allen')),
  cohort            TEXT NOT NULL DEFAULT 'public' CHECK (cohort IN ('public', 'private')),
  privacy_agreed_at TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'approved', 'not_now', 'invited', 'claimed', 'expired')),
  status_changed_at TEXT,
  approved_at       TEXT,
  invited_at        TEXT,
  slug              TEXT CHECK (slug IS NULL OR length(slug) <= 31),
  note              TEXT CHECK (note IS NULL OR length(note) <= 2000),
  -- Every open request carries the core answers; a claimed request carries none of the request at all.
  CHECK (
    (status <> 'claimed' AND first_name IS NOT NULL AND last_name IS NOT NULL AND email IS NOT NULL
      AND has_assistant IS NOT NULL AND email_providers IS NOT NULL AND phone IS NOT NULL AND about IS NOT NULL)
    OR
    (status = 'claimed' AND first_name IS NULL AND last_name IS NULL AND email IS NULL AND has_assistant IS NULL
      AND email_providers IS NULL AND other_email IS NULL AND computers IS NULL AND phone IS NULL
      AND heard_from IS NULL AND heard_detail IS NULL AND timezone IS NULL AND about IS NULL AND referral IS NULL
      AND slug IS NULL AND note IS NULL)
  )
);
INSERT INTO invite_requests_new (id, created_at, first_name, last_name, email, has_assistant, email_providers, other_email,
  computers, phone, plan, heard_from, heard_detail, timezone, about, referral, cohort, privacy_agreed_at, status,
  status_changed_at, approved_at, invited_at, slug, note)
SELECT id, created_at, first_name, last_name, email, has_assistant, email_providers, other_email,
  computers, phone, plan, heard_from, heard_detail, timezone, about, referral, cohort, privacy_agreed_at, status,
  status_changed_at, approved_at, invited_at, slug, note FROM invite_requests;
DROP TABLE invite_requests;
ALTER TABLE invite_requests_new RENAME TO invite_requests;
CREATE INDEX IF NOT EXISTS invite_requests_status ON invite_requests (status, id);
