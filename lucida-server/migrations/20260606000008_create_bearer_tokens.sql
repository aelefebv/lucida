-- Opaque bearer credentials for CLI/Python clients.
--
-- The raw token is generated client-side and shown/stored only there.
-- The server stores a BLAKE3 hash for lookup plus denormalized identity
-- metadata so bearer extraction resolves to the same AuthPrincipal
-- shape as cookie-backed login_sessions.

CREATE TABLE bearer_tokens (
    id             TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    picture_url    TEXT,
    created_at     TIMESTAMP NOT NULL,
    last_used_at   TIMESTAMP,
    expires_at     TIMESTAMP NOT NULL,
    revoked_at     TIMESTAMP
);

CREATE INDEX idx_bearer_tokens_email ON bearer_tokens (email);
CREATE INDEX idx_bearer_tokens_expires_at ON bearer_tokens (expires_at);
