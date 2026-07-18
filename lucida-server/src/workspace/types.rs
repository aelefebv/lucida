//! Domain vocabulary shared by every workspace layer: the role /
//! link-access / saved-view-visibility enums (with their persisted TEXT
//! forms) and the record/summary structs the store returns and the HTTP
//! layer serializes.

use chrono::{DateTime, Utc};
use lucida_content::DatasetId;
use lucida_content::url::{SourceIdentity, SourceRevision};
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;
use serde::{Deserialize, Serialize};

use super::store::StoreError;

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
    pub identity: SourceIdentity,
    /// `None` is accepted only for rows written before source revisions were
    /// introduced; the next successful import upgrades the membership.
    pub revision: Option<SourceRevision>,
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
    pub revision: u64,
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
