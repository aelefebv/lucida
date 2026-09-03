//! PostgreSQL-backed [`WorkspaceStore`].
//!
//! Shares the PostgreSQL pool that [`crate::storage`] opened, as every
//! PostgreSQL store does.
//!
//! The statements come from [`super::sql`], which the SQLite store runs
//! too, so this module holds the binding, the row mapping, and nothing
//! else. Read it beside `sqlite`. Three things tell the two apart, and
//! only three:
//!
//! - **The pool and row types.** `PgPool` and `PgRow` where the other has
//!   `SqlitePool` and `SqliteRow`.
//! - **JSON columns.** The baseline gives four of this store's columns the
//!   `JSONB` type, and PostgreSQL refuses a bound Rust `String` for one
//!   outright. Every payload goes in as a [`sqlx::types::Json`] and comes
//!   back as a [`serde_json::Value`]. A `$n::jsonb` cast would have kept
//!   the `String` bind, but `::` is syntax SQLite rejects, so it would end
//!   the sharing for those statements.
//! - **The clock.** See [`now`].
//!
//! ADR-0058 records why the text is shared and the Rust is not.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, SubsecRound, Utc};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use sqlx::postgres::PgRow;
use sqlx::types::Json;
use sqlx::{PgPool, Postgres, Row};

use crate::workspace::types::{
    SavedViewVisibility, WorkspaceAdminDetails, WorkspaceAdminSummary, WorkspaceDatasetSource,
    WorkspaceLinkAccess, WorkspaceMember, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceSharingSettings, WorkspaceSummary, WorkspaceUserState, WorkspaceViewerProfile,
};

use super::{
    StoreError, WorkspaceStore, default_member_display_name, default_workspace_name, map_json_in,
    map_json_out, map_saved_view_json_in, map_saved_view_json_out, map_sql, normalize_email, sql,
};

/// The instant a write is stamped with.
///
/// Truncated to microseconds because that is `TIMESTAMPTZ`'s resolution:
/// a store method returns the record it just wrote without reading it
/// back, so the value it hands the caller has to be the value the next
/// read will find. `Utc::now()` carries nanoseconds, and the difference is
/// invisible until a caller compares what was returned against what comes
/// back — which the conformance suite does. Truncating rather than
/// rounding leaves a value PostgreSQL stores verbatim.
fn now() -> DateTime<Utc> {
    Utc::now().trunc_subsecs(6)
}

/// A document on its way into a `JSONB` column.
///
/// Serialized to a [`serde_json::Value`] first rather than encoded
/// straight from the struct, so a serialization failure is the same
/// [`StoreError`] the SQLite store reports for it.
fn document_payload(document: &DocumentState) -> Result<Json<serde_json::Value>, StoreError> {
    serde_json::to_value(document)
        .map(Json)
        .map_err(map_json_out)
}

/// The same for a saved view, which has its own error variant.
fn view_payload(view: &SavedView) -> Result<Json<serde_json::Value>, StoreError> {
    serde_json::to_value(view)
        .map(Json)
        .map_err(map_saved_view_json_out)
}

#[derive(Debug, Clone)]
pub struct PostgresWorkspaceStore {
    pool: PgPool,
}

impl PostgresWorkspaceStore {
    /// Build the store from an already-opened pool. The migrator does not
    /// run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    async fn workspace_exists(&self, workspace_id: &str) -> Result<bool, StoreError> {
        let row: Option<(String,)> = sqlx::query_as(sql::WORKSPACE_EXISTS)
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;
        Ok(row.is_some())
    }

    async fn workspace_exists_in_any_state(&self, workspace_id: &str) -> Result<bool, StoreError> {
        let row: Option<(String,)> = sqlx::query_as(sql::WORKSPACE_EXISTS_IN_ANY_STATE)
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;
        Ok(row.is_some())
    }

    async fn list_members(&self, workspace_id: &str) -> Result<Vec<WorkspaceMember>, StoreError> {
        let rows = sqlx::query(sql::LIST_MEMBERS)
            .bind(workspace_id)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?;

        rows.into_iter().map(row_to_member).collect()
    }

    async fn member(
        &self,
        workspace_id: &str,
        email: &str,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let row = sqlx::query(sql::MEMBER)
            .bind(workspace_id)
            .bind(normalize_email(email))
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;

        row.map(row_to_member).transpose()
    }

    async fn get_user_workspace_state(
        &self,
        workspace_id: &str,
        user_email: &str,
    ) -> Result<WorkspaceUserState, StoreError> {
        let row = sqlx::query(sql::USER_WORKSPACE_STATE)
            .bind(workspace_id)
            .bind(user_email)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;

        Ok(match row {
            Some(row) => row_to_user_workspace_state(row),
            None => WorkspaceUserState {
                workspace_id: workspace_id.to_string(),
                last_opened_at: None,
                pinned_at: None,
                last_view: None,
            },
        })
    }
}

