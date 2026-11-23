-- CR-ONBOARDEDTAB.1 fix round 3 (Allen 11-23, "yes both"): a ONE-TIME sweep of requests onboarded (stored 'claimed')
-- under the old trim, so every onboarded request keeps only what Mark onboarded now keeps: id, status, plan and the
-- request date (created_at / privacy_agreed_at). It erases approved_at, invited_at, signed_up_at and status_changed_at,
-- resets cohort to 'public', and deletes those requests' email records, build records and waiting links.
-- kept_name / kept_host / kept_email stay NULL on these rows: the old trim already erased the name, email and address
-- code, so there is nothing left to derive them from (they show as "(trimmed)").
--
-- Allen pastes this into the D1 console (bervo-invites; preview database first, then production) AFTER 0010 and the
-- publish (it needs 0009's signed_up_at column). It changes rows, not the schema. SAFE TO RUN TWICE: a second run
-- finds nothing left to change.
-- Preview first (counts only; paste each line without the leading "-- "):
-- SELECT count(*) AS onboarded, coalesce(sum(approved_at IS NOT NULL OR invited_at IS NOT NULL OR signed_up_at IS NOT NULL OR status_changed_at IS NOT NULL OR cohort <> 'public'), 0) AS with_dates_or_cohort FROM invite_requests WHERE status = 'claimed';
-- SELECT (SELECT count(*) FROM invite_mail WHERE request_id IN (SELECT id FROM invite_requests WHERE status = 'claimed')) AS email_records, (SELECT count(*) FROM invite_provision WHERE request_id IN (SELECT id FROM invite_requests WHERE status = 'claimed')) AS build_records, (SELECT count(*) FROM invite_links WHERE request_id IN (SELECT id FROM invite_requests WHERE status = 'claimed')) AS links;
UPDATE invite_requests SET approved_at = NULL, invited_at = NULL, signed_up_at = NULL, status_changed_at = NULL, cohort = 'public'
  WHERE status = 'claimed';
DELETE FROM invite_mail WHERE request_id IN (SELECT id FROM invite_requests WHERE status = 'claimed');
DELETE FROM invite_provision WHERE request_id IN (SELECT id FROM invite_requests WHERE status = 'claimed');
DELETE FROM invite_links WHERE request_id IN (SELECT id FROM invite_requests WHERE status = 'claimed');
