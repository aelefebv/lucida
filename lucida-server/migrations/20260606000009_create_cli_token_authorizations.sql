-- Short-lived browser approval requests for CLI/Python bearer tokens.
--
-- The CLI generates the raw token and sends only token_hash here. The
-- browser approves the pending hash while authenticated; the CLI polls
-- with poll_token_hash and stores its raw token only after approval.

CREATE TABLE cli_token_authorizations (
    id                 TEXT PRIMARY KEY,
    poll_token_hash    TEXT NOT NULL UNIQUE,
    token_hash         TEXT NOT NULL UNIQUE,
    user_code          TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    created_at         TIMESTAMP NOT NULL,
    expires_at         TIMESTAMP NOT NULL,
    token_expires_at   TIMESTAMP NOT NULL,
    approved_at        TIMESTAMP,
    approved_token_id  TEXT,
    approved_email     TEXT
);

CREATE INDEX idx_cli_token_authorizations_expires_at
    ON cli_token_authorizations (expires_at);
