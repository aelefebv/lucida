-- Session store backing `lucida.db`.
--
-- Opaque session id (UUID v4) as primary key; email/display_name/picture_url
-- denormalized at session creation; three TIMESTAMP columns collectively
-- encode the idle-timeout + hard-cap policy.
--
-- Indexes:
-- * expires_at — supports the cleanup sweep and delete_expired().
-- * email — supports "list all sessions for user X" (logout-all-devices,
--   admin tooling).

CREATE TABLE login_sessions (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    picture_url   TEXT,
    created_at    TIMESTAMP NOT NULL,
    last_used_at  TIMESTAMP NOT NULL,
    expires_at    TIMESTAMP NOT NULL
);

CREATE INDEX idx_login_sessions_expires_at ON login_sessions (expires_at);
CREATE INDEX idx_login_sessions_email ON login_sessions (email);
