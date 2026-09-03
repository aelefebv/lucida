-- The whole schema the lucida server keeps its own records in, for SQLite.
--
-- This baseline replaces thirteen incremental migrations. No older database
-- upgrades into it: this is the schema a fresh one gets, and the only one the
-- code targets.
--
-- `../postgres/` holds the same schema for PostgreSQL. The two files are
-- kept side by side deliberately: a shared file could not declare a
-- timestamp, and the differences are worth reading rather than hiding.
--
-- Four conventions hold across every table below. Read them once and the
-- column declarations stop needing individual explanation.
--
-- **Timestamps are `TEXT`.** SQLite has no date or time type. Every
-- timestamp column holds RFC 3339 in UTC, written and read as
-- `chrono::DateTime<Utc>` by sqlx, which is the one Rust type a timestamp
-- maps to anywhere in the server. Text in this form sorts chronologically,
-- so `ORDER BY` and range comparisons work on the stored value directly.
-- Declaring these `TIMESTAMP` instead would give the column NUMERIC
-- affinity, which invites SQLite to coerce a value that happens to look
-- like a number; `TEXT` says what is there.
--
-- **JSON payloads are `TEXT` with a `json_valid` check.** SQLite has no
-- JSON storage type, so the check is what separates a column that holds JSON
-- from a column that is only named that way. A NULL payload passes, because
-- `json_valid(NULL)` is NULL and a check fails only on false.
--
-- **Counters the server reads as 64-bit are `BIGINT`.** SQLite stores any
-- integer in up to eight bytes whatever the declaration says, so this changes
-- nothing here. It states the width the code uses, for the reader and for a
-- backend that would take `INTEGER` to mean four bytes.
--
-- **Every foreign key declares its own `ON DELETE`.** The SQLite backend
-- turns foreign-key enforcement on for every connection, so the database
-- performs the cascade and no caller writes one by hand. One column names a
-- row in another table without a foreign key, and says why where it is
-- declared.
--
-- One edge is circular: `workspaces.default_saved_view_id` points at
-- `workspace_saved_views`, which points back at `workspaces`. SQLite resolves
-- a foreign-key target when a row is written rather than when the table is
-- created, so the cycle loads from one file in this order. An engine that
-- resolves targets at `CREATE TABLE` cannot, and reordering does not help a
-- cycle: the PostgreSQL baseline issues that one constraint as an `ALTER
-- TABLE` after both tables exist.
--
-- See ADR-0057.

-- Cookie-backed browser sessions. Opaque id (UUID v4) as primary key;
-- email, display name, and picture URL denormalized at sign-in; the three
-- timestamps together encode the idle-timeout and hard-cap policy.
--
-- `expires_at` is indexed for the cleanup sweep, `email` for "every session
-- belonging to this person" (sign out everywhere, admin tooling).
CREATE TABLE login_sessions (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    display_name TEXT NOT NULL,
    picture_url  TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
);

CREATE INDEX idx_login_sessions_expires_at ON login_sessions(expires_at);
CREATE INDEX idx_login_sessions_email ON login_sessions(email);

-- In-flight intent for one OAuth round trip. The web client captures
-- `location.hash` (hashes never reach the server) and posts it with the
-- path to /auth/start, which stashes both here under a 256-bit state token
-- before handing that token to the provider. /auth/callback trades the
-- returned token back for the landing target.
--
-- Single use: the callback consumes the row with DELETE ... RETURNING, so a
-- replayed token finds nothing and 400s. That doubles as state-fixation
-- protection.
--
-- `intended_hash` defaults to '' rather than NULL so the consume path does
-- not branch on an absent hash. `created_at` is indexed for the sweep that
-- drops attempts older than ten minutes.
CREATE TABLE pending_auth (
    state_token   TEXT PRIMARY KEY,
    intended_path TEXT NOT NULL,
    intended_hash TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
);

CREATE INDEX idx_pending_auth_created_at ON pending_auth(created_at);

