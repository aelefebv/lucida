//! Workspace store, live workspace registry, and REST/WebSocket routes.
//!
//! A workspace is the durable collaboration/document boundary. The
//! `WorkspaceManager` owns authorization, lazy live-session restore, and
//! persistence around shared document commands; handlers should not
//! reach into the SQLite store or live session map directly.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::http::header::LOCATION;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, patch, post};
use axum::{Extension, Router};
use chrono::{DateTime, Utc};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::ServerMessage;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, Sqlite, SqlitePool};
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};

use crate::auth::AdminRequired;
use crate::handler;
use crate::session::Session;
use crate::{BroadcastItem, ProxyConfig, UnicastRoutes};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceRole {
    Viewer,
    Editor,
    Owner,
}

impl WorkspaceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Owner => "owner",
        }
    }

    pub fn can_edit(self) -> bool {
        matches!(self, Self::Editor | Self::Owner)
    }

    pub fn can_own(self) -> bool {
        matches!(self, Self::Owner)
    }
}

impl TryFrom<&str> for WorkspaceRole {
    type Error = StoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "viewer" => Ok(Self::Viewer),
            "editor" => Ok(Self::Editor),
            "owner" => Ok(Self::Owner),
            other => Err(StoreError::InvalidRole(other.to_string())),
        }
    }
}

/// Visibility of a workspace saved view.
///
/// `Shared` views are part of the workspace's collaborative surface (the
/// historical behavior); `Personal` views belong to exactly one member —
/// keyed on the normalized `AuthPrincipal.email` in `created_by` — and are
/// never disclosed to anyone else, not even owners. `Proposed` views (#702)
/// are a viewer's bid to share: like a `Personal` view they belong to exactly
/// one member and are hidden from other plain viewers, but they are *also*
/// surfaced to editors as a review queue — an editor can approve (→ `Shared`)
/// or reject (→ back to the proposer's `Personal`). Persisted as TEXT
/// (`"shared"` / `"personal"` / `"proposed"`) and serialized into the
/// REST/JSON response so the client can tell the layers apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedViewVisibility {
    #[default]
    Shared,
    Personal,
    Proposed,
}

impl SavedViewVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Personal => "personal",
            Self::Proposed => "proposed",
        }
    }
}

impl TryFrom<&str> for SavedViewVisibility {
    type Error = StoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "shared" => Ok(Self::Shared),
            "personal" => Ok(Self::Personal),
            "proposed" => Ok(Self::Proposed),
            other => Err(StoreError::InvalidSavedViewVisibility(other.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLinkAccess {
    Restricted,
    AnyoneWithLink,
}

impl WorkspaceLinkAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restricted => "restricted",
            Self::AnyoneWithLink => "anyone_with_link",
        }
    }
}

impl TryFrom<&str> for WorkspaceLinkAccess {
    type Error = StoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "restricted" => Ok(Self::Restricted),
            "anyone_with_link" => Ok(Self::AnyoneWithLink),
            other => Err(StoreError::InvalidLinkAccess(other.to_string())),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub role: WorkspaceRole,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
    pub seq: u64,
    pub dataset_count: i64,
    pub default_saved_view_id: Option<String>,
    pub last_opened_at: Option<DateTime<Utc>>,
    pub pinned_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
    pub seq: u64,
    pub default_saved_view_id: Option<String>,
    pub document: DocumentState,
}

