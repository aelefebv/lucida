//! What both SQL-backed `WorkspaceStore` implementations share: the
//! statements they run, and the one query they assemble at runtime.
//!
//! One text, two engines. Every statement below is valid SQLite and valid
//! PostgreSQL, so the SQLite and PostgreSQL stores execute the same
//! characters and a change to a query lands once. ADR-0058 records the
//! decision and what it measured.
//!
//! **Placeholders are numbered, `$1` and up, in every statement here.**
//! That is PostgreSQL's spelling, and sqlx's SQLite driver reads the
//! number out of the parameter name and binds argument N to `$N`, so the
//! numbered form means the same thing on both sides. SQLite's bare `?` has
//! no PostgreSQL counterpart, which is why the numbered form is the one
//! that travels.
//!
//! **Do not mix the two forms in one statement.** A statement holding both
//! `$1` and `?` binds the same argument to both and reports no error, so
//! it returns a wrong answer rather than failing. Convert a statement
//! whole or leave it alone.
//!
//! **One placeholder per bound argument, numbered in the order they
//! appear.** A number may legally repeat — the driver takes one argument
//! for it on either engine — but nothing here does, so a caller's bind
//! list reads straight down the statement. Several statements pass one
//! value twice under two numbers rather than sharing one number, which
//! costs a bind and buys an implementation that can be checked by eye.
//!
//! A backend is free to run a statement of its own where the engines
//! genuinely differ. Nothing in this store needs one. The seven
//! `ON CONFLICT ... DO UPDATE` clauses and the one `DO NOTHING`, the
//! `COALESCE` over `excluded` in an upsert's update list, and the
//! correlated subquery that appends a dataset to the end of a workspace's
//! order are all standard on both.
//!
//! Two things here are not what they were before the port, and both are
//! portable rather than a divergence: the `GROUP BY` of the four workspace
//! listings, which the note above them explains, and
//! [`admin_search_query`], the query this store assembles at runtime.

use sqlx::{Database, Encode, QueryBuilder, Type};

// ---------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------

/// Whether a live workspace exists, for the paths that answer `None`
/// rather than writing into a workspace that is gone or archived.
pub(crate) const WORKSPACE_EXISTS: &str =
    "SELECT id FROM workspaces WHERE id = $1 AND archived_at IS NULL";

/// The same, ignoring the archive state. An archived workspace still has
/// owners, which is what lets its owner restore it.
pub(crate) const WORKSPACE_EXISTS_IN_ANY_STATE: &str = "SELECT id FROM workspaces WHERE id = $1";

pub(crate) const GET_WORKSPACE: &str = r#"
    SELECT
        id, name, created_by, created_at, updated_at, archived_at,
        seq, default_saved_view_id, document_json
    FROM workspaces
    WHERE id = $1
"#;

/// The workspace row of a brand-new, owner-only workspace.
///
/// `link_access` and `link_role` are deliberately absent, so they take
/// their table defaults — link access OFF. See
/// `insert_blank_owned_workspace` in either store for why that belongs in
/// one statement rather than at every call site.
pub(crate) const INSERT_WORKSPACE: &str = r#"
    INSERT INTO workspaces
        (id, name, created_by, created_at, updated_at, seq, document_json)
    VALUES ($1, $2, $3, $4, $5, 0, $6)
"#;

pub(crate) const RENAME_WORKSPACE: &str = r#"
    UPDATE workspaces
    SET name = $1, updated_at = $2
    WHERE id = $3 AND archived_at IS NULL
"#;

pub(crate) const ARCHIVE_WORKSPACE: &str = r#"
    UPDATE workspaces
    SET archived_at = $1, updated_at = $2
    WHERE id = $3 AND archived_at IS NULL
"#;

pub(crate) const RESTORE_WORKSPACE: &str = r#"
    UPDATE workspaces
    SET archived_at = NULL, updated_at = $1
    WHERE id = $2
"#;