async fn touch_workspace(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    workspace_id: &str,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    sqlx::query(sql::TOUCH_WORKSPACE)
        .bind(now)
        .bind(workspace_id)
        .execute(&mut **tx)
        .await
        .map_err(map_sql)?;
    Ok(())
}

/// Insert a brand-new, owner-only workspace row plus its owner membership
/// row inside `tx`. Shared by `create_workspace` and `duplicate_workspace`
/// so the "blank owned workspace" shape is defined in exactly one place.
///
/// `link_access` / `link_role` are deliberately NOT bound: the
/// `workspaces` columns take their table defaults ('restricted' /
/// 'viewer'), i.e. link access OFF. A duplicate therefore never inherits
/// the source's sharing, and a freshly created workspace starts private —
/// the security-critical invariant. Keeping the INSERT in one place
/// hardens that link-off guarantee against future drift.
async fn insert_blank_owned_workspace(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    id: &str,
    owner_email: &str,
    owner_display_name: &str,
    name: &str,
    document: Json<serde_json::Value>,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    sqlx::query(sql::INSERT_WORKSPACE)
        .bind(id)
        .bind(name)
        .bind(owner_email)
        .bind(now)
        .bind(now)
        .bind(document)
        .execute(&mut **tx)
        .await
        .map_err(map_sql)?;

    sqlx::query(sql::INSERT_OWNER_MEMBER)
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
impl WorkspaceStore for PostgresWorkspaceStore {
    async fn create_workspace(
        &self,
        owner: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now();
        let owner_email = normalize_email(&owner.email);
        let name = default_workspace_name(name);
        let document = DocumentState::default();
        let payload = document_payload(&document)?;

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        insert_blank_owned_workspace(
            &mut tx,
            &id,
            &owner_email,
            &owner.display_name,
            &name,
            payload,
            now,
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
        let now = now();
        let owner_email = normalize_email(&owner.email);
        let name = default_workspace_name(Some(name));

        let mut tx = self.pool.begin().await.map_err(map_sql)?;

        // Read the source inside the tx so the copy is a consistent snapshot.
        let Some(source_row) = sqlx::query(sql::DUPLICATE_SOURCE_WORKSPACE)
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
        let dataset_rows = sqlx::query(sql::DUPLICATE_SOURCE_DATASETS)
            .bind(source_workspace_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(map_sql)?;

        let mut remap: HashMap<DatasetId, DatasetId> = HashMap::new();
        struct CopiedDataset {
            new_id: String,
            dataset_source_id: String,
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
                display_name: row.get("display_name"),
                sort_order: row.get("sort_order"),
            });
        }

        // --- Document: remap every dataset-id reference onto the copy's ids. ---
        let mut document: DocumentState =
            serde_json::from_value(source_row.get("document_json")).map_err(map_json_in)?;
        document.remap_dataset_ids(&remap);
        let document_payload = document_payload(&document)?;

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
            document_payload,
            now,
        )
        .await?;

        // Copied dataset memberships (same source + display name, fresh id).
        for ds in &copied_datasets {
            sqlx::query(sql::INSERT_WORKSPACE_DATASET)
                .bind(&ds.new_id)
                .bind(&new_id)
                .bind(&ds.dataset_source_id)
                .bind(&ds.display_name)
                .bind(&owner_email)
                .bind(now)
                .bind(ds.sort_order)
                .execute(&mut *tx)
                .await
                .map_err(map_sql)?;
        }

        // --- Shared saved views only, re-attributed to the duplicator and
        // kept Shared. Personal/Proposed views (anyone's) are NOT copied. The
        // active/default-view pointer is remapped to the copied view. ---
        let source_view_rows = sqlx::query(sql::DUPLICATE_SOURCE_SHARED_VIEWS)
            .bind(source_workspace_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(map_sql)?;

        let source_default_view_id: Option<String> = source_row.get("default_saved_view_id");
        let mut new_default_view_id: Option<String> = None;
        for row in &source_view_rows {
            let old_view_id: String = row.get("id");
            let view_name: String = row.get("name");
            let mut view: SavedView =
                serde_json::from_value(row.get("view_json")).map_err(map_saved_view_json_in)?;
            view.remap_dataset_ids(&remap);
            // Copy-point defense: the manager's create/update paths run
            // `workspace_saved_view_payload` (which clears `datasets`), but a
            // row inserted by another path — or persisted before that strip
            // existed — may still carry source URLs. The copy must be clean
            // regardless of the source row's state, so clear them here too
            // (decision 0014). `remap_dataset_ids` intentionally leaves
            // URL-keyed `datasets` alone; this is the explicit strip.
            view.clear_source_urls();
            let remapped_view = view_payload(&view)?;
            let new_view_id = uuid::Uuid::new_v4().to_string();

            sqlx::query(sql::INSERT_COPIED_SAVED_VIEW)
                .bind(&new_view_id)
                .bind(&new_id)
                .bind(&view_name)
                .bind(&owner_email)
                .bind(&owner.display_name)
                .bind(now)
                .bind(now)
                .bind(remapped_view)
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
            sqlx::query(sql::SET_DEFAULT_SAVED_VIEW_ON_COPY)
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
            sqlx::query(sql::LIST_WORKSPACES_AS_ADMIN)
                .bind(&email)
                .fetch_all(&self.pool)
                .await
                .map_err(map_sql)?
        } else {
            sqlx::query(sql::LIST_WORKSPACES)
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
            sqlx::query(sql::LIST_ARCHIVED_WORKSPACES_AS_ADMIN)
                .bind(&email)
                .fetch_all(&self.pool)
                .await
                .map_err(map_sql)?
        } else {
            sqlx::query(sql::LIST_ARCHIVED_WORKSPACES)
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

        let mut builder =
            sql::admin_search_query::<Postgres>(trimmed_query, include_archived, limit);
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
        let row = sqlx::query(sql::ADMIN_WORKSPACE_DETAILS)
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
        let row = sqlx::query(sql::GET_WORKSPACE)
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
            if self.workspace_exists(workspace_id).await? {
                return Ok(Some(WorkspaceRole::Owner));
            }
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let row = sqlx::query(sql::ROLE_FOR)
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
            if self.workspace_exists_in_any_state(workspace_id).await? {
                return Ok(Some(WorkspaceRole::Owner));
            }
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let row = sqlx::query(sql::MEMBER_ROLE)
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
            if self.workspace_exists_in_any_state(workspace_id).await? {
                return Ok(Some(WorkspaceRole::Owner));
            }
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let row = sqlx::query(sql::MEMBER_ROLE)
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
        let now = now();
        let result = sqlx::query(sql::RENAME_WORKSPACE)
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
        let now = now();
        let result = sqlx::query(sql::ARCHIVE_WORKSPACE)
            .bind(now)
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

    async fn restore_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let now = now();
        let result = sqlx::query(sql::RESTORE_WORKSPACE)
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
        let payload = document_payload(document)?;
        let now = now();
        sqlx::query(sql::PERSIST_DOCUMENT)
            .bind(seq as i64)
            .bind(payload)
            .bind(now)
            .bind(workspace_id)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn persist_dataset_opened(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        dataset_source_id: &str,
        canonical_url: &str,
        display_name: &str,
        added_by: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError> {
        let now = now();
        let payload = document_payload(document)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(sql::UPSERT_DATASET_SOURCE)
            .bind(dataset_source_id)
            .bind(canonical_url)
            .bind(display_name)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        sqlx::query(sql::INSERT_WORKSPACE_DATASET_AT_END)
            .bind(workspace_dataset_id.as_ref())
            .bind(workspace_id)
            .bind(dataset_source_id)
            .bind(display_name)
            .bind(normalize_email(added_by))
            .bind(now)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        sqlx::query(sql::PERSIST_DOCUMENT)
            .bind(seq as i64)
            .bind(payload)
            .bind(now)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

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
        let now = now();
        let payload = document_payload(document)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(sql::DELETE_WORKSPACE_DATASET)
            .bind(workspace_id)
            .bind(workspace_dataset_id.as_ref())
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        sqlx::query(sql::PERSIST_DOCUMENT)
            .bind(seq as i64)
            .bind(payload)
            .bind(now)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
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
        let now = now();
        let payload = document_payload(document)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(sql::RENAME_WORKSPACE_DATASET)
            .bind(display_name)
            .bind(workspace_id)
            .bind(workspace_dataset_id.as_ref())
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        sqlx::query(sql::PERSIST_DOCUMENT)
            .bind(seq as i64)
            .bind(payload)
            .bind(now)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        tx.commit().await.map_err(map_sql)?;
        Ok(())
    }

    async fn list_dataset_sources(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceDatasetSource>, StoreError> {
        let rows = sqlx::query(sql::LIST_DATASET_SOURCES)
            .bind(workspace_id)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?;

        Ok(rows.into_iter().map(row_to_dataset_source).collect())
    }

    async fn dataset_by_source(
        &self,
        workspace_id: &str,
        dataset_source_id: &str,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError> {
        let row = sqlx::query(sql::DATASET_BY_SOURCE)
            .bind(workspace_id)
            .bind(dataset_source_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;

        Ok(row.map(row_to_dataset_source))
    }

    async fn dataset_by_workspace_dataset(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError> {
        let row = sqlx::query(sql::DATASET_BY_WORKSPACE_DATASET)
            .bind(workspace_id)
            .bind(workspace_dataset_id.as_ref())
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;

        Ok(row.map(row_to_dataset_source))
    }

    async fn sharing_settings(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceSharingSettings>, StoreError> {
        let row = sqlx::query(sql::SHARING_SETTINGS)
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

        let now = now();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(sql::UPSERT_MEMBER)
            .bind(workspace_id)
            .bind(&email)
            .bind(role.as_str())
            .bind(display_name)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        touch_workspace(&mut tx, workspace_id, now).await?;
        tx.commit().await.map_err(map_sql)?;

        self.member(workspace_id, &email).await
    }

    async fn admin_upsert_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: &str,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        if !self.workspace_exists_in_any_state(workspace_id).await? {
            return Ok(None);
        }

        let email = normalize_email(email);
        let display_name = default_member_display_name(&email, display_name);
        let now = now();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(sql::UPSERT_OWNER_MEMBER)
            .bind(workspace_id)
            .bind(&email)
            .bind(display_name)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        touch_workspace(&mut tx, workspace_id, now).await?;
        tx.commit().await.map_err(map_sql)?;

        self.member(workspace_id, &email).await
    }

    async fn update_member_role(
        &self,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let email = normalize_email(email);
        let now = now();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(sql::UPDATE_MEMBER_ROLE)
            .bind(role.as_str())
            .bind(workspace_id)
            .bind(&email)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        }

        touch_workspace(&mut tx, workspace_id, now).await?;
        tx.commit().await.map_err(map_sql)?;

        self.member(workspace_id, &email).await
    }

    async fn remove_member(&self, workspace_id: &str, email: &str) -> Result<bool, StoreError> {
        let email = normalize_email(email);
        let now = now();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(sql::DELETE_MEMBER)
            .bind(workspace_id)
            .bind(&email)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(false);
        }

        touch_workspace(&mut tx, workspace_id, now).await?;
        tx.commit().await.map_err(map_sql)?;
        Ok(true)
    }

    async fn update_link_access(
        &self,
        workspace_id: &str,
        link_access: WorkspaceLinkAccess,
        link_role: WorkspaceRole,
    ) -> Result<Option<WorkspaceSharingSettings>, StoreError> {
        let now = now();
        let result = sqlx::query(sql::UPDATE_LINK_ACCESS)
            .bind(link_access.as_str())
            .bind(link_role.as_str())
            .bind(now)
            .bind(workspace_id)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            return Ok(None);
        }

        self.sharing_settings(workspace_id).await
    }

    async fn list_saved_views(
        &self,
        workspace_id: &str,
        viewer_email: &str,
        viewer_can_edit: bool,
    ) -> Result<Vec<WorkspaceSavedView>, StoreError> {
        let rows = sqlx::query(sql::LIST_SAVED_VIEWS)
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
        let row = sqlx::query(sql::GET_SAVED_VIEW)
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
        let now = now();
        let payload = view_payload(&view)?;
        let created_by_email = normalize_email(&created_by.email);

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(sql::INSERT_SAVED_VIEW)
            .bind(&id)
            .bind(workspace_id)
            .bind(name)
            .bind(&created_by_email)
            .bind(&created_by.display_name)
            .bind(now)
            .bind(now)
            .bind(visibility.as_str())
            .bind(payload)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        touch_workspace(&mut tx, workspace_id, now).await?;
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

        let now = now();
        // An absent payload reaches `COALESCE` as a NULL of the column's
        // own type, so the column keeps what it had.
        let payload = view.as_ref().map(view_payload).transpose()?;

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(sql::UPDATE_SAVED_VIEW)
            .bind(name)
            .bind(payload)
            .bind(now)
            .bind(workspace_id)
            .bind(saved_view_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        }

        touch_workspace(&mut tx, workspace_id, now).await?;
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

        let now = now();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(sql::DELETE_SAVED_VIEW)
            .bind(workspace_id)
            .bind(saved_view_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(false);
        }

        touch_workspace(&mut tx, workspace_id, now).await?;
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

        let now = now();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(sql::SET_SAVED_VIEW_VISIBILITY)
            .bind(visibility.as_str())
            .bind(now)
            .bind(workspace_id)
            .bind(saved_view_id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
            return Ok(None);
        }

        touch_workspace(&mut tx, workspace_id, now).await?;
        tx.commit().await.map_err(map_sql)?;
        self.get_saved_view(workspace_id, saved_view_id).await
    }

    async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: Option<&str>,
    ) -> Result<Option<WorkspaceRecord>, StoreError> {
        let now = now();
        let result = sqlx::query(sql::SET_DEFAULT_SAVED_VIEW)
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
        let row = sqlx::query(sql::GET_VIEWER_PROFILE)
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
        seed_source: Option<&str>,
        view: SavedView,
    ) -> Result<Option<WorkspaceViewerProfile>, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let now = now();
        let payload = view_payload(&view)?;
        sqlx::query(sql::UPSERT_VIEWER_PROFILE)
            .bind(workspace_id)
            .bind(&email)
            .bind(profile)
            .bind(now)
            .bind(now)
            .bind(seed_source)
            .bind(payload)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?;

        self.get_viewer_profile(workspace_id, &email, profile).await
    }

    async fn record_workspace_open(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, StoreError> {
        let email = normalize_email(&principal.email);
        let now = now();
        sqlx::query(sql::RECORD_WORKSPACE_OPEN)
            .bind(&email)
            .bind(workspace_id)
            .bind(now)
            .bind(now)
            .bind(now)
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
        let now = now();
        if pinned {
            sqlx::query(sql::PIN_WORKSPACE)
                .bind(&email)
                .bind(workspace_id)
                .bind(now)
                .bind(now)
                .bind(now)
                .execute(&self.pool)
                .await
                .map_err(map_sql)?;
        } else {
            let mut tx = self.pool.begin().await.map_err(map_sql)?;
            sqlx::query(sql::UNPIN_WORKSPACE)
                .bind(now)
                .bind(&email)
                .bind(workspace_id)
                .execute(&mut *tx)
                .await
                .map_err(map_sql)?;
            sqlx::query(sql::DELETE_EMPTY_USER_WORKSPACE_STATE)
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
        let now = now();
        let payload = view_payload(&view)?;
        sqlx::query(sql::SET_USER_LAST_VIEW)
            .bind(&email)
            .bind(workspace_id)
            .bind(now)
            .bind(now)
            .bind(payload)
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

fn row_to_dataset_source(row: PgRow) -> WorkspaceDatasetSource {
    WorkspaceDatasetSource {
        workspace_dataset_id: DatasetId(row.get::<String, _>("workspace_dataset_id")),
        dataset_source_id: row.get("dataset_source_id"),
        canonical_url: row.get("canonical_url"),
        display_name: row.get("display_name"),
    }
}

fn row_to_summary(row: PgRow) -> Result<WorkspaceSummary, StoreError> {
    let seq: i64 = row.get("seq");
    Ok(WorkspaceSummary {
        id: row.get("id"),
        name: row.get("name"),
        role: WorkspaceRole::try_from(row.get::<String, _>("role").as_str())?,
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        archived_at: row.get("archived_at"),
        seq: seq.max(0) as u64,
        dataset_count: row.get("dataset_count"),
        default_saved_view_id: row.get("default_saved_view_id"),
        last_opened_at: row.get("last_opened_at"),
        pinned_at: row.get("pinned_at"),
    })
}

fn row_to_admin_summary(row: PgRow) -> Result<WorkspaceAdminSummary, StoreError> {
    let seq: i64 = row.get("seq");
    Ok(WorkspaceAdminSummary {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        archived_at: row.get("archived_at"),
        seq: seq.max(0) as u64,
        dataset_count: row.get("dataset_count"),
        member_count: row.get("member_count"),
        owner_count: row.get("owner_count"),
        link_access: WorkspaceLinkAccess::try_from(row.get::<String, _>("link_access").as_str())?,
        link_role: WorkspaceRole::try_from(row.get::<String, _>("link_role").as_str())?,
        default_saved_view_id: row.get("default_saved_view_id"),
    })
}

fn row_to_record(row: PgRow) -> Result<WorkspaceRecord, StoreError> {
    let seq: i64 = row.get("seq");
    Ok(WorkspaceRecord {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        archived_at: row.get("archived_at"),
        seq: seq.max(0) as u64,
        default_saved_view_id: row.get("default_saved_view_id"),
        document: serde_json::from_value(row.get("document_json")).map_err(map_json_in)?,
    })
}

fn row_to_member(row: PgRow) -> Result<WorkspaceMember, StoreError> {
    Ok(WorkspaceMember {
        email: row.get("email"),
        role: WorkspaceRole::try_from(row.get::<String, _>("role").as_str())?,
        display_name: row.get("display_name"),
        added_at: row.get("added_at"),
    })
}

fn row_to_saved_view(row: PgRow) -> Result<WorkspaceSavedView, StoreError> {
    Ok(WorkspaceSavedView {
        id: row.get("id"),
        workspace_id: row.get("workspace_id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        visibility: SavedViewVisibility::try_from(row.get::<String, _>("visibility").as_str())?,
        view: serde_json::from_value(row.get("view_json")).map_err(map_saved_view_json_in)?,
    })
}

fn row_to_viewer_profile(row: PgRow) -> Result<WorkspaceViewerProfile, StoreError> {
    Ok(WorkspaceViewerProfile {
        workspace_id: row.get("workspace_id"),
        user_email: row.get("user_email"),
        profile: row.get("profile"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        seed_source: row.get("seed_source"),
        view: serde_json::from_value(row.get("view_json")).map_err(map_saved_view_json_in)?,
    })
}

fn row_to_user_workspace_state(row: PgRow) -> WorkspaceUserState {
    WorkspaceUserState {
        workspace_id: row.get("workspace_id"),
        last_opened_at: row.get("last_opened_at"),
        pinned_at: row.get("pinned_at"),
        last_view: parse_opt_saved_view(row.get("last_view_json")),
    }
}

/// Decode the persisted `last_view_json` (#700). `None` for the common
/// "never set" case. A malformed payload (e.g. from a future schema)
/// degrades to `None` rather than erroring the whole user-state read — the
/// member simply gets no restored view and falls back to the default,
/// never a broken workspace open.
fn parse_opt_saved_view(raw: Option<serde_json::Value>) -> Option<SavedView> {
    let raw = raw?;
    match serde_json::from_value(raw) {
        Ok(view) => Some(view),
        Err(e) => {
            tracing::warn!("workspace.last_view_json_decode_failed: {e}");
            None
        }
    }
}
