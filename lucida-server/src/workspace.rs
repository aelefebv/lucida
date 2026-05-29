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
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::{Extension, Router};
use chrono::{DateTime, Utc};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::scene::DocumentState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Row, SqlitePool};
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
    pub document: DocumentState,
}

#[derive(Debug, Clone)]
pub struct WorkspaceDatasetSource {
    pub workspace_dataset_id: DatasetId,
    pub dataset_source_id: String,
    pub canonical_url: String,
    pub display_name: String,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
    #[error("workspace document json failed to parse: {0}")]
    InvalidDocument(String),
    #[error("workspace role is invalid: {0}")]
    InvalidRole(String),
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

    async fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRecord>, StoreError>;

    async fn role_for(
        &self,
        workspace_id: &str,
        principal: &AuthPrincipal,
    ) -> Result<Option<WorkspaceRole>, StoreError>;

    async fn rename_workspace(
        &self,
        workspace_id: &str,
        name: &str,
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
}

#[derive(Clone)]
pub struct SqliteWorkspaceStore {
    pool: SqlitePool,
}

impl SqliteWorkspaceStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
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
            document,
        })
    }

    async fn list_workspaces(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<Vec<WorkspaceSummary>, StoreError> {
        let rows = if principal.is_admin {
            sqlx::query(
                r#"
                SELECT
                    w.id, w.name, w.created_by, w.created_at, w.updated_at,
                    w.archived_at, w.seq, 'owner' AS role,
                    COALESCE(COUNT(wd.id), 0) AS dataset_count
                FROM workspaces w
                LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
                WHERE w.archived_at IS NULL
                GROUP BY w.id
                ORDER BY w.updated_at DESC
                "#,
            )
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?
        } else {
            let email = normalize_email(&principal.email);
            sqlx::query(
                r#"
                SELECT
                    w.id, w.name, w.created_by, w.created_at, w.updated_at,
                    w.archived_at, w.seq, wm.role,
                    COALESCE(COUNT(wd.id), 0) AS dataset_count
                FROM workspaces w
                INNER JOIN workspace_members wm ON wm.workspace_id = w.id
                LEFT JOIN workspace_datasets wd ON wd.workspace_id = w.id
                WHERE wm.email = ? AND w.archived_at IS NULL
                GROUP BY w.id
                ORDER BY w.updated_at DESC
                "#,
            )
            .bind(email)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sql)?
        };

        rows.into_iter().map(row_to_summary).collect()
    }

    async fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceRecord>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT id, name, created_by, created_at, updated_at, archived_at, seq, document_json
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
            SELECT wm.role
            FROM workspace_members wm
            INNER JOIN workspaces w ON w.id = wm.workspace_id
            WHERE wm.workspace_id = ? AND wm.email = ? AND w.archived_at IS NULL
            "#,
        )
        .bind(workspace_id)
        .bind(email)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        row.map(|r| WorkspaceRole::try_from(r.get::<String, _>("role").as_str()))
            .transpose()
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

        Ok(rows
            .into_iter()
            .map(|row| WorkspaceDatasetSource {
                workspace_dataset_id: DatasetId(row.get::<String, _>("workspace_dataset_id")),
                dataset_source_id: row.get("dataset_source_id"),
                canonical_url: row.get("canonical_url"),
                display_name: row.get("display_name"),
            })
            .collect())
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
        document: serde_json::from_str(&document_json).map_err(map_json_in)?,
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
        let role = self
            .store
            .role_for(workspace_id, principal)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::Forbidden)?;
        let record = self
            .store
            .get_workspace(workspace_id)
            .await
            .map_err(WorkspaceError::Store)?
            .ok_or(WorkspaceError::NotFound)?;
        if record.archived_at.is_some() {
            return Err(WorkspaceError::Archived);
        }
        Ok((record, role))
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
        .route(
            "/api/workspaces/{workspace_id}",
            get(get_workspace).patch(rename_workspace),
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
}

impl WorkspaceResponse {
    fn from_record(record: WorkspaceRecord, role: WorkspaceRole) -> Self {
        Self {
            id: record.id,
            name: record.name,
            role,
            created_by: record.created_by,
            created_at: record.created_at,
            updated_at: record.updated_at,
            archived_at: record.archived_at,
            seq: record.seq,
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
    async fn dataset_membership_and_document_persist_together() {
        let store = fresh_store().await;
        let owner = principal("owner@example.com", false);
        let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();
        let mut doc = DocumentState::default();
        doc.manifests.insert(
            DatasetId("ds_source".into()),
            lucida_content::DatasetManifest::new(
                DatasetId("ds_source".into()),
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
                &DatasetId("ds_source".into()),
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
        assert_eq!(
            sources[0].workspace_dataset_id,
            DatasetId("ds_source".into())
        );

        let restored = store.get_workspace(&workspace.id).await.unwrap().unwrap();
        assert_eq!(restored.seq, 1);
        assert!(
            restored
                .document
                .manifests
                .contains_key(&DatasetId("ds_source".into()))
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
