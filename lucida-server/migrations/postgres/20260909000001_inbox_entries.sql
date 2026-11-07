-- The workspace inbox for PostgreSQL: the SQLite migration beside this
-- one translated, not copied. Same table, same columns, same names, same
-- indexes, same cascade. Read that file for what the inbox is and why a
-- row is only ever there because somebody sent it.
--
-- Two columns depart from the baseline's "JSON payloads are JSONB"
-- convention on purpose. `JSONB` stores a parsed value: it reorders an
-- object's keys, drops duplicates, and rewrites numbers, so what came
-- back out would no longer be what the page sent. The inbox's whole
-- contract is that the CLI fetches the bytes somebody submitted, so both
-- payload columns are `TEXT` and hold text rather than a value. The
-- SQLite side keeps its `json_valid` check because the idiom is free
-- there; here the server's own parse, which it performs to read the
-- header out, is what says the text is JSON.
CREATE TABLE inbox_entries (
    id           TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sent_by      TEXT NOT NULL,
    sent_by_name TEXT NOT NULL,
    sent_at      TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    size_bytes   BIGINT NOT NULL,
    header_json  TEXT NOT NULL,
    bundle_json  TEXT NOT NULL
);

CREATE INDEX idx_inbox_entries_workspace_sent
    ON inbox_entries(workspace_id, sent_at DESC);

CREATE INDEX idx_inbox_entries_expires_at ON inbox_entries(expires_at);
