//! REST/WebSocket surface for workspaces: [`WorkspacesState`], the
//! [`router`] builder `main.rs` merges into the protected router half, the
//! request/response DTOs, and the handlers. Handlers stay thin — they read
//! the `AuthPrincipal` extension and delegate to [`WorkspaceManager`].

use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::http::header::{LOCATION, ORIGIN};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, patch, post};
use axum::{Extension, Router};
use chrono::{DateTime, Utc};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::quota::MAX_CLIENT_MESSAGE_BYTES;
use lucida_core::saved_view::SavedView;
use serde::{Deserialize, Serialize};

use crate::auth::AdminRequired;
use crate::handler;
use crate::origin::OriginPolicy;

use super::manager::WorkspaceManager;
use super::types::{
    SavedViewVisibility, WorkspaceLinkAccess, WorkspaceRecord, WorkspaceRole, WorkspaceUserState,
};

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
            "/api/workspaces/{workspace_id}/duplicate",
            post(duplicate_workspace),
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

#[derive(Debug, Default, Deserialize)]
pub struct DuplicateWorkspaceRequest {
    /// Optional name override for the copy. When absent (or blank) the copy is
    /// named `Copy of <source name>`.
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
    /// Omit only when creating a new profile. Updates must compare against the
    /// revision returned by GET/PUT so concurrent writers cannot silently win.
    #[serde(default)]
    pub expected_revision: Option<u64>,
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
    pub(crate) fn from_record(record: WorkspaceRecord, role: WorkspaceRole) -> Self {
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

async fn duplicate_workspace(
    State(state): State<WorkspacesState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(workspace_id): Path<String>,
    body: Option<Json<DuplicateWorkspaceRequest>>,
) -> Response {
    let name = body.as_ref().and_then(|Json(body)| body.name.as_deref());
    match state
        .manager
        .duplicate_workspace(&workspace_id, &principal, name)
        .await
    {
        // The caller always owns the copy.
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
            body.expected_revision,
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
    origin_policy: Option<Extension<OriginPolicy>>,
    lifecycle: Option<Extension<crate::health::RuntimeLifecycle>>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // CORS middleware does not protect WebSocket upgrades. Apply the same
    // authoritative policy here before restoring or attaching a workspace.
    // Originless requests are the documented non-browser client contract. A
    // browser Origin without an installed policy fails closed so a test or
    // alternate router cannot accidentally bypass production admission.
    let browser_origin_allowed = match origin_policy {
        Some(Extension(policy)) => policy.allows_headers(&headers),
        None => !headers.contains_key(ORIGIN),
    };
    if !browser_origin_allowed {
        tracing::warn!(workspace_id, "ws.origin_denied");
        return StatusCode::FORBIDDEN.into_response();
    }

    let attachment = match state
        .manager
        .attach_workspace(&workspace_id, &principal)
        .await
    {
        Ok(attachment) => attachment,
        Err(e) => return e.into_response(),
    };
    let lifecycle = lifecycle
        .map(|Extension(lifecycle)| lifecycle)
        .unwrap_or_default();
    let manager = Arc::clone(&state.manager);
    let Some(client_id) = attachment.next_client_id() else {
        tracing::error!(
            workspace_id = %attachment.workspace_id,
            "ws.workspace_client_id_exhausted"
        );
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.max_message_size(MAX_CLIENT_MESSAGE_BYTES)
        .max_frame_size(MAX_CLIENT_MESSAGE_BYTES)
        .write_buffer_size(0)
        .max_write_buffer_size(crate::outbox::MAX_SOCKET_WRITE_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            tracing::info!(client_id, workspace_id = %attachment.workspace_id, "ws.workspace_client_connected");
            handler::handle_workspace_client(
                client_id,
                socket,
                attachment,
                manager,
                principal,
                lifecycle,
            )
            .await;
        })
    .into_response()
}
