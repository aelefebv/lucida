//! `SqliteWorkspaceStore`: the production SQLite backend for
//! [`WorkspaceStore`], including the row mappers that decode persisted
//! rows back into the domain structs.

use std::collections::HashMap;

use chrono::Utc;
use lucida_content::DatasetId;
use lucida_content::url::{SourceIdentity, SourceRevision, SourceVersion};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use sqlx::{Row, Sqlite, SqlitePool};

use crate::workspace::types::{
    SavedViewVisibility, WorkspaceAdminDetails, WorkspaceAdminSummary, WorkspaceDatasetSource,
    WorkspaceLinkAccess, WorkspaceMember, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceSharingSettings, WorkspaceSummary, WorkspaceUserState, WorkspaceViewerProfile,
};

use super::{
    StoreError, WorkspaceStore, default_member_display_name, default_workspace_name,
    map_saved_view_json_in, map_saved_view_json_out, map_sql, normalize_email, parse_document,
    parse_dt, parse_opt_dt, previous_stored_seq, serialize_document, stored_seq,
};

use async_trait::async_trait;

#[derive(Clone)]
pub struct SqliteWorkspaceStore {
    pool: SqlitePool,
}

impl SqliteWorkspaceStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn workspace_exists(&self, workspace_id: &str) -> Result<bool, StoreError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT id FROM workspaces WHERE id = ? AND archived_at IS NULL")
                .bind(workspace_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(map_sql)?;
        Ok(row.is_some())
    }

    async fn list_members(&self, workspace_id: &str) -> Result<Vec<WorkspaceMember>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT email, role, display_name, added_at
            FROM workspace_members
            WHERE workspace_id = ?
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'editor' THEN 1
                    ELSE 2
                END,
                email ASC
            "#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sql)?;

        rows.into_iter().map(row_to_member).collect()
    }

    async fn get_user_workspace_state(
        &self,
        workspace_id: &str,
        user_email: &str,
    ) -> Result<WorkspaceUserState, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT workspace_id, last_opened_at, pinned_at, last_view_json
            FROM user_workspace_state
            WHERE workspace_id = ? AND user_email = ?
            "#,
        )
        .bind(workspace_id)
        .bind(user_email)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        match row {
            Some(row) => row_to_user_workspace_state(row),
            None => Ok(WorkspaceUserState {
                workspace_id: workspace_id.to_string(),
                last_opened_at: None,
                pinned_at: None,
                last_view: None,
            }),
        }
    }
}

async fn touch_workspace(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    workspace_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"
        UPDATE workspaces
        SET updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(now)
    .bind(workspace_id)
    .execute(&mut **tx)
    .await
    .map_err(map_sql)?;
    Ok(())
}

/// Insert a brand-new, owner-only workspace row plus its owner membership row
/// inside `tx`. Shared by `create_workspace` and `duplicate_workspace` so the
/// "blank owned workspace" shape is defined in exactly one place.
///
/// `link_access` / `link_role` are deliberately NOT bound: the `workspaces`
/// columns take their table defaults ('restricted' / 'viewer'), i.e. link
/// access OFF. A duplicate therefore never inherits the source's sharing, and a
/// freshly created workspace starts private — the security-critical invariant.
/// Keeping the INSERT in one place hardens that link-off guarantee against
/// future drift (a column added with a non-OFF default would otherwise have to
/// be remembered at every call site). Callers pass pre-normalized values
/// (`owner_email`, `name`, serialized `document_json`, RFC3339 `now`) so this is
/// a pure persistence step with no policy of its own; `seq` is initialized to 0.
async fn insert_blank_owned_workspace(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    id: &str,
    owner_email: &str,
    owner_display_name: &str,
    name: &str,
    document_json: &str,
    now: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        r#"
        INSERT INTO workspaces
            (id, name, created_by, created_at, updated_at, seq, document_json)
        VALUES (?, ?, ?, ?, ?, 0, ?)
        "#,
    )
    .bind(id)
    .bind(name)
    .bind(owner_email)
    .bind(now)
    .bind(now)
    .bind(document_json)
    .execute(&mut **tx)
    .await
    .map_err(map_sql)?;

    sqlx::query(
        r#"
        INSERT INTO workspace_members
            (workspace_id, email, role, display_name, added_at)
        VALUES (?, ?, 'owner', ?, ?)
        "#,
    )
    .bind(id)
    .bind(owner_email)
    .bind(owner_display_name)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(map_sql)?;

    Ok(())
}

#[async_trait]
impl WorkspaceStore for SqliteWorkspaceStore {
    async fn create_workspace(
        &self,
        owner: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_s = now.to_rfc3339();
        let owner_email = normalize_email(&owner.email);
        let name = default_workspace_name(name);
        let document = DocumentState::default();
        let document_json = serialize_document(&document)?;

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        insert_blank_owned_workspace(
            &mut tx,
            &id,
            &owner_email,
            &owner.display_name,
            &name,
            &document_json,
            &now_s,
        )
        .await?;
        tx.commit().await.map_err(map_sql)?;

        Ok(WorkspaceRecord {
            id,
            name,
            created_by: owner_email,
            created_at: now,
            updated_at: now,
            archived_at: None,
            seq: 0,
            default_saved_view_id: None,
            document,
        })
    }

