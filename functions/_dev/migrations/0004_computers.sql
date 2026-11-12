-- Adds "Which type of computer(s) do you use?" to invite requests (Allen 11-11). Run once, after 0003,
-- BEFORE the code that writes it is published. A second run fails harmlessly with "duplicate column name".
-- Stored as a JSON list in this fixed order; "none" (iPad and/or phone only) is never combined with a computer.
-- Trimmed with the rest of the request on "claimed" (TRIMMED_COLUMNS) and deleted with it.
ALTER TABLE invite_requests ADD COLUMN computers TEXT CHECK (computers IS NULL OR computers IN ('["windows"]', '["mac"]', '["windows","mac"]', '["none"]'));