/// Bump the workspace's `updated_at` without touching anything else, so a
/// membership or saved-view write moves the workspace up the recents list.
pub(crate) const TOUCH_WORKSPACE: &str = r#"
    UPDATE workspaces
    SET updated_at = $1
    WHERE id = $2
"#;

/// The document and its sequence number, written together.
///
/// `seq` is `BIGINT` in both baselines and the trait takes a `u64`, so a
/// sequence past the range of a 32-bit integer is an ordinary value here
/// rather than an overflow. The conformance suite writes one.
pub(crate) const PERSIST_DOCUMENT: &str = r#"
    UPDATE workspaces
    SET seq = $1, document_json = $2, updated_at = $3
    WHERE id = $4
"#;

pub(crate) const SET_DEFAULT_SAVED_VIEW: &str = r#"
    UPDATE workspaces
    SET default_saved_view_id = $1, updated_at = $2
    WHERE id = $3 AND archived_at IS NULL
"#;

pub(crate) const UPDATE_LINK_ACCESS: &str = r#"
    UPDATE workspaces
    SET link_access = $1, link_role = $2, updated_at = $3
    WHERE id = $4 AND archived_at IS NULL
"#;

pub(crate) const SHARING_SETTINGS: &str = r#"
    SELECT link_access, link_role
    FROM workspaces
    WHERE id = $1 AND archived_at IS NULL
"#;

// ---------------------------------------------------------------------
// Workspace listings
// ---------------------------------------------------------------------

// The four listings below group by `w.id` and select columns from the
// tables joined onto it. PostgreSQL lets a grouped query select any column
// of a table whose primary key is in the `GROUP BY`, but that reasoning
// stops at the table: `uws.pinned_at` and `wm.role` come from other tables
// and have to be named. Both joins match at most one row per workspace —
// each is on the whole of that table's primary key — so naming them splits
// no group and the answer is the same on either engine. SQLite would have
// accepted the shorter form; only PostgreSQL asks.

pub(crate) const LIST_WORKSPACES_AS_ADMIN: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id, 'owner' AS role,
        uws.last_opened_at, uws.pinned_at,
        COALESCE(COUNT(wd.id), 0) AS dataset_count
    FROM workspaces w
    LEFT JOIN user_workspace_state uws
        ON uws.workspace_id = w.id AND uws.user_email = $1
    LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
    WHERE w.archived_at IS NULL
    GROUP BY w.id, uws.last_opened_at, uws.pinned_at
    ORDER BY
        CASE WHEN uws.pinned_at IS NULL THEN 1 ELSE 0 END,
        COALESCE(uws.pinned_at, uws.last_opened_at, w.updated_at) DESC,
        w.updated_at DESC
"#;

pub(crate) const LIST_WORKSPACES: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id,
        COALESCE(wm.role, w.link_role) AS role,
        uws.last_opened_at, uws.pinned_at,
        COALESCE(COUNT(wd.id), 0) AS dataset_count
    FROM workspaces w
    LEFT JOIN workspace_members wm
        ON wm.workspace_id = w.id AND wm.email = $1
    LEFT JOIN user_workspace_state uws
        ON uws.workspace_id = w.id AND uws.user_email = $2
    LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
    WHERE
        w.archived_at IS NULL
        AND (
            wm.email IS NOT NULL
            OR (
                uws.user_email IS NOT NULL
                AND w.link_access = 'anyone_with_link'
            )
        )
    GROUP BY w.id, wm.role, uws.last_opened_at, uws.pinned_at
    ORDER BY
        CASE WHEN uws.pinned_at IS NULL THEN 1 ELSE 0 END,
        COALESCE(uws.pinned_at, uws.last_opened_at, w.updated_at) DESC,
        w.updated_at DESC
"#;

pub(crate) const LIST_ARCHIVED_WORKSPACES_AS_ADMIN: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id, 'owner' AS role,
        uws.last_opened_at, uws.pinned_at,
        COALESCE(COUNT(wd.id), 0) AS dataset_count
    FROM workspaces w
    LEFT JOIN user_workspace_state uws
        ON uws.workspace_id = w.id AND uws.user_email = $1
    LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
    WHERE w.archived_at IS NOT NULL
    GROUP BY w.id, uws.last_opened_at, uws.pinned_at
    ORDER BY w.archived_at DESC, w.updated_at DESC
