use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionClass {
    View,
    Control,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposureViewMode {
    Open,
    TokenRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneMode {
    Live,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientViewMode {
    TwoD,
    ThreeD,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarningSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WarningCode {
    UncalibratedOverlay,
    StaleDerivedLayer,
    IncompleteLabelIndex,
    ComputedAtLod,
    GenerationBuildIncomplete,
    MissingActiveLayer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarningEntry {
    pub warning_code: WarningCode,
    pub severity: WarningSeverity,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExposureMode {
    pub lan_enabled: bool,
    pub view_mode: ExposureViewMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseState {
    pub lease_holder_client_id: Option<String>,
    pub lease_holder_label: Option<String>,
    pub acquired_at: Option<String>,
    pub stealable: bool,
    pub expires_at: Option<String>,
}

impl Default for LeaseState {
    fn default() -> Self {
        Self {
            lease_holder_client_id: None,
            lease_holder_label: None,
            acquired_at: None,
            stealable: true,
            expires_at: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseChangeKind {
    Requested,
    Stolen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditEventKind {
    LeaseRequested,
    LeaseStolen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditLogEntry {
    pub session_rev: u64,
    pub event_kind: AuditEventKind,
    pub actor_client_id: String,
    pub actor_label: String,
    pub previous_lease_holder_client_id: Option<String>,
    pub previous_lease_holder_label: Option<String>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub session_id: String,
    pub name: String,
    pub schema_version: String,
    pub engine_version: String,
    pub created_at: String,
    pub session_rev: u64,
    pub scene_rev: u64,
    pub lease_state: LeaseState,
    pub exposure_mode: ExposureMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientRosterEntry {
    pub client_id: String,
    pub label: String,
    pub permission_class: PermissionClass,
    pub connected_at: String,
    pub last_seen_at: String,
    pub is_lease_holder: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRecord {
    pub source_id: String,
    pub name: String,
    pub latest_working_generation_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasetBinding {
    pub dataset_id: String,
    pub source_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerState {
    pub layer_id: String,
    pub name: String,
    pub layer_rev: u64,
    pub metadata_rev: u64,
    pub write_rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetState {
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedSceneState {
    pub scene_rev: u64,
    pub scene_id: String,
    pub name: String,
    pub mode: SceneMode,
    pub sources: BTreeMap<String, SourceRecord>,
    pub datasets: BTreeMap<String, DatasetBinding>,
    pub layers: BTreeMap<String, LayerState>,
    pub layer_order: Vec<String>,
    pub targets: BTreeMap<String, TargetState>,
    pub warnings: Vec<WarningEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerClientViewState {
    pub client_id: String,
    pub view_rev: u64,
    pub view_mode: ClientViewMode,
    pub active_layer_id: Option<String>,
    pub warnings: Vec<WarningEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permissions {
    pub permission_class: PermissionClass,
    pub can_edit_shared_scene: bool,
    pub can_publish_derived: bool,
    pub is_lease_holder: bool,
}

impl Permissions {
    pub(crate) fn from_permission(
        permission_class: PermissionClass,
        is_lease_holder: bool,
    ) -> Self {
        let can_edit_shared_scene = is_lease_holder
            && matches!(
                permission_class,
                PermissionClass::Control | PermissionClass::Admin
            );
        let can_publish_derived = matches!(
            permission_class,
            PermissionClass::Control | PermissionClass::Admin
        );

        Self {
            permission_class,
            can_edit_shared_scene,
            can_publish_derived,
            is_lease_holder,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshotPayload {
    pub session: SessionState,
    pub shared_scene: SharedSceneState,
    pub client_view: PerClientViewState,
    pub permissions: Permissions,
    pub lease_state: LeaseState,
    pub client_roster: Vec<ClientRosterEntry>,
    pub warnings: Vec<WarningEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshotEnvelope {
    pub message_type: String,
    pub schema_version: String,
    pub session_id: String,
    pub session_rev: u64,
    pub snapshot: SessionSnapshotPayload,
    pub emitted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedSession {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachRequest {
    pub session_id: String,
    pub client_label: String,
    pub requested_permission: PermissionClass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconnectRequest {
    pub session_id: String,
    pub previous_client_id: Option<String>,
    pub client_label: String,
    pub requested_permission: PermissionClass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeartbeatEnvelope {
    pub message_type: String,
    pub schema_version: String,
    pub session_id: String,
    pub client_id: String,
    pub session_rev: u64,
    pub sent_at: String,
}
