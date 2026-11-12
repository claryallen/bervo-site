-- Adds the "What other email account(s)?" answer to invite requests (Allen 11-11). Run once, after 0001,
-- BEFORE the code that writes it is published (an insert naming a missing column would fail every request).
-- Running it a second time fails harmlessly with "duplicate column name". Trimmed with the rest of the request on
-- "claimed" (TRIMMED_COLUMNS) and deleted with it.
ALTER TABLE invite_requests ADD COLUMN other_email TEXT CHECK (other_email IS NULL OR length(other_email) BETWEEN 1 AND 40);