"#;

pub(crate) const LIST_ARCHIVED_WORKSPACES: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id, wm.role,
        uws.last_opened_at, uws.pinned_at,
        COALESCE(COUNT(wd.id), 0) AS dataset_count
    FROM workspaces w
    INNER JOIN workspace_members wm
        ON wm.workspace_id = w.id AND wm.email = $1 AND wm.role = 'owner'
    LEFT JOIN user_workspace_state uws
        ON uws.workspace_id = w.id AND uws.user_email = $2
    LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
    WHERE w.archived_at IS NOT NULL
    GROUP BY w.id, wm.role, uws.last_opened_at, uws.pinned_at
    ORDER BY w.archived_at DESC, w.updated_at DESC
"#;

// ---------------------------------------------------------------------
// The admin search
// ---------------------------------------------------------------------

/// Everything before the optional filters. Split from the tail because
/// what sits between them depends on the arguments; see
/// [`admin_search_query`].
const ADMIN_SEARCH_HEAD: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id,
        w.link_access, w.link_role,
        COUNT(DISTINCT wd.id) AS dataset_count,
        COUNT(DISTINCT wm.email) AS member_count,
        COUNT(DISTINCT CASE WHEN wm.role = 'owner' THEN wm.email END) AS owner_count
    FROM workspaces w
    LEFT JOIN workspace_members wm ON wm.workspace_id = w.id
    LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
    WHERE 1 = 1
"#;

const ADMIN_SEARCH_LIVE_ONLY: &str = " AND w.archived_at IS NULL";

const ADMIN_SEARCH_TAIL: &str = r#"
    GROUP BY w.id
    ORDER BY
        CASE WHEN w.archived_at IS NULL THEN 0 ELSE 1 END,
        w.updated_at DESC
    LIMIT
"#;

/// The widest result set the admin console will ask for in one call.
const ADMIN_SEARCH_MAX_ROWS: usize = 100;

