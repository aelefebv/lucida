-- The workspace inbox: bundles people sent with Send report, kept for a
-- fixed number of days so the CLI can list and fetch them.
--
-- A row exists only because somebody pressed the action. The server reads
-- the header out once, at the write, so a listing needs no parse, and it
-- derives nothing else: no row of its own goes in this table, and nothing
-- here is computed from what it holds. See ADR-0050 as amended.
--
-- `sent_at` and `expires_at` are both written at the send, `expires_at`
-- being `sent_at` plus the fixed retention. Reads filter on `expires_at`
-- and the write sweeps past it, so an entry stops being visible the moment
-- it expires rather than when a sweep next runs.
--
-- `bundle_json` holds the bytes the page produced, and `header_json` the
-- slice of them the listing reads. Both are `TEXT` and neither is a
-- parsed value: what the CLI fetches has to be what was sent, so the
-- column stores the text rather than something a round trip through a
-- JSON type reassembled. The baseline's `json_valid` check still applies
-- — it is what separates a column holding JSON from one only named that
-- way — and it costs a parse the server has already performed anyway.
CREATE TABLE inbox_entries (
    id           TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sent_by      TEXT NOT NULL,
    sent_by_name TEXT NOT NULL,
    sent_at      TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    header_json  TEXT NOT NULL CHECK (json_valid(header_json)),
    bundle_json  TEXT NOT NULL CHECK (json_valid(bundle_json))
);

-- The listing: one workspace's unexpired entries, newest first.
CREATE INDEX idx_inbox_entries_workspace_sent
    ON inbox_entries(workspace_id, sent_at DESC);

-- The sweep, which is workspace-blind: it deletes by expiry alone.
CREATE INDEX idx_inbox_entries_expires_at ON inbox_entries(expires_at);
