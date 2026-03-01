use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub const SCHEMA_VERSION: &str = "lucida-proto-0.1";
pub const ENGINE_VERSION: &str = "0.1.0";
pub const SNAPSHOT_MESSAGE_TYPE: &str = "session.snapshot";

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarningEntry {
    pub warning_code: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourceRecord;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DatasetBinding;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LayerState;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TargetState;

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
    fn from(permission_class: PermissionClass, is_lease_holder: bool) -> Self {
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
pub enum SessionError {
    SessionNotFound {
        session_id: String,
    },
    ClientNotFound {
        session_id: String,
        client_id: String,
    },
}

impl Display for SessionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::SessionNotFound { session_id } => {
                write!(f, "session `{session_id}` was not found")
            }
            SessionError::ClientNotFound {
                session_id,
                client_id,
            } => write!(
                f,
                "client `{client_id}` was not found in session `{session_id}`"
            ),
        }
    }
}

impl Error for SessionError {}

#[derive(Debug)]
struct ClientRecord {
    roster_entry: ClientRosterEntry,
    view_state: PerClientViewState,
}

#[derive(Debug)]
struct SessionRecord {
    session_state: SessionState,
    shared_scene: SharedSceneState,
    lease_state: LeaseState,
    clients: BTreeMap<String, ClientRecord>,
}

#[derive(Debug, Default)]
pub struct SessionManager {
    next_session_index: u64,
    next_scene_index: u64,
    next_client_index: u64,
    sessions: BTreeMap<String, SessionRecord>,
}

impl SessionManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_session(&mut self, name: impl Into<String>) -> CreatedSession {
        self.next_session_index += 1;
        self.next_scene_index += 1;

        let session_id = format!("sess_{:08}", self.next_session_index);
        let scene_id = format!("scn_{:08}", self.next_scene_index);
        let now = rfc3339_now();
        let session_name = name.into();

        let session_state = SessionState {
            session_id: session_id.clone(),
            name: session_name.clone(),
            schema_version: SCHEMA_VERSION.to_owned(),
            engine_version: ENGINE_VERSION.to_owned(),
            created_at: now,
            session_rev: 0,
            scene_rev: 0,
            lease_state: LeaseState::default(),
            exposure_mode: ExposureMode {
                lan_enabled: true,
                view_mode: ExposureViewMode::Open,
            },
        };

        let shared_scene = SharedSceneState {
            scene_rev: 0,
            scene_id,
            name: format!("{session_name}-scene"),
            mode: SceneMode::Live,
            sources: BTreeMap::new(),
            datasets: BTreeMap::new(),
            layers: BTreeMap::new(),
            layer_order: Vec::new(),
            targets: BTreeMap::new(),
            warnings: Vec::new(),
        };

        let record = SessionRecord {
            session_state,
            shared_scene,
            lease_state: LeaseState::default(),
            clients: BTreeMap::new(),
        };

        self.sessions.insert(session_id.clone(), record);
        CreatedSession { session_id }
    }

    pub fn attach_client(
        &mut self,
        request: AttachRequest,
    ) -> Result<SessionSnapshotEnvelope, SessionError> {
        let session = self.sessions.get_mut(&request.session_id).ok_or_else(|| {
            SessionError::SessionNotFound {
                session_id: request.session_id.clone(),
            }
        })?;
        self.next_client_index += 1;
        let client_id = format!("cli_{:08}", self.next_client_index);
        let now = rfc3339_now();

        session.session_state.session_rev += 1;

        let is_lease_holder = session
            .lease_state
            .lease_holder_client_id
            .as_deref()
            .is_some_and(|holder| holder == client_id);

        let roster_entry = ClientRosterEntry {
            client_id: client_id.clone(),
            label: request.client_label,
            permission_class: request.requested_permission,
            connected_at: now.clone(),
            last_seen_at: now.clone(),
            is_lease_holder,
        };

        let view_state = PerClientViewState {
            client_id: client_id.clone(),
            view_rev: 0,
            view_mode: ClientViewMode::TwoD,
            active_layer_id: None,
            warnings: Vec::new(),
        };

        session.clients.insert(
            client_id.clone(),
            ClientRecord {
                roster_entry: roster_entry.clone(),
                view_state: view_state.clone(),
            },
        );

        let client_roster = session
            .clients
            .values()
            .map(|client| client.roster_entry.clone())
            .collect::<Vec<_>>();
        let warnings = collect_snapshot_warnings(session);
        let permissions = Permissions::from(request.requested_permission, is_lease_holder);

        Ok(SessionSnapshotEnvelope {
            message_type: SNAPSHOT_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: session.session_state.session_id.clone(),
            session_rev: session.session_state.session_rev,
            snapshot: SessionSnapshotPayload {
                session: session.session_state.clone(),
                shared_scene: session.shared_scene.clone(),
                client_view: view_state,
                permissions,
                lease_state: session.lease_state.clone(),
                client_roster,
                warnings,
            },
            emitted_at: now,
        })
    }

    pub fn detach_client(
        &mut self,
        session_id: &str,
        client_id: &str,
    ) -> Result<u64, SessionError> {
        let session =
            self.sessions
                .get_mut(session_id)
                .ok_or_else(|| SessionError::SessionNotFound {
                    session_id: session_id.to_owned(),
                })?;

        let removed = session.clients.remove(client_id);
        if removed.is_none() {
            return Err(SessionError::ClientNotFound {
                session_id: session_id.to_owned(),
                client_id: client_id.to_owned(),
            });
        }

        session.session_state.session_rev += 1;
        Ok(session.session_state.session_rev)
    }
}