/// The one query in this store assembled at runtime rather than written
/// out: the admin console's workspace search, whose shape depends on
/// whether a query string and archived workspaces were asked for.
///
/// Generic over the engine because a `QueryBuilder` writes its own
/// placeholders — `?` for SQLite, `$1` and up for PostgreSQL — which is
/// the one place the numbered-placeholder rule above cannot reach. Both
/// stores call this, so the fragments, the order they go in, and how the
/// arguments are shaped on the way past are still written once; the two
/// `Encode` bounds are the price. The alternative was two copies of the
/// same thirty lines of `push`, which is exactly the shape a typo hides
/// in.
///
/// **The search scans, and that is the decision.** Every term is matched
/// with `LOWER(column) LIKE '%term%'`, and a leading wildcard rules out an
/// ordinary index on either engine, so both plan a sequential scan today.
/// PostgreSQL could index it with a `pg_trgm` GIN index and SQLite could
/// not, and that is the reason not to: the two baselines are held to the
/// same named indexes by `the_two_baselines_declare_the_same_indexes`, and
/// `pg_trgm` is an extension a deployment has to be allowed to install
/// rather than a line in a schema file. Against that, this is an
/// admin-only query over one row per workspace, capped at
/// [`ADMIN_SEARCH_MAX_ROWS`]. If the workspace table ever reaches a size
/// where the scan is felt, the index is worth its deployment step, and it
/// arrives with a second decision about what the SQLite side does
/// instead.
///
/// **`LOWER` folds a different alphabet on each engine.** SQLite's is
/// ASCII-only; PostgreSQL's follows the database locale and folds the rest
/// of Unicode too, so a workspace named `ÉCLAIR` is found by the query
/// `éclair` on PostgreSQL and not on SQLite. Only `workspaces.name` can
/// hold the difference — ids are UUIDs and every stored address is
/// normalized to lowercase ASCII on the way in — and no portable spelling
/// closes it, because the folding belongs to the engine. The conformance
/// suite pins the ASCII behavior, which is what both engines agree on.
///
/// A backslash in the query is the same story in miniature: PostgreSQL
/// reads it as `LIKE`'s escape character and SQLite has no default escape,
/// so `a\b` matches on one engine and not the other. An `ESCAPE '\'`
/// clause would settle it, at the cost of changing what the SQLite search
/// has always done with a backslash, which is not this port's to trade.
pub(crate) fn admin_search_query<DB>(
    query: Option<&str>,
    include_archived: bool,
    limit: usize,
) -> QueryBuilder<'static, DB>
where
    DB: Database,
    String: Encode<'static, DB> + Type<DB>,
    i64: Encode<'static, DB> + Type<DB>,
{
    let mut builder = QueryBuilder::<DB>::new(ADMIN_SEARCH_HEAD);

    if !include_archived {
        builder.push(ADMIN_SEARCH_LIVE_ONLY);
    }

    if let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) {
        let like = format!("%{}%", query.to_ascii_lowercase());
        builder
            .push(" AND (LOWER(w.id) LIKE ")
            .push_bind(like.clone())
            .push(" OR LOWER(w.name) LIKE ")
            .push_bind(like.clone())
            .push(" OR LOWER(w.created_by) LIKE ")
            .push_bind(like.clone())
            .push(
                r#" OR EXISTS (
                    SELECT 1
                    FROM workspace_members wm_search
                    WHERE wm_search.workspace_id = w.id
                        AND LOWER(wm_search.email) LIKE
                "#,
            )
            .push_bind(like)
            .push("))");
    }

    builder.push(ADMIN_SEARCH_TAIL);
    // A caller asking for no rows gets one rather than an empty answer,
    // and one asking for the world gets the cap.
    builder.push_bind(limit.clamp(1, ADMIN_SEARCH_MAX_ROWS) as i64);
    builder
}

pub(crate) const ADMIN_WORKSPACE_DETAILS: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id,
        w.link_access, w.link_role,
        COUNT(DISTINCT wd.id) AS dataset_count,
        COUNT(DISTINCT wm.email) AS member_count,
        COUNT(DISTINCT CASE WHEN wm.role = 'owner' THEN wm.email END) AS owner_count
    FROM workspaces w
    LEFT JOIN workspace_members wm ON wm.workspace_id = w.id
    LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
    WHERE w.id = $1
    GROUP BY w.id
"#;

// ---------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------

pub(crate) const LIST_MEMBERS: &str = r#"
    SELECT email, role, display_name, added_at
    FROM workspace_members
    WHERE workspace_id = $1
    ORDER BY
        CASE role
            WHEN 'owner' THEN 0
            WHEN 'editor' THEN 1
            ELSE 2
        END,
        email ASC
"#;

pub(crate) const MEMBER: &str = r#"
    SELECT email, role, display_name, added_at
    FROM workspace_members
    WHERE workspace_id = $1 AND email = $2
"#;

pub(crate) const MEMBER_ROLE: &str = r#"
    SELECT role
    FROM workspace_members
    WHERE workspace_id = $1 AND email = $2
"#;

/// The caller's member role, or the workspace's link grant when they have
/// none. One round trip, because the two answers come from the same join.
pub(crate) const ROLE_FOR: &str = r#"
    SELECT
        wm.role AS member_role,
        w.link_access,
        w.link_role
    FROM workspaces w
    LEFT JOIN workspace_members wm
        ON wm.workspace_id = w.id AND wm.email = $1
    WHERE w.id = $2 AND w.archived_at IS NULL
"#;

pub(crate) const INSERT_OWNER_MEMBER: &str = r#"
    INSERT INTO workspace_members
        (workspace_id, email, role, display_name, added_at)
    VALUES ($1, $2, 'owner', $3, $4)
"#;

