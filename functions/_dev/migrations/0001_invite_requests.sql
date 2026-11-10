-- D1 schema for bervo.ai invite requests (CR-INVITEFLOW.1 part A).
-- Allen pastes this into the D1 console (Cloudflare → Storage & Databases → D1 → bervo-invites → Console),
-- once for the production database and once for the preview database. Safe to run twice.

CREATE TABLE IF NOT EXISTS invite_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL,                      -- UTC ISO-8601
  first_name        TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 80),
  last_name         TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  email             TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  company           TEXT NOT NULL CHECK (length(company) BETWEEN 1 AND 120),
  role              TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 120),
  has_assistant     TEXT NOT NULL CHECK (has_assistant IN ('yes', 'no')),
  email_provider    TEXT NOT NULL CHECK (email_provider IN ('google', 'microsoft', 'other')),
  phone             TEXT NOT NULL CHECK (phone IN ('iphone', 'android')),
  timezone          TEXT CHECK (timezone IS NULL OR length(timezone) <= 64),   -- browser zone, never asked
  about             TEXT NOT NULL CHECK (length(about) BETWEEN 1 AND 1000),   -- "Tell us about you and your business"
  referral          TEXT CHECK (referral IS NULL OR referral IN ('allen')),   -- bervo.ai/invite?from=allen (display only)
  cohort            TEXT NOT NULL DEFAULT 'public' CHECK (cohort IN ('public', 'private')),
  privacy_agreed_at TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'approved', 'not_now', 'invited', 'claimed', 'expired')),
  status_changed_at TEXT,
  approved_at       TEXT,
  invited_at        TEXT,
  slug              TEXT CHECK (slug IS NULL OR length(slug) <= 31),
  note              TEXT CHECK (note IS NULL OR length(note) <= 2000)
);
CREATE INDEX IF NOT EXISTS invite_requests_status ON invite_requests (status, id);

-- Rate limit: SHA-256(salt | UTC day | IP) only; never the address. Rows older than 7 days are deleted by the
-- form handler and the admin page.
CREATE TABLE IF NOT EXISTS invite_rate (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
