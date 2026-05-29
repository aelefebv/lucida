//! Workspace store, live workspace registry, and REST/WebSocket routes.
//!
//! A workspace is the durable collaboration/document boundary. The
//! `WorkspaceManager` owns authorization, lazy live-session restore, and
//! persistence around shared document commands; handlers should not
//! reach into the SQLite store or live session map directly.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
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
    pub view: SavedView,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceUserState {
    pub workspace_id: String,
    pub last_opened_at: Option<DateTime<Utc>>,
    pub pinned_at: Option<DateTime<Utc>>,
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

    async fn list_saved_views(
        &self,
        workspace_id: &str,
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

    async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        saved_view_id: Option<&str>,
    ) -> Result<Option<WorkspaceRecord>, StoreError>;

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
            SELECT workspace_id, last_opened_at, pinned_at
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
    ) -> Result<Vec<WorkspaceSavedView>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT
                id, workspace_id, name, created_by, created_by_name,
                created_at, updated_at, view_json
            FROM workspace_saved_views
            WHERE workspace_id = ?
            ORDER BY updated_at DESC
            "#,
        )
        .bind(workspace_id)
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
                created_at, updated_at, view_json
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
                (id, workspace_id, name, created_by, created_by_name, created_at, updated_at, view_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(workspace_id)
        .bind(name)
        .bind(&created_by_email)
        .bind(&created_by.display_name)
        .bind(&now_s)
        .bind(&now_s)
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
    })
}

pub struct LiveWorkspace {
    pub workspace_id: String,
    pub session: Arc<Mutex<Session>>,
    pub tx: broadcast::Sender<BroadcastItem>,
    pub unicast_routes: UnicastRoutes,
    next_id: AtomicU64,
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
        }
    }

    pub fn next_client_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
}

pub struct WorkspaceManager {
    store: Arc<dyn WorkspaceStore>,
    live: Mutex<HashMap<String, Arc<LiveWorkspace>>>,
    proxy_config: ProxyConfig,
}

impl WorkspaceManager {
    pub fn new(store: Arc<dyn WorkspaceStore>, proxy_config: ProxyConfig) -> Self {
        Self {
            store,
            live: Mutex::new(HashMap::new()),
            proxy_config,
        }
    }

    pub fn store(&self) -> Arc<dyn WorkspaceStore> {
        Arc::clone(&self.store)
    }

    pub fn proxy_config(&self) -> ProxyConfig {
        self.proxy_config.clone()
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
        self.require_viewer(workspace_id, principal).await?;
        self.store
            .list_saved_views(workspace_id)
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
        self.store
            .get_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)
    }

    pub async fn create_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        name: &str,
        view: SavedView,
    ) -> Result<WorkspaceSavedView, WorkspaceError> {
        self.require_editor(workspace_id, principal).await?;
        let name = normalize_saved_view_name(name)?;
        let view = workspace_saved_view_payload(view);
        self.store
            .create_saved_view(workspace_id, &name, principal, view)
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
        self.require_editor(workspace_id, principal).await?;
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
        self.require_editor(workspace_id, principal).await?;
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

    pub async fn set_default_saved_view(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
        saved_view_id: Option<&str>,
    ) -> Result<(WorkspaceRecord, WorkspaceRole), WorkspaceError> {
        let role = self.require_editor(workspace_id, principal).await?;
        if let Some(saved_view_id) = saved_view_id {
            self.store
                .get_saved_view(workspace_id, saved_view_id)
                .await
                .map_err(WorkspaceError::Store)?
                .ok_or(WorkspaceError::NotFound)?;
        }
        self.store
            .set_default_saved_view(workspace_id, saved_view_id)
            .await
            .map_err(WorkspaceError::Store)?
            .map(|record| (record, role))
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

    pub async fn live_workspace(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Arc<LiveWorkspace>, WorkspaceError> {
        let (_record, _role) = self.get_workspace_for(workspace_id, principal).await?;

        if let Some(live) = self.live.lock().await.get(workspace_id).cloned() {
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
            "/api/workspaces/{workspace_id}/default-saved-view",
            patch(update_workspace_default_saved_view),
        )
        .route(
            "/api/workspaces/{workspace_id}/pin",
            patch(update_workspace_pin),
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
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceSavedViewRequest {
    pub name: Option<String>,
    pub view: Option<SavedView>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceDefaultSavedViewRequest {
    pub saved_view_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspacePinRequest {
    pub pinned: bool,
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
        .create_saved_view(&workspace_id, &principal, &body.name, body.view)
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
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

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
    async fn workspace_router_builds_with_archived_static_route() {
        let store = fresh_store().await;
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store),
            ProxyConfig::defaults(),
        ));
        let _router = router(manager);
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
            .create_saved_view(&a.id, &owner, "  morphology view  ", view)
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
            .create_saved_view(&workspace.id, &owner, "view", SavedView::empty([800, 600]))
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
            )
            .await
            .unwrap();
        let other_saved = manager
            .create_saved_view(
                &other_workspace.id,
                &owner,
                "other default",
                SavedView::empty([800, 600]),
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