    async fn duplicate_workspace(
        &self,
        source_workspace_id: &str,
        owner: &AuthPrincipal,
        name: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let new_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_s = now.to_rfc3339();
        let owner_email = normalize_email(&owner.email);
        let name = default_workspace_name(Some(name));

        let mut tx = self.pool.begin().await.map_err(map_sql)?;

        // Read the source inside the tx so the copy is a consistent snapshot.
        // archived_at IS NULL: a duplicate is only meaningful for a live
        // workspace, and access was already gated by the manager.
        let Some(source_row) = sqlx::query(
            r#"
            SELECT document_json, default_saved_view_id
            FROM workspaces
            WHERE id = ? AND archived_at IS NULL
            "#,
        )
        .bind(source_workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sql)?
        else {
            return Ok(None);
        };

        // --- Dataset memberships: copy with FRESH workspace-local ids, and
        // build the old->new remap that keeps the document + saved views
        // consistent against the copy's datasets (the id-consistency trap). ---
        let dataset_rows = sqlx::query(
            r#"
            SELECT id, dataset_source_id, source_revision, display_name, sort_order
            FROM workspace_datasets
            WHERE workspace_id = ?
            ORDER BY sort_order ASC, added_at ASC
            "#,
        )
        .bind(source_workspace_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(map_sql)?;

        let mut remap: HashMap<DatasetId, DatasetId> = HashMap::new();
        struct CopiedDataset {
            new_id: String,
            dataset_source_id: String,
            source_revision: Option<String>,
            display_name: String,
            sort_order: i64,
        }
        let mut copied_datasets = Vec::with_capacity(dataset_rows.len());
        for row in &dataset_rows {
            let old_id: String = row.get("id");
            let new_dataset_id = format!("wds-{}", uuid::Uuid::new_v4().simple());
            remap.insert(DatasetId(old_id), DatasetId(new_dataset_id.clone()));
            copied_datasets.push(CopiedDataset {
                new_id: new_dataset_id,
                dataset_source_id: row.get("dataset_source_id"),
                source_revision: row.get("source_revision"),
                display_name: row.get("display_name"),
                sort_order: row.get("sort_order"),
            });
        }

        // --- Document: remap every dataset-id reference onto the copy's ids. ---
        let source_document_json: String = source_row.get("document_json");
        let mut document = parse_document(&source_document_json)?;
        document.remap_dataset_ids(&remap);
        let document_json = serialize_document(&document)?;

        // New workspace row + owner-only membership. Shared with
        // `create_workspace` via `insert_blank_owned_workspace`, which also owns
        // the link-off guarantee: `link_access`/`link_role` are left to their
        // table defaults ('restricted' / 'viewer'), so the copy never inherits
        // the source's sharing, and the source's OTHER members are not copied —
        // the security-critical invariant.
        insert_blank_owned_workspace(
            &mut tx,
            &new_id,
            &owner_email,
            &owner.display_name,
            &name,
            &document_json,
            &now_s,
        )
        .await?;

        // Copied dataset memberships (same source + display name, fresh id).
        for ds in &copied_datasets {
            sqlx::query(
                r#"
                INSERT INTO workspace_datasets
                    (id, workspace_id, dataset_source_id, source_revision, display_name, added_by, added_at, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(&ds.new_id)
            .bind(&new_id)
            .bind(&ds.dataset_source_id)
            .bind(&ds.source_revision)
            .bind(&ds.display_name)
            .bind(&owner_email)
            .bind(&now_s)
            .bind(ds.sort_order)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        }

        // --- Shared saved views only, re-attributed to the duplicator and
        // kept Shared. Personal/Proposed views (anyone's) are NOT copied. The
        // active/default-view pointer is remapped to the copied view. ---
        let source_view_rows = sqlx::query(
            r#"
            SELECT id, name, view_json
            FROM workspace_saved_views
            WHERE workspace_id = ? AND visibility = 'shared'
            ORDER BY created_at ASC
            "#,
        )
        .bind(source_workspace_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(map_sql)?;

        let source_default_view_id: Option<String> = source_row.get("default_saved_view_id");
        let mut new_default_view_id: Option<String> = None;
        for row in &source_view_rows {
            let old_view_id: String = row.get("id");
            let view_name: String = row.get("name");
            let view_json: String = row.get("view_json");
            let mut view: SavedView =
                serde_json::from_str(&view_json).map_err(map_saved_view_json_in)?;
            view.remap_dataset_ids(&remap);
            // Copy-point defense: the manager's create/update paths run
            // `workspace_saved_view_payload` (which clears `datasets`), but a
            // row inserted by another path — or persisted before that strip
            // existed — may still carry source URLs. The copy must be clean
            // regardless of the source row's state, so clear them here too
            // (decision 0014). `remap_dataset_ids` intentionally leaves
            // URL-keyed `datasets` alone; this is the explicit strip.
            view.clear_source_urls();
            let remapped_view_json =
                serde_json::to_string(&view).map_err(map_saved_view_json_out)?;
            let new_view_id = uuid::Uuid::new_v4().to_string();

            sqlx::query(
                r#"
                INSERT INTO workspace_saved_views
                    (id, workspace_id, name, created_by, created_by_name, created_at, updated_at, visibility, view_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', ?)
                "#,
            )
            .bind(&new_view_id)
            .bind(&new_id)
            .bind(&view_name)
            .bind(&owner_email)
            .bind(&owner.display_name)
            .bind(&now_s)
            .bind(&now_s)
            .bind(&remapped_view_json)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

            if source_default_view_id.as_deref() == Some(old_view_id.as_str()) {
                new_default_view_id = Some(new_view_id);
            }
        }

        // Point the copy's default at the copied view (if the source default
        // was a Shared view we copied). A source default pointing at a
        // personal/proposed view we didn't copy resolves to NULL — the copy
        // simply has no default, which is the safe outcome.
        if let Some(default_id) = &new_default_view_id {
            sqlx::query(
                r#"
                UPDATE workspaces
                SET default_saved_view_id = ?
                WHERE id = ?
                "#,
            )
            .bind(default_id)
            .bind(&new_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        }

        tx.commit().await.map_err(map_sql)?;

        Ok(Some(WorkspaceRecord {
            id: new_id,
            name,
            created_by: owner_email,
            created_at: now,
            updated_at: now,
            archived_at: None,
            seq: 0,
            default_saved_view_id: new_default_view_id,
            document,
        }))
    }

    async fn list_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, StoreError> {
        let email = normalize_email(&principal.email);
        let rows = if principal.is_admin {
            sqlx::query(
                r#"
                SELECT
                    w.id, w.name, w.created_by, w.created_at, w.updated_at,
                    w.archived_at, w.seq, w.default_saved_view_id, 'owner' AS role,
                    uws.last_opened_at, uws.pinned_at,
                    COALESCE(COUNT(wd.id), 0) AS dataset_count
                FROM workspaces w
                LEFT JOIN user_workspace_state uws
                    ON uws.workspace_id = w.id AND uws.user_email = ?
                LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
                WHERE w.archived_at IS NULL
                GROUP BY w.id
                ORDER BY
                    CASE WHEN uws.pinned_at IS NULL THEN 1 ELSE 0 END,
                    COALESCE(uws.pinned_at, uws.last_opened_at, w.updated_at) DESC,
                    w.updated_at DESC
                "#,
            )
            .bind(&email)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?
        } else {
            sqlx::query(
                r#"
                SELECT
                    w.id, w.name, w.created_by, w.created_at, w.updated_at,
                    w.archived_at, w.seq, w.default_saved_view_id,
                    COALESCE(wm.role, w.link_role) AS role,
                    uws.last_opened_at, uws.pinned_at,
                    COALESCE(COUNT(wd.id), 0) AS dataset_count
                FROM workspaces w
                LEFT JOIN workspace_members wm
                    ON wm.workspace_id = w.id AND wm.email = ?
                LEFT JOIN user_workspace_state uws
                    ON uws.workspace_id = w.id AND uws.user_email = ?
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
                GROUP BY w.id
                ORDER BY
                    CASE WHEN uws.pinned_at IS NULL THEN 1 ELSE 0 END,
                    COALESCE(uws.pinned_at, uws.last_opened_at, w.updated_at) DESC,
                    w.updated_at DESC
                "#,
            )
            .bind(&email)
            .bind(&email)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?
        };

        rows.into_iter().map(row_to_summary).collect()
    }

    async fn list_archived_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, StoreError> {
        let email = normalize_email(&principal.email);
        let rows = if principal.is_admin {
            sqlx::query(
                r#"
                SELECT
                    w.id, w.name, w.created_by, w.created_at, w.updated_at,
                    w.archived_at, w.seq, w.default_saved_view_id, 'owner' AS role,
                    uws.last_opened_at, uws.pinned_at,
                    COALESCE(COUNT(wd.id), 0) AS dataset_count
                FROM workspaces w
                LEFT JOIN user_workspace_state uws
                    ON uws.workspace_id = w.id AND uws.user_email = ?
                LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
                WHERE w.archived_at IS NOT NULL
                GROUP BY w.id
                ORDER BY w.archived_at DESC, w.updated_at DESC
                "#,
            )
            .bind(&email)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?
        } else {
            sqlx::query(
                r#"
                SELECT
                    w.id, w.name, w.created_by, w.created_at, w.updated_at,
                    w.archived_at, w.seq, w.default_saved_view_id, wm.role,
                    uws.last_opened_at, uws.pinned_at,
                    COALESCE(COUNT(wd.id), 0) AS dataset_count
                FROM workspaces w
                INNER JOIN workspace_members wm
                    ON wm.workspace_id = w.id AND wm.email = ? AND wm.role = 'owner'
                LEFT JOIN user_workspace_state uws
                    ON uws.workspace_id = w.id AND uws.user_email = ?
                LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
                WHERE w.archived_at IS NOT NULL
                GROUP BY w.id
                ORDER BY w.archived_at DESC, w.updated_at DESC
                "#,
            )
            .bind(&email)
            .bind(&email)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?
        };

        rows.into_iter().map(row_to_summary).collect()
    }

    async fn admin_search_workspaces(
        &self,
        query: Option<&str>,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkspaceAdminSummary>, StoreError> {
        let limit = limit.clamp(1, 100) as i64;
        let trimmed_query = query.map(str::trim).filter(|q| !q.is_empty());

        let mut builder = sqlx::QueryBuilder::<Sqlite>::new(
            r#"
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
            "#,
        );

        if !include_archived {
            builder.push(" AND w.archived_at IS NULL");
        }

        if let Some(query) = trimmed_query {
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

        builder.push(
            r#"
            GROUP BY w.id
            ORDER BY
                CASE WHEN w.archived_at IS NULL THEN 0 ELSE 1 END,
                w.updated_at DESC
            LIMIT
            "#,
        );
        builder.push_bind(limit);

        let rows = builder
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?;
        rows.into_iter().map(row_to_admin_summary).collect()
    }

    async fn admin_workspace_details(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceAdminDetails>, StoreError> {
        let row = sqlx::query(
            r#"
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
            WHERE w.id = ?
            GROUP BY w.id
            "#,
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            return Ok(None);
        };
        let workspace = row_to_admin_summary(row)?;
        let members = self.list_members(workspace_id).await?;
        Ok(Some(WorkspaceAdminDetails { workspace, members }))
    }

    async fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRecord>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT
                id, name, created_by, created_at, updated_at, archived_at,
                seq, default_saved_view_id, document_json
            FROM workspaces
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        row.map(row_to_record).transpose()
    }

    async fn role_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError> {
        if principal.is_admin {
            let exists: Option<(String,)> =
                sqlx::query_as("SELECT id FROM workspaces WHERE id = ? AND archived_at IS NULL")
                    .bind(workspace_id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(map_sql)?;
            if exists.is_some() {
                return Ok(Some(WorkspaceRole::Owner));
            }
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let row = sqlx::query(
            r#"
            SELECT
                wm.role AS member_role,
                w.link_access,
                w.link_role
            FROM workspaces w
            LEFT JOIN workspace_members wm
                ON wm.workspace_id = w.id AND wm.email = ?
            WHERE w.id = ? AND w.archived_at IS NULL
            "#,
        )
        .bind(email)
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            return Ok(None);
        };

        if let Some(member_role) = row.get::<Option<String>, _>("member_role") {
            return WorkspaceRole::try_from(member_role.as_str()).map(Some);
        }

        let link_access =
            WorkspaceLinkAccess::try_from(row.get::<String, _>("link_access").as_str())?;
        if link_access == WorkspaceLinkAccess::AnyoneWithLink {
            let link_role = WorkspaceRole::try_from(row.get::<String, _>("link_role").as_str())?;
            if link_role.can_own() {
                return Err(StoreError::InvalidRole(
                    "link role cannot grant owner".to_string(),
                ));
            }
            return Ok(Some(link_role));
        }

        Ok(None)
    }

    async fn owner_role_for_any_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError> {
        if principal.is_admin {
            let exists: Option<(String,)> =
                sqlx::query_as("SELECT id FROM workspaces WHERE id = ?")
                    .bind(workspace_id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(map_sql)?;
            if exists.is_some() {
                return Ok(Some(WorkspaceRole::Owner));
            }
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let row = sqlx::query(
            r#"
            SELECT role
            FROM workspace_members
            WHERE workspace_id = ? AND email = ?
            "#,
        )
        .bind(workspace_id)
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            return Ok(None);
        };
        let role = WorkspaceRole::try_from(row.get::<String, _>("role").as_str())?;
        if role.can_own() {
            Ok(Some(role))
        } else {
            Ok(None)
        }
    }

    async fn member_role_for_any_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError> {
        if principal.is_admin {
            // Admins are owner-equivalent on any workspace that exists, in any
            // state (mirrors `role_for`/`owner_role_for_any_state`).
            let exists: Option<(String,)> =
                sqlx::query_as("SELECT id FROM workspaces WHERE id = ?")
                    .bind(workspace_id)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(map_sql)?;
            if exists.is_some() {
                return Ok(Some(WorkspaceRole::Owner));
            }
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let row = sqlx::query(
            r#"
            SELECT role
            FROM workspace_members
            WHERE workspace_id = ? AND email = ?
            "#,
        )
        .bind(workspace_id)
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            return Ok(None);
        };
        WorkspaceRole::try_from(row.get::<String, _>("role").as_str()).map(Some)
    }

    async fn rename_workspace(
        &self,
        workspace_id: &str,
        name: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let name = default_workspace_name(Some(name));
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET name = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            "#,
        )
        .bind(name)
        .bind(now)
        .bind(workspace_id)
        .execute(&self.pool)
        .await
        .map_err(map_sql)?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_workspace(workspace_id).await
    }

    async fn archive_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let row = sqlx::query(
            r#"
            UPDATE workspaces
            SET archived_at = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            RETURNING
                id, name, created_by, created_at, updated_at, archived_at,
                seq, default_saved_view_id, document_json
            "#,
        )
        .bind(&now)
        .bind(&now)
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sql)?;
        let Some(row) = row else {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        };

        // Decode every fallible field while rollback is still possible. Once
        // commit succeeds, the manager can safely treat this as the durable
        // side of its commit -> local-revocation sequence.
        let record = row_to_record(row)?;
        tx.commit().await.map_err(map_sql)?;
        Ok(Some(record))
    }

    async fn restore_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET archived_at = NULL, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(now)
        .bind(workspace_id)
        .execute(&self.pool)
        .await
        .map_err(map_sql)?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_workspace(workspace_id).await
    }

    async fn persist_document(
        &self,
        workspace_id: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError> {
        let stored_seq = stored_seq(seq)?;
        let previous_seq = previous_stored_seq(seq)?;
        let document_json = serialize_document(document)?;
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ? AND seq = ?
            "#,
        )
        .bind(stored_seq)
        .bind(document_json)
        .bind(now)
        .bind(workspace_id)
        .bind(previous_seq)
        .execute(&self.pool)
        .await
        .map_err(map_sql)?;
        if result.rows_affected() == 0 {
            return Err(StoreError::SequenceConflict { attempted: seq });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn persist_dataset_opened(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        source: &SourceVersion,
        display_name: &str,
        added_by: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError> {
        let stored_seq = stored_seq(seq)?;
        let previous_seq = previous_stored_seq(seq)?;
        let now = Utc::now().to_rfc3339();
        let document_json = serialize_document(document)?;
        let dataset_source_id = source.identity.dataset_id();
        let canonical_url = source.identity.locator.as_str();
        let source_revision = source.revision.as_hex();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let source_write = sqlx::query(
            r#"
            INSERT INTO dataset_sources (id, canonical_url, default_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                default_name = excluded.default_name,
                updated_at = excluded.updated_at
            WHERE dataset_sources.canonical_url = excluded.canonical_url
            "#,
        )
        .bind(&dataset_source_id)
        .bind(canonical_url)
        .bind(display_name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        if source_write.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::InvalidSourceIdentity(format!(
                "{} is already bound to a different canonical locator",
                dataset_source_id
            )));
        }

        sqlx::query(
            r#"
            INSERT INTO workspace_datasets
                (id, workspace_id, dataset_source_id, source_revision, display_name, added_by, added_at, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, (
                SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM workspace_datasets
                WHERE workspace_id = ?
            ))
            ON CONFLICT(workspace_id, dataset_source_id) DO UPDATE SET
                source_revision = excluded.source_revision,
                display_name = excluded.display_name
            "#,
        )
        .bind(workspace_dataset_id.as_ref())
        .bind(workspace_id)
        .bind(&dataset_source_id)
        .bind(&source_revision)
        .bind(display_name)
        .bind(normalize_email(added_by))
        .bind(&now)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ? AND seq = ?
            "#,
        )
        .bind(stored_seq)
        .bind(document_json)
        .bind(&now)
        .bind(workspace_id)
        .bind(previous_seq)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::SequenceConflict { attempted: seq });
        }

        tx.commit().await.map_err(map_sql)?;
        Ok(())
    }

    async fn persist_dataset_refreshed(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        source: &SourceVersion,
        display_name: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError> {
        let stored_seq = stored_seq(seq)?;
        let previous_seq = previous_stored_seq(seq)?;
        let now = Utc::now().to_rfc3339();
        let document_json = serialize_document(document)?;
        let dataset_source_id = source.identity.dataset_id();
        let source_revision = source.revision.as_hex();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;

        let source_write = sqlx::query(
            r#"
            INSERT INTO dataset_sources (id, canonical_url, default_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                default_name = excluded.default_name,
                updated_at = excluded.updated_at
            WHERE dataset_sources.canonical_url = excluded.canonical_url
            "#,
        )
        .bind(&dataset_source_id)
        .bind(source.identity.locator.as_str())
        .bind(display_name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        if source_write.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::InvalidSourceIdentity(format!(
                "{} is already bound to a different canonical locator",
                dataset_source_id
            )));
        }

        let membership = sqlx::query(
            r#"
            UPDATE workspace_datasets
            SET source_revision = ?, display_name = ?
            WHERE workspace_id = ? AND id = ? AND dataset_source_id = ?
            "#,
        )
        .bind(&source_revision)
        .bind(display_name)
        .bind(workspace_id)
        .bind(workspace_dataset_id.as_ref())
        .bind(&dataset_source_id)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        if membership.rows_affected() != 1 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::InvalidSourceIdentity(format!(
                "workspace dataset {} is not bound to source {}",
                workspace_dataset_id, dataset_source_id
            )));
        }

        let workspace = sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ? AND seq = ?
            "#,
        )
        .bind(stored_seq)
        .bind(document_json)
        .bind(&now)
        .bind(workspace_id)
        .bind(previous_seq)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        if workspace.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::SequenceConflict { attempted: seq });
        }

        tx.commit().await.map_err(map_sql)?;
        Ok(())
    }

    async fn persist_dataset_removed(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError> {
        let stored_seq = stored_seq(seq)?;
        let previous_seq = previous_stored_seq(seq)?;
        let now = Utc::now().to_rfc3339();
        let document_json = serialize_document(document)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query("DELETE FROM workspace_datasets WHERE workspace_id = ? AND id = ?")
            .bind(workspace_id)
            .bind(workspace_dataset_id.as_ref())
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ? AND seq = ?
            "#,
        )
        .bind(stored_seq)
        .bind(document_json)
        .bind(now)
        .bind(workspace_id)
        .bind(previous_seq)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::SequenceConflict { attempted: seq });
        }
        tx.commit().await.map_err(map_sql)?;
        Ok(())
    }

