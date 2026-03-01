use std::collections::BTreeMap;

use crate::clock::rfc3339_now;
use crate::constants::{ENGINE_VERSION, SCHEMA_VERSION, SNAPSHOT_MESSAGE_TYPE};
use crate::errors::SessionError;
use crate::id_allocator::{IdAllocator, IdKind};
use crate::model::{
    AttachRequest, ClientRosterEntry, ClientViewMode, CreatedSession, ExposureMode,
    ExposureViewMode, LayerState, LeaseState, PerClientViewState, Permissions, SceneMode,
    SessionSnapshotEnvelope, SessionSnapshotPayload, SessionState, SharedSceneState, SourceRecord,
    WarningEntry,
};
use crate::revision_allocator::RevisionAllocator;

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

#[derive(Debug)]
pub struct SessionManager {
    id_allocator: IdAllocator,
    sessions: BTreeMap<String, SessionRecord>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            id_allocator: IdAllocator::new(),
            sessions: BTreeMap::new(),
        }
    }
}

impl SessionManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_session(&mut self, name: impl Into<String>) -> CreatedSession {
        let session_id = self.id_allocator.allocate(IdKind::Session);
        let scene_id = self.id_allocator.allocate(IdKind::Scene);
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
        if !self.sessions.contains_key(&request.session_id) {
            return Err(SessionError::SessionNotFound {
                session_id: request.session_id,
            });
        }

        let client_id = self.id_allocator.allocate(IdKind::Client);
        let now = rfc3339_now();
        let session = self.session_mut(&request.session_id)?;

        bump_session_rev(session);

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
            client_id,
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
        let permissions =
            Permissions::from_permission(request.requested_permission, is_lease_holder);

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
        let session = self.session_mut(session_id)?;

        let removed = session.clients.remove(client_id);
        if removed.is_none() {
            return Err(SessionError::ClientNotFound {
                session_id: session_id.to_owned(),
                client_id: client_id.to_owned(),
            });
        }

        Ok(bump_session_rev(session))
    }

    pub fn add_source(
        &mut self,
        session_id: &str,
        name: impl Into<String>,
    ) -> Result<SourceRecord, SessionError> {
        if !self.sessions.contains_key(session_id) {
            return Err(SessionError::SessionNotFound {
                session_id: session_id.to_owned(),
            });
        }

        let source = SourceRecord {
            source_id: self.id_allocator.allocate(IdKind::Source),
            name: name.into(),
            latest_working_generation_seq: 0,
        };

        let session = self.session_mut(session_id)?;
        session
            .shared_scene
            .sources
            .insert(source.source_id.clone(), source.clone());
        bump_session_rev(session);
        bump_scene_rev(session);

        Ok(source)
    }

    pub fn bump_source_generation_seq(
        &mut self,
        session_id: &str,
        source_id: &str,
    ) -> Result<u64, SessionError> {
        let session = self.session_mut(session_id)?;

        let generation_seq = {
            let source = session
                .shared_scene
                .sources
                .get_mut(source_id)
                .ok_or_else(|| SessionError::SourceNotFound {
                    session_id: session_id.to_owned(),
                    source_id: source_id.to_owned(),
                })?;

            RevisionAllocator::next_generation_seq(&mut source.latest_working_generation_seq)
        };

        bump_session_rev(session);
        Ok(generation_seq)
    }

    pub fn add_layer(
        &mut self,
        session_id: &str,
        name: impl Into<String>,
    ) -> Result<LayerState, SessionError> {
        if !self.sessions.contains_key(session_id) {
            return Err(SessionError::SessionNotFound {
                session_id: session_id.to_owned(),
            });
        }

        let mut layer = LayerState {
            layer_id: self.id_allocator.allocate(IdKind::Layer),
            name: name.into(),
            layer_rev: 0,
            metadata_rev: 0,
            write_rev: 0,
        };
        RevisionAllocator::next_layer_rev(&mut layer.layer_rev);

        let session = self.session_mut(session_id)?;
        session
            .shared_scene
            .layer_order
            .push(layer.layer_id.clone());
        session
            .shared_scene
            .layers
            .insert(layer.layer_id.clone(), layer.clone());
        bump_session_rev(session);
        bump_scene_rev(session);

        Ok(layer)
    }

    pub fn bump_layer_revision(
        &mut self,
        session_id: &str,
        layer_id: &str,
    ) -> Result<u64, SessionError> {
        let session = self.session_mut(session_id)?;

        let next_layer_rev = {
            let layer = session
                .shared_scene
                .layers
                .get_mut(layer_id)
                .ok_or_else(|| SessionError::LayerNotFound {
                    session_id: session_id.to_owned(),
                    layer_id: layer_id.to_owned(),
                })?;
            RevisionAllocator::next_layer_rev(&mut layer.layer_rev)
        };

        bump_session_rev(session);
        bump_scene_rev(session);
        Ok(next_layer_rev)
    }

    pub fn bump_layer_metadata_revision(
        &mut self,
        session_id: &str,
        layer_id: &str,
    ) -> Result<u64, SessionError> {
        let session = self.session_mut(session_id)?;

        let next_metadata_rev = {
            let layer = session
                .shared_scene
                .layers
                .get_mut(layer_id)
                .ok_or_else(|| SessionError::LayerNotFound {
                    session_id: session_id.to_owned(),
                    layer_id: layer_id.to_owned(),
                })?;
            RevisionAllocator::next_metadata_rev(&mut layer.metadata_rev)
        };

        bump_session_rev(session);
        Ok(next_metadata_rev)
    }

    pub fn bump_layer_write_revision(
        &mut self,
        session_id: &str,
        layer_id: &str,
    ) -> Result<u64, SessionError> {
        let session = self.session_mut(session_id)?;

        let next_write_rev = {
            let layer = session
                .shared_scene
                .layers
                .get_mut(layer_id)
                .ok_or_else(|| SessionError::LayerNotFound {
                    session_id: session_id.to_owned(),
                    layer_id: layer_id.to_owned(),
                })?;
            RevisionAllocator::next_write_rev(&mut layer.write_rev)
        };

        bump_session_rev(session);
        Ok(next_write_rev)
    }

    pub fn update_client_view_mode(
        &mut self,
        session_id: &str,
        client_id: &str,
        view_mode: ClientViewMode,
    ) -> Result<u64, SessionError> {
        let session = self.session_mut(session_id)?;

        let next_view_rev =
            {
                let client = session.clients.get_mut(client_id).ok_or_else(|| {
                    SessionError::ClientNotFound {
                        session_id: session_id.to_owned(),
                        client_id: client_id.to_owned(),
                    }
                })?;
                client.view_state.view_mode = view_mode;
                RevisionAllocator::next_view_rev(&mut client.view_state.view_rev)
            };

        bump_session_rev(session);
        Ok(next_view_rev)
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut SessionRecord, SessionError> {
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| SessionError::SessionNotFound {
                session_id: session_id.to_owned(),
            })
    }
}

