-- The whole schema the lucida server keeps its own records in, for
-- PostgreSQL.
--
-- This is the SQLite baseline in `../sqlite/` translated, not copied. The
-- two files describe the same schema: same tables, same columns, same
-- names, same indexes, same cascades. What differs is how a value is
-- declared, because the two engines do not offer the same types.
--
-- The Rust type is the portable contract. A column here takes whichever
-- PostgreSQL type maps to the Rust type the server already uses, so the
-- store code above reads and writes the same values against either
-- engine. Three conventions cover every difference.
--
-- **Timestamps are `TIMESTAMPTZ`.** SQLite has no date or time type, so
-- the SQLite baseline stores RFC 3339 in UTC as `TEXT` and relies on that
-- form sorting chronologically. PostgreSQL has the type, so it takes it:
-- `ORDER BY` and range comparisons then run on an instant rather than on
-- its spelling, and no string that merely looks like a timestamp can be
-- stored. Both sides map to `chrono::DateTime<Utc>`.
--
-- **JSON payloads are `JSONB`.** The SQLite baseline declares `TEXT` with
-- a `json_valid` check, which is the strongest claim SQLite can make.
-- PostgreSQL parses and stores the value, so a malformed payload is
-- refused at the write with a parse error rather than by a check. The
-- consequence reaches the Rust: a `JSONB` column will not accept a bound
-- Rust `String` the way a `TEXT` column does, so a store writing one of
-- these columns binds `sqlx::types::Json` (or casts the placeholder)
-- rather than the serialized string it binds today.
--
-- **Counters the server reads as 64-bit are `BIGINT`.** Same declaration
-- as the SQLite baseline, and here it is load-bearing: PostgreSQL's
-- `INTEGER` really is four bytes.
--
-- Foreign keys need no counterpart to SQLite's per-connection pragma.
-- PostgreSQL enforces them always, so the `ON DELETE` each edge declares
-- is what happens.
--
-- One edge is circular: `workspaces.default_saved_view_id` points at
-- `workspace_saved_views`, which points back at `workspaces`. PostgreSQL
-- resolves a foreign-key target at `CREATE TABLE`, and reordering does
-- not help a cycle, so that one constraint is added by `ALTER TABLE`
-- after both tables exist. It is the only line here with no positional
-- counterpart in the SQLite file.
--
-- See ADR-0057 for the conventions and ADR-0058 for the translation.

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
    created_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL
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
    created_at    TIMESTAMPTZ NOT NULL
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
    created_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
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
    created_at        TIMESTAMPTZ NOT NULL,
    expires_at        TIMESTAMPTZ NOT NULL,
    token_expires_at  TIMESTAMPTZ NOT NULL,
    approved_at       TIMESTAMPTZ,
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
    created_at      TIMESTAMPTZ NOT NULL,
    view_json       JSONB NOT NULL
);

CREATE INDEX idx_bookmarks_created_by ON bookmarks(created_by);

-- Which dataset URLs a bookmark is attached to. "Show me bookmarks for any
-- of these URLs" is the sidebar's hot read, and a side table turns it into
-- an index scan; the alternative — reaching into `view_json` — forces a
-- per-row JSON parse. `bookmarks::store_postgres::tests` reads the query
-- plan to prove the index is the one being used.
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
-- workspace pointing at nothing. The foreign key that says so closes the
-- cycle with `workspace_saved_views` and is added at the end of this file.
CREATE TABLE workspaces (
    id                    TEXT PRIMARY KEY NOT NULL,
    name                  TEXT NOT NULL,
    created_by            TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL,
    archived_at           TIMESTAMPTZ,
    link_access           TEXT NOT NULL DEFAULT 'restricted',
    link_role             TEXT NOT NULL DEFAULT 'viewer',
    seq                   BIGINT NOT NULL DEFAULT 0,
    document_json         JSONB NOT NULL,
    default_saved_view_id TEXT
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
    added_at     TIMESTAMPTZ NOT NULL,
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
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL
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
    added_at          TIMESTAMPTZ NOT NULL,
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
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL,
    visibility      TEXT NOT NULL DEFAULT 'shared',
    view_json       JSONB NOT NULL
);

CREATE INDEX idx_workspace_saved_views_workspace_updated
    ON workspace_saved_views(workspace_id, updated_at DESC);
CREATE INDEX idx_workspace_saved_views_personal_owner
    ON workspace_saved_views(workspace_id, created_by)
    WHERE visibility = 'personal';
CREATE INDEX idx_workspace_saved_views_proposed
    ON workspace_saved_views(workspace_id, created_by)
    WHERE visibility = 'proposed';

-- The circular edge, deferred to here because PostgreSQL resolves a
-- foreign-key target at `CREATE TABLE`. The constraint carries the name
-- PostgreSQL would have generated for it inline, so an error message reads
-- the same either way.
ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_default_saved_view_id_fkey
    FOREIGN KEY (default_saved_view_id)
    REFERENCES workspace_saved_views(id) ON DELETE SET NULL;

-- One person's own dashboard state for one workspace: recents, pins, and
-- the view they last had open. Keyed per member, so nothing here is visible
-- to anyone else, and `last_view_json` is unrelated to the workspace-wide
-- `default_saved_view_id`.
CREATE TABLE user_workspace_state (
    user_email     TEXT NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL,
    last_opened_at TIMESTAMPTZ,
    pinned_at      TIMESTAMPTZ,
    last_view_json JSONB,
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
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL,
    seed_source  TEXT,
    view_json    JSONB NOT NULL,
    PRIMARY KEY (workspace_id, user_email, profile)
);

CREATE INDEX idx_workspace_viewer_profiles_workspace_user
    ON workspace_viewer_profiles(workspace_id, user_email, updated_at DESC);
