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
/// never disclosed to anyone else, not even owners. Persisted as TEXT
/// (`"shared"` / `"personal"`) and serialized into the REST/JSON response so
/// the client can tell the two layers apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedViewVisibility {
    #[default]
    Shared,
    Personal,
}

impl SavedViewVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Personal => "personal",
        }
    }
}

impl TryFrom<&str> for SavedViewVisibility {
    type Error = StoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "shared" => Ok(Self::Shared),
            "personal" => Ok(Self::Personal),
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

    /// Saved views visible to `viewer_email`: every `Shared` view plus the
    /// caller's own `Personal` views, and no other member's personal view. The
    /// shared-∪-own-personal predicate is resolved in SQL (one round-trip, no
    /// fetch-all-then-filter); `viewer_email` must already be normalized.
    async fn list_saved_views(
        &self,
        workspace_id: &str,
        viewer_email: &str,
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
    ) -> Result<Vec<WorkspaceSavedView>, StoreError> {
        // The shared-∪-own-personal predicate lives entirely here: a row is
        // visible when it is shared, or it is the caller's own personal row.
        // No fetch-all-then-filter — another member's personal row never
        // crosses the store boundary.
        let rows = sqlx::query(
            r#"
            SELECT
                id, workspace_id, name, created_by, created_by_name,
                created_at, updated_at, visibility, view_json
            FROM workspace_saved_views
            WHERE workspace_id = ?
                AND (visibility = 'shared' OR created_by = ?)
            ORDER BY updated_at DESC
            "#,
        )
        .bind(workspace_id)
        .bind(viewer_email)
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
        let record = self
            .store
            .get_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        if record.archived_at.is_some() {
            return Err(WorkspaceError::Archived);
        }
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
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
        // row is read. The shared-∪-own-personal filter is then applied in SQL,
        // scoped to this caller's normalized email.
        self.require_viewer(workspace_id, principal).await?;
        self.store
            .list_saved_views(workspace_id, &normalize_email(&principal.email))
            .await
            .map_err(WorkspaceError::Store)
    }

    pub async fn get_saved_view(
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
        // Never-leak boundary: a personal view is disclosed only to its
        // creator. Any other caller gets NotFound — identical to a missing row,
        // so existence is never confirmed. This is the single read-side gate; a
        // refactor cannot reopen the leak without removing this check.
        ensure_saved_view_readable(&saved_view, principal)?;
        Ok(saved_view)
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
        // member (viewer+) may save one. Shared views remain editor-gated.
        match visibility {
            SavedViewVisibility::Personal => {
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
    ///    personal view the caller cannot see yields `NotFound` (identical to a
    ///    missing row), so even editors/owners/admins never learn it exists.
    /// 3. **creator-only** — a shared view is readable by everyone, but only
    ///    the original creator may re-scope it; anyone else gets `Forbidden`.
    /// 4. **target-visibility authority** — making a view `Shared` is a
    ///    shared-state mutation (exactly like creating a `Shared` view), so it
    ///    additionally requires editor; demoting back to `Personal` needs no
    ///    editor (the creator is merely making their own view private again).
    ///
    /// Returns the (now-confirmed-visible) view so callers can persist without
    /// re-fetching. This is the gate #702 (approve/reject a proposed view)
    /// reuses verbatim: "approve" is exactly a creator/authorized re-scope to
    /// `Shared`, so it can call this with `target_visibility = Shared` and
    /// inherit the same never-leak + creator-only + editor boundary rather than
    /// re-deriving it.
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

/// The personal-view never-leak rule, in one place: a `Personal` view is
/// readable only by its creator (matched on normalized email); everyone else
/// is told `NotFound` so the row's existence is never confirmed. `Shared`
/// views are readable by any viewer (membership is enforced upstream).
fn ensure_saved_view_readable(
    saved_view: &WorkspaceSavedView,
    principal: &AuthPrincipal,
) -> Result<(), WorkspaceError> {
    match saved_view.visibility {
        SavedViewVisibility::Shared => Ok(()),
        SavedViewVisibility::Personal => {
            if saved_view.created_by == normalize_email(&principal.email) {
                Ok(())
            } else {
                Err(WorkspaceError::NotFound)
            }
        }
    }
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
        let err = manager
            .get_workspace_for(&workspace.id, &owner)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));

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
}