    async fn persist_dataset_renamed(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        display_name: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError> {
        let stored_seq = stored_seq(seq)?;
        let previous_seq = previous_stored_seq(seq)?;
        let now = Utc::now().to_rfc3339();
        let document_json = serialize_document(document)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        // Update only the workspace-scoped display name. The shared
        // dataset_sources.default_name (the source's import-time name) is left
        // alone — a rename is per-workspace, not a rename of the global source.
        sqlx::query(
            "UPDATE workspace_datasets SET display_name = ? WHERE workspace_id = ? AND id = ?",
        )
        .bind(display_name)
        .bind(workspace_id)
        .bind(workspace_dataset_id.as_ref())
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ? AND seq = ?
            "#,
        )
        .bind(stored_seq)
        .bind(document_json)
        .bind(now)
        .bind(workspace_id)
        .bind(previous_seq)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Err(StoreError::SequenceConflict { attempted: seq });
        }
        tx.commit().await.map_err(map_sql)?;
        Ok(())
    }

    async fn list_dataset_sources(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceDatasetSource>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT
                wd.id AS workspace_dataset_id,
                wd.dataset_source_id,
                wd.source_revision,
                ds.canonical_url,
                wd.display_name
            FROM workspace_datasets wd
            INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
            WHERE wd.workspace_id = ?
            ORDER BY wd.sort_order ASC, wd.added_at ASC
            "#,
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sql)?;

        rows.into_iter().map(row_to_dataset_source).collect()
    }

    async fn dataset_by_source(
        &self,
        workspace_id: &str,
        identity: &SourceIdentity,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT
                wd.id AS workspace_dataset_id,
                wd.dataset_source_id,
                wd.source_revision,
                ds.canonical_url,
                wd.display_name
            FROM workspace_datasets wd
            INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
            WHERE wd.workspace_id = ? AND wd.dataset_source_id = ?
            "#,
        )
        .bind(workspace_id)
        .bind(identity.dataset_id())
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        row.map(row_to_dataset_source).transpose()
    }

    async fn dataset_by_workspace_dataset(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT
                wd.id AS workspace_dataset_id,
                wd.dataset_source_id,
                wd.source_revision,
                ds.canonical_url,
                wd.display_name
            FROM workspace_datasets wd
            INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
            WHERE wd.workspace_id = ? AND wd.id = ?
            "#,
        )
        .bind(workspace_id)
        .bind(workspace_dataset_id.as_ref())
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        row.map(row_to_dataset_source).transpose()
    }

    async fn sharing_settings(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceSharingSettings>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT link_access, link_role
            FROM workspaces
            WHERE id = ? AND archived_at IS NULL
            "#,
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            return Ok(None);
        };

        let members = self.list_members(workspace_id).await?;
        Ok(Some(WorkspaceSharingSettings {
            link_access: WorkspaceLinkAccess::try_from(
                row.get::<String, _>("link_access").as_str(),
            )?,
            link_role: WorkspaceRole::try_from(row.get::<String, _>("link_role").as_str())?,
            members,
        }))
    }

    async fn upsert_member(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: &str,
        role: WorkspaceRole,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let email = normalize_email(email);
        let display_name = default_member_display_name(&email, display_name);
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let row = sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, email) DO UPDATE SET
                role = excluded.role,
                display_name = excluded.display_name
            WHERE excluded.role = 'owner'
               OR workspace_members.role <> 'owner'
               OR (
                    SELECT COUNT(*)
                    FROM workspace_members AS owners
                    WHERE owners.workspace_id = excluded.workspace_id
                      AND owners.role = 'owner'
               ) > 1
            RETURNING email, role, display_name, added_at
            "#,
        )
        .bind(workspace_id)
        .bind(&email)
        .bind(role.as_str())
        .bind(display_name)
        .bind(&now)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            let retained_owner: Option<(String,)> = sqlx::query_as(
                "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
            )
            .bind(workspace_id)
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_sql)?;
            let owner_count: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
            )
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_sql)?;
            tx.rollback().await.map_err(map_sql)?;
            if role != WorkspaceRole::Owner
                && retained_owner
                    .as_ref()
                    .is_some_and(|(role,)| role == "owner")
                && owner_count.0 == 1
            {
                return Err(StoreError::LastOwner);
            }
            return Ok(None);
        };
        let member = row_to_member(row)?;

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        Ok(Some(member))
    }

    async fn admin_upsert_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: &str,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM workspaces WHERE id = ?")
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_sql)?;
        if exists.is_none() {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        }

        let email = normalize_email(email);
        let display_name = default_member_display_name(&email, display_name);
        let now = Utc::now().to_rfc3339();
        let row = sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES (?, ?, 'owner', ?, ?)
            ON CONFLICT(workspace_id, email) DO UPDATE SET
                role = 'owner',
                display_name = excluded.display_name
            RETURNING email, role, display_name, added_at
            "#,
        )
        .bind(workspace_id)
        .bind(&email)
        .bind(display_name)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await
        .map_err(map_sql)?;
        let member = row_to_member(row)?;

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        Ok(Some(member))
    }

    async fn update_member_role(
        &self,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let email = normalize_email(email);
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let row = sqlx::query(
            r#"
            UPDATE workspace_members
            SET role = ?
            WHERE workspace_id = ? AND email = ?
              AND (
                    ? = 'owner'
                 OR role <> 'owner'
                 OR (
                        SELECT COUNT(*)
                        FROM workspace_members AS owners
                        WHERE owners.workspace_id = workspace_members.workspace_id
                          AND owners.role = 'owner'
                    ) > 1
              )
            RETURNING email, role, display_name, added_at
            "#,
        )
        .bind(role.as_str())
        .bind(workspace_id)
        .bind(&email)
        .bind(role.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            let retained_role: Option<(String,)> = sqlx::query_as(
                "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
            )
            .bind(workspace_id)
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_sql)?;
            tx.rollback().await.map_err(map_sql)?;
            if retained_role
                .as_ref()
                .is_some_and(|(role,)| role == "owner")
                && role != WorkspaceRole::Owner
            {
                return Err(StoreError::LastOwner);
            }
            return Ok(None);
        };
        let member = row_to_member(row)?;

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        Ok(Some(member))
    }

    async fn remove_member(&self, workspace_id: &str, email: &str) -> Result<bool, StoreError> {
        let email = normalize_email(email);
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(
            r#"
            DELETE FROM workspace_members
            WHERE workspace_id = ? AND email = ?
              AND (
                    role <> 'owner'
                 OR (
                        SELECT COUNT(*)
                        FROM workspace_members AS owners
                        WHERE owners.workspace_id = workspace_members.workspace_id
                          AND owners.role = 'owner'
                    ) > 1
              )
            "#,
        )
        .bind(workspace_id)
        .bind(&email)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            let retained_role: Option<(String,)> = sqlx::query_as(
                "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
            )
            .bind(workspace_id)
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_sql)?;
            tx.rollback().await.map_err(map_sql)?;
            if retained_role
                .as_ref()
                .is_some_and(|(role,)| role == "owner")
            {
                return Err(StoreError::LastOwner);
            }
            return Ok(false);
        }

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        Ok(true)
    }

    async fn update_link_access(
        &self,
        workspace_id: &str,
        link_access: WorkspaceLinkAccess,
        link_role: WorkspaceRole,
    ) -> Result<Option<WorkspaceSharingSettings>, StoreError> {
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let row = sqlx::query(
            r#"
            UPDATE workspaces
            SET link_access = ?, link_role = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            RETURNING link_access, link_role
            "#,
        )
        .bind(link_access.as_str())
        .bind(link_role.as_str())
        .bind(&now)
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        };
        let link_access =
            WorkspaceLinkAccess::try_from(row.get::<String, _>("link_access").as_str())?;
        let link_role = WorkspaceRole::try_from(row.get::<String, _>("link_role").as_str())?;

        let member_rows = sqlx::query(
            r#"
            SELECT email, role, display_name, added_at
            FROM workspace_members
            WHERE workspace_id = ?
            ORDER BY
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'editor' THEN 1
                    ELSE 2
                END,
                email ASC
            "#,
        )
        .bind(workspace_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(map_sql)?;
        let members = member_rows
            .into_iter()
            .map(row_to_member)
            .collect::<Result<Vec<_>, _>>()?;

        tx.commit().await.map_err(map_sql)?;
        Ok(Some(WorkspaceSharingSettings {
            link_access,
            link_role,
            members,
        }))
    }

    async fn list_saved_views(
        &self,
        workspace_id: &str,
        viewer_email: &str,
        viewer_can_edit: bool,
    ) -> Result<Vec<WorkspaceSavedView>, StoreError> {
        // The whole visibility predicate lives here, resolved in SQL: a row is
        // visible when it is shared, it is the caller's own (personal OR
        // proposed) row, or — only when the caller can edit — it is *any*
        // proposed row (the editor review queue, #702). No fetch-all-then-
        // filter: another member's personal row, or another member's proposed
        // row for a plain viewer, never crosses the store boundary.
        let rows = sqlx::query(
            r#"
            SELECT
                id, workspace_id, name, created_by, created_by_name,
                created_at, updated_at, visibility, view_json
            FROM workspace_saved_views
            WHERE workspace_id = ?
                AND (
                    visibility = 'shared'
                    OR created_by = ?
                    OR (? AND visibility = 'proposed')
                )
            ORDER BY updated_at DESC
            "#,
        )
        .bind(workspace_id)
        .bind(viewer_email)
        .bind(viewer_can_edit)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sql)?;

        rows.into_iter().map(row_to_saved_view).collect()
    }

    async fn get_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
    ) -> Result<Option<WorkspaceSavedView>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT
                id, workspace_id, name, created_by, created_by_name,
                created_at, updated_at, visibility, view_json
            FROM workspace_saved_views
            WHERE workspace_id = ? AND id = ?
            "#,
        )
        .bind(workspace_id)
        .bind(saved_view_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        row.map(row_to_saved_view).transpose()
    }

    async fn create_saved_view(
        &self,
        workspace_id: &str,
        name: &str,
        created_by: &AuthPrincipal,
        view: SavedView,
        visibility: SavedViewVisibility,
    ) -> Result<Option<WorkspaceSavedView>, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_s = now.to_rfc3339();
        let view_json = serde_json::to_string(&view).map_err(map_saved_view_json_out)?;
        let created_by_email = normalize_email(&created_by.email);

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(
            r#"
            INSERT INTO workspace_saved_views
                (id, workspace_id, name, created_by, created_by_name, created_at, updated_at, visibility, view_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(workspace_id)
        .bind(name)
        .bind(&created_by_email)
        .bind(&created_by.display_name)
        .bind(&now_s)
        .bind(&now_s)
        .bind(visibility.as_str())
        .bind(&view_json)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        touch_workspace(&mut tx, workspace_id, &now_s).await?;
        tx.commit().await.map_err(map_sql)?;

        Ok(Some(WorkspaceSavedView {
            id,
            workspace_id: workspace_id.to_string(),
            name: name.to_string(),
            created_by: created_by_email,
            created_by_name: created_by.display_name.clone(),
            created_at: now,
            updated_at: now,
            visibility,
            view,
        }))
    }

    async fn update_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
        name: Option<&str>,
        view: Option<SavedView>,
    ) -> Result<Option<WorkspaceSavedView>, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        let now = Utc::now().to_rfc3339();
        let view_json = view
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(map_saved_view_json_out)?;

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(
            r#"
            UPDATE workspace_saved_views
            SET
                name = COALESCE(?, name),
                view_json = COALESCE(?, view_json),
                updated_at = ?
            WHERE workspace_id = ? AND id = ?
            "#,
        )
        .bind(name)
        .bind(view_json)
        .bind(&now)
        .bind(workspace_id)
        .bind(saved_view_id)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        }

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        self.get_saved_view(workspace_id, saved_view_id).await
    }

    async fn delete_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
    ) -> Result<bool, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(false);
        }

        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result =
            sqlx::query("DELETE FROM workspace_saved_views WHERE workspace_id = ? AND id = ?")
                .bind(workspace_id)
                .bind(saved_view_id)
                .execute(&mut *tx)
                .await
                .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(false);
        }

        sqlx::query(
            r#"
            UPDATE workspaces
            SET default_saved_view_id = NULL
            WHERE id = ? AND default_saved_view_id = ?
            "#,
        )
        .bind(workspace_id)
        .bind(saved_view_id)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;
        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        Ok(true)
    }

    async fn set_saved_view_visibility(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
        visibility: SavedViewVisibility,
    ) -> Result<Option<WorkspaceSavedView>, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        // Re-scope only the visibility column (and updated_at); name/view_json/
        // created_by are left untouched so attribution and the saved camera are
        // preserved across the promote/demote. Mirrors update_saved_view.
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(
            r#"
            UPDATE workspace_saved_views
            SET
                visibility = ?,
                updated_at = ?
            WHERE workspace_id = ? AND id = ?
            "#,
        )
        .bind(visibility.as_str())
        .bind(&now)
        .bind(workspace_id)
        .bind(saved_view_id)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        }

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;
        self.get_saved_view(workspace_id, saved_view_id).await
    }

    async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: Option<&str>,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let now = Utc::now().to_rfc3339();
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET default_saved_view_id = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            "#,
        )
        .bind(saved_view_id)
        .bind(now)
        .bind(workspace_id)
        .execute(&self.pool)
        .await
        .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_workspace(workspace_id).await
    }

    async fn get_viewer_profile(
        &self,
        workspace_id: &str,
        user_email: &str,
        profile: &str,
    ) -> Result<Option<WorkspaceViewerProfile>, StoreError> {
        let email = normalize_email(user_email);
        let row = sqlx::query(
            r#"
            SELECT
                workspace_id, user_email, profile, created_at, updated_at,
                seed_source, view_json, revision
            FROM workspace_viewer_profiles
            WHERE workspace_id = ? AND user_email = ? AND profile = ?
            "#,
        )
        .bind(workspace_id)
        .bind(&email)
        .bind(profile)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        row.map(row_to_viewer_profile).transpose()
    }

    async fn upsert_viewer_profile(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        profile: &str,
        expected_revision: Option<u64>,
        seed_source: Option<&str>,
        view: SavedView,
    ) -> Result<Option<WorkspaceViewerProfile>, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let now = Utc::now().to_rfc3339();
        let view_json = serde_json::to_string(&view).map_err(map_saved_view_json_out)?;
        let result = if let Some(expected_revision) = expected_revision {
            let expected_revision = i64::try_from(expected_revision)
                .map_err(|_| StoreError::ViewerProfileRevisionOutOfRange(expected_revision))?;
            if expected_revision == i64::MAX {
                return Err(StoreError::ViewerProfileRevisionOutOfRange(
                    expected_revision as u64,
                ));
            }
            sqlx::query(
                r#"
                UPDATE workspace_viewer_profiles
                SET updated_at = ?,
                    seed_source = COALESCE(?, seed_source),
                    view_json = ?,
                    revision = revision + 1
                WHERE workspace_id = ? AND user_email = ? AND profile = ? AND revision = ?
                "#,
            )
            .bind(&now)
            .bind(seed_source)
            .bind(&view_json)
            .bind(workspace_id)
            .bind(&email)
            .bind(profile)
            .bind(expected_revision)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?
        } else {
            sqlx::query(
                r#"
                INSERT INTO workspace_viewer_profiles
                    (workspace_id, user_email, profile, created_at, updated_at,
                     seed_source, view_json, revision)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(workspace_id, user_email, profile) DO NOTHING
                "#,
            )
            .bind(workspace_id)
            .bind(&email)
            .bind(profile)
            .bind(&now)
            .bind(&now)
            .bind(seed_source)
            .bind(&view_json)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?
        };

        if result.rows_affected() == 0 {
            let actual = sqlx::query_scalar::<_, i64>(
                r#"
                SELECT revision
                FROM workspace_viewer_profiles
                WHERE workspace_id = ? AND user_email = ? AND profile = ?
                "#,
            )
            .bind(workspace_id)
            .bind(&email)
            .bind(profile)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?
            .map(|revision| {
                u64::try_from(revision).map_err(|_| {
                    StoreError::Backend(format!("viewer profile revision is negative: {revision}"))
                })
            })
            .transpose()?;
            return Err(StoreError::ViewerProfileConflict {
                expected: expected_revision,
                actual,
            });
        }

        self.get_viewer_profile(workspace_id, &email, profile).await
    }

    async fn record_workspace_open(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, StoreError> {
        let email = normalize_email(&principal.email);
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO user_workspace_state
                (user_email, workspace_id, created_at, updated_at, last_opened_at, pinned_at)
            VALUES (?, ?, ?, ?, ?, NULL)
            ON CONFLICT(user_email, workspace_id) DO UPDATE SET
                updated_at = excluded.updated_at,
                last_opened_at = excluded.last_opened_at
            "#,
        )
        .bind(&email)
        .bind(workspace_id)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(map_sql)?;

        self.get_user_workspace_state(workspace_id, &email).await
    }

    async fn set_workspace_pinned(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        pinned: bool,
    ) -> Result<WorkspaceUserState, StoreError> {
        let email = normalize_email(&principal.email);
        let now = Utc::now().to_rfc3339();
        if pinned {
            sqlx::query(
                r#"
                INSERT INTO user_workspace_state
                    (user_email, workspace_id, created_at, updated_at, last_opened_at, pinned_at)
                VALUES (?, ?, ?, ?, NULL, ?)
                ON CONFLICT(user_email, workspace_id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    pinned_at = excluded.pinned_at
                "#,
            )
            .bind(&email)
            .bind(workspace_id)
            .bind(&now)
            .bind(&now)
            .bind(&now)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?;
        } else {
            let mut tx = self.pool.begin().await.map_err(map_sql)?;
            sqlx::query(
                r#"
                UPDATE user_workspace_state
                SET pinned_at = NULL, updated_at = ?
                WHERE user_email = ? AND workspace_id = ?
                "#,
            )
            .bind(&now)
            .bind(&email)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
            sqlx::query(
                r#"
                DELETE FROM user_workspace_state
                WHERE
                    user_email = ?
                    AND workspace_id = ?
                    AND pinned_at IS NULL
                    AND last_opened_at IS NULL
                "#,
            )
            .bind(&email)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
            tx.commit().await.map_err(map_sql)?;
        }

        self.get_user_workspace_state(workspace_id, &email).await
    }

    async fn set_user_workspace_last_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        view: SavedView,
    ) -> Result<WorkspaceUserState, StoreError> {
        let email = normalize_email(&principal.email);
        let now = Utc::now().to_rfc3339();
        let view_json = serde_json::to_string(&view).map_err(map_saved_view_json_out)?;
        // Upsert ONLY this member's row, touching ONLY `last_view_json` (and
        // `updated_at`) on conflict. Crucially this never writes
        // `last_opened_at`/`pinned_at` for an existing row (so a remembered
        // view doesn't perturb recents/pins) and never touches the
        // `workspaces` table — `default_saved_view_id` is unrelated storage,
        // upholding the "recording a last view never changes the default"
        // invariant by construction.
        sqlx::query(
            r#"
            INSERT INTO user_workspace_state
                (user_email, workspace_id, created_at, updated_at, last_opened_at, pinned_at, last_view_json)
            VALUES (?, ?, ?, ?, NULL, NULL, ?)
            ON CONFLICT(user_email, workspace_id) DO UPDATE SET
                updated_at = excluded.updated_at,
                last_view_json = excluded.last_view_json
            "#,
        )
        .bind(&email)
        .bind(workspace_id)
        .bind(&now)
        .bind(&now)
        .bind(&view_json)
        .execute(&self.pool)
        .await
        .map_err(map_sql)?;

        self.get_user_workspace_state(workspace_id, &email).await
    }

    async fn get_user_workspace_state_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, StoreError> {
        let email = normalize_email(&principal.email);
        self.get_user_workspace_state(workspace_id, &email).await
    }
}