-- Opaque bearer credentials for the CLI and Python clients. The raw token
-- is generated client-side and never reaches the server; what is stored is
-- a BLAKE3 hash for lookup, plus the same denormalized identity the session
-- table carries, so bearer extraction resolves to the same principal shape
-- as a cookie.
CREATE TABLE bearer_tokens (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    email        TEXT NOT NULL,
    display_name TEXT NOT NULL,
    picture_url  TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT
);

CREATE INDEX idx_bearer_tokens_email ON bearer_tokens(email);
CREATE INDEX idx_bearer_tokens_expires_at ON bearer_tokens(expires_at);

-- Short-lived browser approvals for bearer tokens. The CLI mints the raw
-- token and sends only `token_hash`; a signed-in browser approves the
-- pending hash; the CLI polls with `poll_token_hash` and keeps its raw
-- token only once approval lands.
--
-- `approved_token_id` names the row in `bearer_tokens` that approval
-- minted. It carries no foreign key on purpose: an authorization is a
-- record of what happened, and revoking or aging out the credential must
-- not rewrite it.
CREATE TABLE cli_token_authorizations (
    id                TEXT PRIMARY KEY,
    poll_token_hash   TEXT NOT NULL UNIQUE,
    token_hash        TEXT NOT NULL UNIQUE,
    user_code         TEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    token_expires_at  TEXT NOT NULL,
    approved_at       TEXT,
    approved_token_id TEXT,
    approved_email    TEXT
);

CREATE INDEX idx_cli_token_authorizations_expires_at
    ON cli_token_authorizations(expires_at);

-- Server-stored bookmarks: a saved view under a stable opaque id, so a
-- `#b=<id>` URL reopens the same view across sessions and people. The
-- creator's email and display name are snapshotted at create time.
--
-- `view_json` carries the whole saved view. Its shape belongs to
-- `lucida-core` and evolves by version bump inside the payload, which keeps
-- view evolution out of the schema entirely. See ADR-0015.
CREATE TABLE bookmarks (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    view_json       TEXT NOT NULL CHECK (json_valid(view_json))
);

CREATE INDEX idx_bookmarks_created_by ON bookmarks(created_by);

-- Which dataset URLs a bookmark is attached to. "Show me bookmarks for any
-- of these URLs" is the sidebar's hot read, and a side table turns it into
-- an index scan; the alternative — reaching into `view_json` — forces a
-- per-row JSON parse. `bookmarks::store::tests` reads the query plan to
-- prove the index is the one being used.
CREATE TABLE bookmark_datasets (
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    dataset_url TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, dataset_url)
);

CREATE INDEX idx_bookmark_datasets_url ON bookmark_datasets(dataset_url);

-- The durable half of a collaborative session: shared document snapshot,
-- membership, dataset list, saved views.
--
-- `default_saved_view_id` is the shared view a bare workspace open applies.
-- Deleting that view sets the pointer back to NULL rather than leaving the
-- workspace pointing at nothing.
CREATE TABLE workspaces (
    id                    TEXT PRIMARY KEY NOT NULL,
    name                  TEXT NOT NULL,
    created_by            TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    archived_at           TEXT,
    link_access           TEXT NOT NULL DEFAULT 'restricted',
    link_role             TEXT NOT NULL DEFAULT 'viewer',
    seq                   BIGINT NOT NULL DEFAULT 0,
    document_json         TEXT NOT NULL CHECK (json_valid(document_json)),
    default_saved_view_id TEXT
        REFERENCES workspace_saved_views(id) ON DELETE SET NULL
);

CREATE INDEX idx_workspaces_created_by ON workspaces(created_by);
CREATE INDEX idx_workspaces_updated_at ON workspaces(updated_at);
CREATE INDEX idx_workspaces_archived_at ON workspaces(archived_at);

-- Who belongs to a workspace and with what authority. Link access is a
-- separate grant on the workspace row; this table is explicit membership.
CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email        TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
    display_name TEXT NOT NULL DEFAULT '',
    added_at     TEXT NOT NULL,
    PRIMARY KEY (workspace_id, email)
);