fn collect_snapshot_warnings(session: &SessionRecord) -> Vec<WarningEntry> {
    let mut warnings = Vec::new();
    warnings.extend(session.shared_scene.warnings.iter().cloned());

    let client_warnings = session
        .clients
        .values()
        .flat_map(|client| client.view_state.warnings.iter().cloned())
        .collect::<Vec<_>>();
    warnings.extend(client_warnings);

    warnings
}

fn rfc3339_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("rfc3339 formatting should not fail for utc timestamps")
}

#[cfg(test)]
mod tests {
    use super::{
        AttachRequest, PermissionClass, SCHEMA_VERSION, SNAPSHOT_MESSAGE_TYPE, SessionError,
        SessionManager,
    };

    #[test]
    fn create_session_and_attach_returns_full_snapshot() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("main-lab-session");

        let snapshot = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice-laptop".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        assert_eq!(snapshot.message_type, SNAPSHOT_MESSAGE_TYPE);
        assert_eq!(snapshot.schema_version, SCHEMA_VERSION);
        assert_eq!(snapshot.session_id, created.session_id);
        assert_eq!(snapshot.session_rev, 1);
        assert_eq!(snapshot.snapshot.session.session_rev, 1);
        assert_eq!(snapshot.snapshot.client_roster.len(), 1);
        assert_eq!(
            snapshot.snapshot.client_roster[0].client_id,
            snapshot.snapshot.client_view.client_id
        );
        assert_eq!(
            snapshot.snapshot.permissions.permission_class,
            PermissionClass::View
        );
        assert!(!snapshot.snapshot.permissions.can_edit_shared_scene);
        assert!(!snapshot.snapshot.client_view.client_id.is_empty());
        assert!(snapshot.snapshot.shared_scene.scene_id.starts_with("scn_"));
    }

    #[test]
    fn attaching_multiple_clients_updates_roster_and_session_revision() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("collab-session");

        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");

        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id,
                client_label: "bob".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("second attach should succeed");

        assert_eq!(first.session_rev, 1);
        assert_eq!(second.session_rev, 2);
        assert_eq!(second.snapshot.client_roster.len(), 2);
        assert_ne!(
            first.snapshot.client_view.client_id,
            second.snapshot.client_view.client_id
        );
    }

    #[test]
    fn attach_to_unknown_session_returns_error() {
        let mut manager = SessionManager::new();

        let result = manager.attach_client(AttachRequest {
            session_id: "sess_missing".to_owned(),
            client_label: "alice".to_owned(),
            requested_permission: PermissionClass::View,
        });

        assert_eq!(
            result,
            Err(SessionError::SessionNotFound {
                session_id: "sess_missing".to_owned()
            })
        );
    }

    #[test]
    fn detach_client_removes_client_from_session() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("detach-session");

        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");
        let detached_revision = manager
            .detach_client(
                &created.session_id,
                &attached.snapshot.client_view.client_id,
            )
            .expect("detach should succeed");
        let reattach = manager
            .attach_client(AttachRequest {
                session_id: created.session_id,
                client_label: "bob".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("reattach should succeed");

        assert_eq!(detached_revision, 2);
        assert_eq!(reattach.session_rev, 3);
        assert_eq!(reattach.snapshot.client_roster.len(), 1);
        assert_eq!(reattach.snapshot.client_roster[0].label, "bob");
    }
}