fn row_to_dataset_source(
    row: sqlx::sqlite::SqliteRow,
) -> Result<WorkspaceDatasetSource, StoreError> {
    let dataset_source_id: String = row.get("dataset_source_id");
    let canonical_url: String = row.get("canonical_url");
    let identity = SourceIdentity::from_persisted(&canonical_url, &dataset_source_id)
        .map_err(|error| StoreError::InvalidSourceIdentity(error.to_string()))?;
    let revision = row
        .get::<Option<String>, _>("source_revision")
        .map(|raw| {
            SourceRevision::from_hex(&raw).ok_or_else(|| {
                StoreError::InvalidSourceIdentity(format!(
                    "persisted source revision is not a 32-byte hex digest: {raw}"
                ))
            })
        })
        .transpose()?;
    Ok(WorkspaceDatasetSource {
        workspace_dataset_id: DatasetId(row.get::<String, _>("workspace_dataset_id")),
        identity,
        revision,
        display_name: row.get("display_name"),
    })
}

fn row_to_summary(row: sqlx::sqlite::SqliteRow) -> Result<WorkspaceSummary, StoreError> {
    let seq: i64 = row.get("seq");
    Ok(WorkspaceSummary {
        id: row.get("id"),
        name: row.get("name"),
        role: WorkspaceRole::try_from(row.get::<String, _>("role").as_str())?,
        created_by: row.get("created_by"),
        created_at: parse_dt(row.get("created_at"))?,
        updated_at: parse_dt(row.get("updated_at"))?,
        archived_at: parse_opt_dt(row.get("archived_at"))?,
        seq: seq.max(0) as u64,
        dataset_count: row.get("dataset_count"),
        default_saved_view_id: row.get("default_saved_view_id"),
        last_opened_at: parse_opt_dt(row.get("last_opened_at"))?,
        pinned_at: parse_opt_dt(row.get("pinned_at"))?,
    })
}