CREATE INDEX idx_workspace_members_email ON workspace_members(email);

-- A dataset's source identity, independent of any workspace, so several
-- workspaces reuse one set of import, cache, and generated artifacts. One
-- canonical URL names one source.
CREATE TABLE dataset_sources (
    id            TEXT PRIMARY KEY NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE,
    default_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- One workspace's membership in one source: a workspace-local id, a
-- workspace-local display name, and a position in the layer panel. Renaming
-- here is a rename inside this workspace and leaves the shared source
-- alone.
--
-- Deleting the source is refused while a workspace still holds it, so this
-- edge restricts rather than cascades.
CREATE TABLE workspace_datasets (
    id                TEXT PRIMARY KEY NOT NULL,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    dataset_source_id TEXT NOT NULL
        REFERENCES dataset_sources(id) ON DELETE RESTRICT,
    display_name      TEXT NOT NULL,
    added_by          TEXT NOT NULL,
    added_at          TEXT NOT NULL,
    sort_order        BIGINT NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, dataset_source_id)
);

CREATE INDEX idx_workspace_datasets_workspace ON workspace_datasets(workspace_id);
CREATE INDEX idx_workspace_datasets_source ON workspace_datasets(dataset_source_id);

-- Saved views that belong to one workspace. Unlike a bookmark, the payload
-- refers to workspace-local dataset ids, so source URLs are not indexed
-- here — `workspace_datasets` owns source identity.
--
-- `visibility` is 'shared', 'personal', or 'proposed'. A proposed view is a
-- viewer's bid to share: out of the shared list, but visible to editors for
-- review. The two partial indexes below serve the two filtered reads — a
-- member's own personal views, and a workspace's review queue — without
-- scanning every view in the workspace.
CREATE TABLE workspace_saved_views (
    id              TEXT PRIMARY KEY NOT NULL,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    visibility      TEXT NOT NULL DEFAULT 'shared',
    view_json       TEXT NOT NULL CHECK (json_valid(view_json))
);

CREATE INDEX idx_workspace_saved_views_workspace_updated
    ON workspace_saved_views(workspace_id, updated_at DESC);
CREATE INDEX idx_workspace_saved_views_personal_owner
    ON workspace_saved_views(workspace_id, created_by)
    WHERE visibility = 'personal';
CREATE INDEX idx_workspace_saved_views_proposed
    ON workspace_saved_views(workspace_id, created_by)
    WHERE visibility = 'proposed';

-- One person's own dashboard state for one workspace: recents, pins, and
-- the view they last had open. Keyed per member, so nothing here is visible
-- to anyone else, and `last_view_json` is unrelated to the workspace-wide
-- `default_saved_view_id`.
CREATE TABLE user_workspace_state (
    user_email     TEXT NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_opened_at TEXT,
    pinned_at      TEXT,
    last_view_json TEXT CHECK (json_valid(last_view_json)),
    PRIMARY KEY (user_email, workspace_id)
);

CREATE INDEX idx_user_workspace_state_user_recent
    ON user_workspace_state(user_email, pinned_at, last_opened_at);
CREATE INDEX idx_user_workspace_state_workspace
    ON user_workspace_state(workspace_id);

-- Private headless viewer state, one row per (workspace, person, profile).
-- This is not presence. It persists a saved-view-shaped payload so the CLI
-- and Python clients keep a current view across short-lived invocations.
CREATE TABLE workspace_viewer_profiles (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_email   TEXT NOT NULL,
    profile      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    seed_source  TEXT,
    view_json    TEXT NOT NULL CHECK (json_valid(view_json)),
    PRIMARY KEY (workspace_id, user_email, profile)
);

CREATE INDEX idx_workspace_viewer_profiles_workspace_user
    ON workspace_viewer_profiles(workspace_id, user_email, updated_at DESC);
