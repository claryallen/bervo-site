-- CR-PROVREGION.2: where the server was built when the picker had to fall back (region, size, monthly dollars).
-- JSON {"region","size","usd"}, written only by /api/provision-state's notes action after validation; null = the usual placement.
-- Run in the D1 console BEFORE publishing the code (the code also works without it: the codes are stored, the placement line is not).
ALTER TABLE invite_provision ADD COLUMN placement TEXT CHECK (placement IS NULL OR length(placement) <= 120);
