//! Workspace store, live workspace registry, and REST/WebSocket routes.
//!
//! A workspace is the durable collaboration/document boundary. The
//! `WorkspaceManager` owns authorization, lazy live-session restore, and
//! persistence around shared document commands; handlers should not
//! reach into the SQLite store or live session map directly.
//!
//! Module layout:
//!
//! - [`types`] — the domain vocabulary: role / link-access / saved-view
//!   visibility enums and the record/summary structs every other layer
//!   exchanges.
//! - [`store`] — the `WorkspaceStore` trait (the persistence seam the
//!   manager programs against) and `SqliteWorkspaceStore`, the production
//!   SQLite backend with its row mappers.
//! - [`manager`] — `LiveWorkspace` + `WorkspaceManager`: live-session
//!   lifecycle (lazy restore, idle eviction), membership/link
//!   authorization, saved views and their approval flow, viewer profiles,
//!   document persistence, and `WorkspaceError` with its HTTP mapping.
//! - [`http`] — the REST/WebSocket surface: request/response DTOs, the
//!   handlers, and the [`router`] builder `main.rs` merges into the
//!   protected router half.

pub mod http;
pub mod manager;
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
pub use manager::{LiveWorkspace, WorkspaceError, WorkspaceManager, WorkspaceRuntimeConfig};
pub use store::{SqliteWorkspaceStore, StoreError, WorkspaceStore};
pub use types::{
    SavedViewVisibility, WorkspaceAdminDetails, WorkspaceAdminSummary, WorkspaceDatasetSource,
    WorkspaceLinkAccess, WorkspaceMember, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceSharingSettings, WorkspaceSummary, WorkspaceUserState, WorkspaceViewerProfile,
};