#[derive(Debug, Clone)]
pub struct WorkspaceDatasetSource {
    pub workspace_dataset_id: DatasetId,
    pub dataset_source_id: String,
    pub canonical_url: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceMember {
    pub email: String,
    pub role: WorkspaceRole,
    pub display_name: String,
    pub added_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSharingSettings {
    pub link_access: WorkspaceLinkAccess,
    pub link_role: WorkspaceRole,
    pub members: Vec<WorkspaceMember>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSavedView {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub visibility: SavedViewVisibility,
    pub view: SavedView,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceViewerProfile {
    pub workspace_id: String,
    pub user_email: String,
    pub profile: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub seed_source: Option<String>,
    pub view: SavedView,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceUserState {
    pub workspace_id: String,
    pub last_opened_at: Option<DateTime<Utc>>,
    pub pinned_at: Option<DateTime<Utc>>,
    /// The caller's own last-open view in this workspace (#700), restored on
    /// a bare `/w/:id` open behind a user toggle. `None` until the member
    /// records one. Per-user isolated (keyed on the member's email alongside
    /// the rest of this row) and never another user's. Recording it never
    /// mutates the shared `workspaces.default_saved_view_id`.
    pub last_view: Option<SavedView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceAdminSummary {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
    pub seq: u64,
    pub dataset_count: i64,
    pub member_count: i64,
    pub owner_count: i64,
    pub link_access: WorkspaceLinkAccess,
    pub link_role: WorkspaceRole,
    pub default_saved_view_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceAdminDetails {
    pub workspace: WorkspaceAdminSummary,
    pub members: Vec<WorkspaceMember>,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
    #[error("workspace document json failed to parse: {0}")]
    InvalidDocument(String),
    #[error("workspace saved-view json failed to parse: {0}")]
    InvalidSavedView(String),
    #[error("workspace role is invalid: {0}")]
    InvalidRole(String),
    #[error("workspace link access is invalid: {0}")]
    InvalidLinkAccess(String),
    #[error("workspace saved-view visibility is invalid: {0}")]
    InvalidSavedViewVisibility(String),
}

fn map_sql(e: sqlx::Error) -> StoreError {
    StoreError::Backend(e.to_string())
}

fn map_json_in(e: serde_json::Error) -> StoreError {
    StoreError::InvalidDocument(e.to_string())
}

fn map_json_out(e: serde_json::Error) -> StoreError {
    StoreError::Backend(format!("document_json serialize: {e}"))
}

fn map_saved_view_json_in(e: serde_json::Error) -> StoreError {
    StoreError::InvalidSavedView(e.to_string())
}

fn map_saved_view_json_out(e: serde_json::Error) -> StoreError {
    StoreError::Backend(format!("view_json serialize: {e}"))
}

fn parse_dt(raw: String) -> Result<DateTime<Utc>, StoreError> {
    DateTime::parse_from_rfc3339(&raw)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| StoreError::Backend(format!("timestamp parse: {e}")))
}

fn parse_opt_dt(raw: Option<String>) -> Result<Option<DateTime<Utc>>, StoreError> {
    raw.map(parse_dt).transpose()
}

fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

fn default_workspace_name(name: Option<&str>) -> String {
    let trimmed = name.unwrap_or("Untitled workspace").trim();
    if trimmed.is_empty() {
        "Untitled workspace".to_string()
    } else {
        trimmed.chars().take(200).collect()
    }
}

fn default_member_display_name(email: &str, display_name: &str) -> String {
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        email.to_string()
    } else {
        trimmed.chars().take(200).collect()
    }
}

const MAX_SAVED_VIEW_NAME_CHARS: usize = 200;
const MAX_VIEWER_PROFILE_NAME_CHARS: usize = 64;
const MAX_DATASET_NAME_CHARS: usize = 200;

#[async_trait]
pub trait WorkspaceStore: Send + Sync + 'static {
    async fn create_workspace(
        &self,
        owner: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, StoreError>;

    async fn list_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, StoreError>;

    async fn list_archived_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, StoreError>;

    async fn admin_search_workspaces(
        &self,
        query: Option<&str>,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkspaceAdminSummary>, StoreError>;

    async fn admin_workspace_details(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceAdminDetails>, StoreError>;

    async fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRecord>, StoreError>;

    async fn role_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError>;

    async fn owner_role_for_any_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError>;

    /// The caller's explicit member role regardless of archive state.
    ///
    /// Unlike `role_for`, this ignores `archived_at` and does NOT consider
    /// anyone-with-link: it answers only "is this principal a real member of
    /// this workspace (active or archived)?" It exists so the workspace-open
    /// path can decide whether an *archived* workspace should surface its
    /// archived state (to a member) or stay indistinguishable from a missing
    /// workspace (to a non-member) — see `get_workspace_for`.
    async fn member_role_for_any_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError>;

    async fn rename_workspace(
        &self,
        workspace_id: &str,
        name: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError>;

    async fn archive_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError>;

    async fn restore_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError>;

    async fn persist_document(
        &self,
        workspace_id: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError>;

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
    ) -> Result<(), StoreError>;

    async fn persist_dataset_removed(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError>;

    /// Persist a dataset rename: update the `workspace_datasets.display_name`
    /// row for `workspace_dataset_id` and the workspace `document_json` (which
    /// carries the renamed manifest) in one transaction. Keeps the
    /// server-private DB name in sync with the document so restored bindings
    /// and listings agree after reopen.
    async fn persist_dataset_renamed(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
        display_name: &str,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), StoreError>;

    async fn list_dataset_sources(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceDatasetSource>, StoreError>;

    async fn dataset_by_source(
        &self,
        workspace_id: &str,
        dataset_source_id: &str,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError>;

    async fn dataset_by_workspace_dataset(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError>;

    async fn sharing_settings(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceSharingSettings>, StoreError>;

    async fn upsert_member(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: &str,
        role: WorkspaceRole,
    ) -> Result<Option<WorkspaceMember>, StoreError>;

    async fn admin_upsert_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: &str,
    ) -> Result<Option<WorkspaceMember>, StoreError>;

    async fn update_member_role(
        &self,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<Option<WorkspaceMember>, StoreError>;

    async fn remove_member(&self, workspace_id: &str, email: &str) -> Result<bool, StoreError>;

    async fn update_link_access(
        &self,
        workspace_id: &str,
        link_access: WorkspaceLinkAccess,
        link_role: WorkspaceRole,
    ) -> Result<Option<WorkspaceSharingSettings>, StoreError>;

    /// Saved views visible to `viewer_email`: every `Shared` view, plus the
    /// caller's own `Personal`/`Proposed` views, plus — when `viewer_can_edit`
    /// is true — *every* `Proposed` view in the workspace (the editor review
    /// queue, #702). No other member's `Personal` view, and no other member's
    /// `Proposed` view unless the caller can edit, ever crosses the store
    /// boundary. The whole predicate is resolved in SQL (one round-trip, no
    /// fetch-all-then-filter); `viewer_email` must already be normalized.
    async fn list_saved_views(
        &self,
        workspace_id: &str,
        viewer_email: &str,
        viewer_can_edit: bool,
    ) -> Result<Vec<WorkspaceSavedView>, StoreError>;

    async fn get_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
    ) -> Result<Option<WorkspaceSavedView>, StoreError>;

    async fn create_saved_view(
        &self,
        workspace_id: &str,
        name: &str,
        created_by: &AuthPrincipal,
        view: SavedView,
        visibility: SavedViewVisibility,
    ) -> Result<Option<WorkspaceSavedView>, StoreError>;

    async fn update_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
        name: Option<&str>,
        view: Option<SavedView>,
    ) -> Result<Option<WorkspaceSavedView>, StoreError>;

    async fn delete_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
    ) -> Result<bool, StoreError>;

    async fn set_saved_view_visibility(
        &self,
        workspace_id: &str,
        saved_view_id: &str,
        visibility: SavedViewVisibility,
    ) -> Result<Option<WorkspaceSavedView>, StoreError>;

    async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: Option<&str>,
    ) -> Result<Option<WorkspaceRecord>, StoreError>;

    async fn get_viewer_profile(
        &self,
        workspace_id: &str,
        user_email: &str,
        profile: &str,
    ) -> Result<Option<WorkspaceViewerProfile>, StoreError>;

    async fn upsert_viewer_profile(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        profile: &str,
        seed_source: Option<&str>,
        view: SavedView,
    ) -> Result<Option<WorkspaceViewerProfile>, StoreError>;

    async fn record_workspace_open(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, StoreError>;

    async fn set_workspace_pinned(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        pinned: bool,
    ) -> Result<WorkspaceUserState, StoreError>;

    /// Upsert the caller's own last-open view (#700) for
    /// `(workspace_id, principal.email)`, returning their refreshed state
    /// (which includes `last_view`). Mirrors `upsert_viewer_profile`: writes
    /// only this user's row and ONLY the `last_view_json` column — it must
    /// never touch `workspaces.default_saved_view_id`.
    async fn set_user_workspace_last_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        view: SavedView,
    ) -> Result<WorkspaceUserState, StoreError>;

    /// Read the caller's own workspace state including `last_view`.
    /// Per-user isolated (keyed on `principal.email`); never returns another
    /// member's state, and yields `last_view = None` when unset.
    async fn get_user_workspace_state_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, StoreError>;
}

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

    async fn member(
        &self,
        workspace_id: &str,
        email: &str,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT email, role, display_name, added_at
            FROM workspace_members
            WHERE workspace_id = ? AND email = ?
            "#,
        )
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
        let document_json = serde_json::to_string(&document).map_err(map_json_out)?;

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(
            r#"
            INSERT INTO workspaces
                (id, name, created_by, created_at, updated_at, seq, document_json)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            "#,
        )
        .bind(&id)
        .bind(&name)
        .bind(&owner_email)
        .bind(&now_s)
        .bind(&now_s)
        .bind(&document_json)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES (?, ?, 'owner', ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&owner_email)
        .bind(&owner.display_name)
        .bind(&now_s)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

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
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET archived_at = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            "#,
        )
        .bind(&now)
        .bind(&now)
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
        let document_json = serde_json::to_string(document).map_err(map_json_out)?;
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(seq as i64)
        .bind(document_json)
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
        let now = Utc::now().to_rfc3339();
        let document_json = serde_json::to_string(document).map_err(map_json_out)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(
            r#"
            INSERT INTO dataset_sources (id, canonical_url, default_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                canonical_url = excluded.canonical_url,
                default_name = excluded.default_name,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(dataset_source_id)
        .bind(canonical_url)
        .bind(display_name)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        sqlx::query(
            r#"
            INSERT INTO workspace_datasets
                (id, workspace_id, dataset_source_id, display_name, added_by, added_at, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, (
                SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM workspace_datasets
                WHERE workspace_id = ?
            ))
            ON CONFLICT(workspace_id, dataset_source_id) DO NOTHING
            "#,
        )
        .bind(workspace_dataset_id.as_ref())
        .bind(workspace_id)
        .bind(dataset_source_id)
        .bind(display_name)
        .bind(normalize_email(added_by))
        .bind(&now)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(seq as i64)
        .bind(document_json)
        .bind(&now)
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
        let now = Utc::now().to_rfc3339();
        let document_json = serde_json::to_string(document).map_err(map_json_out)?;
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query("DELETE FROM workspace_datasets WHERE workspace_id = ? AND id = ?")
            .bind(workspace_id)
            .bind(workspace_dataset_id.as_ref())
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(seq as i64)
        .bind(document_json)
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
        let now = Utc::now().to_rfc3339();
        let document_json = serde_json::to_string(document).map_err(map_json_out)?;
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
        sqlx::query(
            r#"
            UPDATE workspaces
            SET seq = ?, document_json = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(seq as i64)
        .bind(document_json)
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
        let rows = sqlx::query(
            r#"
            SELECT
                wd.id AS workspace_dataset_id,
                wd.dataset_source_id,
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

        Ok(rows.into_iter().map(row_to_dataset_source).collect())
    }

    async fn dataset_by_source(
        &self,
        workspace_id: &str,
        dataset_source_id: &str,
    ) -> Result<Option<WorkspaceDatasetSource>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT
                wd.id AS workspace_dataset_id,
                wd.dataset_source_id,
                ds.canonical_url,
                wd.display_name
            FROM workspace_datasets wd
            INNER JOIN dataset_sources ds ON ds.id = wd.dataset_source_id
            WHERE wd.workspace_id = ? AND wd.dataset_source_id = ?
            "#,
        )
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
        let row = sqlx::query(
            r#"
            SELECT
                wd.id AS workspace_dataset_id,
                wd.dataset_source_id,
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

        Ok(row.map(row_to_dataset_source))
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
        sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, email) DO UPDATE SET
                role = excluded.role,
                display_name = excluded.display_name
            "#,
        )
        .bind(workspace_id)
        .bind(&email)
        .bind(role.as_str())
        .bind(display_name)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;

        self.member(workspace_id, &email).await
    }

    async fn admin_upsert_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: &str,
    ) -> Result<Option<WorkspaceMember>, StoreError> {
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM workspaces WHERE id = ?")
            .bind(workspace_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_sql)?;
        if exists.is_none() {
            return Ok(None);
        }

        let email = normalize_email(email);
        let display_name = default_member_display_name(&email, display_name);
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(
            r#"
            INSERT INTO workspace_members
                (workspace_id, email, role, display_name, added_at)
            VALUES (?, ?, 'owner', ?, ?)
            ON CONFLICT(workspace_id, email) DO UPDATE SET
                role = 'owner',
                display_name = excluded.display_name
            "#,
        )
        .bind(workspace_id)
        .bind(&email)
        .bind(display_name)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        touch_workspace(&mut tx, workspace_id, &now).await?;
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
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result = sqlx::query(
            r#"
            UPDATE workspace_members
            SET role = ?
            WHERE workspace_id = ? AND email = ?
            "#,
        )
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

        touch_workspace(&mut tx, workspace_id, &now).await?;
        tx.commit().await.map_err(map_sql)?;

        self.member(workspace_id, &email).await
    }

    async fn remove_member(&self, workspace_id: &str, email: &str) -> Result<bool, StoreError> {
        let email = normalize_email(email);
        let now = Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let result =
            sqlx::query("DELETE FROM workspace_members WHERE workspace_id = ? AND email = ?")
                .bind(workspace_id)
                .bind(&email)
                .execute(&mut *tx)
                .await
                .map_err(map_sql)?;

        if result.rows_affected() == 0 {
            tx.rollback().await.map_err(map_sql)?;
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
        let result = sqlx::query(
            r#"
            UPDATE workspaces
            SET link_access = ?, link_role = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            "#,
        )
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
                seed_source, view_json
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
        seed_source: Option<&str>,
        view: SavedView,
    ) -> Result<Option<WorkspaceViewerProfile>, StoreError> {
        if !self.workspace_exists(workspace_id).await? {
            return Ok(None);
        }

        let email = normalize_email(&principal.email);
        let now = Utc::now().to_rfc3339();
        let view_json = serde_json::to_string(&view).map_err(map_saved_view_json_out)?;
        sqlx::query(
            r#"
            INSERT INTO workspace_viewer_profiles
                (workspace_id, user_email, profile, created_at, updated_at, seed_source, view_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, user_email, profile) DO UPDATE SET
                updated_at = excluded.updated_at,
                seed_source = COALESCE(excluded.seed_source, workspace_viewer_profiles.seed_source),
                view_json = excluded.view_json
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
        .map_err(map_sql)?;

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

fn row_to_dataset_source(row: sqlx::sqlite::SqliteRow) -> WorkspaceDatasetSource {
    WorkspaceDatasetSource {
        workspace_dataset_id: DatasetId(row.get::<String, _>("workspace_dataset_id")),
        dataset_source_id: row.get("dataset_source_id"),
        canonical_url: row.get("canonical_url"),
        display_name: row.get("display_name"),
    }
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
        document: serde_json::from_str(&document_json).map_err(map_json_in)?,
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

pub struct LiveWorkspace {
    pub workspace_id: String,
    pub session: Arc<Mutex<Session>>,
    pub tx: broadcast::Sender<BroadcastItem>,
    pub unicast_routes: UnicastRoutes,
    next_id: AtomicU64,
    empty_since: Mutex<Option<Instant>>,
    background_cancelled: AtomicBool,
}

impl LiveWorkspace {
    fn new(workspace_id: String, session: Session) -> Self {
        let (tx, _) = broadcast::channel::<BroadcastItem>(256);
        Self {
            workspace_id,
            session: Arc::new(Mutex::new(session)),
            tx,
            unicast_routes: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            empty_since: Mutex::new(Some(Instant::now())),
            background_cancelled: AtomicBool::new(false),
        }
    }

    pub fn next_client_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn cancel_background(&self) -> bool {
        !self.background_cancelled.swap(true, Ordering::SeqCst)
    }

    pub fn background_cancelled(&self) -> bool {
        self.background_cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceRuntimeConfig {
    pub idle_ttl: Duration,
    pub idle_sweep_interval: Duration,
}

impl Default for WorkspaceRuntimeConfig {
    fn default() -> Self {
        Self {
            idle_ttl: Duration::from_secs(60 * 60),
            idle_sweep_interval: Duration::from_secs(60),
        }
    }
}

pub struct WorkspaceManager {
    store: Arc<dyn WorkspaceStore>,
    live: Mutex<HashMap<String, Arc<LiveWorkspace>>>,
    proxy_config: ProxyConfig,
    runtime_config: WorkspaceRuntimeConfig,
}

impl WorkspaceManager {
    pub fn new(store: Arc<dyn WorkspaceStore>, proxy_config: ProxyConfig) -> Self {
        Self::new_with_runtime_config(store, proxy_config, WorkspaceRuntimeConfig::default())
    }

    pub fn new_with_runtime_config(
        store: Arc<dyn WorkspaceStore>,
        proxy_config: ProxyConfig,
        runtime_config: WorkspaceRuntimeConfig,
    ) -> Self {
        Self {
            store,
            live: Mutex::new(HashMap::new()),
            proxy_config,
            runtime_config,
        }
    }

    pub fn store(&self) -> Arc<dyn WorkspaceStore> {
        Arc::clone(&self.store)
    }

    pub fn proxy_config(&self) -> ProxyConfig {
        self.proxy_config.clone()
    }

    pub fn runtime_config(&self) -> WorkspaceRuntimeConfig {
        self.runtime_config
    }

    pub fn spawn_idle_eviction_loop(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let interval = manager
                .runtime_config
                .idle_sweep_interval
                .max(Duration::from_secs(1));
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                let evicted = manager.evict_idle_workspaces().await;
                if evicted > 0 {
                    tracing::info!(evicted, "workspace.live_idle_sweep_evicted");
                }
            }
        })
    }

    pub async fn live_workspace_count(&self) -> usize {
        self.live.lock().await.len()
    }

    pub async fn evict_idle_workspaces(&self) -> usize {
        let ttl = self.runtime_config.idle_ttl;
        let candidates: Vec<_> = self.live.lock().await.values().cloned().collect();
        let mut evicted = 0usize;

        for live in candidates {
            let client_count = live.session.lock().await.clients.len();
            if client_count > 0 {
                *live.empty_since.lock().await = None;
                tracing::debug!(
                    workspace_id = %live.workspace_id,
                    client_count,
                    "workspace.live_eviction_skipped_active"
                );
                continue;
            }

            let idle_for = {
                let mut empty_since = live.empty_since.lock().await;
                let since = empty_since.get_or_insert_with(Instant::now);
                since.elapsed()
            };
            if idle_for < ttl {
                tracing::debug!(
                    workspace_id = %live.workspace_id,
                    idle_for_ms = idle_for.as_millis() as u64,
                    idle_ttl_ms = ttl.as_millis() as u64,
                    "workspace.live_eviction_skipped_ttl"
                );
                continue;
            }

            let removed = {
                let mut live_map = self.live.lock().await;
                match live_map.get(&live.workspace_id) {
                    Some(current) if Arc::ptr_eq(current, &live) => {
                        live_map.remove(&live.workspace_id)
                    }
                    _ => None,
                }
            };

            let Some(removed) = removed else {
                continue;
            };
            self.shutdown_live_workspace_background(&removed, "idle_eviction")
                .await;
            tracing::info!(
                workspace_id = %removed.workspace_id,
                idle_for_ms = idle_for.as_millis() as u64,
                "workspace.live_evicted"
            );
            evicted += 1;
        }

        evicted
    }

    pub async fn list_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, WorkspaceError> {
        self.store
            .list_workspaces(principal)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn list_archived_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, WorkspaceError> {
        self.store
            .list_archived_workspaces(principal)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn admin_search_workspaces(
        &self,
        query: Option<&str>,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkspaceAdminSummary>, WorkspaceError> {
        self.store
            .admin_search_workspaces(query, include_archived, limit)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn admin_workspace_details(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, WorkspaceError> {
        self.store
            .admin_workspace_details(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn create_workspace(
        &self,
        principal: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        self.store
            .create_workspace(principal, name)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn get_workspace_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        // NEVER-LEAK (workspace-open path). This path is reachable by *anyone*
        // who is handed a `/w/<id>` deep-link (annotation share-by-link), so a
        // caller with no access must not be able to tell "exists but denied"
        // from "does not exist": both collapse to NotFound (404), byte-identical
        // to a missing row. This mirrors the saved-views never-leak discipline
        // (see `get_saved_view`). The role check therefore comes FIRST, and a
        // missing role yields NotFound, not Forbidden.
        //
        // Archived is surfaced (Gone/410) only to a real member — the one party
        // that already knows the workspace exists; to a non-member an archived
        // workspace is also indistinguishable from a missing one (NotFound).
        // The anyone-with-link grant is honored by `role_for` (active rows
        // only), so a valid link still resolves to a role → 200.
        let record = self
            .store
            .get_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        if record.archived_at.is_some() {
            // `role_for` excludes archived rows, so distinguish member from
            // non-member with an archive-state-agnostic membership lookup.
            return if self
                .store
                .member_role_for_any_state(workspace_id, principal)
                .await
                .map_err(WorkspaceError::Store)?
                .is_some()
            {
                Err(WorkspaceError::Archived)
            } else {
                Err(WorkspaceError::NotFound)
            };
        }
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        Ok((record, role))
    }

    pub async fn open_workspace_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole, WorkspaceUserState), WorkspaceError> {
        let (record, role) = self.get_workspace_for(workspace_id, principal).await?;
        let user_state = self
            .store
            .record_workspace_open(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?;
        Ok((record, role, user_state))
    }

    pub async fn rename_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        name: &str,
    ) -> Result<WorkspaceRecord, WorkspaceError> {
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        if !role.can_own() {
            return Err(WorkspaceError::Forbidden);
        }
        self.store
            .rename_workspace(workspace_id, name)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn archive_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self.require_owner(workspace_id, principal).await?;
        let record = self
            .store
            .archive_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.notify_workspace_archived(workspace_id).await;
        Ok((record, role))
    }

    pub async fn restore_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self
            .require_owner_any_state(workspace_id, principal)
            .await?;
        let record = self
            .store
            .restore_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        Ok((record, role))
    }

    pub async fn admin_archive_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, WorkspaceError> {
        self.store
            .archive_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.notify_workspace_archived(workspace_id).await;
        self.admin_workspace_details(workspace_id).await
    }

    pub async fn admin_restore_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, WorkspaceError> {
        self.store
            .restore_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        self.admin_workspace_details(workspace_id).await
    }

    pub async fn sharing_settings(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceSharingSettings, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        self.store
            .sharing_settings(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn upsert_member(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        email: &str,
        display_name: Option<&str>,
        role: WorkspaceRole,
    ) -> Result<WorkspaceMember, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        let email = normalize_request_email(email)?;
        let settings = self.current_sharing_settings(workspace_id).await?;
        ensure_owner_retained(&settings, &email, Some(role))?;
        self.store
            .upsert_member(workspace_id, &email, display_name.unwrap_or(""), role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn admin_upsert_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: Option<&str>,
    ) -> Result<WorkspaceMember, WorkspaceError> {
        let email = normalize_request_email(email)?;
        self.store
            .admin_upsert_owner(workspace_id, &email, display_name.unwrap_or(""))
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn update_member_role(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<WorkspaceMember, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        let email = normalize_request_email(email)?;
        let settings = self.current_sharing_settings(workspace_id).await?;
        ensure_owner_retained(&settings, &email, Some(role))?;
        self.store
            .update_member_role(workspace_id, &email, role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn remove_member(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        email: &str,
    ) -> Result<(), WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        let email = normalize_request_email(email)?;
        let settings = self.current_sharing_settings(workspace_id).await?;
        ensure_owner_retained(&settings, &email, None)?;
        let removed = self
            .store
            .remove_member(workspace_id, &email)
            .await
            .map_err(WorkspaceError::Store)?;
        if removed {
            Ok(())
        } else {
            Err(WorkspaceError::NotFound)
        }
    }

    pub async fn update_link_access(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        link_access: WorkspaceLinkAccess,
        link_role: WorkspaceRole,
    ) -> Result<WorkspaceSharingSettings, WorkspaceError> {
        self.require_owner(workspace_id, principal).await?;
        if link_role.can_own() {
            return Err(WorkspaceError::BadRequest(
                "link role cannot be owner".to_string(),
            ));
        }
        self.store
            .update_link_access(workspace_id, link_access, link_role)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn list_saved_views(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSavedView>, WorkspaceError> {
        // Members only — a non-member is denied by the viewer gate before any
        // row is read. The shared-∪-own-(personal|proposed) filter is then
        // applied in SQL, scoped to this caller's normalized email; editors
        // additionally get every proposed view in the workspace (the #702
        // review queue), so the caller's edit-ness is pushed into the query.
        let role = self.require_viewer(workspace_id, principal).await?;
        self.store
            .list_saved_views(
                workspace_id,
                &normalize_email(&principal.email),
                role.can_edit(),
            )
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn get_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        let role = self.require_viewer(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        // Never-leak boundary: a personal view — and a pending proposed view —
        // is disclosed by the role-blind gate only to its creator; any other
        // caller gets NotFound, identical to a missing row, so existence is
        // never confirmed.
        //
        // The one role-dependent exception (#702): an *editor* reviewing the
        // workspace may read ANY pending proposal. It is layered here, not in
        // the pure gate, so the never-leak default stays deny-by-construction.
        // A rejected proposal becomes `Personal`, at which point this exception
        // no longer applies and the editor loses visibility unless it is their
        // own — exactly the personal-view boundary.
        match ensure_saved_view_readable(&saved_view, principal) {
            Ok(()) => Ok(saved_view),
            Err(err) => {
                if saved_view.visibility == SavedViewVisibility::Proposed && role.can_edit() {
                    Ok(saved_view)
                } else {
                    Err(err)
                }
            }
        }
    }

    pub async fn create_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        name: &str,
        view: SavedView,
        visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        // Personal views are private and never mutate shared state, so any
        // member (viewer+) may save one. A Proposed view is a viewer's *bid* to
        // share: it likewise touches no shared state until an editor approves
        // it, so a plain viewer may create one too (#702). Only directly
        // creating a Shared view remains editor-gated.
        match visibility {
            SavedViewVisibility::Personal | SavedViewVisibility::Proposed => {
                self.require_viewer(workspace_id, principal).await?;
            }
            SavedViewVisibility::Shared => {
                self.require_editor(workspace_id, principal).await?;
            }
        }
        let name = normalize_saved_view_name(name)?;
        let view = workspace_saved_view_payload(view);
        self.store
            .create_saved_view(workspace_id, &name, principal, view, visibility)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn update_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
        name: Option<&str>,
        view: Option<SavedView>,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        // Mirror create/get: ownership of a personal view (or editor on a
        // shared view) is enforced before any mutation. A non-creator of a
        // personal view — including editors, owners, and admins — gets
        // NotFound and never confirms the row exists.
        self.ensure_saved_view_mutable(workspace_id, principal, saved_view_id)
            .await?;
        if name.is_none() && view.is_none() {
            return Err(WorkspaceError::BadRequest(
                "saved view patch is empty".to_string(),
            ));
        }
        let name = name.map(normalize_saved_view_name).transpose()?;
        let view = view.map(workspace_saved_view_payload);
        self.store
            .update_saved_view(workspace_id, saved_view_id, name.as_deref(), view)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn delete_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<(), WorkspaceError> {
        // Same ownership gate as update: a personal view can be deleted only by
        // its creator; a shared view requires editor. Everyone else gets
        // NotFound.
        self.ensure_saved_view_mutable(workspace_id, principal, saved_view_id)
            .await?;
        let deleted = self
            .store
            .delete_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?;
        if deleted {
            Ok(())
        } else {
            Err(WorkspaceError::NotFound)
        }
    }

    /// Promote/demote a saved view between `Personal` and `Shared`.
    ///
    /// Authorization is entirely delegated to `ensure_saved_view_rescopable`
    /// (the single re-scope gate); this method only persists the new
    /// visibility once the gate has returned the visible view. `created_by` is
    /// never written here, so attribution is preserved across the change.
    pub async fn set_saved_view_visibility(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
        visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.ensure_saved_view_rescopable(workspace_id, principal, saved_view_id, visibility)
            .await?;
        self.store
            .set_saved_view_visibility(workspace_id, saved_view_id, visibility)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    /// Approve a viewer's proposed saved view (#702): it becomes `Shared`.
    ///
    /// This is **editor authority over another member's proposal**, which is
    /// fundamentally different from the creator-only re-scope path
    /// (`set_saved_view_visibility` / `ensure_saved_view_rescopable`): the
    /// approving editor is, by design, *not* the author. So it does NOT route
    /// through that creator-only gate. Instead `require_editor` is the single
    /// authority check — a viewer cannot approve (`Forbidden`).
    ///
    /// `created_by` is never written, so the proposer stays the author once the
    /// view goes shared (attribution is preserved). The view MUST currently be
    /// `Proposed`: approving an already-shared (or anyone's personal) view is a
    /// `BadRequest`, not a silent no-op — except that another member's personal
    /// view stays `NotFound` even to an editor, preserving the never-leak rule.
    ///
    /// **Self-approve guard (#817):** a proposer cannot be their own reviewer.
    /// The whole point of the review queue is that a *second* party signs off, so
    /// even an editor/owner who created the proposal may not approve it — that
    /// would reach `Proposed->Shared` with no reviewer, the exact transition the
    /// `/visibility` allow-list (`ensure_saved_view_rescopable`) forbids for the
    /// creator. The guard is placed here (the approve path), *after* the shared
    /// review gate, so (a) the readability/role checks in
    /// `ensure_proposal_reviewable` still run first — a stranger keeps getting
    /// `Forbidden`/`NotFound` and never learns the view exists — and (b) it does
    /// NOT apply to `reject_saved_view`: a creator self-rejecting is just
    /// withdrawing their own proposal (Proposed->Personal), which is already
    /// legal via `/visibility`. A sole editor wanting to share their own view
    /// uses the legal `Personal->Shared` re-scope directly; the queue is for a
    /// *different* editor. The denial is `Forbidden` (an authorization act on the
    /// view, like the creator-only re-scope gate), not `BadRequest` (a state
    /// error).
    pub async fn approve_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        let saved_view = self
            .ensure_proposal_reviewable(workspace_id, principal, saved_view_id)
            .await?;
        // Creator != reviewer: a proposer cannot self-approve. Reached only after
        // the shared gate has confirmed the caller may see and review the view,
        // so never-leak ordering is intact; scoped to approve so reject/withdraw
        // by the creator stays legal.
        if saved_view.created_by == normalize_email(&principal.email) {
            return Err(WorkspaceError::Forbidden);
        }
        self.store
            .set_saved_view_visibility(workspace_id, saved_view_id, SavedViewVisibility::Shared)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    /// Reject a viewer's proposed saved view (#702): it reverts to the
    /// proposer's own `Personal` view — non-destructive, the saved camera and
    /// attribution are untouched, the proposer simply keeps it privately.
    ///
    /// Same authority as `approve_saved_view`: `require_editor` (a viewer
    /// cannot reject), editor-over-another-member's-proposal, NOT the
    /// creator-only re-scope gate. The view MUST currently be `Proposed`
    /// (`BadRequest` otherwise; never-leak preserved for others' personal).
    pub async fn reject_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.ensure_proposal_reviewable(workspace_id, principal, saved_view_id)
            .await?;
        self.store
            .set_saved_view_visibility(workspace_id, saved_view_id, SavedViewVisibility::Personal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    /// The shared authority gate for the two editor review actions
    /// (`approve` / `reject`), kept distinct from the creator-only re-scope
    /// gate because the authority is genuinely different: here the reviewer is
    /// an editor acting on *someone else's* proposal.
    ///
    /// Order, and why:
    /// 1. `require_editor` — a viewer (or non-member) cannot review at all
    ///    (`Forbidden`); this is the entire authority for the action.
    /// 2. fetch — a missing id is `NotFound`.
    /// 3. never-leak guard — a `Personal` view that is not the editor's own is
    ///    still `NotFound`, exactly as the read gate would say, so reviewing a
    ///    proposal can never be used to probe for another member's hidden
    ///    personal views.
    /// 4. **must be `Proposed`** — any other (readable) state is a `BadRequest`;
    ///    approve/reject only ever act on a pending proposal.
    ///
    /// Returns the confirmed-`Proposed` view so callers can persist without
    /// re-fetching.
    async fn ensure_proposal_reviewable(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_editor(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        // Never-leak: another member's personal view is invisible even to an
        // editor, so reviewing cannot confirm it exists.
        if saved_view.visibility == SavedViewVisibility::Personal
            && saved_view.created_by != normalize_email(&principal.email)
        {
            return Err(WorkspaceError::NotFound);
        }
        if saved_view.visibility != SavedViewVisibility::Proposed {
            return Err(WorkspaceError::BadRequest(
                "saved view is not a pending proposal".to_string(),
            ));
        }
        Ok(saved_view)
    }

    /// The single mutation-authorization gate for saved views, mirroring the
    /// read path. Membership is required first (a non-member gets `Forbidden`
    /// before any row is read, exactly like `get_saved_view`); the row is then
    /// fetched and funnelled through `ensure_saved_view_readable`, so a
    /// personal view that is not the caller's own yields `NotFound` and is
    /// never confirmed to exist — for editors, owners, and admins alike. Only
    /// after the view is confirmed visible do `Shared` views additionally
    /// require editor, leaving today's shared-view behavior intact while
    /// letting a viewer mutate their own personal view (as `create` allows a
    /// viewer to make one). Routing both `update` and `delete` through here
    /// keeps the never-leak rule in one place.
    async fn ensure_saved_view_mutable(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        ensure_saved_view_readable(&saved_view, principal)?;
        if saved_view.visibility == SavedViewVisibility::Shared {
            self.require_editor(workspace_id, principal).await?;
        }
        Ok(saved_view)
    }

    /// The single authorization gate for *changing a saved view's visibility*
    /// (re-scoping it between `Personal` and `Shared`), kept separate from the
    /// read gate (`get_saved_view`) and the content-mutation gate
    /// (`ensure_saved_view_mutable`) because the authority is genuinely
    /// different: re-scoping is restricted to the **creator**, and *who else*
    /// is allowed depends on the *target* visibility.
    ///
    /// The check order — and the reasons — are:
    /// 1. `require_viewer` — a non-member is denied (`Forbidden`) before any
    ///    row is read, so membership is never disclosed by a re-scope attempt.
    /// 2. fetch + `ensure_saved_view_readable` — never-leak in one place: a
    ///    personal (or pending proposed) view the caller cannot see yields
    ///    `NotFound` (identical to a missing row), so even editors/owners/admins
    ///    never learn it exists.
    /// 3. **creator-only** — a shared view is readable by everyone, but only
    ///    the original creator may re-scope it; anyone else gets `Forbidden`.
    /// 4. **transition allow-list** — the source→target re-scope must be one of
    ///    the legal creator transitions (`saved_view_transition_allowed`); any
    ///    other pair is `BadRequest`. This is the structural gate (#817): it
    ///    rejects `Shared→Proposed` and, crucially, `Proposed→Shared` — the
    ///    self-approve bypass — so sharing a proposal stays exclusively the
    ///    editor review queue's job (`approve_saved_view`), never `/visibility`.
    ///    A same-state request is an idempotent no-op and falls through to a
    ///    (value-preserving) persist by the caller.
    /// 5. **target-visibility authority** — making a view `Shared` is a
    ///    shared-state mutation (exactly like creating a `Shared` view), so it
    ///    additionally requires editor; demoting back to `Personal`, or
    ///    proposing, needs no editor (the creator is acting on their own view).
    ///    Checked last so an illegal transition is `BadRequest` regardless of
    ///    the caller's role — the deny is by construction, not role-dependent.
    ///
    /// Returns the (now-confirmed-visible) view so callers can persist without
    /// re-fetching. The #702 review actions (`approve_saved_view` /
    /// `reject_saved_view`, the Proposed→Shared / Proposed→Personal review
    /// queue) deliberately do NOT route through this creator-only gate: their
    /// authority is an *editor acting on another member's* proposal, so they use
    /// `ensure_proposal_reviewable` instead — keeping the review queue the only
    /// path that shares a proposal.
    async fn ensure_saved_view_rescopable(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: &str,
        target_visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let saved_view = self
            .store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        // Never-leak: a personal view the caller didn't create is NotFound.
        ensure_saved_view_readable(&saved_view, principal)?;
        // Creator-only: re-scoping is an authorship act, not a read or a
        // content edit. A non-creator (even of a shared view) cannot re-scope.
        if saved_view.created_by != normalize_email(&principal.email) {
            return Err(WorkspaceError::Forbidden);
        }
        // Transition allow-list: close the gate by construction. Anything not on
        // the creator allow-list — notably Shared→Proposed and the
        // Proposed→Shared self-approve bypass — is rejected here, before the
        // role check, so the deny is structural rather than role-dependent.
        if !saved_view_transition_allowed(saved_view.visibility, target_visibility) {
            return Err(WorkspaceError::BadRequest(format!(
                "cannot change saved view visibility from {} to {}",
                saved_view.visibility.as_str(),
                target_visibility.as_str()
            )));
        }
        // Target-visibility authority: promoting to Shared mutates shared
        // state, so it needs editor; demoting to Personal does not.
        if target_visibility == SavedViewVisibility::Shared {
            self.require_editor(workspace_id, principal).await?;
        }
        Ok(saved_view)
    }

    pub async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: Option<&str>,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self.require_editor(workspace_id, principal).await?;
        if let Some(saved_view_id) = saved_view_id {
            let saved_view = self
                .store
                .get_saved_view(workspace_id, saved_view_id)
                .await
                .map_err(WorkspaceError::Store)?
                .ok_or(WorkspaceError::NotFound)?;
            // A workspace-wide default must be shared: pointing it at a personal
            // view would surface that view to every member through the default,
            // breaking the never-leak invariant. Reject rather than leak.
            if saved_view.visibility != SavedViewVisibility::Shared {
                return Err(WorkspaceError::BadRequest(
                    "a personal saved view cannot be the workspace default".to_string(),
                ));
            }
        }
        self.store
            .set_default_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .map(|record| (record, role))
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn get_viewer_profile(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        profile: &str,
    ) -> Result<Option<WorkspaceViewerProfile>, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let profile = normalize_viewer_profile_name(profile)?;
        self.store
            .get_viewer_profile(workspace_id, &principal.email, &profile)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn upsert_viewer_profile(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        profile: &str,
        seed_source: Option<&str>,
        view: SavedView,
    ) -> Result<WorkspaceViewerProfile, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let profile = normalize_viewer_profile_name(profile)?;
        let view = workspace_saved_view_payload(view);
        self.store
            .upsert_viewer_profile(workspace_id, principal, &profile, seed_source, view)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn set_workspace_pinned(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        pinned: bool,
    ) -> Result<WorkspaceUserState, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        self.store
            .set_workspace_pinned(workspace_id, principal, pinned)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Record the caller's own last-open view (#700). Any member (viewer+)
    /// may remember their own view; the write is scoped to
    /// `(workspace_id, principal.email)` and stores ONLY the per-user
    /// `last_view` — it never mutates the shared `default_saved_view_id`.
    /// Source URLs are stripped (mirroring `upsert_viewer_profile`) since
    /// workspace views address datasets by workspace-local id.
    pub async fn set_user_workspace_last_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        view: SavedView,
    ) -> Result<WorkspaceUserState, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        let view = workspace_saved_view_payload(view);
        self.store
            .set_user_workspace_last_view(workspace_id, principal, view)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Read the caller's own workspace state including `last_view` (#700).
    /// `require_viewer` gates access; the store keys on `principal.email`, so
    /// the result is the caller's own row only — never another member's, and
    /// `last_view = None` when they've never recorded one.
    pub async fn get_user_workspace_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceUserState, WorkspaceError> {
        self.require_viewer(workspace_id, principal).await?;
        self.store
            .get_user_workspace_state_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn live_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Arc<LiveWorkspace>, WorkspaceError> {
        let (_record, _role) = self.get_workspace_for(workspace_id, principal).await?;

        if let Some(live) = self.live.lock().await.get(workspace_id).cloned() {
            tracing::debug!(workspace_id, "workspace.live_reused");
            return Ok(live);
        }

        let record = self
            .store
            .get_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        let mut session = Session::new();
        session.document = record.document;
        session.seq = record.seq;
        let live = Arc::new(LiveWorkspace::new(workspace_id.to_string(), session));
        let sources = self
            .store
            .list_dataset_sources(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?;
        tracing::info!(
            workspace_id,
            seq = record.seq,
            dataset_sources = sources.len(),
            "workspace.live_restore_started"
        );
        handler::restore_workspace_bindings(
            Arc::clone(&live.session),
            live.tx.clone(),
            sources,
            self.proxy_config.clone(),
        )
        .await;
        self.live
            .lock()
            .await
            .insert(workspace_id.to_string(), Arc::clone(&live));
        tracing::info!(workspace_id, "workspace.live_loaded");
        Ok(live)
    }

    pub async fn require_viewer(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        self.store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)
    }

    pub async fn require_editor(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        if role.can_edit() {
            Ok(role)
        } else {
            Err(WorkspaceError::Forbidden)
        }
    }

    pub async fn require_owner(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        if role.can_own() {
            Ok(role)
        } else {
            Err(WorkspaceError::Forbidden)
        }
    }

    pub async fn require_owner_any_state(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<WorkspaceRole, WorkspaceError> {
        self.store
            .owner_role_for_any_state(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)
    }

    async fn notify_workspace_archived(&self, workspace_id: &str) {
        let live = self.live.lock().await.remove(workspace_id);
        let Some(live) = live else {
            return;
        };
        let msg = ServerMessage::WorkspaceArchived {
            workspace_id: workspace_id.to_string(),
        };
        let _ = live.tx.send(BroadcastItem::WorkspaceArchived {
            json: serde_json::to_string(&msg).unwrap(),
        });
        self.shutdown_live_workspace_background(&live, "archive")
            .await;
        tracing::info!(workspace_id, "workspace.live_archived_cancelled");
    }

    async fn shutdown_live_workspace_background(&self, live: &LiveWorkspace, reason: &str) {
        let first_cancel = live.cancel_background();
        let services: Vec<_> = {
            let sess = live.session.lock().await;
            sess.server_bindings
                .values()
                .map(|binding| binding.generated_service.clone())
                .collect()
        };
        for service in &services {
            service.shutdown(reason).await;
        }
        tracing::info!(
            workspace_id = %live.workspace_id,
            reason,
            first_cancel,
            generated_services = services.len(),
            "workspace.live_background_cancelled"
        );
    }

    pub async fn persist_applied_command(
        &self,
        live: &LiveWorkspace,
        command: &DocumentCommand,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), WorkspaceError> {
        match command {
            DocumentCommand::RemoveDataset { id } => {
                self.store
                    .persist_dataset_removed(&live.workspace_id, id, seq, document)
                    .await
            }
            _ => {
                self.store
                    .persist_document(&live.workspace_id, seq, document)
                    .await
            }
        }
        .map_err(WorkspaceError::Store)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn persist_dataset_opened(
        &self,
        live: &LiveWorkspace,
        workspace_dataset_id: &DatasetId,
        dataset_source_id: &str,
        canonical_url: &str,
        display_name: &str,
        added_by: &AuthPrincipal,
        seq: u64,
        document: &DocumentState,
    ) -> Result<(), WorkspaceError> {
        self.store
            .persist_dataset_opened(
                &live.workspace_id,
                workspace_dataset_id,
                dataset_source_id,
                canonical_url,
                display_name,
                &added_by.email,
                seq,
                document,
            )
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn dataset_by_source(
        &self,
        workspace_id: &str,
        dataset_source_id: &str,
    ) -> Result<Option<WorkspaceDatasetSource>, WorkspaceError> {
        self.store
            .dataset_by_source(workspace_id, dataset_source_id)
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn dataset_by_workspace_dataset(
        &self,
        workspace_id: &str,
        workspace_dataset_id: &DatasetId,
    ) -> Result<Option<WorkspaceDatasetSource>, WorkspaceError> {
        self.store
            .dataset_by_workspace_dataset(workspace_id, workspace_dataset_id)
            .await
            .map_err(WorkspaceError::Store)
    }

    /// Rename a workspace dataset's display label, the right way: mutate the
    /// shared collaborative document so the change broadcasts to co-present
    /// peers and survives reopen, and keep the server-private DB
    /// `display_name` in sync so listings and restored bindings agree.
    ///
    /// The new name flows as a `DocumentCommand::RenameDataset`, returned to
    /// the caller (the WS handler) so it can broadcast + ack it on the live
    /// channel exactly like every other document command — that is what
    /// delivers it live to peers. Persistence is handled here:
    /// [`Store::persist_dataset_renamed`] writes both the `workspace_datasets`
    /// row and the full `document_json` in one transaction, so reopening the
    /// workspace (which loads `document_json` into `session.document`) shows
    /// the new name.
    ///
    /// Authority + safety, role-first to preserve never-leak:
    /// 1. `require_editor` — a viewer or non-member gets `Forbidden` before
    ///    any document/row is read (uniform with `open_remote_dataset` and the
    ///    other editor-gated mutations).
    /// 2. validation — empty/whitespace/over-long names are `BadRequest`.
    /// 3. the dataset must exist in the live document — a missing id is
    ///    `NotFound`, identical to a dataset that was never opened, so the
    ///    rename never confirms which ids exist.
    ///
    /// Returns the applied `(seq, command)` so the handler can broadcast.
    pub async fn rename_dataset(
        &self,
        live: &LiveWorkspace,
        principal: &AuthPrincipal,
        workspace_dataset_id: &DatasetId,
        name: &str,
    ) -> Result<(u64, DocumentCommand), WorkspaceError> {
        // 1. Authority first — never read the document for a non-editor.
        self.require_editor(&live.workspace_id, principal).await?;

        // 2. Validate before mutating anything.
        let name = normalize_dataset_name(name)?;

        let command = DocumentCommand::RenameDataset {
            id: workspace_dataset_id.clone(),
            name: name.clone(),
        };

        // 3. Apply to the live session, but only if the dataset actually
        //    exists in the document. A missing id is NotFound (never-leak),
        //    not a silent no-op that would still bump seq and persist.
        let (seq, document) = {
            let mut sess = live.session.lock().await;
            if !sess.document.manifests.contains_key(workspace_dataset_id) {
                return Err(WorkspaceError::NotFound);
            }
            let seq = sess.apply(command.clone());
            (seq, sess.document.clone())
        };

        // 4. Persist: workspace_datasets.display_name + document_json together.
        self.store
            .persist_dataset_renamed(
                &live.workspace_id,
                workspace_dataset_id,
                &name,
                seq,
                &document,
            )
            .await
            .map_err(WorkspaceError::Store)?;

        Ok((seq, command))
    }

    async fn current_sharing_settings(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceSharingSettings, WorkspaceError> {
        self.store
            .sharing_settings(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }
}

fn normalize_request_email(email: &str) -> Result<String, WorkspaceError> {
    let normalized = normalize_email(email);
    if normalized.is_empty() || !normalized.contains('@') {
        return Err(WorkspaceError::BadRequest(
            "member email is invalid".to_string(),
        ));
    }
    Ok(normalized)
}

/// The never-leak rule for non-shared views, in one place: a `Personal` view —
/// and a still-pending `Proposed` view — is readable here only by its creator
/// (matched on normalized email); everyone else is told `NotFound` so the
/// row's existence is never confirmed. `Shared` views are readable by any
/// viewer (membership is enforced upstream).
///
/// This gate is intentionally **role-blind**: the editor review exception for
/// `Proposed` views (an editor may read *any* member's pending proposal) is
/// genuinely role-dependent and is therefore layered at the manager
/// (`get_saved_view`, `list_saved_views`, `approve`/`reject`), not here.
/// Keeping the pure match creator-only means a refactor cannot accidentally
/// disclose another viewer's pending proposal: the default is always deny.
fn ensure_saved_view_readable(
    saved_view: &WorkspaceSavedView,
    principal: &AuthPrincipal,
) -> Result<(), WorkspaceError> {
    match saved_view.visibility {
        SavedViewVisibility::Shared => Ok(()),
        SavedViewVisibility::Personal | SavedViewVisibility::Proposed => {
            if saved_view.created_by == normalize_email(&principal.email) {
                Ok(())
            } else {
                Err(WorkspaceError::NotFound)
            }
        }
    }
}

/// The creator-driven `/visibility` transition allow-list — the *only* source→
/// target re-scopes the direct REST endpoint may perform, closed by
/// construction so an illegal transition is unreachable rather than merely
/// unsent by today's web UI.
///
/// Allowed (all by the creator; the `→Shared` editor authority is enforced
/// separately by the caller, not here):
/// - `Personal → Shared`  (creator shares; caller additionally requires editor)
/// - `Shared   → Personal` (creator makes their own shared view private again)
/// - `Personal → Proposed` (creator proposes their view for review)
/// - `Proposed → Personal` (creator withdraws their own pending proposal)
/// - a same-state request (`X → X`) — an idempotent no-op (`Ok`), so a benign
///   "set it to what it already is" never errors.
///
/// Everything else is `BadRequest`. In particular this is what closes the gate
/// on the two illegal direct transitions #817 calls out:
/// - `Shared   → Proposed` — a shared view cannot be demoted into the review
///   queue.
/// - `Proposed → Shared` — the self-approve bypass: a creator (even an editor)
///   cannot move their OWN proposal straight to shared and skip the editor
///   review queue. Sharing a proposal is exclusively `approve_saved_view`'s job
///   (editor authority over *another member's* bid), never `/visibility`.
fn saved_view_transition_allowed(source: SavedViewVisibility, target: SavedViewVisibility) -> bool {
    use SavedViewVisibility::{Personal, Proposed, Shared};
    // Same-state is always an idempotent no-op.
    if source == target {
        return true;
    }
    matches!(
        (source, target),
        (Personal, Shared) | (Shared, Personal) | (Personal, Proposed) | (Proposed, Personal)
    )
}

fn normalize_saved_view_name(raw: &str) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::BadRequest(
            "saved view name is empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_SAVED_VIEW_NAME_CHARS {
        return Err(WorkspaceError::BadRequest(format!(
            "saved view name exceeds {MAX_SAVED_VIEW_NAME_CHARS} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// Validate + canonicalize a dataset display name. Mirrors
/// [`normalize_saved_view_name`]: an empty/whitespace-only name is a
/// `BadRequest` (a blank layer label is meaningless), and an over-long name is
/// a `BadRequest`. The trimmed form is what gets stored, so leading/trailing
/// whitespace never lands in the document or the DB.
fn normalize_dataset_name(raw: &str) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::BadRequest(
            "dataset name is empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_DATASET_NAME_CHARS {
        return Err(WorkspaceError::BadRequest(format!(
            "dataset name exceeds {MAX_DATASET_NAME_CHARS} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn normalize_viewer_profile_name(raw: &str) -> Result<String, WorkspaceError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WorkspaceError::BadRequest(
            "viewer profile name is empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_VIEWER_PROFILE_NAME_CHARS {
        return Err(WorkspaceError::BadRequest(format!(
            "viewer profile name exceeds {MAX_VIEWER_PROFILE_NAME_CHARS} characters"
        )));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(WorkspaceError::BadRequest(
            "viewer profile may contain only letters, numbers, '-', '_', or '.'".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn workspace_saved_view_payload(mut view: SavedView) -> SavedView {
    // Workspace saved views refer to datasets by workspace-local ids in
    // dataset_order/dataset_settings/active_layouts. Source URLs belong
    // to workspace_datasets and must not be copied into the saved-view row.
    view.datasets.clear();
    view
}

fn ensure_owner_retained(
    settings: &WorkspaceSharingSettings,
    target_email: &str,
    next_role: Option<WorkspaceRole>,
) -> Result<(), WorkspaceError> {
    let Some(existing) = settings
        .members
        .iter()
        .find(|member| member.email == target_email)
    else {
        return Ok(());
    };
    if existing.role != WorkspaceRole::Owner {
        return Ok(());
    }

    let owners = settings
        .members
        .iter()
        .filter(|member| member.role == WorkspaceRole::Owner)
        .count();
    let remains_owner = next_role == Some(WorkspaceRole::Owner);
    if owners <= 1 && !remains_owner {
        return Err(WorkspaceError::BadRequest(
            "workspace must retain at least one owner".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace not found")]
    NotFound,
    #[error("workspace is archived")]
    Archived,
    #[error("forbidden")]
    Forbidden,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("{0}")]
    Store(StoreError),
}

impl WorkspaceError {
    pub fn into_response(self) -> Response {
        let (status, code, detail) = match self {
            WorkspaceError::NotFound => (StatusCode::NOT_FOUND, "not_found", None),
            WorkspaceError::Archived => (StatusCode::GONE, "workspace_archived", None),
            WorkspaceError::Forbidden => (StatusCode::FORBIDDEN, "forbidden", None),
            WorkspaceError::BadRequest(detail) => {
                (StatusCode::BAD_REQUEST, "bad_request", Some(detail))
            }
            WorkspaceError::Store(e) => {
                tracing::error!(error = %e, "workspaces.store_error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_store_error",
                    None,
                )
            }
        };
        let body = match detail {
            Some(detail) => json!({ "error": code, "detail": detail }),
            None => json!({ "error": code }),
        };
        (status, Json(body)).into_response()
    }
}

#[derive(Clone)]
pub struct WorkspacesState {
    pub manager: Arc<WorkspaceManager>,
}

pub fn router(manager: Arc<WorkspaceManager>) -> Router {
    Router::new()
        .route("/admin/workspaces", get(admin_search_workspaces))
        .route("/admin/workspaces/{workspace_id}", get(admin_get_workspace))
        .route(
            "/admin/workspaces/{workspace_id}/archive",
            post(admin_archive_workspace),
        )
        .route(
            "/admin/workspaces/{workspace_id}/restore",
            post(admin_restore_workspace),
        )
        .route(
            "/admin/workspaces/{workspace_id}/owners",
            post(admin_upsert_owner),
        )
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route("/api/workspaces/archived", get(list_archived_workspaces))
        .route(
            "/api/workspaces/{workspace_id}",
            get(get_workspace)
                .post(open_workspace)
                .patch(rename_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/sharing",
            get(get_sharing_settings).patch(update_link_access),
        )
        .route(
            "/api/workspaces/{workspace_id}/saved-views",
            get(list_workspace_saved_views).post(create_workspace_saved_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/saved-views/{saved_view_id}",
            get(get_workspace_saved_view)
                .patch(update_workspace_saved_view)
                .delete(delete_workspace_saved_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/saved-views/{saved_view_id}/visibility",
            patch(set_workspace_saved_view_visibility),
        )
        .route(
            "/api/workspaces/{workspace_id}/saved-views/{saved_view_id}/approve",
            post(approve_workspace_saved_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/saved-views/{saved_view_id}/reject",
            post(reject_workspace_saved_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/viewer-profiles/{profile}",
            get(get_workspace_viewer_profile).put(upsert_workspace_viewer_profile),
        )
        .route(
            "/api/workspaces/{workspace_id}/default-saved-view",
            patch(update_workspace_default_saved_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/pin",
            patch(update_workspace_pin),
        )
        .route(
            "/api/workspaces/{workspace_id}/last-view",
            patch(update_workspace_last_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/user-state",
            get(get_workspace_user_state),
        )
        .route(
            "/api/workspaces/{workspace_id}/archive",
            post(archive_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/restore",
            post(restore_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/members",
            post(upsert_member),
        )
        .route(
            "/api/workspaces/{workspace_id}/members/{email}",
            patch(update_member_role).delete(remove_member),
        )
        .route("/ws/workspaces/{workspace_id}", get(workspace_ws))
        .with_state(WorkspacesState { manager })
}

#[derive(Debug, Default, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenameWorkspaceRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpsertMemberRequest {
    pub email: String,
    pub role: WorkspaceRole,
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberRoleRequest {
    pub role: WorkspaceRole,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLinkAccessRequest {
    pub link_access: WorkspaceLinkAccess,
    pub link_role: WorkspaceRole,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceSavedViewRequest {
    pub name: String,
    pub view: SavedView,
    /// Defaults to `shared` so existing clients (which omit it) are unaffected.
    #[serde(default)]
    pub visibility: SavedViewVisibility,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceSavedViewRequest {
    pub name: Option<String>,
    pub view: Option<SavedView>,
}

#[derive(Debug, Deserialize)]
pub struct SetWorkspaceSavedViewVisibilityRequest {
    pub visibility: SavedViewVisibility,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceDefaultSavedViewRequest {
    pub saved_view_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertWorkspaceViewerProfileRequest {
    pub view: SavedView,
    #[serde(default)]
    pub seed_source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspacePinRequest {
    pub pinned: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceLastViewRequest {
    pub view: SavedView,
}

#[derive(Debug, Default, Deserialize)]
pub struct AdminWorkspaceSearchQuery {
    pub q: Option<String>,
    pub include_archived: Option<bool>,
    pub limit: Option<usize>,
}

impl AdminWorkspaceSearchQuery {
    fn query(&self) -> Option<&str> {
        self.q.as_deref().map(str::trim).filter(|q| !q.is_empty())
    }

    fn include_archived(&self) -> bool {
        self.include_archived.unwrap_or(false)
    }

    fn limit(&self) -> usize {
        self.limit.unwrap_or(25).clamp(1, 100)
    }
}

#[derive(Debug, Deserialize)]
pub struct AdminUpsertOwnerRequest {
    pub email: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceResponse {
    pub id: String,
    pub name: String,
    pub role: WorkspaceRole,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
    pub seq: u64,
    pub default_saved_view_id: Option<String>,
    pub last_opened_at: Option<DateTime<Utc>>,
    pub pinned_at: Option<DateTime<Utc>>,
}

impl WorkspaceResponse {
    fn from_record(record: WorkspaceRecord, role: WorkspaceRole) -> Self {
        Self::from_record_and_user_state(record, role, None)
    }

    fn from_record_and_user_state(
        record: WorkspaceRecord,
        role: WorkspaceRole,
        user_state: Option<WorkspaceUserState>,
    ) -> Self {
        Self {
            id: record.id,
            name: record.name,
            role,
            created_by: record.created_by,
            created_at: record.created_at,
            updated_at: record.updated_at,
            archived_at: record.archived_at,
            seq: record.seq,
            default_saved_view_id: record.default_saved_view_id,
            last_opened_at: user_state.as_ref().and_then(|state| state.last_opened_at),
            pinned_at: user_state.as_ref().and_then(|state| state.pinned_at),
        }
    }
}

async fn admin_search_workspaces(
    _admin: AdminRequired,
    State(state): State<WorkspacesState>,
    Query(query): Query<AdminWorkspaceSearchQuery>,
) -> Response {
    match state
        .manager
        .admin_search_workspaces(query.query(), query.include_archived(), query.limit())
        .await
    {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn admin_get_workspace(
    _admin: AdminRequired,
    State(state): State<WorkspacesState>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state.manager.admin_workspace_details(&workspace_id).await {
        Ok(details) => (StatusCode::OK, Json(details)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn admin_archive_workspace(
    _admin: AdminRequired,
    State(state): State<WorkspacesState>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state.manager.admin_archive_workspace(&workspace_id).await {
        Ok(details) => (StatusCode::OK, Json(details)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn admin_restore_workspace(
    _admin: AdminRequired,
    State(state): State<WorkspacesState>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state.manager.admin_restore_workspace(&workspace_id).await {
        Ok(details) => (StatusCode::OK, Json(details)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn admin_upsert_owner(
    _admin: AdminRequired,
    State(state): State<WorkspacesState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<AdminUpsertOwnerRequest>,
) -> Response {
    match state
        .manager
        .admin_upsert_owner(&workspace_id, &body.email, body.display_name.as_deref())
        .await
    {
        Ok(member) => (StatusCode::OK, Json(member)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn list_workspaces(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    match state.manager.list_workspaces(&principal).await {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn list_archived_workspaces(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    match state.manager.list_archived_workspaces(&principal).await {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn create_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    body: Option<Json<CreateWorkspaceRequest>>,
) -> Response {
    let name = body.as_ref().and_then(|Json(body)| body.name.as_deref());
    match state.manager.create_workspace(&principal, name).await {
        Ok(record) => (
            StatusCode::CREATED,
            Json(WorkspaceResponse::from_record(record, WorkspaceRole::Owner)),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn get_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .get_workspace_for(&workspace_id, &principal)
        .await
    {
        Ok((record, role)) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record(record, role)),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn open_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .open_workspace_for(&workspace_id, &principal)
        .await
    {
        Ok((record, role, user_state)) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record_and_user_state(
                record,
                role,
                Some(user_state),
            )),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn rename_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<RenameWorkspaceRequest>,
) -> Response {
    match state
        .manager
        .rename_workspace(&workspace_id, &principal, &body.name)
        .await
    {
        Ok(record) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record(record, WorkspaceRole::Owner)),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn archive_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .archive_workspace(&workspace_id, &principal)
        .await
    {
        Ok((record, role)) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record(record, role)),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn restore_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .restore_workspace(&workspace_id, &principal)
        .await
    {
        Ok((record, role)) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record(record, role)),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn get_sharing_settings(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .sharing_settings(&workspace_id, &principal)
        .await
    {
        Ok(settings) => (StatusCode::OK, Json(settings)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn update_link_access(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<UpdateLinkAccessRequest>,
) -> Response {
    match state
        .manager
        .update_link_access(&workspace_id, &principal, body.link_access, body.link_role)
        .await
    {
        Ok(settings) => (StatusCode::OK, Json(settings)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn list_workspace_saved_views(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .list_saved_views(&workspace_id, &principal)
        .await
    {
        Ok(rows) => (StatusCode::OK, Json(rows)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn get_workspace_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, saved_view_id)): Path<(String, String)>,
) -> Response {
    match state
        .manager
        .get_saved_view(&workspace_id, &principal, &saved_view_id)
        .await
    {
        Ok(saved_view) => (StatusCode::OK, Json(saved_view)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn create_workspace_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<CreateWorkspaceSavedViewRequest>,
) -> Response {
    match state
        .manager
        .create_saved_view(
            &workspace_id,
            &principal,
            &body.name,
            body.view,
            body.visibility,
        )
        .await
    {
        Ok(saved_view) => {
            let location = format!(
                "/api/workspaces/{}/saved-views/{}",
                saved_view.workspace_id, saved_view.id
            );
            (
                StatusCode::CREATED,
                [(LOCATION, location)],
                Json(saved_view),
            )
                .into_response()
        }
        Err(e) => e.into_response(),
    }
}

async fn update_workspace_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, saved_view_id)): Path<(String, String)>,
    Json(body): Json<UpdateWorkspaceSavedViewRequest>,
) -> Response {
    match state
        .manager
        .update_saved_view(
            &workspace_id,
            &principal,
            &saved_view_id,
            body.name.as_deref(),
            body.view,
        )
        .await
    {
        Ok(saved_view) => (StatusCode::OK, Json(saved_view)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn set_workspace_saved_view_visibility(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, saved_view_id)): Path<(String, String)>,
    Json(body): Json<SetWorkspaceSavedViewVisibilityRequest>,
) -> Response {
    match state
        .manager
        .set_saved_view_visibility(&workspace_id, &principal, &saved_view_id, body.visibility)
        .await
    {
        Ok(saved_view) => (StatusCode::OK, Json(saved_view)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn approve_workspace_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, saved_view_id)): Path<(String, String)>,
) -> Response {
    match state
        .manager
        .approve_saved_view(&workspace_id, &principal, &saved_view_id)
        .await
    {
        Ok(saved_view) => (StatusCode::OK, Json(saved_view)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn reject_workspace_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, saved_view_id)): Path<(String, String)>,
) -> Response {
    match state
        .manager
        .reject_saved_view(&workspace_id, &principal, &saved_view_id)
        .await
    {
        Ok(saved_view) => (StatusCode::OK, Json(saved_view)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn delete_workspace_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, saved_view_id)): Path<(String, String)>,
) -> Response {
    match state
        .manager
        .delete_saved_view(&workspace_id, &principal, &saved_view_id)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    }
}

async fn get_workspace_viewer_profile(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, profile)): Path<(String, String)>,
) -> Response {
    match state
        .manager
        .get_viewer_profile(&workspace_id, &principal, &profile)
        .await
    {
        Ok(Some(profile)) => (StatusCode::OK, Json(profile)).into_response(),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    }
}

async fn upsert_workspace_viewer_profile(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, profile)): Path<(String, String)>,
    Json(body): Json<UpsertWorkspaceViewerProfileRequest>,
) -> Response {
    match state
        .manager
        .upsert_viewer_profile(
            &workspace_id,
            &principal,
            &profile,
            body.seed_source.as_deref(),
            body.view,
        )
        .await
    {
        Ok(profile) => (StatusCode::OK, Json(profile)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn update_workspace_default_saved_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<UpdateWorkspaceDefaultSavedViewRequest>,
) -> Response {
    match state
        .manager
        .set_default_saved_view(&workspace_id, &principal, body.saved_view_id.as_deref())
        .await
    {
        Ok((record, role)) => (
            StatusCode::OK,
            Json(WorkspaceResponse::from_record(record, role)),
        )
            .into_response(),
        Err(e) => e.into_response(),
    }
}

async fn update_workspace_pin(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<UpdateWorkspacePinRequest>,
) -> Response {
    match state
        .manager
        .set_workspace_pinned(&workspace_id, &principal, body.pinned)
        .await
    {
        Ok(user_state) => (StatusCode::OK, Json(user_state)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn update_workspace_last_view(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<UpdateWorkspaceLastViewRequest>,
) -> Response {
    match state
        .manager
        .set_user_workspace_last_view(&workspace_id, &principal, body.view)
        .await
    {
        Ok(user_state) => (StatusCode::OK, Json(user_state)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn get_workspace_user_state(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
) -> Response {
    match state
        .manager
        .get_user_workspace_state(&workspace_id, &principal)
        .await
    {
        Ok(user_state) => (StatusCode::OK, Json(user_state)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn upsert_member(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    Json(body): Json<UpsertMemberRequest>,
) -> Response {
    match state
        .manager
        .upsert_member(
            &workspace_id,
            &principal,
            &body.email,
            body.display_name.as_deref(),
            body.role,
        )
        .await
    {
        Ok(member) => (StatusCode::OK, Json(member)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn update_member_role(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, email)): Path<(String, String)>,
    Json(body): Json<UpdateMemberRoleRequest>,
) -> Response {
    match state
        .manager
        .update_member_role(&workspace_id, &principal, &email, body.role)
        .await
    {
        Ok(member) => (StatusCode::OK, Json(member)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn remove_member(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((workspace_id, email)): Path<(String, String)>,
) -> Response {
    match state
        .manager
        .remove_member(&workspace_id, &principal, &email)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    }
}

async fn workspace_ws(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let live = match state
        .manager
        .live_workspace(&workspace_id, &principal)
        .await
    {
        Ok(live) => live,
        Err(e) => return e.into_response(),
    };
    let manager = Arc::clone(&state.manager);
    ws.on_upgrade(move |socket| async move {
        let client_id = live.next_client_id();
        tracing::info!(client_id, workspace_id = %live.workspace_id, "ws.workspace_client_connected");
        handler::handle_workspace_client(client_id, socket, live, manager, principal).await;
    })
    .into_response()
}

#[cfg(test)]
pub mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tower::ServiceExt;

    use crate::auth::{
        AuthConfig, AuthMode, BearerToken, BearerTokenStore, LoginSessionStore,
        MemoryBearerTokenStore, MemorySessionStore, hash_bearer_token,
    };
    use crate::auth::{DualCredentialExtractor, PrincipalExtractor};

    use super::*;

    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

    pub fn principal(email: &str, is_admin: bool) -> AuthPrincipal {
        AuthPrincipal {
            email: email.to_string(),
            display_name: email.to_string(),
            picture_url: None,
            is_admin,
        }
    }

    async fn fresh_store() -> SqliteWorkspaceStore {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        SqliteWorkspaceStore::new(pool)
    }

    fn idle_eviction_config() -> WorkspaceRuntimeConfig {
        WorkspaceRuntimeConfig {
            idle_ttl: Duration::ZERO,
            idle_sweep_interval: Duration::from_secs(60),
        }
    }

    fn workspace_router_with_principal(
        manager: Arc<WorkspaceManager>,
        principal: AuthPrincipal,
    ) -> Router {
        let principal = Arc::new(principal);
        router(manager).layer(axum::middleware::from_fn(
            move |mut req: Request<Body>, next: axum::middleware::Next| {
                let principal = Arc::clone(&principal);
                async move {
                    req.extensions_mut()
                        .insert(AuthPrincipal::clone(&*principal));
                    next.run(req).await
                }
            },
        ))
    }

    async fn response_json(res: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn create_lists_owner_workspace() {
        let store = fresh_store().await;
        let p = principal("Alice@Example.com", false);

        let workspace = store.create_workspace(&p, None).await.unwrap();
        assert_eq!(workspace.name, "Untitled workspace");

        let rows = store.list_workspaces(&p).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, workspace.id);
        assert_eq!(rows[0].role, WorkspaceRole::Owner);
    }

    #[tokio::test]
    async fn bearer_authenticates_workspace_websocket_upgrade() {
        let store = fresh_store().await;
        let owner = principal("cli@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Bearer WS"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store),
            ProxyConfig::defaults(),
        ));

        let raw_token = "lucida_pat_ws_test";
        let now = Utc::now();
        let bearer_store = Arc::new(MemoryBearerTokenStore::new());
        bearer_store
            .create(BearerToken {
                id: "ws-token".into(),
                token_hash: hash_bearer_token(raw_token),
                name: "ws test".into(),
                email: owner.email.clone(),
                display_name: owner.display_name.clone(),
                picture_url: owner.picture_url.clone(),
                created_at: now,
                last_used_at: None,
                expires_at: now + chrono::Duration::hours(1),
                revoked_at: None,
            })
            .await
            .unwrap();
        let mut config = AuthConfig::for_tests();
        config.mode = AuthMode::Google;
        let extractor: Arc<dyn PrincipalExtractor> = Arc::new(DualCredentialExtractor::new(
            Arc::new(config),
            Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
            Arc::clone(&bearer_store) as Arc<dyn BearerTokenStore>,
        ));
        let app = router(manager).layer(axum::middleware::from_fn_with_state(
            extractor,
            crate::auth::middleware::auth_middleware,
        ));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let url = format!(
            "ws://{addr}/ws/workspaces/{}",
            urlencoding::encode(&workspace.id)
        );
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {raw_token}").parse().unwrap(),
        );

        let (socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SWITCHING_PROTOCOLS
        );
        drop(socket);
        server.abort();
    }

    #[tokio::test]
    async fn workspace_router_builds_with_archived_static_route() {
        let store = fresh_store().await;
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store),
            ProxyConfig::defaults(),
        ));
        let _router = router(manager);
    }

    #[tokio::test]
    async fn admin_support_routes_require_admin_even_for_workspace_owner() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Support deny"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store),
            ProxyConfig::defaults(),
        ));
        let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());

        let requests = [
            Request::builder()
                .method(Method::GET)
                .uri("/admin/workspaces")
                .body(Body::empty())
                .unwrap(),
            Request::builder()
                .method(Method::GET)
                .uri(format!("/admin/workspaces/{}", workspace.id))
                .body(Body::empty())
                .unwrap(),
            Request::builder()
                .method(Method::POST)
                .uri(format!("/admin/workspaces/{}/archive", workspace.id))
                .body(Body::empty())
                .unwrap(),
            Request::builder()
                .method(Method::POST)
                .uri(format!("/admin/workspaces/{}/restore", workspace.id))
                .body(Body::empty())
                .unwrap(),
            Request::builder()
                .method(Method::POST)
                .uri(format!("/admin/workspaces/{}/owners", workspace.id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"email":"owner@example.com"}"#))
                .unwrap(),
        ];

        for req in requests {
            let res = app.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn admin_support_route_returns_details_without_membership() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let admin = principal("admin@example.com", true);
        let workspace = store
            .create_workspace(&owner, Some("Support details"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store),
            ProxyConfig::defaults(),
        ));
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                Some("Editor User"),
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
        let app = workspace_router_with_principal(Arc::clone(&manager), admin);

        let res = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/admin/workspaces/{}", workspace.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = response_json(res).await;
        assert_eq!(body["workspace"]["id"], workspace.id);
        assert_eq!(body["workspace"]["member_count"], 2);
        assert_eq!(body["workspace"]["owner_count"], 1);
        assert_eq!(body["members"][0]["email"], "owner@example.com");
        assert_eq!(body["members"][1]["email"], "editor@example.com");
    }

    #[tokio::test]
    async fn last_view_rest_round_trips_and_preserves_default() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Last view REST"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store.clone()),
            ProxyConfig::defaults(),
        ));

        // Pin a shared default so we can prove the last-view PATCH leaves it.
        let shared = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "shared",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        manager
            .set_default_saved_view(&workspace.id, &owner, Some(&shared.id))
            .await
            .unwrap();

        let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());

        // GET user-state before any record: last_view is null.
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/api/workspaces/{}/user-state", workspace.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = response_json(res).await;
        assert!(body["last_view"].is_null());

        // PATCH last-view with a {view} body.
        let view = SavedView::empty([1024, 768]);
        let payload = serde_json::json!({ "view": view });
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri(format!("/api/workspaces/{}/last-view", workspace.id))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = response_json(res).await;
        assert_eq!(body["workspace_id"], workspace.id);
        assert!(!body["last_view"].is_null());

        // GET user-state now returns the remembered view.
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/api/workspaces/{}/user-state", workspace.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response_json(res).await;
        assert_eq!(body["last_view"]["v"], 1);

        // Invariant at the wire layer: the shared default is untouched.
        let record = store.get_workspace(&workspace.id).await.unwrap().unwrap();
        assert_eq!(
            record.default_saved_view_id.as_deref(),
            Some(shared.id.as_str())
        );
    }

    #[tokio::test]
    async fn admin_support_search_and_lifecycle_override_without_membership() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Support lifecycle"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();

        let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();
        let mut rx = live.tx.subscribe();

        let rows = manager
            .admin_search_workspaces(Some("editor@example.com"), false, 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, workspace.id);
        assert_eq!(rows[0].member_count, 2);
        assert_eq!(rows[0].owner_count, 1);

        let archived = manager
            .admin_archive_workspace(&workspace.id)
            .await
            .unwrap();
        assert!(archived.workspace.archived_at.is_some());
        assert!(!manager.live.lock().await.contains_key(&workspace.id));
        let item = rx.recv().await.unwrap();
        assert!(matches!(item, BroadcastItem::WorkspaceArchived { .. }));
        assert!(store.list_workspaces(&owner).await.unwrap().is_empty());

        assert!(
            manager
                .admin_search_workspaces(Some("support lifecycle"), false, 10)
                .await
                .unwrap()
                .is_empty()
        );
        let archived_rows = manager
            .admin_search_workspaces(Some("support lifecycle"), true, 10)
            .await
            .unwrap();
        assert_eq!(archived_rows.len(), 1);
        assert!(archived_rows[0].archived_at.is_some());

        let restored = manager
            .admin_restore_workspace(&workspace.id)
            .await
            .unwrap();
        assert!(restored.workspace.archived_at.is_none());
        assert_eq!(store.list_workspaces(&owner).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn admin_can_recover_orphaned_workspace_owner() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let recovered = principal("Recovered@Example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Orphaned"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        assert!(
            store
                .remove_member(&workspace.id, &owner.email)
                .await
                .unwrap()
        );
        let details = manager
            .admin_workspace_details(&workspace.id)
            .await
            .unwrap();
        assert_eq!(details.workspace.owner_count, 0);
        // The former owner was removed, so they are now a non-member: opening the
        // workspace must be indistinguishable from a missing one (never-leak),
        // i.e. NotFound rather than Forbidden. (Recovery is admin-only, below.)
        let err = manager
            .get_workspace_for(&workspace.id, &owner)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));

        let member = manager
            .admin_upsert_owner(&workspace.id, &recovered.email, Some("Recovered Owner"))
            .await
            .unwrap();
        assert_eq!(member.email, "recovered@example.com");
        assert_eq!(member.role, WorkspaceRole::Owner);
        assert_eq!(
            store.role_for(&workspace.id, &recovered).await.unwrap(),
            Some(WorkspaceRole::Owner)
        );

        let err = manager
            .update_member_role(
                &workspace.id,
                &recovered,
                &recovered.email,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));
    }

    #[tokio::test]
    async fn non_member_cannot_see_role_but_admin_can() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let other = principal("other@example.com", false);
        let admin = principal("admin@example.com", true);
        let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();

        assert_eq!(store.role_for(&workspace.id, &other).await.unwrap(), None,);
        assert_eq!(
            store.role_for(&workspace.id, &admin).await.unwrap(),
            Some(WorkspaceRole::Owner),
        );
    }

    #[tokio::test]
    async fn owner_can_add_explicit_member_role() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let other = principal("other@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Shared"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let member = manager
            .upsert_member(
                &workspace.id,
                &owner,
                "Other@Example.com",
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();

        assert_eq!(member.email, "other@example.com");
        assert_eq!(
            store.role_for(&workspace.id, &other).await.unwrap(),
            Some(WorkspaceRole::Editor)
        );
        let rows = store.list_workspaces(&other).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, WorkspaceRole::Editor);
    }

    #[tokio::test]
    async fn anyone_with_link_grants_configured_non_owner_role() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let other = principal("other@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Linked"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        assert_eq!(store.role_for(&workspace.id, &other).await.unwrap(), None);

        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();
        assert_eq!(
            store.role_for(&workspace.id, &other).await.unwrap(),
            Some(WorkspaceRole::Viewer)
        );

        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
        assert_eq!(
            store.role_for(&workspace.id, &other).await.unwrap(),
            Some(WorkspaceRole::Editor)
        );

        let err = manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Owner,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));
    }

    #[tokio::test]
    async fn explicit_membership_overrides_link_role() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let other = principal("other@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Linked member"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &other.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();

        assert_eq!(
            store.role_for(&workspace.id, &other).await.unwrap(),
            Some(WorkspaceRole::Editor)
        );
    }

    #[tokio::test]
    async fn link_workspace_enters_recents_only_after_successful_open() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let visitor = principal("visitor@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Linked recent"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        assert!(store.list_workspaces(&visitor).await.unwrap().is_empty());

        let (_record, role, state) = manager
            .open_workspace_for(&workspace.id, &visitor)
            .await
            .unwrap();
        assert_eq!(role, WorkspaceRole::Viewer);
        assert_eq!(state.workspace_id, workspace.id);
        assert!(state.last_opened_at.is_some());

        let rows = store.list_workspaces(&visitor).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, workspace.id);
        assert_eq!(rows[0].role, WorkspaceRole::Viewer);
        assert!(rows[0].last_opened_at.is_some());
        assert!(rows[0].pinned_at.is_none());
    }

    #[tokio::test]
    async fn link_recents_do_not_make_workspaces_globally_discoverable() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let visitor = principal("visitor@example.com", false);
        let stranger = principal("stranger@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Private link"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();
        manager
            .open_workspace_for(&workspace.id, &visitor)
            .await
            .unwrap();

        assert_eq!(store.list_workspaces(&visitor).await.unwrap().len(), 1);
        assert!(store.list_workspaces(&stranger).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn pins_are_personal_and_sort_before_recents() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let teammate = principal("teammate@example.com", false);
        let first = store.create_workspace(&owner, Some("First")).await.unwrap();
        let second = store
            .create_workspace(&owner, Some("Second"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &first.id,
                &owner,
                &teammate.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();
        manager
            .upsert_member(
                &second.id,
                &owner,
                &teammate.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        manager
            .open_workspace_for(&second.id, &owner)
            .await
            .unwrap();
        manager.open_workspace_for(&first.id, &owner).await.unwrap();
        manager
            .set_workspace_pinned(&second.id, &owner, true)
            .await
            .unwrap();

        let owner_rows = store.list_workspaces(&owner).await.unwrap();
        assert_eq!(owner_rows[0].id, second.id);
        assert!(owner_rows[0].pinned_at.is_some());

        let teammate_rows = store.list_workspaces(&teammate).await.unwrap();
        let teammate_second = teammate_rows
            .iter()
            .find(|row| row.id == second.id)
            .expect("teammate can see second workspace");
        assert!(teammate_second.pinned_at.is_none());
    }

    #[tokio::test]
    async fn link_only_recent_disappears_when_link_access_is_disabled() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let visitor = principal("visitor@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Disable link"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
        manager
            .open_workspace_for(&workspace.id, &visitor)
            .await
            .unwrap();
        manager
            .set_workspace_pinned(&workspace.id, &visitor, true)
            .await
            .unwrap();

        assert_eq!(store.list_workspaces(&visitor).await.unwrap().len(), 1);

        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::Restricted,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        assert!(store.list_workspaces(&visitor).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn unpin_without_existing_state_does_not_create_link_recent() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let visitor = principal("visitor@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("No accidental recent"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .update_link_access(
                &workspace.id,
                &owner,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let state = manager
            .set_workspace_pinned(&workspace.id, &visitor, false)
            .await
            .unwrap();
        assert!(state.last_opened_at.is_none());
        assert!(state.pinned_at.is_none());
        assert!(store.list_workspaces(&visitor).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn archive_restore_is_owner_only_and_controls_dashboard_visibility() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Lifecycle"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let err = manager
            .archive_workspace(&workspace.id, &editor)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));
        let err = manager
            .archive_workspace(&workspace.id, &viewer)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        let (archived, role) = manager
            .archive_workspace(&workspace.id, &owner)
            .await
            .unwrap();
        assert_eq!(role, WorkspaceRole::Owner);
        assert!(archived.archived_at.is_some());
        assert!(store.list_workspaces(&owner).await.unwrap().is_empty());
        assert!(store.list_workspaces(&editor).await.unwrap().is_empty());

        let owner_archived = store.list_archived_workspaces(&owner).await.unwrap();
        assert_eq!(owner_archived.len(), 1);
        assert_eq!(owner_archived[0].id, workspace.id);
        assert!(
            store
                .list_archived_workspaces(&editor)
                .await
                .unwrap()
                .is_empty()
        );

        let err = manager
            .restore_workspace(&workspace.id, &viewer)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        let (restored, role) = manager
            .restore_workspace(&workspace.id, &owner)
            .await
            .unwrap();
        assert_eq!(role, WorkspaceRole::Owner);
        assert!(restored.archived_at.is_none());
        assert_eq!(store.list_workspaces(&owner).await.unwrap().len(), 1);
        assert_eq!(store.list_workspaces(&editor).await.unwrap().len(), 1);
        assert!(
            store
                .list_archived_workspaces(&owner)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn archived_workspace_blocks_new_access_until_restored() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Archived access"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        manager
            .archive_workspace(&workspace.id, &owner)
            .await
            .unwrap();

        let err = manager
            .get_workspace_for(&workspace.id, &owner)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Archived));
        let err = match manager.live_workspace(&workspace.id, &owner).await {
            Ok(_) => panic!("archived workspace unexpectedly opened a live session"),
            Err(err) => err,
        };
        assert!(matches!(err, WorkspaceError::Archived));

        manager
            .restore_workspace(&workspace.id, &owner)
            .await
            .unwrap();
        assert!(
            manager
                .get_workspace_for(&workspace.id, &owner)
                .await
                .is_ok()
        );
    }

    // Resolve the open-path error a non-member would receive to the concrete
    // (status, json-body) a browser/CLI actually sees, going through the same
    // terminal `WorkspaceError::into_response` mapping the handler uses.
    async fn open_status_body(
        manager: &WorkspaceManager,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> (StatusCode, serde_json::Value) {
        let res = match manager.get_workspace_for(workspace_id, principal).await {
            Ok((record, role)) => (
                StatusCode::OK,
                Json(WorkspaceResponse::from_record(record, role)),
            )
                .into_response(),
            Err(err) => err.into_response(),
        };
        let status = res.status();
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, body)
    }

    #[tokio::test]
    async fn workspace_open_never_leaks_existence_to_non_member() {
        // NEVER-LEAK regression (annotation share-by-link, slice 3): the
        // workspace-open response a deep-link recipient receives must be
        // byte-identical whether the workspace exists-but-is-restricted, is
        // archived, or never existed. Otherwise a recipient enumerates which
        // workspaces/annotations exist via the Network tab. Folded from the
        // red-team family `annotation_deeplink_neverleak_family.json` cases
        // nl-http-restricted-exists-vs-missing, nl-http-deleted-vs-missing,
        // and nl-http-control-member-ok.
        let store = fresh_store().await;
        let alice = principal("alice@example.com", false);
        let bob = principal("bob@example.com", false);

        // A default (restricted) workspace alice owns; bob is not a member.
        let restricted = store
            .create_workspace(&alice, Some("Restricted"))
            .await
            .unwrap();
        // A workspace alice owns then archives; bob is not a member.
        let archived = store
            .create_workspace(&alice, Some("Archived"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .archive_workspace(&archived.id, &alice)
            .await
            .unwrap();

        let missing = open_status_body(&manager, "does-not-exist-xyz", &bob).await;
        let restricted_exists = open_status_body(&manager, &restricted.id, &bob).await;
        let archived_exists = open_status_body(&manager, &archived.id, &bob).await;

        // The control: a missing workspace is 404 {"error":"not_found"}.
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        assert_eq!(missing.1, json!({ "error": "not_found" }));

        // exists-but-restricted is indistinguishable from missing.
        assert_eq!(
            restricted_exists, missing,
            "restricted-but-existing open must be byte-identical to a missing one for a non-member"
        );
        // archived is also indistinguishable from missing (no 410 leak to a non-member).
        assert_eq!(
            archived_exists, missing,
            "archived open must be byte-identical to a missing one for a non-member"
        );

        // Control: a real member (the owner) still opens the restricted one (200),
        // so the never-leak collapse did not over-collapse access for everyone.
        let owner_open = open_status_body(&manager, &restricted.id, &alice).await;
        assert_eq!(owner_open.0, StatusCode::OK);

        // Control: a member still learns their OWN archived workspace is archived
        // (410), the one party that already knows it exists.
        let owner_archived = open_status_body(&manager, &archived.id, &alice).await;
        assert_eq!(owner_archived.0, StatusCode::GONE);
        assert_eq!(owner_archived.1, json!({ "error": "workspace_archived" }));
    }

    #[tokio::test]
    async fn workspace_open_anyone_with_link_still_grants_access() {
        // The never-leak collapse must NOT break the share-by-link grant: a
        // non-member opening an anyone-with-link workspace still gets 200 and the
        // configured link role (the "deep-link is not a grant, but the link
        // *role* is" path the feature relies on).
        let store = fresh_store().await;
        let alice = principal("alice@example.com", false);
        let bob = principal("bob@example.com", false);
        let workspace = store
            .create_workspace(&alice, Some("Linked"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        // Before enabling the link, bob is a non-member → never-leak 404.
        let before = open_status_body(&manager, &workspace.id, &bob).await;
        assert_eq!(before.0, StatusCode::NOT_FOUND);

        manager
            .update_link_access(
                &workspace.id,
                &alice,
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let (record, role) = manager
            .get_workspace_for(&workspace.id, &bob)
            .await
            .unwrap();
        assert_eq!(record.id, workspace.id);
        assert_eq!(role, WorkspaceRole::Viewer);
    }

    #[tokio::test]
    async fn archiving_revokes_live_workspace_and_denies_new_mutations() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Live archive"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();
        let mut rx = live.tx.subscribe();

        manager
            .archive_workspace(&workspace.id, &owner)
            .await
            .unwrap();

        assert!(live.background_cancelled());
        assert!(!manager.live.lock().await.contains_key(&workspace.id));
        let item = rx.recv().await.unwrap();
        let BroadcastItem::WorkspaceArchived { json } = item else {
            panic!("expected workspace archived broadcast");
        };
        let msg: ServerMessage = serde_json::from_str(&json).unwrap();
        match msg {
            ServerMessage::WorkspaceArchived { workspace_id } => {
                assert_eq!(workspace_id, workspace.id);
            }
            _ => panic!("expected workspace archived server message"),
        }

        let err = manager
            .require_editor(&workspace.id, &owner)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));
    }

    #[tokio::test]
    async fn idle_eviction_drops_empty_live_workspace_and_reopen_restores_document() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Idle restore"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new_with_runtime_config(
            Arc::new(store.clone()),
            ProxyConfig::defaults(),
            idle_eviction_config(),
        );
        let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();

        store
            .persist_document(&workspace.id, 7, &DocumentState::default())
            .await
            .unwrap();

        let evicted = manager.evict_idle_workspaces().await;
        assert_eq!(evicted, 1);
        assert!(live.background_cancelled());
        assert_eq!(manager.live_workspace_count().await, 0);

        let reopened = manager.live_workspace(&workspace.id, &owner).await.unwrap();
        assert!(!Arc::ptr_eq(&live, &reopened));
        assert_eq!(reopened.session.lock().await.seq, 7);
    }

    #[tokio::test]
    async fn active_live_workspace_is_not_idle_evicted() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Active"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new_with_runtime_config(
            Arc::new(store),
            ProxyConfig::defaults(),
            idle_eviction_config(),
        );
        let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();
        live.session.lock().await.add_client(42);

        let evicted = manager.evict_idle_workspaces().await;
        assert_eq!(evicted, 0);
        assert!(!live.background_cancelled());
        assert_eq!(manager.live_workspace_count().await, 1);
    }

    #[tokio::test]
    async fn idle_eviction_preserves_dataset_source_membership_for_reuse() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Reusable source"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new_with_runtime_config(
            Arc::new(store.clone()),
            ProxyConfig::defaults(),
            idle_eviction_config(),
        );
        let workspace_dataset_id = DatasetId("wds-reusable".into());

        manager.live_workspace(&workspace.id, &owner).await.unwrap();
        store
            .persist_dataset_opened(
                &workspace.id,
                &workspace_dataset_id,
                "ds_reusable_source",
                "file:///tmp/reusable.zarr",
                "reusable.zarr",
                &owner.email,
                1,
                &DocumentState::default(),
            )
            .await
            .unwrap();

        assert_eq!(manager.evict_idle_workspaces().await, 1);
        let sources = store.list_dataset_sources(&workspace.id).await.unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].workspace_dataset_id, workspace_dataset_id);
        assert_eq!(sources[0].dataset_source_id, "ds_reusable_source");
    }

    #[tokio::test]
    async fn last_owner_cannot_be_removed_or_demoted() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let other_owner = principal("other-owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Owners"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let err = manager
            .update_member_role(&workspace.id, &owner, &owner.email, WorkspaceRole::Viewer)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));

        let err = manager
            .remove_member(&workspace.id, &owner, &owner.email)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));

        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &other_owner.email,
                None,
                WorkspaceRole::Owner,
            )
            .await
            .unwrap();
        manager
            .update_member_role(&workspace.id, &owner, &owner.email, WorkspaceRole::Viewer)
            .await
            .unwrap();

        assert_eq!(
            store.role_for(&workspace.id, &owner).await.unwrap(),
            Some(WorkspaceRole::Viewer)
        );
        assert_eq!(
            store.role_for(&workspace.id, &other_owner).await.unwrap(),
            Some(WorkspaceRole::Owner)
        );
    }

    #[tokio::test]
    async fn workspace_saved_views_are_scoped_and_strip_source_urls() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let a = store.create_workspace(&owner, Some("A")).await.unwrap();
        let b = store.create_workspace(&owner, Some("B")).await.unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let mut view = SavedView::empty([800, 600]);
        view.datasets.push("gs://bucket/source-url.zarr".into());
        view.dataset_order.push(DatasetId("wds_workspace_a".into()));

        let saved = manager
            .create_saved_view(
                &a.id,
                &owner,
                "  morphology view  ",
                view,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        assert_eq!(saved.workspace_id, a.id);
        assert_eq!(saved.name, "morphology view");
        assert!(saved.view.datasets.is_empty());
        assert_eq!(
            saved.view.dataset_order,
            vec![DatasetId("wds_workspace_a".into())]
        );

        let listed_a = manager.list_saved_views(&a.id, &owner).await.unwrap();
        assert_eq!(listed_a.len(), 1);
        assert_eq!(listed_a[0].id, saved.id);
        let listed_b = manager.list_saved_views(&b.id, &owner).await.unwrap();
        assert!(listed_b.is_empty());

        let mut replacement = SavedView::empty([640, 480]);
        replacement
            .datasets
            .push("file:///should-not-store.zarr".into());
        replacement
            .dataset_order
            .push(DatasetId("wds_workspace_a_reordered".into()));
        let updated = manager
            .update_saved_view(&a.id, &owner, &saved.id, Some("renamed"), Some(replacement))
            .await
            .unwrap();
        assert_eq!(updated.name, "renamed");
        assert!(updated.view.datasets.is_empty());
        assert_eq!(
            updated.view.dataset_order,
            vec![DatasetId("wds_workspace_a_reordered".into())]
        );
    }

    #[tokio::test]
    async fn workspace_saved_view_viewers_can_read_but_not_mutate() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Shared saved views"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let saved = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "view",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();

        let listed = manager
            .list_saved_views(&workspace.id, &viewer)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, saved.id);
        assert_eq!(
            manager
                .get_saved_view(&workspace.id, &viewer, &saved.id)
                .await
                .unwrap()
                .id,
            saved.id
        );

        let err = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "viewer create",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        let err = manager
            .update_saved_view(&workspace.id, &viewer, &saved.id, Some("nope"), None)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        let err = manager
            .delete_saved_view(&workspace.id, &viewer, &saved.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));
    }

    #[tokio::test]
    async fn workspace_personal_saved_view_mutations_are_creator_only() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let editor = principal("editor@example.com", false);
        let admin = principal("admin@example.com", true);
        let workspace = store
            .create_workspace(&owner, Some("Personal saved views"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();

        // A viewer may create a personal view (mirrors create_saved_view), and
        // must be able to mutate their own — editor is NOT required for the
        // owner of a personal view.
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "my personal",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        assert_eq!(personal.visibility, SavedViewVisibility::Personal);

        // Every other caller — editor, owner, admin — is told NotFound (never
        // Forbidden, never success): the row's existence is never confirmed.
        for other in [&editor, &owner, &admin] {
            let err = manager
                .update_saved_view(&workspace.id, other, &personal.id, Some("hijack"), None)
                .await
                .unwrap_err();
            assert!(
                matches!(err, WorkspaceError::NotFound),
                "update by {} should be NotFound, got {err:?}",
                other.email
            );
            let err = manager
                .delete_saved_view(&workspace.id, other, &personal.id)
                .await
                .unwrap_err();
            assert!(
                matches!(err, WorkspaceError::NotFound),
                "delete by {} should be NotFound, got {err:?}",
                other.email
            );
        }

        // The personal view survived every unauthorized attempt.
        let still_there = manager
            .get_saved_view(&workspace.id, &viewer, &personal.id)
            .await
            .unwrap();
        assert_eq!(still_there.name, "my personal");

        // The creator (a viewer) can update their own personal view.
        let updated = manager
            .update_saved_view(&workspace.id, &viewer, &personal.id, Some("renamed"), None)
            .await
            .unwrap();
        assert_eq!(updated.name, "renamed");

        // ...and delete it.
        manager
            .delete_saved_view(&workspace.id, &viewer, &personal.id)
            .await
            .unwrap();
        let err = manager
            .get_saved_view(&workspace.id, &viewer, &personal.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));

        // A non-existent id is NotFound for everyone (unchanged).
        let err = manager
            .update_saved_view(&workspace.id, &owner, "does-not-exist", Some("x"), None)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
        let err = manager
            .delete_saved_view(&workspace.id, &owner, "does-not-exist")
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
    }

    #[tokio::test]
    async fn promote_personal_view_to_shared_enforces_creator_editor_and_never_leak() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let admin = principal("admin@example.com", true);
        let workspace = store
            .create_workspace(&owner, Some("Promote saved views"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        // The editor creates a personal view, plus a second personal view and a
        // shared view that must remain untouched by any promotion.
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "editor personal",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let bystander = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "editor personal 2",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let shared = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "shared default",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        manager
            .set_default_saved_view(&workspace.id, &owner, Some(&shared.id))
            .await
            .unwrap();

        // Never-leak: a non-creator (editor or owner or admin) of the *other*
        // member's personal view cannot even see it, so promotion is NotFound —
        // never Forbidden, which would confirm the row exists.
        let viewer_personal = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "viewer personal",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        for other in [&editor, &owner, &admin] {
            let err = manager
                .set_saved_view_visibility(
                    &workspace.id,
                    other,
                    &viewer_personal.id,
                    SavedViewVisibility::Shared,
                )
                .await
                .unwrap_err();
            assert!(
                matches!(err, WorkspaceError::NotFound),
                "promotion by {} of someone else's personal view should be NotFound, got {err:?}",
                other.email
            );
        }

        // A non-member is denied before any row is read (Forbidden, not
        // NotFound — membership is the first gate).
        let stranger = principal("stranger@example.com", false);
        let err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &stranger,
                &personal.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // The creator promotes their own personal view to shared. created_by is
        // preserved (attribution) and the view payload is untouched.
        let promoted = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &personal.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        assert_eq!(promoted.id, personal.id);
        assert_eq!(promoted.visibility, SavedViewVisibility::Shared);
        assert_eq!(promoted.created_by, normalize_email(&editor.email));
        assert_eq!(promoted.created_by_name, personal.created_by_name);
        assert_eq!(promoted.name, "editor personal");

        // Now that it is shared, every member can see it — including the viewer,
        // who never could before.
        let seen = manager
            .get_saved_view(&workspace.id, &viewer, &personal.id)
            .await
            .unwrap();
        assert_eq!(seen.visibility, SavedViewVisibility::Shared);

        // Promotion never touched the other personal view or the shared
        // default.
        let still_personal = manager
            .get_saved_view(&workspace.id, &editor, &bystander.id)
            .await
            .unwrap();
        assert_eq!(still_personal.visibility, SavedViewVisibility::Personal);
        let record = store.get_workspace(&workspace.id).await.unwrap().unwrap();
        assert_eq!(
            record.default_saved_view_id.as_deref(),
            Some(shared.id.as_str())
        );

        // The creator can demote it back to personal WITHOUT editor being
        // required for the demote path itself: prove this with a creator who is
        // only a viewer.
        let owned_by_viewer = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "viewer second",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        // A viewer cannot promote to shared (shared mutation needs editor).
        let err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &viewer,
                &owned_by_viewer.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // The editor demotes their now-shared view back to personal; no editor
        // is strictly needed for demote, and attribution is still preserved.
        let demoted = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &personal.id,
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        assert_eq!(demoted.visibility, SavedViewVisibility::Personal);
        assert_eq!(demoted.created_by, normalize_email(&editor.email));
        // ...and once personal again, the viewer can no longer see it.
        let err = manager
            .get_saved_view(&workspace.id, &viewer, &personal.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));

        // Creator-only on a SHARED view: a shared view is readable by everyone,
        // but a non-creator (here the editor, who did not create `shared`)
        // cannot re-scope it — Forbidden, not success and not NotFound.
        let err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &shared.id,
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // A non-existent id is NotFound for everyone.
        let err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &owner,
                "does-not-exist",
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
    }

    #[tokio::test]
    async fn set_saved_view_visibility_rest_promotes_and_preserves_attribution() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Promote REST"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store.clone()),
            ProxyConfig::defaults(),
        ));
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "rest personal",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();

        let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
        let res = app
            .oneshot(
                Request::builder()
                    .method(Method::PATCH)
                    .uri(format!(
                        "/api/workspaces/{}/saved-views/{}/visibility",
                        workspace.id, personal.id
                    ))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"visibility":"shared"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = response_json(res).await;
        assert_eq!(body["id"], personal.id);
        assert_eq!(body["visibility"], "shared");
        assert_eq!(body["created_by"], normalize_email(&owner.email));

        // The store reflects the new visibility.
        let reread = store
            .get_saved_view(&workspace.id, &personal.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reread.visibility, SavedViewVisibility::Shared);
    }

    #[test]
    fn saved_view_transition_allow_list_is_closed_by_construction() {
        use SavedViewVisibility::{Personal, Proposed, Shared};
        // The four legal creator transitions.
        assert!(saved_view_transition_allowed(Personal, Shared));
        assert!(saved_view_transition_allowed(Shared, Personal));
        assert!(saved_view_transition_allowed(Personal, Proposed));
        assert!(saved_view_transition_allowed(Proposed, Personal));
        // Same-state is an idempotent no-op for every state.
        assert!(saved_view_transition_allowed(Personal, Personal));
        assert!(saved_view_transition_allowed(Shared, Shared));
        assert!(saved_view_transition_allowed(Proposed, Proposed));
        // The illegal transitions #817 closes: Shared cannot be demoted into the
        // review queue, and a proposal cannot self-approve straight to shared.
        assert!(!saved_view_transition_allowed(Shared, Proposed));
        assert!(!saved_view_transition_allowed(Proposed, Shared));
    }

    /// #817: the `/visibility` endpoint may only perform the creator
    /// transition allow-list. This proves the gate is closed by construction:
    /// the two illegal transitions (`Shared→Proposed`, and the
    /// `Proposed→Shared` self-approve bypass attempted by an editor-creator) are
    /// `BadRequest`; every legal transition succeeds; `→Shared` by a non-editor
    /// creator keeps the existing authority error; never-leak and `created_by`
    /// are preserved.
    #[tokio::test]
    async fn set_saved_view_visibility_enforces_transition_allow_list() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Transition gate"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for (p, role) in [
            (&editor, WorkspaceRole::Editor),
            (&viewer, WorkspaceRole::Viewer),
        ] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, role)
                .await
                .unwrap();
        }

        // --- never-leak: a member who is not the creator of a Personal view
        // gets NotFound, uniform with a missing id (the view's existence is
        // never confirmed via the visibility endpoint). ---
        let viewer_personal = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "viewer private",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let leak_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &viewer_personal.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(leak_err, WorkspaceError::NotFound),
            "non-creator rescope of a personal view must be NotFound, got {leak_err:?}"
        );
        let missing_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                "does-not-exist",
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(missing_err, WorkspaceError::NotFound),
            "missing id must be NotFound, identical to the hidden personal view"
        );

        // --- legal: Personal -> Proposed (creator proposes their own view). ---
        let proposing = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "to propose",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &proposing.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);
        assert_eq!(proposed.created_by, normalize_email(&editor.email));

        // --- illegal: Proposed -> Shared by the editor-creator (the
        // self-approve bypass) MUST be BadRequest, NOT a silent share. Sharing a
        // proposal is exclusively the editor review queue (`approve_saved_view`).
        let bypass_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &proposed.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(bypass_err, WorkspaceError::BadRequest(_)),
            "Proposed->Shared self-approve bypass must be BadRequest, got {bypass_err:?}"
        );
        // It is genuinely still Proposed in the store — the bypass changed
        // nothing.
        let still_proposed = store
            .get_saved_view(&workspace.id, &proposed.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still_proposed.visibility, SavedViewVisibility::Proposed);

        // --- legal: Proposed -> Personal (creator withdraws their proposal). ---
        let withdrawn = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &proposed.id,
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        assert_eq!(withdrawn.visibility, SavedViewVisibility::Personal);
        assert_eq!(withdrawn.created_by, normalize_email(&editor.email));

        // --- legal: Personal -> Shared by an editor-creator; created_by is
        // preserved across the rescope (authorship is never reassigned). ---
        let to_share = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "to share",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let shared = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &to_share.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        assert_eq!(shared.visibility, SavedViewVisibility::Shared);
        assert_eq!(
            shared.created_by,
            normalize_email(&editor.email),
            "created_by must be preserved across a legal rescope"
        );
        assert_eq!(shared.created_by_name, to_share.created_by_name);

        // --- illegal: Shared -> Proposed (a shared view cannot be demoted into
        // the review queue) MUST be BadRequest. ---
        let demote_to_queue_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &shared.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(demote_to_queue_err, WorkspaceError::BadRequest(_)),
            "Shared->Proposed must be BadRequest, got {demote_to_queue_err:?}"
        );

        // --- legal: Shared -> Personal by the creator (make it private again). ---
        let private_again = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &shared.id,
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        assert_eq!(private_again.visibility, SavedViewVisibility::Personal);
        assert_eq!(private_again.created_by, normalize_email(&editor.email));

        // --- authority preserved: ->Shared by a creator who is NOT an editor
        // (a viewer) is the existing authority error (Forbidden), even though
        // Personal->Shared is itself on the allow-list. ---
        let viewer_to_share = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "viewer wants to share",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let authority_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &viewer,
                &viewer_to_share.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(authority_err, WorkspaceError::Forbidden),
            "non-editor creator promoting to Shared must be Forbidden, got {authority_err:?}"
        );
    }

    #[test]
    fn saved_view_visibility_proposed_round_trips_text() {
        assert_eq!(SavedViewVisibility::Proposed.as_str(), "proposed");
        assert_eq!(
            SavedViewVisibility::try_from("proposed").unwrap(),
            SavedViewVisibility::Proposed
        );
        // Serializes lowercase for the REST/JSON surface.
        assert_eq!(
            serde_json::to_value(SavedViewVisibility::Proposed).unwrap(),
            serde_json::json!("proposed")
        );
        // An unknown string is still rejected (no silent fallback).
        assert!(SavedViewVisibility::try_from("queued").is_err());
    }

    #[test]
    fn proposed_view_is_readable_only_by_creator_in_the_pure_gate() {
        // The role-blind gate treats Proposed exactly like Personal: creator
        // Ok, everyone else NotFound. The editor exception is layered above.
        let creator = principal("creator@example.com", false);
        let other = principal("other@example.com", false);
        let proposed = WorkspaceSavedView {
            id: "sv".into(),
            workspace_id: "ws".into(),
            name: "p".into(),
            created_by: normalize_email(&creator.email),
            created_by_name: creator.display_name.clone(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            visibility: SavedViewVisibility::Proposed,
            view: SavedView::empty([800, 600]),
        };
        assert!(ensure_saved_view_readable(&proposed, &creator).is_ok());
        assert!(matches!(
            ensure_saved_view_readable(&proposed, &other),
            Err(WorkspaceError::NotFound)
        ));
    }

    #[tokio::test]
    async fn viewer_can_propose_and_only_creator_or_editor_sees_it() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let other_viewer = principal("nosy@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Propose visibility"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for (p, role) in [
            (&editor, WorkspaceRole::Editor),
            (&viewer, WorkspaceRole::Viewer),
            (&other_viewer, WorkspaceRole::Viewer),
        ] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, role)
                .await
                .unwrap();
        }

        // A plain viewer may propose, exactly as they may save a personal view.
        let proposed = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "viewer proposal",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);
        assert_eq!(proposed.created_by, normalize_email(&viewer.email));

        // The proposer sees their own proposal.
        let seen = manager
            .get_saved_view(&workspace.id, &viewer, &proposed.id)
            .await
            .unwrap();
        assert_eq!(seen.visibility, SavedViewVisibility::Proposed);
        // An editor (and the owner) may read it for review.
        for reviewer in [&editor, &owner] {
            let seen = manager
                .get_saved_view(&workspace.id, reviewer, &proposed.id)
                .await
                .unwrap();
            assert_eq!(seen.id, proposed.id);
        }
        // Never-leak: another plain viewer cannot even see it (NotFound, not
        // Forbidden — its existence is never confirmed).
        let err = manager
            .get_saved_view(&workspace.id, &other_viewer, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));

        // list_saved_views: the proposer sees their proposal; an editor gets the
        // review queue; another plain viewer does NOT see the pending proposal.
        let viewer_list = manager
            .list_saved_views(&workspace.id, &viewer)
            .await
            .unwrap();
        assert!(viewer_list.iter().any(|v| v.id == proposed.id));
        let editor_list = manager
            .list_saved_views(&workspace.id, &editor)
            .await
            .unwrap();
        assert!(editor_list.iter().any(|v| v.id == proposed.id));
        let other_list = manager
            .list_saved_views(&workspace.id, &other_viewer)
            .await
            .unwrap();
        assert!(!other_list.iter().any(|v| v.id == proposed.id));
    }

    #[tokio::test]
    async fn approve_proposal_shares_it_preserving_attribution_and_is_editor_only() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let other_viewer = principal("bystander@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Approve proposal"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for (p, role) in [
            (&editor, WorkspaceRole::Editor),
            (&viewer, WorkspaceRole::Viewer),
            (&other_viewer, WorkspaceRole::Viewer),
        ] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, role)
                .await
                .unwrap();
        }

        let proposed = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "to approve",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();

        // A viewer (the proposer included) cannot approve their own proposal.
        for non_editor in [&viewer, &other_viewer] {
            let err = manager
                .approve_saved_view(&workspace.id, non_editor, &proposed.id)
                .await
                .unwrap_err();
            assert!(matches!(err, WorkspaceError::Forbidden));
        }
        // A non-member is denied before any row is read.
        let stranger = principal("stranger@example.com", false);
        let err = manager
            .approve_saved_view(&workspace.id, &stranger, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // Still Proposed after the failed attempts.
        let still = store
            .get_saved_view(&workspace.id, &proposed.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still.visibility, SavedViewVisibility::Proposed);

        // The editor approves: it becomes Shared, attribution preserved.
        let approved = manager
            .approve_saved_view(&workspace.id, &editor, &proposed.id)
            .await
            .unwrap();
        assert_eq!(approved.visibility, SavedViewVisibility::Shared);
        assert_eq!(approved.created_by, normalize_email(&viewer.email));
        assert_eq!(approved.created_by_name, proposed.created_by_name);
        assert_eq!(approved.name, "to approve");

        // Now every member sees it as a shared view, including the bystander.
        let seen = manager
            .get_saved_view(&workspace.id, &other_viewer, &proposed.id)
            .await
            .unwrap();
        assert_eq!(seen.visibility, SavedViewVisibility::Shared);

        // Approving a non-proposed (already shared) view is a BadRequest.
        let err = manager
            .approve_saved_view(&workspace.id, &editor, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));

        // A missing id is NotFound; another member's personal view stays
        // NotFound even for an editor (never-leak), not BadRequest.
        let err = manager
            .approve_saved_view(&workspace.id, &editor, "does-not-exist")
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
        let hidden_personal = manager
            .create_saved_view(
                &workspace.id,
                &other_viewer,
                "private",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let err = manager
            .approve_saved_view(&workspace.id, &editor, &hidden_personal.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
    }

    #[tokio::test]
    async fn reject_proposal_reverts_to_proposer_personal_non_destructively() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let other_viewer = principal("bystander@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Reject proposal"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for (p, role) in [
            (&editor, WorkspaceRole::Editor),
            (&viewer, WorkspaceRole::Viewer),
            (&other_viewer, WorkspaceRole::Viewer),
        ] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, role)
                .await
                .unwrap();
        }

        let proposed = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "to reject",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();

        // A viewer cannot reject.
        let err = manager
            .reject_saved_view(&workspace.id, &viewer, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // The editor rejects: it reverts to the proposer's PERSONAL view,
        // attribution and payload intact (non-destructive).
        let rejected = manager
            .reject_saved_view(&workspace.id, &editor, &proposed.id)
            .await
            .unwrap();
        assert_eq!(rejected.visibility, SavedViewVisibility::Personal);
        assert_eq!(rejected.created_by, normalize_email(&viewer.email));
        assert_eq!(rejected.name, "to reject");

        // The proposer still owns it privately...
        let still_mine = manager
            .get_saved_view(&workspace.id, &viewer, &proposed.id)
            .await
            .unwrap();
        assert_eq!(still_mine.visibility, SavedViewVisibility::Personal);
        // ...and it is no longer visible to anyone else, including the editor
        // (the review exception only applies while it is pending).
        for other in [&editor, &other_viewer] {
            let err = manager
                .get_saved_view(&workspace.id, other, &proposed.id)
                .await
                .unwrap_err();
            assert!(matches!(err, WorkspaceError::NotFound));
        }

        // Rejecting again (now personal, not proposed) is a BadRequest, and the
        // editor cannot even probe via the personal id once it is hidden again
        // -> NotFound for the now-hidden personal view.
        let err = manager
            .reject_saved_view(&workspace.id, &editor, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
    }

    #[tokio::test]
    async fn approve_reject_rest_endpoints_are_editor_only_and_return_updated_view() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Review REST"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store.clone()),
            ProxyConfig::defaults(),
        ));
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        // The viewer proposes (create with visibility Proposed is allowed for a
        // viewer at the manager; the REST create path threads `visibility`
        // straight through `CreateWorkspaceSavedViewRequest`).
        let proposed = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "rest proposal",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        let proposed_id = proposed.id.clone();

        // A viewer cannot approve through REST (403).
        let viewer_app = workspace_router_with_principal(Arc::clone(&manager), viewer.clone());
        let res = viewer_app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/api/workspaces/{}/saved-views/{}/approve",
                        workspace.id, proposed_id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // The owner (editor authority) approves: 200 + updated shared view.
        let owner_app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
        let res = owner_app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/api/workspaces/{}/saved-views/{}/approve",
                        workspace.id, proposed_id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = response_json(res).await;
        assert_eq!(body["id"], proposed_id);
        assert_eq!(body["visibility"], "shared");
        assert_eq!(body["created_by"], normalize_email(&viewer.email));

        // Approving the now-shared view again is a 400 (not a proposal).
        let owner_app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
        let res = owner_app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!(
                        "/api/workspaces/{}/saved-views/{}/reject",
                        workspace.id, proposed_id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn workspace_viewer_profiles_are_private_and_strip_source_urls() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Headless viewer state"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let mut view = SavedView::empty([800, 600]);
        view.datasets.push("/tmp/source.zarr".into());
        view.dataset_order.push(DatasetId("wds_headless".into()));

        let saved = manager
            .upsert_viewer_profile(
                &workspace.id,
                &viewer,
                "default",
                Some("document_defaults"),
                view,
            )
            .await
            .unwrap();

        assert_eq!(saved.workspace_id, workspace.id);
        assert_eq!(saved.user_email, viewer.email);
        assert_eq!(saved.profile, "default");
        assert_eq!(saved.seed_source.as_deref(), Some("document_defaults"));
        assert!(saved.view.datasets.is_empty());
        assert_eq!(
            saved.view.dataset_order,
            vec![DatasetId("wds_headless".into())]
        );

        let owner_profile = manager
            .get_viewer_profile(&workspace.id, &owner, "default")
            .await
            .unwrap();
        assert!(owner_profile.is_none());

        let viewer_profile = manager
            .get_viewer_profile(&workspace.id, &viewer, "default")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(viewer_profile.user_email, viewer.email);
        assert_eq!(
            viewer_profile.view.dataset_order,
            vec![DatasetId("wds_headless".into())]
        );
    }

    #[tokio::test]
    async fn workspace_viewer_profiles_reject_invalid_profile_names() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Headless viewer profile names"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let err = manager
            .upsert_viewer_profile(
                &workspace.id,
                &owner,
                "../escape",
                None,
                SavedView::empty([800, 600]),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));
    }

    #[tokio::test]
    async fn workspace_default_saved_view_is_editor_controlled_and_scoped() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Default view"))
            .await
            .unwrap();
        let other_workspace = store.create_workspace(&owner, Some("Other")).await.unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let saved = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "default",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        let other_saved = manager
            .create_saved_view(
                &other_workspace.id,
                &owner,
                "other default",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();

        let (record, role) = manager
            .set_default_saved_view(&workspace.id, &editor, Some(&saved.id))
            .await
            .unwrap();
        assert_eq!(role, WorkspaceRole::Editor);
        assert_eq!(
            record.default_saved_view_id.as_deref(),
            Some(saved.id.as_str())
        );

        let err = manager
            .set_default_saved_view(&workspace.id, &viewer, None)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        let err = manager
            .set_default_saved_view(&workspace.id, &editor, Some(&other_saved.id))
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));

        manager
            .delete_saved_view(&workspace.id, &editor, &saved.id)
            .await
            .unwrap();
        let restored = store.get_workspace(&workspace.id).await.unwrap().unwrap();
        assert!(restored.default_saved_view_id.is_none());
    }

    #[tokio::test]
    async fn workspace_last_view_round_trips_per_user_and_never_touches_default() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Remember my last view"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        // Pin the shared default first so we can prove recording a last view
        // leaves it untouched.
        let shared = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "shared default",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();
        manager
            .set_default_saved_view(&workspace.id, &owner, Some(&shared.id))
            .await
            .unwrap();

        // Before any record, the caller's state has no last view.
        let before = manager
            .get_user_workspace_state(&workspace.id, &viewer)
            .await
            .unwrap();
        assert!(before.last_view.is_none());

        // A viewer (lowest role) records their own view; source URLs are
        // stripped, the workspace-local dataset order is kept.
        let mut view = SavedView::empty([1024, 768]);
        view.datasets.push("/secret/source.zarr".into());
        view.dataset_order.push(DatasetId("wds_mine".into()));
        let state = manager
            .set_user_workspace_last_view(&workspace.id, &viewer, view)
            .await
            .unwrap();
        let last = state.last_view.expect("last_view recorded");
        assert!(last.datasets.is_empty(), "source URLs must be stripped");
        assert_eq!(last.dataset_order, vec![DatasetId("wds_mine".into())]);

        // Read-back via the principal-scoped getter sees the same view.
        let got = manager
            .get_user_workspace_state(&workspace.id, &viewer)
            .await
            .unwrap();
        assert_eq!(
            got.last_view.as_ref().map(|v| &v.dataset_order),
            Some(&vec![DatasetId("wds_mine".into())])
        );

        // Invariant: recording a last view never changes the shared default.
        let record = store.get_workspace(&workspace.id).await.unwrap().unwrap();
        assert_eq!(
            record.default_saved_view_id.as_deref(),
            Some(shared.id.as_str())
        );

        // Per-user isolation: another member never sees the viewer's last view.
        let owner_state = manager
            .get_user_workspace_state(&workspace.id, &owner)
            .await
            .unwrap();
        assert!(owner_state.last_view.is_none());
    }

    #[tokio::test]
    async fn workspace_last_view_does_not_disturb_pin_and_recents() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Last view coexists"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        // Establish pin + recents on the owner's row.
        manager
            .set_workspace_pinned(&workspace.id, &owner, true)
            .await
            .unwrap();
        let opened = store
            .record_workspace_open(&workspace.id, &owner)
            .await
            .unwrap();
        assert!(opened.pinned_at.is_some());
        assert!(opened.last_opened_at.is_some());

        // Recording a last view must upsert ONLY last_view, leaving the
        // existing pin/recents intact.
        let state = manager
            .set_user_workspace_last_view(&workspace.id, &owner, SavedView::empty([640, 480]))
            .await
            .unwrap();
        assert!(state.last_view.is_some());
        assert!(
            state.pinned_at.is_some(),
            "pin must survive a last-view write"
        );
        assert!(
            state.last_opened_at.is_some(),
            "recents must survive a last-view write"
        );
    }

    #[tokio::test]
    async fn workspace_last_view_requires_membership() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let stranger = principal("stranger@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Members only"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let set_err = manager
            .set_user_workspace_last_view(&workspace.id, &stranger, SavedView::empty([800, 600]))
            .await
            .unwrap_err();
        assert!(matches!(set_err, WorkspaceError::Forbidden));

        let get_err = manager
            .get_user_workspace_state(&workspace.id, &stranger)
            .await
            .unwrap_err();
        assert!(matches!(get_err, WorkspaceError::Forbidden));
    }

    #[tokio::test]
    async fn workspace_last_view_absent_on_legacy_rows() {
        // A row written before #700 (here: via record_workspace_open, which
        // leaves last_view_json NULL) reads back last_view = None — the
        // additive migration adds a nullable column with no backfill.
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("Legacy"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        store
            .record_workspace_open(&workspace.id, &owner)
            .await
            .unwrap();
        let state = manager
            .get_user_workspace_state(&workspace.id, &owner)
            .await
            .unwrap();
        assert!(state.last_opened_at.is_some());
        assert!(state.last_view.is_none());
    }

    #[tokio::test]
    async fn dataset_membership_and_document_persist_together() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();
        let workspace_dataset_id = DatasetId("wds_runtime".into());
        let mut doc = DocumentState::default();
        doc.manifests.insert(
            workspace_dataset_id.clone(),
            lucida_content::DatasetManifest::new(
                workspace_dataset_id.clone(),
                "dataset".into(),
                lucida_content::DatasetKind::Single,
                vec![],
                vec![],
                vec![],
                vec![],
                None,
            ),
        );

        store
            .persist_dataset_opened(
                &workspace.id,
                &workspace_dataset_id,
                "ds_source",
                "file:///data/demo.zarr",
                "demo.zarr",
                &owner.email,
                1,
                &doc,
            )
            .await
            .unwrap();

        let sources = store.list_dataset_sources(&workspace.id).await.unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].workspace_dataset_id, workspace_dataset_id);
        assert_eq!(sources[0].dataset_source_id, "ds_source");
        assert_eq!(
            store
                .dataset_by_source(&workspace.id, "ds_source")
                .await
                .unwrap()
                .unwrap()
                .workspace_dataset_id,
            DatasetId("wds_runtime".into())
        );

        let restored = store.get_workspace(&workspace.id).await.unwrap().unwrap();
        assert_eq!(restored.seq, 1);
        assert!(
            restored
                .document
                .manifests
                .contains_key(&DatasetId("wds_runtime".into()))
        );
    }

    // --- Dataset rename (#701) -------------------------------------------

    /// Seed a workspace with a single dataset whose manifest name and DB
    /// `display_name` are both `name`, persisted at `seq`. Returns the
    /// workspace id and the workspace-dataset id so a test can then open the
    /// live workspace (which loads this document from the store) and rename it.
    async fn seed_workspace_with_dataset(
        store: &SqliteWorkspaceStore,
        owner: &AuthPrincipal,
        name: &str,
    ) -> (String, DatasetId) {
        let workspace = store.create_workspace(owner, Some("Demo")).await.unwrap();
        let workspace_dataset_id = DatasetId("wds_rename".into());
        let mut doc = DocumentState::default();
        doc.manifests.insert(
            workspace_dataset_id.clone(),
            lucida_content::DatasetManifest::new(
                workspace_dataset_id.clone(),
                name.into(),
                lucida_content::DatasetKind::Single,
                vec![],
                vec![],
                vec![],
                vec![],
                None,
            ),
        );
        store
            .persist_dataset_opened(
                &workspace.id,
                &workspace_dataset_id,
                "ds_source",
                "file:///data/original.zarr",
                name,
                &owner.email,
                1,
                &doc,
            )
            .await
            .unwrap();
        (workspace.id, workspace_dataset_id)
    }

    // THE HEADLINE TEST: a rename must survive close + reopen. The prior
    // (rejected) attempt updated only the DB display_name and a web-local
    // override, so the persisted document still carried the old manifest name
    // and the rename was silently lost on reopen. This drives the rename
    // through the document-mutation path, evicts the live workspace, reopens
    // it (which loads the persisted document_json), and asserts the
    // client-visible manifest name is the NEW one.
    #[tokio::test]
    async fn rename_dataset_survives_evict_and_reopen() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new_with_runtime_config(
            Arc::new(store.clone()),
            ProxyConfig::defaults(),
            idle_eviction_config(),
        );

        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();
        // Sanity: the live document carries the original name.
        assert_eq!(
            live.session.lock().await.document.manifests[&wds_id].name,
            "original.zarr"
        );

        let (seq, _) = manager
            .rename_dataset(&live, &owner, &wds_id, "Renamed Layer")
            .await
            .unwrap();
        assert_eq!(seq, 2, "rename should advance the document seq");
        // In-session reflection is immediate.
        assert_eq!(
            live.session.lock().await.document.manifests[&wds_id].name,
            "Renamed Layer"
        );

        // Evict the live workspace so the next open reloads from the store.
        let evicted = manager.evict_idle_workspaces().await;
        assert_eq!(evicted, 1);
        assert_eq!(manager.live_workspace_count().await, 0);

        // Reopen: the client-visible document manifest name is the NEW one.
        let reopened = manager.live_workspace(&workspace_id, &owner).await.unwrap();
        assert!(!Arc::ptr_eq(&live, &reopened));
        let reopened_name = reopened.session.lock().await.document.manifests[&wds_id]
            .name
            .clone();
        assert_eq!(
            reopened_name, "Renamed Layer",
            "the renamed name must survive reopen (loaded from persisted document_json)"
        );

        // The server-private DB display_name is kept in sync too, so listings
        // and restored bindings agree.
        let db_name = store
            .dataset_by_workspace_dataset(&workspace_id, &wds_id)
            .await
            .unwrap()
            .unwrap()
            .display_name;
        assert_eq!(db_name, "Renamed Layer");
    }

    #[tokio::test]
    async fn rename_dataset_trims_and_persists_trimmed_name() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

        manager
            .rename_dataset(&live, &owner, &wds_id, "  Padded Name  ")
            .await
            .unwrap();
        assert_eq!(
            live.session.lock().await.document.manifests[&wds_id].name,
            "Padded Name"
        );
        let db_name = store
            .dataset_by_workspace_dataset(&workspace_id, &wds_id)
            .await
            .unwrap()
            .unwrap()
            .display_name;
        assert_eq!(db_name, "Padded Name");
    }

    #[tokio::test]
    async fn rename_dataset_is_editor_only_and_never_leaks() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let viewer = principal("viewer@example.com", false);
        manager
            .upsert_member(
                &workspace_id,
                &owner,
                &viewer.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();

        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

        // A viewer cannot rename — Forbidden (role-first).
        let err = manager
            .rename_dataset(&live, &viewer, &wds_id, "viewer rename")
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // A non-member cannot rename — Forbidden, identical to the viewer, so
        // membership is never confirmed.
        let stranger = principal("stranger@example.com", false);
        let err = manager
            .rename_dataset(&live, &stranger, &wds_id, "stranger rename")
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

        // The denied renames did not mutate anything.
        assert_eq!(
            live.session.lock().await.document.manifests[&wds_id].name,
            "original.zarr"
        );
    }

    #[tokio::test]
    async fn rename_dataset_missing_id_is_not_found() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, _wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

        // An editor renaming a dataset that does not exist in the document
        // gets NotFound (uniform with a dataset that was never opened) — and
        // the seq does not advance (no phantom mutation persisted).
        let before_seq = live.session.lock().await.seq;
        let err = manager
            .rename_dataset(
                &live,
                &owner,
                &DatasetId("wds_ghost".into()),
                "ghost rename",
            )
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
        assert_eq!(live.session.lock().await.seq, before_seq);
    }

    #[tokio::test]
    async fn rename_dataset_validation_rejects_empty_whitespace_and_overlong() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

        for bad in ["", "   ", "\t\n"] {
            let err = manager
                .rename_dataset(&live, &owner, &wds_id, bad)
                .await
                .unwrap_err();
            assert!(
                matches!(err, WorkspaceError::BadRequest(_)),
                "empty/whitespace name {bad:?} should be BadRequest, got {err:?}"
            );
        }

        let overlong = "x".repeat(MAX_DATASET_NAME_CHARS + 1);
        let err = manager
            .rename_dataset(&live, &owner, &wds_id, &overlong)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::BadRequest(_)));

        // None of the rejected renames mutated the document or advanced seq.
        let sess = live.session.lock().await;
        assert_eq!(sess.document.manifests[&wds_id].name, "original.zarr");
        assert_eq!(sess.seq, 1);
    }

    #[tokio::test]
    async fn rename_dataset_leaves_source_url_unchanged() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

        let url_before = store
            .dataset_by_workspace_dataset(&workspace_id, &wds_id)
            .await
            .unwrap()
            .unwrap()
            .canonical_url;

        manager
            .rename_dataset(&live, &owner, &wds_id, "Renamed")
            .await
            .unwrap();

        let after = store
            .dataset_by_workspace_dataset(&workspace_id, &wds_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.canonical_url, url_before);
        assert_eq!(after.canonical_url, "file:///data/original.zarr");
        // The source id is unchanged; only the per-workspace label moved.
        assert_eq!(after.dataset_source_id, "ds_source");
        assert_eq!(after.display_name, "Renamed");
    }

    #[tokio::test]
    async fn rename_dataset_leaves_existing_saved_view_name_unchanged() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        // A saved view references dataset ids, not names; renaming the dataset
        // must not rewrite the saved view's own name.
        let saved = manager
            .create_saved_view(
                &workspace_id,
                &owner,
                "My Saved View",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap();

        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();
        manager
            .rename_dataset(&live, &owner, &wds_id, "Renamed Dataset")
            .await
            .unwrap();

        let after = manager
            .get_saved_view(&workspace_id, &owner, &saved.id)
            .await
            .unwrap();
        assert_eq!(after.name, "My Saved View");
    }

    #[tokio::test]
    async fn rename_dataset_broadcasts_command_to_peers() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let (workspace_id, wds_id) =
            seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

        // A co-present peer subscribes to the live broadcast channel.
        let mut rx = live.tx.subscribe();

        manager
            .rename_dataset(&live, &owner, &wds_id, "Live Rename")
            .await
            .unwrap();
        // The handler is what broadcasts in production; here we assert the
        // rename produced the document the peer would converge on, then
        // emulate the handler's broadcast and confirm the peer receives a
        // CommandBroadcast carrying the rename.
        let (seq, command) = {
            // Re-derive what the handler sends: it forwards the same
            // (seq, RenameDataset) returned by rename_dataset. We already
            // applied; reconstruct the broadcast item exactly as the handler.
            let sess = live.session.lock().await;
            (
                sess.seq,
                DocumentCommand::RenameDataset {
                    id: wds_id.clone(),
                    name: "Live Rename".to_string(),
                },
            )
        };
        let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
        let ack_msg = ServerMessage::Ack { seq };
        // `BroadcastItem` is not `Debug`, so don't `.unwrap()` the send result
        // (its error would need Debug); a failed send just means no receiver.
        let _ = live.tx.send(BroadcastItem::CommandBroadcast {
            sender: u64::MAX,
            broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
            ack_json: serde_json::to_string(&ack_msg).unwrap(),
        });

        let item = rx.recv().await.unwrap();
        match item {
            BroadcastItem::CommandBroadcast { broadcast_json, .. } => {
                assert!(broadcast_json.contains("\"type\":\"rename_dataset\""));
                assert!(broadcast_json.contains("Live Rename"));
            }
            _ => panic!("expected a CommandBroadcast broadcast item"),
        }
    }

    #[tokio::test]
    async fn same_source_can_have_distinct_workspace_dataset_ids() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let a = store.create_workspace(&owner, Some("A")).await.unwrap();
        let b = store.create_workspace(&owner, Some("B")).await.unwrap();
        let source_id = "ds_shared_source";
        let canonical_url = "file:///data/shared.zarr";

        for (workspace, workspace_dataset_id) in [
            (&a, DatasetId("wds_workspace_a".into())),
            (&b, DatasetId("wds_workspace_b".into())),
        ] {
            let mut doc = DocumentState::default();
            doc.manifests.insert(
                workspace_dataset_id.clone(),
                lucida_content::DatasetManifest::new(
                    workspace_dataset_id.clone(),
                    "shared.zarr".into(),
                    lucida_content::DatasetKind::Single,
                    vec![],
                    vec![],
                    vec![],
                    vec![],
                    None,
                ),
            );
            store
                .persist_dataset_opened(
                    &workspace.id,
                    &workspace_dataset_id,
                    source_id,
                    canonical_url,
                    "shared.zarr",
                    &owner.email,
                    1,
                    &doc,
                )
                .await
                .unwrap();
        }

        let source_a = store
            .dataset_by_source(&a.id, source_id)
            .await
            .unwrap()
            .unwrap();
        let source_b = store
            .dataset_by_source(&b.id, source_id)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(source_a.dataset_source_id, source_b.dataset_source_id);
        assert_eq!(source_a.canonical_url, source_b.canonical_url);
        assert_ne!(source_a.workspace_dataset_id, source_b.workspace_dataset_id);
        assert_eq!(
            source_a.workspace_dataset_id,
            DatasetId("wds_workspace_a".into())
        );
        assert_eq!(
            source_b.workspace_dataset_id,
            DatasetId("wds_workspace_b".into())
        );
    }

    #[tokio::test]
    async fn live_workspace_sessions_are_independent() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let a = store.create_workspace(&owner, Some("A")).await.unwrap();
        let b = store.create_workspace(&owner, Some("B")).await.unwrap();
        let manager = WorkspaceManager::new(Arc::new(store), ProxyConfig::defaults());

        let live_a = manager.live_workspace(&a.id, &owner).await.unwrap();
        let live_b = manager.live_workspace(&b.id, &owner).await.unwrap();

        let cmd = DocumentCommand::RegisterLayout {
            dataset_id: DatasetId("ds-a".into()),
            layout: lucida_content::LayoutSpec {
                id: lucida_content::LayoutId("layout-a".into()),
                name: "Layout A".into(),
                placements: vec![],
            },
        };
        let (seq, document) = {
            let mut sess = live_a.session.lock().await;
            let seq = sess.apply(cmd.clone());
            (seq, sess.document.clone())
        };
        manager
            .persist_applied_command(&live_a, &cmd, seq, &document)
            .await
            .unwrap();

        assert_eq!(live_a.session.lock().await.seq, 1);
        assert_eq!(live_b.session.lock().await.seq, 0);
        assert!(
            live_a
                .session
                .lock()
                .await
                .document
                .registered_layouts
                .contains_key(&DatasetId("ds-a".into()))
        );
        assert!(
            !live_b
                .session
                .lock()
                .await
                .document
                .registered_layouts
                .contains_key(&DatasetId("ds-a".into()))
        );
    }
    // ===================================================================
    // RED TEAM (#817 issue-sweep): probe the new transition allow-list and
    // the surrounding never-leak / self-approve invariants.
    // ===================================================================

    /// RED TEAM #1 — the self-approve bypass via `approve_saved_view`.
    ///
    /// The #817 change closes Proposed->Shared on `/visibility`
    /// (`set_saved_view_visibility`) "so sharing a proposal stays exclusively
    /// the editor review queue's job (`approve_saved_view`)". The whole point
    /// of a *review queue* is that someone OTHER than the proposer signs off.
    /// This test drives the entire creator-only path the change permits
    /// (Personal -> Proposed on /visibility, which is on the allow-list) and
    /// then has the SAME principal approve their OWN proposal. If that yields
    /// Shared, the editor-creator has achieved Proposed->Shared on their own
    /// view with no second party — the exact outcome the allow-list was added
    /// to forbid, simply routed through approve instead of /visibility.
    #[tokio::test]
    async fn redteam_editor_self_approves_own_proposal_proposed_to_shared() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("self approve"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &editor.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();

        // Editor creates a Personal view, then proposes it via the very
        // /visibility transition the allow-list blesses (Personal -> Proposed).
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "my view",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &personal.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

        // The SAME editor now approves their OWN proposal.
        let approve_result = manager
            .approve_saved_view(&workspace.id, &editor, &proposed.id)
            .await;

        // The review-queue intent: a proposer cannot be their own reviewer, so
        // self-approval is denied (Forbidden — an authorization act on the view,
        // like the creator-only re-scope gate) and must NOT share the view.
        assert!(
            matches!(approve_result, Err(WorkspaceError::Forbidden)),
            "self-approve must be Forbidden (creator != reviewer), got {approve_result:?}"
        );
        let shared_in_store = store
            .get_saved_view(&workspace.id, &proposed.id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(
            shared_in_store.visibility,
            SavedViewVisibility::Shared,
            "SELF-APPROVE BYPASS: editor-creator drove their own proposal \
             Proposed->Shared via approve_saved_view. The /visibility allow-list \
             forbids Proposed->Shared for the creator, and approve must enforce \
             the same reviewer!=creator rule so the same person cannot both \
             propose and approve — preserving the review queue.",
        );
        // The proposal is untouched: still Proposed, still the editor's, free for
        // a *different* editor to review.
        assert_eq!(shared_in_store.visibility, SavedViewVisibility::Proposed);
    }

    /// RED TEAM #2 — single-editor (owner-only) workspace: the proposer is the
    /// only person who CAN review. The review queue is structurally a no-op
    /// rubber stamp. Owner creates -> proposes -> self-approves -> Shared.
    #[tokio::test]
    async fn redteam_single_owner_self_approves_in_solo_workspace() {
        let store = fresh_store().await;
        let owner = principal("solo@example.com", false);
        let workspace = store.create_workspace(&owner, Some("solo")).await.unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let personal = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "solo view",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &owner,
                &personal.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

        let approve_result = manager
            .approve_saved_view(&workspace.id, &owner, &proposed.id)
            .await;
        assert!(
            matches!(approve_result, Err(WorkspaceError::Forbidden)),
            "solo self-approve must be Forbidden (creator != reviewer), got {approve_result:?}"
        );
        let after = store
            .get_saved_view(&workspace.id, &proposed.id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(
            after.visibility,
            SavedViewVisibility::Shared,
            "SELF-APPROVE BYPASS (solo): the sole owner proposed and approved \
             their own view, reaching Shared with literally no second party."
        );
        // The view is not stranded: it stays Proposed (and the owner can still
        // withdraw it via the legal Proposed->Personal /visibility path, or share
        // their own view directly via Personal->Shared — the queue is for a
        // *different* reviewer).
        assert_eq!(after.visibility, SavedViewVisibility::Proposed);
    }

    /// RED TEAM #3 — confirm the /visibility allow-list itself holds for the
    /// two illegal direct transitions, even attempted by an owner (highest
    /// role). These SHOULD be BadRequest (this is the part the change gets
    /// right; included so the report is grounded).
    #[tokio::test]
    async fn redteam_visibility_endpoint_rejects_illegal_transitions_for_owner() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("owner gate"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        // Proposed -> Shared (self-approve) via /visibility must be BadRequest.
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "p1",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &owner,
                &personal.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        let err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &owner,
                &proposed.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, WorkspaceError::BadRequest(_)),
            "Proposed->Shared via /visibility must be BadRequest, got {err:?}"
        );

        // Shared -> Proposed via /visibility must be BadRequest.
        let p2 = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "p2",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let shared = manager
            .set_saved_view_visibility(&workspace.id, &owner, &p2.id, SavedViewVisibility::Shared)
            .await
            .unwrap();
        let err2 = manager
            .set_saved_view_visibility(
                &workspace.id,
                &owner,
                &shared.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err2, WorkspaceError::BadRequest(_)),
            "Shared->Proposed via /visibility must be BadRequest, got {err2:?}"
        );
    }

    /// RED TEAM #4 — never-leak ordering on the NEW allow-list deny.
    ///
    /// A workspace MEMBER who is not the creator attempts an ILLEGAL transition
    /// (Proposed->Shared) on another member's *Proposed* view. Because Proposed
    /// is creator-private (ensure_saved_view_readable treats Proposed like
    /// Personal), the readability check must fire FIRST and yield NotFound —
    /// identical to a missing id — so the BadRequest allow-list error never
    /// leaks the view's existence. If this ever returned BadRequest, a stranger
    /// could distinguish "exists but illegal" from "absent".
    #[tokio::test]
    async fn redteam_illegal_transition_does_not_leak_hidden_proposed_view() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let other_editor = principal("other-editor@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("leak gate"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for p in [&editor, &other_editor] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, WorkspaceRole::Editor)
                .await
                .unwrap();
        }

        // `editor` owns a Proposed view (creator-private until reviewed).
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "hidden",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &personal.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();

        // `other_editor` (a non-creator member) attempts the illegal
        // Proposed->Shared transition on a view they cannot read.
        let leak_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &other_editor,
                &proposed.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        let missing_err = manager
            .set_saved_view_visibility(
                &workspace.id,
                &other_editor,
                "does-not-exist",
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();

        // Both must be NotFound (indistinguishable). A BadRequest here would be
        // a never-leak hole: it confirms the hidden Proposed view exists.
        assert!(
            matches!(leak_err, WorkspaceError::NotFound),
            "NEVER-LEAK: illegal transition on a hidden Proposed view must be \
             NotFound (uniform with a missing id), got {leak_err:?}"
        );
        assert!(matches!(missing_err, WorkspaceError::NotFound));
    }

    /// RED TEAM #5 — created_by preservation across approve (the only
    /// Proposed->Shared path). Confirms authorship is not reassigned to the
    /// reviewer. (Sanity guard for the created_by-tampering axis.)
    #[tokio::test]
    async fn redteam_approve_preserves_created_by_not_reviewer() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let viewer = principal("viewer@example.com", false);
        let workspace = store.create_workspace(&owner, Some("attr")).await.unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for (p, role) in [
            (&editor, WorkspaceRole::Editor),
            (&viewer, WorkspaceRole::Viewer),
        ] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, role)
                .await
                .unwrap();
        }
        let proposed = manager
            .create_saved_view(
                &workspace.id,
                &viewer,
                "bid",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        let approved = manager
            .approve_saved_view(&workspace.id, &editor, &proposed.id)
            .await
            .unwrap();
        assert_eq!(
            approved.created_by,
            normalize_email(&viewer.email),
            "created_by must stay the proposer, not become the reviewer"
        );
    }

    /// The self-approve guard must NOT be over-broad: a *different* editor can
    /// still approve a proposal whose creator is themselves an editor. This is
    /// the precise over-reach risk of a creator!=reviewer check — it must gate on
    /// the *individual*, not the role, so the normal two-party review flow keeps
    /// working when the proposer happens to be an editor/owner.
    #[tokio::test]
    async fn different_editor_can_approve_an_editor_creators_proposal() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let editor = principal("editor@example.com", false);
        let reviewer = principal("reviewer@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("two editors"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
        for p in [&editor, &reviewer] {
            manager
                .upsert_member(&workspace.id, &owner, &p.email, None, WorkspaceRole::Editor)
                .await
                .unwrap();
        }

        // An editor creates and proposes their own view (legal Personal->Proposed).
        let personal = manager
            .create_saved_view(
                &workspace.id,
                &editor,
                "shared candidate",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &editor,
                &personal.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

        // The creator-editor still cannot self-approve...
        let self_err = manager
            .approve_saved_view(&workspace.id, &editor, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(self_err, WorkspaceError::Forbidden));

        // ...but a DIFFERENT editor can — the two-party review flow is intact and
        // the original author keeps attribution.
        let approved = manager
            .approve_saved_view(&workspace.id, &reviewer, &proposed.id)
            .await
            .unwrap();
        assert_eq!(approved.visibility, SavedViewVisibility::Shared);
        assert_eq!(approved.created_by, normalize_email(&editor.email));
    }

    /// The self-approve guard is scoped to APPROVE only: a creator may still
    /// self-*reject* (withdraw) their own proposal, reverting it to their own
    /// Personal view (Proposed->Personal). Rejecting is non-destructive and the
    /// equivalent withdraw is already legal via /visibility, so it must keep
    /// working for the proposer.
    #[tokio::test]
    async fn creator_can_self_reject_to_withdraw_own_proposal() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store
            .create_workspace(&owner, Some("withdraw"))
            .await
            .unwrap();
        let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

        let personal = manager
            .create_saved_view(
                &workspace.id,
                &owner,
                "to withdraw",
                SavedView::empty([800, 600]),
                SavedViewVisibility::Personal,
            )
            .await
            .unwrap();
        let proposed = manager
            .set_saved_view_visibility(
                &workspace.id,
                &owner,
                &personal.id,
                SavedViewVisibility::Proposed,
            )
            .await
            .unwrap();
        assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

        // The creator rejects their OWN proposal: allowed (withdraw), reverts to
        // their Personal view non-destructively.
        let rejected = manager
            .reject_saved_view(&workspace.id, &owner, &proposed.id)
            .await
            .unwrap();
        assert_eq!(rejected.visibility, SavedViewVisibility::Personal);
        assert_eq!(rejected.created_by, normalize_email(&owner.email));
        assert_eq!(rejected.name, "to withdraw");
    }
}
