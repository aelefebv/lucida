//! Workspace persistence: the `WorkspaceStore` trait plus the shared
//! error type and normalization helpers its implementation uses.
//!
//! The trait is the seam between `WorkspaceManager` and storage — the
//! manager holds `Arc<dyn WorkspaceStore>`, so authorization and live-session
//! logic never see SQL. The production backend is [`SqliteWorkspaceStore`].

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lucida_content::DatasetId;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use thiserror::Error;

use super::types::{
    SavedViewVisibility, WorkspaceAdminDetails, WorkspaceAdminSummary, WorkspaceDatasetSource,
    WorkspaceLinkAccess, WorkspaceMember, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceSharingSettings, WorkspaceSummary, WorkspaceUserState, WorkspaceViewerProfile,
};

mod sqlite;

pub use sqlite::SqliteWorkspaceStore;

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

pub(crate) fn normalize_email(email: &str) -> String {
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

#[async_trait]
pub trait WorkspaceStore: Send + Sync + 'static {
    async fn create_workspace(
        &self,
        owner: &AuthPrincipal,
        name: Option<&str>,
    ) -> Result<WorkspaceRecord, StoreError>;

    /// Deep-copy `source_workspace_id` into a brand-new workspace owned by
    /// `owner`, named `name`, in ONE transaction. The copy COPIES:
    /// dataset memberships (with their per-workspace display names), the
    /// **Shared** saved views (re-attributed to `owner`, kept Shared), the
    /// active/default-view pointer (remapped to the copied view), and the
    /// document. The copy DOES NOT copy `workspace_members` (only the owner
    /// row), link access, or any other sharing/permission: it is created with
    /// the new-workspace defaults (restricted, owner-only, link OFF) so the
    /// source's membership/permission set can never leak into the duplicate.
    ///
    /// Dataset memberships get FRESH workspace-local ids; the document and the
    /// copied saved views are remapped onto those fresh ids so the copy
    /// resolves entirely against its own `workspace_datasets` (no dangling
    /// references to the source). `Ok(None)` if the source row is missing.
    async fn duplicate_workspace(
        &self,
        source_workspace_id: &str,
        owner: &AuthPrincipal,
        name: &str,
    ) -> Result<Option<WorkspaceRecord>, StoreError>;

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
