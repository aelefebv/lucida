-- In-flight intent for an OAuth round-trip. The web client's JS shim
-- captures `location.hash` (hashes never reach the server) and POSTs it
-- to /auth/start; the handler stashes path + hash here keyed by a
-- 256-bit `state` token, hands the token to Google, and /auth/callback
-- trades the returned `state` back for the original landing target.
--
-- Single-use: callback consumes via DELETE+RETURNING (or SQLite
-- equivalent — see the store impl). A replayed `state` finds nothing
-- and 400s, doubling as state-fixation protection.
--
-- `intended_hash` defaults to '' rather than NULL so the consume path
-- doesn't have to branch on Option<String>.
--
-- Index on created_at supports the cleanup sweep (drop rows older than
-- 10 minutes — stale attempts; the user will retry from scratch).

CREATE TABLE pending_auth (
    state_token   TEXT PRIMARY KEY,
    intended_path TEXT NOT NULL,
    intended_hash TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMP NOT NULL
);

CREATE INDEX idx_pending_auth_created_at ON pending_auth (created_at);
