//! Workspace store, live workspace registry, and REST/WebSocket routes.
//!
//! A workspace is the durable collaboration/document boundary. The
//! `WorkspaceManager` owns authorization, lazy live-session restore, and
//! persistence around shared document commands; handlers should not
//! reach into the store or live session map directly.

pub mod http;
pub mod manager;
pub mod preview;
pub mod store;
pub mod types;

#[cfg(test)]
pub mod tests;

pub use http::{
    AdminUpsertOwnerRequest, AdminWorkspaceSearchQuery, CreateWorkspaceRequest,
    CreateWorkspaceSavedViewRequest, DuplicateWorkspaceRequest, RenameWorkspaceRequest,
    SetWorkspaceSavedViewVisibilityRequest, UpdateLinkAccessRequest, UpdateMemberRoleRequest,
    UpdateWorkspaceDefaultSavedViewRequest, UpdateWorkspaceLastViewRequest,
    UpdateWorkspacePinRequest, UpdateWorkspaceSavedViewRequest, UpsertMemberRequest,
    UpsertWorkspaceViewerProfileRequest, WorkspaceResponse, WorkspacesState, router,
};
pub use manager::{
    CommandApplyError, LiveWorkspace, WorkspaceError, WorkspaceManager, WorkspaceRuntimeConfig,
};
pub use store::{PostgresWorkspaceStore, SqliteWorkspaceStore, StoreError, WorkspaceStore};
pub use types::{
    NewWorkspacePreview, PreviewWrite, SavedViewVisibility, WorkspaceAdminDetails,
    WorkspaceAdminSummary, WorkspaceDatasetSource, WorkspaceLinkAccess, WorkspaceMember,
    WorkspacePreview, WorkspacePreviewMeta, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceSharingSettings, WorkspaceSummary, WorkspaceUserState, WorkspaceViewerProfile,
};