fn bump_session_rev(session: &mut SessionRecord) -> u64 {
    RevisionAllocator::next_session_rev(&mut session.session_state.session_rev)
}

fn bump_scene_rev(session: &mut SessionRecord) -> u64 {
    let scene_rev = RevisionAllocator::next_scene_rev(&mut session.session_state.scene_rev);
    session.shared_scene.scene_rev = scene_rev;
    scene_rev
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

#[cfg(test)]
mod tests {
    use crate::constants::{SCHEMA_VERSION, SNAPSHOT_MESSAGE_TYPE};
    use crate::errors::SessionError;
    use crate::model::{AttachRequest, ClientViewMode, PermissionClass};

    use super::SessionManager;

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

    #[test]
    fn handles_revision_families_for_source_layer_and_view() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("revision-session");

        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");

        let source = manager
            .add_source(&created.session_id, "source-a")
            .expect("source add should succeed");
        let gen_1 = manager
            .bump_source_generation_seq(&created.session_id, &source.source_id)
            .expect("generation bump 1 should succeed");
        let gen_2 = manager
            .bump_source_generation_seq(&created.session_id, &source.source_id)
            .expect("generation bump 2 should succeed");

        let layer = manager
            .add_layer(&created.session_id, "layer-a")
            .expect("layer add should succeed");
        let layer_rev = manager
            .bump_layer_revision(&created.session_id, &layer.layer_id)
            .expect("layer rev bump should succeed");
        let metadata_rev = manager
            .bump_layer_metadata_revision(&created.session_id, &layer.layer_id)
            .expect("metadata rev bump should succeed");
        let write_rev = manager
            .bump_layer_write_revision(&created.session_id, &layer.layer_id)
            .expect("write rev bump should succeed");
        let view_rev = manager
            .update_client_view_mode(
                &created.session_id,
                &attached.snapshot.client_view.client_id,
                ClientViewMode::ThreeD,
            )
            .expect("view rev bump should succeed");

        assert!(source.source_id.starts_with("src_"));
        assert!(layer.layer_id.starts_with("lay_"));
        assert_eq!(gen_1, 1);
        assert_eq!(gen_2, 2);
        assert_eq!(layer_rev, 2);
        assert_eq!(metadata_rev, 1);
        assert_eq!(write_rev, 1);
        assert_eq!(view_rev, 1);
    }
}
