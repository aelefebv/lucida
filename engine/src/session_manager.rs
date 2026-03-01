use std::collections::BTreeMap;

use crate::clock::rfc3339_now;
use crate::constants::{
    ENGINE_VERSION, HEARTBEAT_MESSAGE_TYPE, SCHEMA_VERSION, SNAPSHOT_MESSAGE_TYPE,
};
use crate::errors::SessionError;
use crate::id_allocator::{IdAllocator, IdKind};
use crate::model::{
    AttachRequest, AuditEventKind, AuditLogEntry, ClientRosterEntry, ClientViewMode,
    CreatedSession, ExposureMode, ExposureViewMode, HeartbeatEnvelope, LayerState, LeaseChangeKind,
    LeaseState, PerClientViewState, PermissionClass, Permissions, ReconnectRequest, SceneMode,
    SessionSnapshotEnvelope, SessionSnapshotPayload, SessionState, SharedSceneState, SourceRecord,
    WarningEntry,
};
use crate::revision_allocator::RevisionAllocator;
use crate::warning_service::aggregate_warnings;

#[derive(Debug)]
struct ClientRecord {
    roster_entry: ClientRosterEntry,
    view_state: PerClientViewState,
    last_seen_tick: u64,
}

#[derive(Debug)]
struct SessionRecord {
    session_state: SessionState,
    shared_scene: SharedSceneState,
    lease_state: LeaseState,
    clients: BTreeMap<String, ClientRecord>,
    audit_log: Vec<AuditLogEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseTransition {
    pub change_kind: LeaseChangeKind,
    pub changed_by_client_id: String,
    pub changed_by_label: String,
    pub changed_at: String,
    pub previous_lease_holder_client_id: Option<String>,
    pub previous_lease_holder_label: Option<String>,
    pub lease_state: LeaseState,
    pub resulting_session_rev: u64,
    pub audit_entry: AuditLogEntry,
}

#[derive(Debug)]
pub struct SessionManager {
    id_allocator: IdAllocator,
    heartbeat_tick: u64,
    sessions: BTreeMap<String, SessionRecord>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            id_allocator: IdAllocator::new(),
            heartbeat_tick: 0,
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
            audit_log: Vec::new(),
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
        let last_seen_tick = self.next_heartbeat_tick();
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
                last_seen_tick,
            },
        );
        refresh_warnings(session);

        let client_roster = session
            .clients
            .values()
            .map(|client| client.roster_entry.clone())
            .collect::<Vec<_>>();
        let warnings = collect_snapshot_warnings(session, &view_state.client_id);
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
        let removed_held_lease =
            session.lease_state.lease_holder_client_id.as_deref() == Some(client_id);

        let removed = session.clients.remove(client_id);
        if removed.is_none() {
            return Err(SessionError::ClientNotFound {
                session_id: session_id.to_owned(),
                client_id: client_id.to_owned(),
            });
        }

        if removed_held_lease {
            apply_lease_holder(session, None, None, None);
        }
        refresh_warnings(session);

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
        refresh_warnings(session);

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
        refresh_warnings(session);
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
        refresh_warnings(session);

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
        refresh_warnings(session);
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
        refresh_warnings(session);
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
        refresh_warnings(session);
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
        refresh_warnings(session);
        Ok(next_view_rev)
    }

    pub fn update_client_active_layer(
        &mut self,
        session_id: &str,
        client_id: &str,
        active_layer_id: Option<String>,
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
                client.view_state.active_layer_id = active_layer_id;
                RevisionAllocator::next_view_rev(&mut client.view_state.view_rev)
            };

        bump_session_rev(session);
        refresh_warnings(session);
        Ok(next_view_rev)
    }

    pub fn client_permission_and_lease(
        &self,
        session_id: &str,
        client_id: &str,
    ) -> Result<(PermissionClass, bool), SessionError> {
        let session = self.session_ref(session_id)?;
        let client =
            session
                .clients
                .get(client_id)
                .ok_or_else(|| SessionError::ClientNotFound {
                    session_id: session_id.to_owned(),
                    client_id: client_id.to_owned(),
                })?;

        Ok((
            client.roster_entry.permission_class,
            client.roster_entry.is_lease_holder,
        ))
    }

    pub fn set_lease_holder(
        &mut self,
        session_id: &str,
        client_id: Option<&str>,
    ) -> Result<u64, SessionError> {
        let session = self.session_mut(session_id)?;
        let lease_holder_label = if let Some(id) = client_id {
            Some(client_label(session, session_id, id)?.to_owned())
        } else {
            None
        };
        let acquired_at = client_id.map(|_| rfc3339_now());
        apply_lease_holder(session, client_id, lease_holder_label, acquired_at);
        refresh_warnings(session);
        Ok(bump_session_rev(session))
    }

    pub fn heartbeat(
        &mut self,
        session_id: &str,
        client_id: &str,
    ) -> Result<HeartbeatEnvelope, SessionError> {
        let now = rfc3339_now();
        let heartbeat_tick = self.next_heartbeat_tick();
        let session = self.session_mut(session_id)?;
        let client =
            session
                .clients
                .get_mut(client_id)
                .ok_or_else(|| SessionError::ClientNotFound {
                    session_id: session_id.to_owned(),
                    client_id: client_id.to_owned(),
                })?;

        client.roster_entry.last_seen_at = now.clone();
        client.last_seen_tick = heartbeat_tick;

        Ok(HeartbeatEnvelope {
            message_type: HEARTBEAT_MESSAGE_TYPE.to_owned(),
            schema_version: SCHEMA_VERSION.to_owned(),
            session_id: session_id.to_owned(),
            client_id: client_id.to_owned(),
            session_rev: session.session_state.session_rev,
            sent_at: now,
        })
    }

    pub fn disconnect_idle_clients(
        &mut self,
        session_id: &str,
        max_idle_ticks: u64,
    ) -> Result<Vec<String>, SessionError> {
        let current_tick = self.heartbeat_tick;
        let session = self.session_mut(session_id)?;
        let stale_client_ids = session
            .clients
            .iter()
            .filter_map(|(client_id, client)| {
                if current_tick.saturating_sub(client.last_seen_tick) > max_idle_ticks {
                    Some(client_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        if stale_client_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut removed_client_ids = Vec::with_capacity(stale_client_ids.len());
        for client_id in stale_client_ids {
            let removed = session.clients.remove(&client_id);
            if removed.is_some() {
                let removed_held_lease = session.lease_state.lease_holder_client_id.as_deref()
                    == Some(client_id.as_str());
                if removed_held_lease {
                    apply_lease_holder(session, None, None, None);
                }
                removed_client_ids.push(client_id);
            }
        }

        if !removed_client_ids.is_empty() {
            refresh_warnings(session);
            bump_session_rev(session);
        }

        Ok(removed_client_ids)
    }

    pub fn reconnect_client(
        &mut self,
        request: ReconnectRequest,
    ) -> Result<SessionSnapshotEnvelope, SessionError> {
        let ReconnectRequest {
            session_id,
            previous_client_id,
            client_label,
            requested_permission,
        } = request;

        if let Some(previous_client_id) = previous_client_id.as_deref() {
            let session = self.session_mut(&session_id)?;
            let removed_held_lease =
                session.lease_state.lease_holder_client_id.as_deref() == Some(previous_client_id);
            let removed = session.clients.remove(previous_client_id);
            if removed.is_some() {
                if removed_held_lease {
                    apply_lease_holder(session, None, None, None);
                }
                refresh_warnings(session);
                bump_session_rev(session);
            }
        } else if !self.sessions.contains_key(&session_id) {
            return Err(SessionError::SessionNotFound { session_id });
        }

        self.attach_client(AttachRequest {
            session_id,
            client_label,
            requested_permission,
        })
    }

    pub fn request_lease(
        &mut self,
        session_id: &str,
        client_id: &str,
    ) -> Result<Option<LeaseTransition>, SessionError> {
        let session = self.session_mut(session_id)?;
        let changed_by_label = client_label(session, session_id, client_id)?.to_owned();
        let previous_lease_holder_client_id = session.lease_state.lease_holder_client_id.clone();
        let previous_lease_holder_label = session.lease_state.lease_holder_label.clone();

        if let Some(holder_id) = previous_lease_holder_client_id.as_deref() {
            if holder_id == client_id {
                return Ok(None);
            }

            return Err(SessionError::LeaseUnavailable {
                session_id: session_id.to_owned(),
                lease_holder_client_id: holder_id.to_owned(),
            });
        }

        let changed_at = rfc3339_now();
        apply_lease_holder(
            session,
            Some(client_id),
            Some(changed_by_label.clone()),
            Some(changed_at.clone()),
        );
        refresh_warnings(session);
        let resulting_session_rev = bump_session_rev(session);
        let audit_entry = append_audit_entry(
            session,
            AuditLogEntry {
                session_rev: resulting_session_rev,
                event_kind: AuditEventKind::LeaseRequested,
                actor_client_id: client_id.to_owned(),
                actor_label: changed_by_label.clone(),
                previous_lease_holder_client_id: previous_lease_holder_client_id.clone(),
                previous_lease_holder_label: previous_lease_holder_label.clone(),
                recorded_at: changed_at.clone(),
            },
        );

        Ok(Some(LeaseTransition {
            change_kind: LeaseChangeKind::Requested,
            changed_by_client_id: client_id.to_owned(),
            changed_by_label,
            changed_at,
            previous_lease_holder_client_id,
            previous_lease_holder_label,
            lease_state: session.lease_state.clone(),
            resulting_session_rev,
            audit_entry,
        }))
    }

    pub fn steal_lease(
        &mut self,
        session_id: &str,
        client_id: &str,
    ) -> Result<Option<LeaseTransition>, SessionError> {
        let session = self.session_mut(session_id)?;
        let changed_by_label = client_label(session, session_id, client_id)?.to_owned();

        if !session.lease_state.stealable {
            return Err(SessionError::LeaseNotStealable {
                session_id: session_id.to_owned(),
            });
        }

        let previous_lease_holder_client_id = session.lease_state.lease_holder_client_id.clone();
        let previous_lease_holder_label = session.lease_state.lease_holder_label.clone();
        if previous_lease_holder_client_id.as_deref() == Some(client_id) {
            return Ok(None);
        }

        let change_kind = if previous_lease_holder_client_id.is_some() {
            LeaseChangeKind::Stolen
        } else {
            LeaseChangeKind::Requested
        };

        let changed_at = rfc3339_now();
        apply_lease_holder(
            session,
            Some(client_id),
            Some(changed_by_label.clone()),
            Some(changed_at.clone()),
        );
        refresh_warnings(session);
        let resulting_session_rev = bump_session_rev(session);

        let event_kind = if matches!(change_kind, LeaseChangeKind::Stolen) {
            AuditEventKind::LeaseStolen
        } else {
            AuditEventKind::LeaseRequested
        };
        let audit_entry = append_audit_entry(
            session,
            AuditLogEntry {
                session_rev: resulting_session_rev,
                event_kind,
                actor_client_id: client_id.to_owned(),
                actor_label: changed_by_label.clone(),
                previous_lease_holder_client_id: previous_lease_holder_client_id.clone(),
                previous_lease_holder_label: previous_lease_holder_label.clone(),
                recorded_at: changed_at.clone(),
            },
        );

        Ok(Some(LeaseTransition {
            change_kind,
            changed_by_client_id: client_id.to_owned(),
            changed_by_label,
            changed_at,
            previous_lease_holder_client_id,
            previous_lease_holder_label,
            lease_state: session.lease_state.clone(),
            resulting_session_rev,
            audit_entry,
        }))
    }

    pub fn audit_log(&self, session_id: &str) -> Result<Vec<AuditLogEntry>, SessionError> {
        let session = self.session_ref(session_id)?;
        Ok(session.audit_log.clone())
    }

    pub fn session_and_scene_revisions(
        &self,
        session_id: &str,
    ) -> Result<(u64, u64), SessionError> {
        let session = self.session_ref(session_id)?;
        Ok((
            session.session_state.session_rev,
            session.session_state.scene_rev,
        ))
    }

    pub fn client_view_revision(
        &self,
        session_id: &str,
        client_id: &str,
    ) -> Result<u64, SessionError> {
        let session = self.session_ref(session_id)?;
        let client =
            session
                .clients
                .get(client_id)
                .ok_or_else(|| SessionError::ClientNotFound {
                    session_id: session_id.to_owned(),
                    client_id: client_id.to_owned(),
                })?;

        Ok(client.view_state.view_rev)
    }

    pub fn client_view_state(
        &self,
        session_id: &str,
        client_id: &str,
    ) -> Result<PerClientViewState, SessionError> {
        let session = self.session_ref(session_id)?;
        let client =
            session
                .clients
                .get(client_id)
                .ok_or_else(|| SessionError::ClientNotFound {
                    session_id: session_id.to_owned(),
                    client_id: client_id.to_owned(),
                })?;

        Ok(client.view_state.clone())
    }

    pub fn combined_warnings_for_client(
        &self,
        session_id: &str,
        client_id: &str,
    ) -> Result<Vec<WarningEntry>, SessionError> {
        let session = self.session_ref(session_id)?;
        if !session.clients.contains_key(client_id) {
            return Err(SessionError::ClientNotFound {
                session_id: session_id.to_owned(),
                client_id: client_id.to_owned(),
            });
        }

        Ok(collect_snapshot_warnings(session, client_id))
    }

    fn next_heartbeat_tick(&mut self) -> u64 {
        self.heartbeat_tick = self.heartbeat_tick.saturating_add(1);
        self.heartbeat_tick
    }

    fn session_ref(&self, session_id: &str) -> Result<&SessionRecord, SessionError> {
        self.sessions
            .get(session_id)
            .ok_or_else(|| SessionError::SessionNotFound {
                session_id: session_id.to_owned(),
            })
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

fn sync_lease_state(session: &mut SessionRecord) {
    session.session_state.lease_state = session.lease_state.clone();
}

fn client_label<'a>(
    session: &'a SessionRecord,
    session_id: &str,
    client_id: &str,
) -> Result<&'a str, SessionError> {
    let client = session
        .clients
        .get(client_id)
        .ok_or_else(|| SessionError::ClientNotFound {
            session_id: session_id.to_owned(),
            client_id: client_id.to_owned(),
        })?;
    Ok(client.roster_entry.label.as_str())
}

fn apply_lease_holder(
    session: &mut SessionRecord,
    client_id: Option<&str>,
    lease_holder_label: Option<String>,
    acquired_at: Option<String>,
) {
    session.lease_state.lease_holder_client_id = client_id.map(ToOwned::to_owned);
    session.lease_state.lease_holder_label = lease_holder_label;
    session.lease_state.acquired_at = acquired_at;
    session.lease_state.expires_at = None;

    let lease_holder_id = session.lease_state.lease_holder_client_id.clone();
    for client in session.clients.values_mut() {
        client.roster_entry.is_lease_holder = lease_holder_id
            .as_deref()
            .is_some_and(|holder| holder == client.roster_entry.client_id);
    }

    sync_lease_state(session);
}

fn append_audit_entry(session: &mut SessionRecord, entry: AuditLogEntry) -> AuditLogEntry {
    session.audit_log.push(entry.clone());
    entry
}

fn refresh_warnings(session: &mut SessionRecord) {
    let client_views = session
        .clients
        .iter()
        .map(|(client_id, client)| (client_id.clone(), client.view_state.clone()))
        .collect::<BTreeMap<_, _>>();
    let aggregation = aggregate_warnings(&session.shared_scene, &client_views);

    session.shared_scene.warnings = aggregation.shared_scene_warnings;
    for (client_id, warnings) in aggregation.per_client_warnings {
        if let Some(client) = session.clients.get_mut(&client_id) {
            client.view_state.warnings = warnings;
        }
    }
}

fn collect_snapshot_warnings(session: &SessionRecord, client_id: &str) -> Vec<WarningEntry> {
    let mut warnings = Vec::new();
    warnings.extend(session.shared_scene.warnings.iter().cloned());

    let client_warnings = session
        .clients
        .get(client_id)
        .map(|client| client.view_state.warnings.clone())
        .unwrap_or_default();
    warnings.extend(client_warnings);

    warnings
}

#[cfg(test)]
mod tests {
    use crate::constants::{HEARTBEAT_MESSAGE_TYPE, SCHEMA_VERSION, SNAPSHOT_MESSAGE_TYPE};
    use crate::errors::SessionError;
    use crate::model::{
        AttachRequest, AuditEventKind, ClientViewMode, LeaseChangeKind, PermissionClass,
        ReconnectRequest,
    };

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

    #[test]
    fn set_lease_holder_updates_client_lease_flags() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("lease-session");

        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "bob".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("second attach should succeed");

        let _ = manager
            .set_lease_holder(
                &created.session_id,
                Some(&first.snapshot.client_view.client_id),
            )
            .expect("set lease holder should succeed");

        let first_state = manager
            .client_permission_and_lease(&created.session_id, &first.snapshot.client_view.client_id)
            .expect("first client lookup should succeed");
        let second_state = manager
            .client_permission_and_lease(
                &created.session_id,
                &second.snapshot.client_view.client_id,
            )
            .expect("second client lookup should succeed");

        assert!(first_state.1);
        assert!(!second_state.1);
    }

    #[test]
    fn request_and_steal_lease_enforce_single_holder_and_are_audit_logged() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("lease-sm-session");

        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "bob".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("second attach should succeed");

        let first_transition = manager
            .request_lease(&created.session_id, &first.snapshot.client_view.client_id)
            .expect("initial lease request should succeed")
            .expect("first request should mutate lease state");
        assert_eq!(first_transition.change_kind, LeaseChangeKind::Requested);
        assert_eq!(
            first_transition
                .lease_state
                .lease_holder_client_id
                .as_deref(),
            Some(first.snapshot.client_view.client_id.as_str())
        );

        let error = manager
            .request_lease(&created.session_id, &second.snapshot.client_view.client_id)
            .expect_err("request by non-holder should fail when another holder exists");
        assert_eq!(
            error,
            SessionError::LeaseUnavailable {
                session_id: created.session_id.clone(),
                lease_holder_client_id: first.snapshot.client_view.client_id.clone(),
            }
        );

        let second_transition = manager
            .steal_lease(&created.session_id, &second.snapshot.client_view.client_id)
            .expect("lease steal should succeed")
            .expect("steal should mutate lease state");
        assert_eq!(second_transition.change_kind, LeaseChangeKind::Stolen);
        assert_eq!(
            second_transition.previous_lease_holder_client_id.as_deref(),
            Some(first.snapshot.client_view.client_id.as_str())
        );
        assert_eq!(
            second_transition
                .lease_state
                .lease_holder_client_id
                .as_deref(),
            Some(second.snapshot.client_view.client_id.as_str())
        );

        let first_state = manager
            .client_permission_and_lease(&created.session_id, &first.snapshot.client_view.client_id)
            .expect("first client lookup should succeed");
        let second_state = manager
            .client_permission_and_lease(
                &created.session_id,
                &second.snapshot.client_view.client_id,
            )
            .expect("second client lookup should succeed");
        assert!(!first_state.1);
        assert!(second_state.1);

        let audit_log = manager
            .audit_log(&created.session_id)
            .expect("audit log lookup should succeed");
        assert_eq!(audit_log.len(), 2);
        assert_eq!(audit_log[0].event_kind, AuditEventKind::LeaseRequested);
        assert_eq!(
            audit_log[0].actor_client_id,
            first.snapshot.client_view.client_id
        );
        assert_eq!(audit_log[1].event_kind, AuditEventKind::LeaseStolen);
        assert_eq!(
            audit_log[1].actor_client_id,
            second.snapshot.client_view.client_id
        );
        assert_eq!(
            audit_log[1].previous_lease_holder_client_id.as_deref(),
            Some(first.snapshot.client_view.client_id.as_str())
        );
    }

    #[test]
    fn request_lease_is_idempotent_for_current_holder() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("lease-idempotent");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("attach should succeed");

        let first = manager
            .request_lease(
                &created.session_id,
                &attached.snapshot.client_view.client_id,
            )
            .expect("first request should succeed");
        let second = manager
            .request_lease(
                &created.session_id,
                &attached.snapshot.client_view.client_id,
            )
            .expect("second request should also succeed");

        assert!(first.is_some());
        assert!(second.is_none());
        let audit_log = manager
            .audit_log(&created.session_id)
            .expect("audit log lookup should succeed");
        assert_eq!(audit_log.len(), 1);
    }

    #[test]
    fn heartbeat_returns_envelope_and_keeps_session_revision_stable() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("heartbeat-session");
        let attached = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("attach should succeed");

        let before = manager
            .session_and_scene_revisions(&created.session_id)
            .expect("revision lookup should succeed")
            .0;
        let heartbeat = manager
            .heartbeat(
                &created.session_id,
                &attached.snapshot.client_view.client_id,
            )
            .expect("heartbeat should succeed");
        let after = manager
            .session_and_scene_revisions(&created.session_id)
            .expect("revision lookup should succeed")
            .0;

        assert_eq!(heartbeat.message_type, HEARTBEAT_MESSAGE_TYPE);
        assert_eq!(heartbeat.schema_version, SCHEMA_VERSION);
        assert_eq!(heartbeat.session_id, created.session_id);
        assert_eq!(heartbeat.client_id, attached.snapshot.client_view.client_id);
        assert_eq!(heartbeat.session_rev, before);
        assert_eq!(after, before);
    }

    #[test]
    fn disconnect_idle_clients_removes_stale_clients_and_clears_lease_holder() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("idle-disconnect");
        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "first".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let second = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "second".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("second attach should succeed");

        manager
            .set_lease_holder(
                &created.session_id,
                Some(&first.snapshot.client_view.client_id),
            )
            .expect("set lease holder should succeed");
        manager
            .heartbeat(&created.session_id, &second.snapshot.client_view.client_id)
            .expect("heartbeat should succeed");

        let removed = manager
            .disconnect_idle_clients(&created.session_id, 0)
            .expect("disconnect should succeed");

        assert_eq!(removed, vec![first.snapshot.client_view.client_id.clone()]);
        assert!(
            !manager
                .client_permission_and_lease(
                    &created.session_id,
                    &second.snapshot.client_view.client_id
                )
                .expect("second state lookup should succeed")
                .1
        );
        assert_eq!(
            manager.client_permission_and_lease(
                &created.session_id,
                &first.snapshot.client_view.client_id
            ),
            Err(SessionError::ClientNotFound {
                session_id: created.session_id.clone(),
                client_id: first.snapshot.client_view.client_id.clone(),
            })
        );

        let snapshot = manager
            .attach_client(AttachRequest {
                session_id: created.session_id,
                client_label: "observer".to_owned(),
                requested_permission: PermissionClass::View,
            })
            .expect("observer attach should succeed");
        assert_eq!(snapshot.snapshot.lease_state.lease_holder_client_id, None);
    }

    #[test]
    fn reconnect_client_replaces_old_client_and_preserves_shared_state() {
        let mut manager = SessionManager::new();
        let created = manager.create_session("reconnect-session");
        let first = manager
            .attach_client(AttachRequest {
                session_id: created.session_id.clone(),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("first attach should succeed");
        let source = manager
            .add_source(&created.session_id, "source-a")
            .expect("source add should succeed");
        let layer = manager
            .add_layer(&created.session_id, "layer-a")
            .expect("layer add should succeed");
        manager
            .set_lease_holder(
                &created.session_id,
                Some(&first.snapshot.client_view.client_id),
            )
            .expect("set lease holder should succeed");

        let reconnected = manager
            .reconnect_client(ReconnectRequest {
                session_id: created.session_id,
                previous_client_id: Some(first.snapshot.client_view.client_id.clone()),
                client_label: "alice".to_owned(),
                requested_permission: PermissionClass::Control,
            })
            .expect("reconnect should succeed");

        assert_eq!(reconnected.snapshot.shared_scene.sources.len(), 1);
        assert_eq!(reconnected.snapshot.shared_scene.layers.len(), 1);
        assert!(
            reconnected
                .snapshot
                .shared_scene
                .sources
                .contains_key(&source.source_id)
        );
        assert!(
            reconnected
                .snapshot
                .shared_scene
                .layers
                .contains_key(&layer.layer_id)
        );
        assert_eq!(reconnected.snapshot.client_roster.len(), 1);
        assert_ne!(
            reconnected.snapshot.client_view.client_id,
            first.snapshot.client_view.client_id
        );
        assert_eq!(
            reconnected.snapshot.lease_state.lease_holder_client_id,
            None
        );
    }
}
