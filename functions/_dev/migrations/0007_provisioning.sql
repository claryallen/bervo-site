-- Automatic server builds (CR-AUTOPROVISION.1, Allen 11-15: "Approve is the go").
-- Allen pastes this into the D1 console after 0006 (production and preview databases), BEFORE the code that
-- reads it is published. Safe to run twice (IF NOT EXISTS everywhere).
--
-- invite_provision: one row per approved request the Mini's picker (daily-dashboard tools/tenant/auto_provision.py)
--   has seen. Written ONLY through the signed endpoint /api/provision-state (the Mini keeps a read-only D1 token)
--   and by the admin page's Retry button. No customer content: a state word, a step name, a run id, dates.
--   queued -> building -> ready | failed | stopped ; waiting_cap (the daily cap of new servers was reached; runs
--   later). stopped = the request was withdrawn (Not now) during the build: the build stopped at the next step
--   boundary, nothing torn down; approving it again lets the picker continue. Retry (admin page) moves failed ->
--   queued; the picker never retries a failed row by itself. notes = the profile's unattended defaults as fixed
--   codes (a JSON list, e.g. ["tz_defaulted","pronouns_default"]; never customer text).
-- (fix round 1, 11-15: 'stopped' and notes added before this migration was ever run anywhere.)
-- invite_links: the owner's one-time link, delivered by the Mini (/api/provision-link), stored ENCRYPTED
--   (AES-GCM, key = Pages secret BERVO_LINK_KEY; additional data binds it to its request and kind). Deleted the
--   moment its email is sent, and on expiry. Never in the page HTML, never logged.
-- provision_nonces: replay guard for the signed endpoints (a signature is accepted once; kept 10 minutes).
-- Retention: rows go with their request (functions/_lib/invites.js pruneOld); a claimed request's links go at once.

CREATE TABLE IF NOT EXISTS invite_provision (
  request_id         INTEGER PRIMARY KEY,                -- invite_requests.id
  state              TEXT NOT NULL CHECK (state IN ('queued', 'building', 'ready', 'failed', 'waiting_cap', 'stopped')),
  step               TEXT CHECK (step IS NULL OR step IN ('profile', 'approval_check', 'droplet', 'ssh', 'phase0',
                       'phase1', 'phase2', 'phase2b', 'phase3', 'phase4', 'phase4b', 'phase5', 'phase6', 'line',
                       'owner', 'health', 'scan', 'timeout', 'interrupted')),
  run_id             TEXT CHECK (run_id IS NULL OR (length(run_id) BETWEEN 8 AND 64)),
  queued_at          TEXT,                               -- UTC ISO-8601
  started_at         TEXT,
  finished_at        TEXT,
  retry_requested_at TEXT,
  notes              TEXT CHECK (notes IS NULL OR length(notes) <= 400),
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('invite', 'reminder3', 'reminder10')),
  iv          TEXT NOT NULL CHECK (length(iv) BETWEEN 8 AND 32),     -- base64, 12 bytes
  ct          TEXT NOT NULL CHECK (length(ct) BETWEEN 16 AND 512),   -- base64 AES-GCM ciphertext + tag
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
-- One waiting link per request and kind: a newer delivery replaces the older (the older no longer works anyway).
CREATE UNIQUE INDEX IF NOT EXISTS invite_links_one ON invite_links (request_id, kind);

CREATE TABLE IF NOT EXISTS provision_nonces (
  sig_hash   TEXT PRIMARY KEY CHECK (length(sig_hash) = 64),
  created_at TEXT NOT NULL
);
