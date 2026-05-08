-- Slice 4 (PRD #455, issue #460): the second table in lucida.db.
--
-- Stores the in-flight intent for an OAuth round-trip. The web client's
-- JS shim captures `location.hash` (since hashes never reach the
-- server) and POSTs it to /auth/start; the handler stashes path + hash
-- here keyed by a 256-bit `state` token, hands the token to Google,
-- and the /auth/callback handler trades the returned `state` back for
-- the original landing target before redirecting.
--
-- The row is single-use: callback consumes it via DELETE+RETURNING (or
-- the SQLite equivalent — see the store impl for the actual SQL). A
-- replayed `state` value finds nothing and 400s, which doubles as
-- protection against state-fixation.
--
-- `intended_hash` defaults to '' rather than NULL so the consume path
-- doesn't have to branch on Option<String>; the hash is opaque to the
-- server anyway.
--
-- Index on created_at supports the slice-8 cleanup sweep (drop rows
-- older than 10 minutes — anything older than that is a stale OAuth
-- attempt, and the user will retry from scratch).

CREATE TABLE pending_auth (
    state_token   TEXT PRIMARY KEY,
    intended_path TEXT NOT NULL,
    intended_hash TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMP NOT NULL
);

CREATE INDEX idx_pending_auth_created_at ON pending_auth (created_at);