fn row_to_admin_summary(row: sqlx::sqlite::SqliteRow) -> Result<WorkspaceAdminSummary, StoreError> {
    let seq: i64 = row.get("seq");
    Ok(WorkspaceAdminSummary {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_at: parse_dt(row.get("created_at"))?,
        updated_at: parse_dt(row.get("updated_at"))?,
        archived_at: parse_opt_dt(row.get("archived_at"))?,
        seq: seq.max(0) as u64,
        dataset_count: row.get("dataset_count"),
        member_count: row.get("member_count"),
        owner_count: row.get("owner_count"),
        link_access: WorkspaceLinkAccess::try_from(row.get::<String, _>("link_access").as_str())?,
        link_role: WorkspaceRole::try_from(row.get::<String, _>("link_role").as_str())?,
        default_saved_view_id: row.get("default_saved_view_id"),
    })
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> Result<WorkspaceRecord, StoreError> {
    let seq: i64 = row.get("seq");
    let document_json: String = row.get("document_json");
    Ok(WorkspaceRecord {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_at: parse_dt(row.get("created_at"))?,
        updated_at: parse_dt(row.get("updated_at"))?,
        archived_at: parse_opt_dt(row.get("archived_at"))?,
        seq: seq.max(0) as u64,
        default_saved_view_id: row.get("default_saved_view_id"),
        document: parse_document(&document_json)?,
    })
}

fn row_to_member(row: sqlx::sqlite::SqliteRow) -> Result<WorkspaceMember, StoreError> {
    Ok(WorkspaceMember {
        email: row.get("email"),
        role: WorkspaceRole::try_from(row.get::<String, _>("role").as_str())?,
        display_name: row.get("display_name"),
        added_at: parse_dt(row.get("added_at"))?,
    })
}

fn row_to_saved_view(row: sqlx::sqlite::SqliteRow) -> Result<WorkspaceSavedView, StoreError> {
    let view_json: String = row.get("view_json");
    Ok(WorkspaceSavedView {
        id: row.get("id"),
        workspace_id: row.get("workspace_id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at: parse_dt(row.get("created_at"))?,
        updated_at: parse_dt(row.get("updated_at"))?,
        visibility: SavedViewVisibility::try_from(row.get::<String, _>("visibility").as_str())?,
        view: serde_json::from_str(&view_json).map_err(map_saved_view_json_in)?,
    })
}

fn row_to_viewer_profile(
    row: sqlx::sqlite::SqliteRow,
) -> Result<WorkspaceViewerProfile, StoreError> {
    let view_json: String = row.get("view_json");
    Ok(WorkspaceViewerProfile {
        workspace_id: row.get("workspace_id"),
        user_email: row.get("user_email"),
        profile: row.get("profile"),
        revision: u64::try_from(row.get::<i64, _>("revision"))
            .map_err(|_| StoreError::Backend("viewer profile revision is negative".to_string()))?,
        created_at: parse_dt(row.get("created_at"))?,
        updated_at: parse_dt(row.get("updated_at"))?,
        seed_source: row.get("seed_source"),
        view: serde_json::from_str(&view_json).map_err(map_saved_view_json_in)?,
    })
}

fn row_to_user_workspace_state(
    row: sqlx::sqlite::SqliteRow,
) -> Result<WorkspaceUserState, StoreError> {
    Ok(WorkspaceUserState {
        workspace_id: row.get("workspace_id"),
        last_opened_at: parse_opt_dt(row.get("last_opened_at"))?,
        pinned_at: parse_opt_dt(row.get("pinned_at"))?,
        last_view: parse_opt_saved_view(row.get("last_view_json")),
    })
}

/// Decode the persisted `last_view_json` (#700). `None` for the common
/// "never set" case (NULL/empty). A malformed payload (e.g. from a future
/// schema or a partial write) degrades to `None` rather than erroring the
/// whole user-state read — the member simply gets no restored view and
/// falls back to the default, never a broken workspace open.
fn parse_opt_saved_view(raw: Option<String>) -> Option<SavedView> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str(&raw) {
        Ok(view) => Some(view),
        Err(e) => {
            tracing::warn!("workspace.last_view_json_decode_failed: {e}");
            None
        }
    }
}