pub(crate) const UPSERT_MEMBER: &str = r#"
    INSERT INTO workspace_members
        (workspace_id, email, role, display_name, added_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(workspace_id, email) DO UPDATE SET
        role = excluded.role,
        display_name = excluded.display_name
"#;

pub(crate) const UPSERT_OWNER_MEMBER: &str = r#"
    INSERT INTO workspace_members
        (workspace_id, email, role, display_name, added_at)
    VALUES ($1, $2, 'owner', $3, $4)
    ON CONFLICT(workspace_id, email) DO UPDATE SET
        role = 'owner',
        display_name = excluded.display_name
"#;

pub(crate) const UPDATE_MEMBER_ROLE: &str = r#"
    UPDATE workspace_members
    SET role = $1
    WHERE workspace_id = $2 AND email = $3
"#;

pub(crate) const DELETE_MEMBER: &str =
    "DELETE FROM workspace_members WHERE workspace_id = $1 AND email = $2";

// ---------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------

pub(crate) const UPSERT_DATASET_SOURCE: &str = r#"
    INSERT INTO dataset_sources (id, canonical_url, default_name, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(id) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        default_name = excluded.default_name,
        updated_at = excluded.updated_at
"#;

/// Attach a source to a workspace at the end of its layer order.
///
/// The correlated subquery reads the order this row is about to join, so
/// the position is chosen inside the write rather than by a separate read
/// that another writer could interleave with. `DO NOTHING` makes reopening
/// a source already in the workspace a no-op, which is what keeps the
/// workspace-local id the document already refers to.
pub(crate) const INSERT_WORKSPACE_DATASET_AT_END: &str = r#"
    INSERT INTO workspace_datasets
        (id, workspace_id, dataset_source_id, display_name, added_by, added_at, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, (
        SELECT COALESCE(MAX(sort_order), -1) + 1
        FROM workspace_datasets
        WHERE workspace_id = $7
    ))
    ON CONFLICT(workspace_id, dataset_source_id) DO NOTHING
"#;

/// The same attachment with the order given, for a copy that reproduces
/// the source workspace's layer order exactly.
pub(crate) const INSERT_WORKSPACE_DATASET: &str = r#"
    INSERT INTO workspace_datasets
        (id, workspace_id, dataset_source_id, display_name, added_by, added_at, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
"#;

pub(crate) const DELETE_WORKSPACE_DATASET: &str =
    "DELETE FROM workspace_datasets WHERE workspace_id = $1 AND id = $2";

/// A rename inside one workspace. `dataset_sources.default_name` — the
/// source's import-time name, shared by every workspace holding it — is
/// deliberately left alone.
pub(crate) const RENAME_WORKSPACE_DATASET: &str =
    "UPDATE workspace_datasets SET display_name = $1 WHERE workspace_id = $2 AND id = $3";

pub(crate) const LIST_DATASET_SOURCES: &str = r#"
    SELECT
        wd.id AS workspace_dataset_id,
        wd.dataset_source_id,
        ds.canonical_url,
        wd.display_name
    FROM workspace_datasets wd
    INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
    WHERE wd.workspace_id = $1
    ORDER BY wd.sort_order ASC, wd.added_at ASC
"#;

pub(crate) const DATASET_BY_SOURCE: &str = r#"
    SELECT
        wd.id AS workspace_dataset_id,
        wd.dataset_source_id,
        ds.canonical_url,
        wd.display_name
    FROM workspace_datasets wd
    INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
    WHERE wd.workspace_id = $1 AND wd.dataset_source_id = $2
"#;

pub(crate) const DATASET_BY_WORKSPACE_DATASET: &str = r#"
    SELECT
        wd.id AS workspace_dataset_id,
        wd.dataset_source_id,
        ds.canonical_url,
        wd.display_name
    FROM workspace_datasets wd
    INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
    WHERE wd.workspace_id = $1 AND wd.id = $2
"#;

// ---------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------

/// The whole visibility predicate, resolved in SQL: a row is visible when
/// it is shared, when it is the caller's own — personal or proposed — or,
/// only when the caller can edit, when it is any proposed row at all (the
/// editor review queue). No fetch-all-then-filter: another member's
/// personal row, or their proposed row for a plain viewer, never crosses
/// the store boundary.
///
/// `$3` is the caller's editing right, bound as a Rust `bool`. PostgreSQL
/// takes it as a `boolean` and SQLite as the 0 or 1 it treats as one, so
/// the same conjunction reads the same on both.
pub(crate) const LIST_SAVED_VIEWS: &str = r#"
    SELECT
        id, workspace_id, name, created_by, created_by_name,
        created_at, updated_at, visibility, view_json
    FROM workspace_saved_views
    WHERE workspace_id = $1
        AND (
            visibility = 'shared'
            OR created_by = $2
            OR ($3 AND visibility = 'proposed')
        )
    ORDER BY updated_at DESC
"#;

pub(crate) const GET_SAVED_VIEW: &str = r#"
    SELECT
        id, workspace_id, name, created_by, created_by_name,
        created_at, updated_at, visibility, view_json
    FROM workspace_saved_views
    WHERE workspace_id = $1 AND id = $2
"#;

pub(crate) const INSERT_SAVED_VIEW: &str = r#"
    INSERT INTO workspace_saved_views
        (id, workspace_id, name, created_by, created_by_name, created_at, updated_at, visibility, view_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
"#;

/// A copied view: shared, and re-attributed to whoever made the copy.
pub(crate) const INSERT_COPIED_SAVED_VIEW: &str = r#"
    INSERT INTO workspace_saved_views
        (id, workspace_id, name, created_by, created_by_name, created_at, updated_at, visibility, view_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'shared', $8)
"#;

/// A partial update: a `NULL` argument leaves the column alone, so the
/// caller passes only what changed.
pub(crate) const UPDATE_SAVED_VIEW: &str = r#"
    UPDATE workspace_saved_views
    SET
        name = COALESCE($1, name),
        view_json = COALESCE($2, view_json),
        updated_at = $3
    WHERE workspace_id = $4 AND id = $5
"#;

/// Re-scope a view without disturbing anything else about it.
///
/// This is the whole of the approval workflow's write: promoting a
/// proposal to shared, demoting it back to its author's personal, and
/// every other move between the three states run this one statement.
/// `name`, `view_json`, and `created_by` are untouched on purpose, so the
/// saved camera and the original author survive the transition.
pub(crate) const SET_SAVED_VIEW_VISIBILITY: &str = r#"
    UPDATE workspace_saved_views
    SET
        visibility = $1,
        updated_at = $2
    WHERE workspace_id = $3 AND id = $4
"#;

/// A workspace whose default pointed at this view is left pointing at
/// nothing: `workspaces.default_saved_view_id` declares
/// `ON DELETE SET NULL`, so the database clears it as part of this delete.
pub(crate) const DELETE_SAVED_VIEW: &str =
    "DELETE FROM workspace_saved_views WHERE workspace_id = $1 AND id = $2";

// ---------------------------------------------------------------------
// Duplication
// ---------------------------------------------------------------------

/// The source workspace, read inside the copy's transaction so the copy is
/// a consistent snapshot. `archived_at IS NULL` because a duplicate is
/// only meaningful for a live workspace.
pub(crate) const DUPLICATE_SOURCE_WORKSPACE: &str = r#"
    SELECT document_json, default_saved_view_id
    FROM workspaces
    WHERE id = $1 AND archived_at IS NULL
"#;

pub(crate) const DUPLICATE_SOURCE_DATASETS: &str = r#"
    SELECT id, dataset_source_id, display_name, sort_order
    FROM workspace_datasets
    WHERE workspace_id = $1
    ORDER BY sort_order ASC, added_at ASC
"#;

/// Shared views only. A personal or proposed view belongs to one member
/// and is not the copier's to carry across.
pub(crate) const DUPLICATE_SOURCE_SHARED_VIEWS: &str = r#"
    SELECT id, name, view_json
    FROM workspace_saved_views
    WHERE workspace_id = $1 AND visibility = 'shared'
    ORDER BY created_at ASC
"#;

/// Point the fresh copy at its own copy of the source's default view.
/// Unconditional on the archive state, unlike [`SET_DEFAULT_SAVED_VIEW`],
/// because the row was created moments ago inside this transaction.
pub(crate) const SET_DEFAULT_SAVED_VIEW_ON_COPY: &str = r#"
    UPDATE workspaces
    SET default_saved_view_id = $1
    WHERE id = $2
"#;

// ---------------------------------------------------------------------
// Viewer profiles and per-member state
// ---------------------------------------------------------------------

pub(crate) const GET_VIEWER_PROFILE: &str = r#"
    SELECT
        workspace_id, user_email, profile, created_at, updated_at,
        seed_source, view_json
    FROM workspace_viewer_profiles
    WHERE workspace_id = $1 AND user_email = $2 AND profile = $3
"#;

/// Passing no seed leaves the one the slot was first opened from, rather
/// than clearing it — which is what the `COALESCE` over `excluded` is for.
pub(crate) const UPSERT_VIEWER_PROFILE: &str = r#"
    INSERT INTO workspace_viewer_profiles
        (workspace_id, user_email, profile, created_at, updated_at, seed_source, view_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(workspace_id, user_email, profile) DO UPDATE SET
        updated_at = excluded.updated_at,
        seed_source = COALESCE(excluded.seed_source, workspace_viewer_profiles.seed_source),
        view_json = excluded.view_json
"#;

pub(crate) const USER_WORKSPACE_STATE: &str = r#"
    SELECT workspace_id, last_opened_at, pinned_at, last_view_json
    FROM user_workspace_state
    WHERE workspace_id = $1 AND user_email = $2
"#;

pub(crate) const RECORD_WORKSPACE_OPEN: &str = r#"
    INSERT INTO user_workspace_state
        (user_email, workspace_id, created_at, updated_at, last_opened_at, pinned_at)
    VALUES ($1, $2, $3, $4, $5, NULL)
    ON CONFLICT(user_email, workspace_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at
"#;

pub(crate) const PIN_WORKSPACE: &str = r#"
    INSERT INTO user_workspace_state
        (user_email, workspace_id, created_at, updated_at, last_opened_at, pinned_at)
    VALUES ($1, $2, $3, $4, NULL, $5)
    ON CONFLICT(user_email, workspace_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        pinned_at = excluded.pinned_at
"#;

pub(crate) const UNPIN_WORKSPACE: &str = r#"
    UPDATE user_workspace_state
    SET pinned_at = NULL, updated_at = $1
    WHERE user_email = $2 AND workspace_id = $3
"#;

/// Drop a row that no longer records anything, so unpinning a workspace
/// the member never opened leaves nothing behind.
pub(crate) const DELETE_EMPTY_USER_WORKSPACE_STATE: &str = r#"
    DELETE FROM user_workspace_state
    WHERE
        user_email = $1
        AND workspace_id = $2
        AND pinned_at IS NULL
        AND last_opened_at IS NULL
"#;

/// Upsert one member's own last-open view, touching only `last_view_json`
/// and `updated_at`.
///
/// On conflict this never writes `last_opened_at` or `pinned_at`, so a
/// remembered view does not perturb recents or pins, and it never touches
/// the `workspaces` table — `workspaces.default_saved_view_id` is
/// unrelated storage, which upholds "recording a last view never changes
/// the shared default" by construction.
pub(crate) const SET_USER_LAST_VIEW: &str = r#"
    INSERT INTO user_workspace_state
        (user_email, workspace_id, created_at, updated_at, last_opened_at, pinned_at, last_view_json)
    VALUES ($1, $2, $3, $4, NULL, NULL, $5)
    ON CONFLICT(user_email, workspace_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_view_json = excluded.last_view_json
"#;
