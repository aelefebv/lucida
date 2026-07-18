ALTER TABLE pending_auth
ADD COLUMN browser_binding_hash TEXT NOT NULL DEFAULT '';
