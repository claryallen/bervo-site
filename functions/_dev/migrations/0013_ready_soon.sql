ALTER TABLE invite_requests ADD COLUMN ready_soon INTEGER DEFAULT 0 CHECK (ready_soon IS NULL OR ready_soon IN (0, 1));
