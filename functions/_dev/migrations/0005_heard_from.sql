-- Adds "How did you hear about Bervo?" to invite requests (options approved by Allen 11-11; built 11-11).
-- Run once, after 0004, BEFORE the code that writes it is published. A second run fails harmlessly
-- ("duplicate column name"). heard_detail is only for "Referred by someone" / "Other".
-- Both are trimmed with the rest of the request on "claimed" (TRIMMED_COLUMNS) and deleted with it.
ALTER TABLE invite_requests ADD COLUMN heard_from TEXT CHECK (heard_from IS NULL OR heard_from IN ('referral', 'social', 'search', 'ai', 'media', 'ad', 'event', 'other'));
ALTER TABLE invite_requests ADD COLUMN heard_detail TEXT CHECK (heard_detail IS NULL OR length(heard_detail) BETWEEN 1 AND 200);
