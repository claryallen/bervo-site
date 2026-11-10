-- D1 schema for bervo.ai invite requests (CR-INVITEFLOW.1 part A).
-- Allen pastes this into the D1 console (Cloudflare → Storage & Databases → D1 → bervo-invites → Console),
-- once for the production database and once for the preview database. Safe to run twice.
-- Retention: 'not_now' and 'expired' rows are deleted 90 days after status_changed_at; 'claimed' rows are trimmed
-- (admin page on Mark claimed, and tools/tenant/invite_retention.py in daily-dashboard).

CREATE TABLE IF NOT EXISTS invite_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL,                      -- UTC ISO-8601
  first_name        TEXT CHECK (first_name IS NULL OR length(first_name) BETWEEN 1 AND 80),
  last_name         TEXT CHECK (last_name IS NULL OR length(last_name) BETWEEN 1 AND 80),
  email             TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  company           TEXT CHECK (company IS NULL OR length(company) BETWEEN 1 AND 120),
  role              TEXT CHECK (role IS NULL OR length(role) BETWEEN 1 AND 120),
  has_assistant     TEXT CHECK (has_assistant IS NULL OR has_assistant IN ('yes', 'no')),
  email_provider    TEXT CHECK (email_provider IS NULL OR email_provider IN ('google', 'microsoft', 'other')),
  phone             TEXT CHECK (phone IS NULL OR phone IN ('iphone', 'android')),
  timezone          TEXT CHECK (timezone IS NULL OR length(timezone) <= 64),   -- browser zone, never asked
  about             TEXT CHECK (about IS NULL OR length(about) BETWEEN 1 AND 1000),   -- "Tell us about you and your business"
  referral          TEXT CHECK (referral IS NULL OR referral IN ('allen')),   -- bervo.ai/invite?from=allen (display only)
  cohort            TEXT NOT NULL DEFAULT 'public' CHECK (cohort IN ('public', 'private')),
  privacy_agreed_at TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'approved', 'not_now', 'invited', 'claimed', 'expired')),
  status_changed_at TEXT,
  approved_at       TEXT,
  invited_at        TEXT,
  slug              TEXT CHECK (slug IS NULL OR length(slug) <= 31),
  note              TEXT CHECK (note IS NULL OR length(note) <= 2000),
  -- Retention (Allen 11-10, "Yes, 90 days"): once the customer is live (status 'claimed') the row keeps only
  -- id, cohort, status and dates. Every other status must carry the full request; a claimed row carries none of it.
  CHECK (
    (status <> 'claimed' AND first_name IS NOT NULL AND last_name IS NOT NULL AND email IS NOT NULL
      AND company IS NOT NULL AND role IS NOT NULL AND has_assistant IS NOT NULL AND email_provider IS NOT NULL
      AND phone IS NOT NULL AND about IS NOT NULL)
    OR
    (status = 'claimed' AND first_name IS NULL AND last_name IS NULL AND email IS NULL AND company IS NULL
      AND role IS NULL AND has_assistant IS NULL AND email_provider IS NULL AND phone IS NULL AND timezone IS NULL
      AND about IS NULL AND referral IS NULL AND slug IS NULL AND note IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS invite_requests_status ON invite_requests (status, id);

-- Rate limit: SHA-256(salt | UTC day | IP) only; never the address. Rows older than 7 days are deleted by the
-- form handler, the admin page and tools/tenant/invite_retention.py (daily, from the Mini).
CREATE TABLE IF NOT EXISTS invite_rate (
  ip_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
