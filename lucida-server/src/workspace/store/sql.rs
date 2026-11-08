//! What both SQL-backed `WorkspaceStore` implementations share: the
//! statements they run, and the one query they assemble at runtime.
//!
//! Every statement is valid on both engines and uses numbered
//! `$N` placeholders, which sqlx's SQLite driver binds by number. Do not
//! mix `$1` and `?` in one statement: it binds the same argument to both
//! and returns a wrong answer without an error. Each bound argument gets
//! its own number, in order of appearance, so a bind list reads straight
//! down the statement even where that passes one value twice.

use sqlx::{Database, Encode, QueryBuilder, Type};

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
/// their table defaults — link access off. See
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

/// The document and its sequence number, written together, and only over
/// an older one. Without the guard, two writes that reach the database out
/// of order would leave the older document standing. No row changed means
/// the write was refused; the caller turns that into
/// `StoreError::StaleDocument`.
///
/// `seq` is `BIGINT` in both baselines and the trait takes a `u64`, so a
/// sequence past the range of a 32-bit integer is an ordinary value here
/// rather than an overflow. The conformance suite writes one.
pub(crate) const PERSIST_DOCUMENT: &str = r#"
    UPDATE workspaces
    SET seq = $1, document_json = $2, updated_at = $3
    WHERE id = $4 AND seq < $5
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

// The four listings below group by `w.id` and select columns from the
// tables joined onto it. PostgreSQL lets a grouped query select any column
// of a table whose primary key is in the `GROUP BY`, but that reasoning
// stops at the table: `uws.pinned_at` and `wm.role` come from other tables
// and have to be named. Both joins match at most one row per workspace —
// each is on the whole of that table's primary key — so naming them splits
// no group and the answer is the same on either engine. SQLite would have
// accepted the shorter form; only PostgreSQL asks.
//
// `first_dataset_url` is a correlated subquery because no aggregate both
// engines share picks one row of a group by order. "First" is the order
// `LIST_DATASET_SOURCES` lists them in. `preview_updated_at` is one too,
// so it needs no place in the `GROUP BY`.

pub(crate) const LIST_WORKSPACES_AS_ADMIN: &str = r#"
    SELECT
        w.id, w.name, w.created_by, w.created_at, w.updated_at,
        w.archived_at, w.seq, w.default_saved_view_id, 'owner' AS role,
        uws.last_opened_at, uws.pinned_at,
        COALESCE(COUNT(wd.id), 0) AS dataset_count,
        (
            SELECT ds.canonical_url
            FROM workspace_datasets first_wd
            INNER JOIN dataset_sources ds ON ds.id = first_wd.dataset_source_id
            WHERE first_wd.workspace_id = w.id
            ORDER BY first_wd.sort_order ASC, first_wd.added_at ASC
            LIMIT 1
        ) AS first_dataset_url,
        (
            SELECT wp.updated_at
            FROM workspace_previews wp
            WHERE wp.workspace_id = w.id
        ) AS preview_updated_at
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
        COALESCE(COUNT(wd.id), 0) AS dataset_count,
        (
            SELECT ds.canonical_url
            FROM workspace_datasets first_wd
            INNER JOIN dataset_sources ds ON ds.id = first_wd.dataset_source_id
            WHERE first_wd.workspace_id = w.id
            ORDER BY first_wd.sort_order ASC, first_wd.added_at ASC
            LIMIT 1
        ) AS first_dataset_url,
        (
            SELECT wp.updated_at
            FROM workspace_previews wp
            WHERE wp.workspace_id = w.id
        ) AS preview_updated_at
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
        COALESCE(COUNT(wd.id), 0) AS dataset_count,
        (
            SELECT ds.canonical_url
            FROM workspace_datasets first_wd
            INNER JOIN dataset_sources ds ON ds.id = first_wd.dataset_source_id
            WHERE first_wd.workspace_id = w.id
            ORDER BY first_wd.sort_order ASC, first_wd.added_at ASC
            LIMIT 1
        ) AS first_dataset_url,
        (
            SELECT wp.updated_at
            FROM workspace_previews wp
            WHERE wp.workspace_id = w.id
        ) AS preview_updated_at
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
        COALESCE(COUNT(wd.id), 0) AS dataset_count,
        (
            SELECT ds.canonical_url
            FROM workspace_datasets first_wd
            INNER JOIN dataset_sources ds ON ds.id = first_wd.dataset_source_id
            WHERE first_wd.workspace_id = w.id
            ORDER BY first_wd.sort_order ASC, first_wd.added_at ASC
            LIMIT 1
        ) AS first_dataset_url,
        (
            SELECT wp.updated_at
            FROM workspace_previews wp
            WHERE wp.workspace_id = w.id
        ) AS preview_updated_at
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

