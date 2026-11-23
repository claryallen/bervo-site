-- CR-ONBOARDEDTAB.1 (Allen 11-23, "keep first name + initial and address, build it"): when Allen presses Mark onboarded
-- (stored status 'claimed'), the request is trimmed as before but keeps three short fields so the Onboarded tab can say
-- who it was: kept_name = first name + last initial ("Ashley C"), kept_host = the address code ("reh1120", shown as
-- reh1120.bervo.ai), and (Allen 11-23, "yes, keep email too") kept_email = the email address they asked with. All three
-- are written in the same UPDATE as the trim, and only on an onboarded (claimed) row. Everything else in the trim stays
-- erased (phone, answers, about, note, full last name). The table's own CHECK still requires first_name / last_name /
-- email / slug to be NULL on a claimed row; these are new columns.
--
-- Allen pastes this into the D1 console (bervo-invites; production and preview databases) after 0009. The code works
-- before it: without the columns, Mark onboarded trims exactly as today (no name, address or email kept) and the Onboarded
-- cards show "(trimmed)".
-- NOT safe to run twice: a second run fails with "duplicate column name: kept_name" and changes nothing.
-- Check first: SELECT sql FROM sqlite_master WHERE name='invite_requests' must list signed_up_at (0009) and must not
-- already list kept_name.
ALTER TABLE invite_requests ADD COLUMN kept_name TEXT CHECK (kept_name IS NULL OR (status = 'claimed' AND length(kept_name) BETWEEN 1 AND 40));
ALTER TABLE invite_requests ADD COLUMN kept_host TEXT CHECK (kept_host IS NULL OR (status = 'claimed' AND length(kept_host) BETWEEN 1 AND 63));
ALTER TABLE invite_requests ADD COLUMN kept_email TEXT CHECK (kept_email IS NULL OR (status = 'claimed' AND length(kept_email) BETWEEN 3 AND 254));
