-- Slice 2 (PRD #455, issue #457): the first table in lucida.db.
--
-- Schema decisions live in PRD #455 §"Schema decisions"; the short
-- version: opaque session id (UUID v4) as primary key, denormalized
-- email/display_name/picture_url snapshotted at session creation, and
-- three TIMESTAMP columns that collectively encode the idle-timeout +
-- hard-cap policy (created_at + last_used_at + expires_at).
--
-- Indexes:
-- * expires_at — supports the cleanup sweep (slice 8) and the
--   range-deletion in delete_expired().
-- * email — supports future "list all sessions for user X" queries
--   (logout-all-devices, admin tooling). Cheap to maintain.

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