/// The one query this store assembles at runtime: the admin console's
/// workspace search, whose shape depends on whether a query string and
/// archived workspaces were asked for.
///
/// Generic over the engine because a `QueryBuilder` writes its own
/// placeholders (`?` on SQLite, `$N` on PostgreSQL), which the numbered
/// rule above cannot reach. Writing it once is worth the two `Encode` bounds.
///
/// The search scans on purpose. A leading-wildcard `LIKE` rules out an
/// ordinary index, and a `pg_trgm` index would break the rule that both
/// baselines declare the same indexes, for an admin-only query capped at
/// [`ADMIN_SEARCH_MAX_ROWS`]. `LOWER` folds only ASCII on SQLite but more
/// of Unicode on PostgreSQL, and a backslash is a `LIKE` escape only on
/// PostgreSQL. The conformance suite pins the ASCII behavior both share.
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

/// Write a workspace's one preview, replacing the existing one only if it
/// was written at or before `$7`.
///
/// The `WHERE` on the update is the rate limit, and it is part of the
/// write so concurrent uploads cannot both pass it. An insert has no row
/// to compare and always lands. Either way the statement changes one row
/// or none, and none means the existing preview was too recent.
pub(crate) const UPSERT_PREVIEW: &str = r#"
    INSERT INTO workspace_previews
        (workspace_id, content_type, size_bytes, image, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(workspace_id) DO UPDATE SET
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        image = excluded.image,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    WHERE workspace_previews.updated_at <= $7
"#;

pub(crate) const PREVIEW_UPDATED_AT: &str =
    "SELECT updated_at FROM workspace_previews WHERE workspace_id = $1";

pub(crate) const GET_PREVIEW: &str = r#"
    SELECT workspace_id, content_type, size_bytes, image, updated_at, updated_by
    FROM workspace_previews
    WHERE workspace_id = $1
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Postgres, Sqlite};

    /// The statement with every placeholder replaced by one marker, so two
    /// engines' output can be compared on everything except how a bound
    /// value is spelled.
    fn placeholders_masked(sql: &str) -> String {
        let mut masked = String::with_capacity(sql.len());
        let mut chars = sql.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '?' => masked.push('@'),
                '$' => {
                    masked.push('@');
                    while chars.peek().is_some_and(char::is_ascii_digit) {
                        chars.next();
                    }
                }
                _ => masked.push(c),
            }
        }
        masked
    }

    /// Every other statement in this module is one text both engines run,
    /// so a conformance case that passes on both has already checked its
    /// syntax. The admin search is assembled by a `QueryBuilder`, which
    /// writes the placeholders itself, and that is the one thing the two
    /// engines do not spell the same way.
    ///
    /// So: the same query, twice, differing in nothing but how the bound
    /// values are named. Needs no server, which is the point — a builder
    /// misused on the engine the developer is not running would otherwise
    /// only surface in continuous integration.
    #[test]
    fn the_admin_search_differs_between_engines_only_in_its_placeholders() {
        for (query, bound_values) in [(Some("demo"), 5), (None, 1)] {
            let sqlite = admin_search_query::<Sqlite>(query, false, 10);
            let postgres = admin_search_query::<Postgres>(query, false, 10);

            assert_eq!(
                placeholders_masked(sqlite.sql()),
                placeholders_masked(postgres.sql()),
                "the two engines must be assembling the same query",
            );

            assert_eq!(
                sqlite.sql().matches('?').count(),
                bound_values,
                "SQLite takes the anonymous form from the builder: {}",
                sqlite.sql(),
            );
            assert!(
                !postgres.sql().contains('?'),
                "PostgreSQL has no anonymous placeholder: {}",
                postgres.sql(),
            );
            assert!(
                postgres.sql().contains(&format!("${bound_values}")),
                "PostgreSQL numbers its placeholders through to the last: {}",
                postgres.sql(),
            );
        }
    }

    /// The archived filter is the only fragment that is a bare `push`,
    /// with no bound value to give it away, so this is where its presence
    /// and absence are pinned. Matching the fragment itself rather than
    /// the column: the `ORDER BY` sorts on `archived_at` either way.
    #[test]
    fn the_admin_search_asks_for_live_workspaces_only_by_default() {
        assert!(
            admin_search_query::<Sqlite>(None, false, 10)
                .sql()
                .contains(ADMIN_SEARCH_LIVE_ONLY),
        );
        assert!(
            !admin_search_query::<Sqlite>(None, true, 10)
                .sql()
                .contains(ADMIN_SEARCH_LIVE_ONLY),
        );
    }

    /// A query of nothing but whitespace is not a query. Both stores hand
    /// the caller's string straight through, so the trim happens here or
    /// nowhere.
    #[test]
    fn a_blank_query_filters_nothing() {
        let blank = admin_search_query::<Sqlite>(Some("   "), false, 10);
        assert!(!blank.sql().contains("LIKE"), "{}", blank.sql());
        assert_eq!(
            blank.sql().matches('?').count(),
            1,
            "the limit, and no more"
        );
    }
}
