use std::collections::{HashMap, VecDeque};

use lucida_content::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, PeerIdentity, PresenceState, ServerMessage};
use lucida_core::scene::{DatasetDisplaySettings, DisplayState, DocumentState};
use lucida_core::view::ViewState;
use lucida_protocol::{
    DatasetOpenFailureDiagnostic, GeneratedAvailabilityDelta, GeneratedAvailabilitySnapshot,
};

use crate::binding::ServerBinding;

const HISTORY_CAPACITY: usize = 256;

pub struct Session {
    pub document: DocumentState,
    pub seq: u64,
    history: VecDeque<(u64, DocumentCommand)>,
    /// Server-hosted datasets: dataset_id → operational binding (store + resolver + cache).
    pub server_bindings: HashMap<DatasetId, ServerBinding>,
    /// Server-private source/restore metadata for workspace datasets.
    /// Kept outside `DocumentState` so client-visible membership remains
    /// the source of truth while operational restore failures stay diagnosable.
    pub binding_runtime: HashMap<DatasetId, DatasetBindingRuntimeState>,
    /// Server-authored runtime generated coarse metadata/readiness.
    /// Kept outside `DocumentState` so it is never treated as a user
    /// document command or saved-view payload.
    pub generated_availability: HashMap<DatasetId, GeneratedAvailabilitySnapshot>,
    /// Per-client ephemeral presence state.
    pub clients: HashMap<ClientId, PresenceState>,
}

#[derive(Debug, Clone)]
pub struct DatasetBindingRuntimeState {
    pub source_url: String,
    pub dataset_source_id: Option<String>,
    pub display_name: String,
    pub last_restore_failure: Option<DatasetOpenFailureDiagnostic>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            document: DocumentState::default(),
            seq: 0,
            history: VecDeque::with_capacity(HISTORY_CAPACITY),
            server_bindings: HashMap::new(),
            binding_runtime: HashMap::new(),
            generated_availability: HashMap::new(),
            clients: HashMap::new(),
        }
    }

    pub fn snapshot(&self, your_id: ClientId) -> ServerMessage {
        ServerMessage::Snapshot {
            seq: self.seq,
            document: self.document.clone(),
            peers: self.clients.values().cloned().collect(),
            your_id,
            generated_availability: self.generated_availability.clone(),
        }
    }

    /// Apply a document command. Returns the new seq number.
    pub fn apply(&mut self, cmd: DocumentCommand) -> u64 {
        if let DocumentCommand::RemoveDataset { id } = &cmd {
            self.generated_availability.remove(id);
            self.binding_runtime.remove(id);
        }
        self.document.apply(cmd.clone());

        self.seq += 1;
        if self.history.len() == HISTORY_CAPACITY {
            self.history.pop_front();
        }
        self.history.push_back((self.seq, cmd));
        self.seq
    }

    pub fn apply_generated_availability_delta(
        &mut self,
        dataset_id: DatasetId,
        delta: GeneratedAvailabilityDelta,
    ) {
        self.generated_availability
            .entry(dataset_id)
            .or_default()
            .apply_delta(delta);
    }

    pub fn record_binding_source(
        &mut self,
        dataset_id: DatasetId,
        source_url: String,
        dataset_source_id: Option<String>,
        display_name: String,
    ) {
        self.binding_runtime
            .entry(dataset_id)
            .and_modify(|state| {
                state.source_url = source_url.clone();
                state.dataset_source_id = dataset_source_id.clone();
                state.display_name = display_name.clone();
            })
            .or_insert(DatasetBindingRuntimeState {
                source_url,
                dataset_source_id,
                display_name,
                last_restore_failure: None,
            });
    }

    pub fn record_binding_restore_failure(
        &mut self,
        dataset_id: DatasetId,
        source_url: String,
        dataset_source_id: Option<String>,
        display_name: String,
        diagnostic: DatasetOpenFailureDiagnostic,
    ) {
        self.binding_runtime.insert(
            dataset_id,
            DatasetBindingRuntimeState {
                source_url,
                dataset_source_id,
                display_name,
                last_restore_failure: Some(diagnostic),
            },
        );
    }

    pub fn clear_binding_restore_failure(&mut self, dataset_id: &DatasetId) {
        if let Some(state) = self.binding_runtime.get_mut(dataset_id) {
            state.last_restore_failure = None;
        }
    }

    /// Register a newly connected client.
    ///
    /// `identity` is the server-authored presentational identity for the
    /// peer's cursor (#540), derived from the connection's authenticated
    /// principal. The non-workspace `/ws` path has no principal and passes
    /// `None`, so anonymous peers still join and render via the numeric-id
    /// fallback.
    pub fn add_client(&mut self, id: ClientId, identity: Option<PeerIdentity>) -> PresenceState {
        let presence = PresenceState {
            client_id: id,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: None,
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
            identity,
        };
        self.clients.insert(id, presence.clone());
        presence
    }

    /// Remove a client and return the list of clients whose follow target was invalidated
    /// (they were following the disconnected client and need to stop).
    pub fn remove_client(&mut self, id: ClientId) -> Vec<ClientId> {
        self.clients.remove(&id);
        // Redirect any followers of this client to stop following.
        let mut affected = Vec::new();
        for (cid, presence) in &mut self.clients {
            if presence.following == Some(id) {
                presence.following = None;
                affected.push(*cid);
            }
        }
        affected
    }

    pub fn update_presence(
        &mut self,
        id: ClientId,
        camera: Camera,
        view: ViewState,
        display: DisplayState,
    ) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.camera = camera;
            presence.view = view;
            presence.display = display;
        }
    }

    pub fn update_cursor(&mut self, id: ClientId, position: Option<[f64; 2]>) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.cursor = position;
        }
    }

    pub fn update_dataset_presence(
        &mut self,
        id: ClientId,
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    ) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.dataset_order = dataset_order;
            presence.dataset_settings = dataset_settings;
        }
    }

    /// Set follow target for a client.
    /// Returns a list of (client_id, new_target) pairs for all affected clients
    /// (including transitive chain resolution).
    pub fn set_follow(
        &mut self,
        client_id: ClientId,
        target: Option<ClientId>,
    ) -> Vec<(ClientId, Option<ClientId>)> {
        let mut changes = Vec::new();

        // Validate: can't follow yourself
        if target == Some(client_id) {
            return changes;
        }

        // Validate: target must exist and must not be following someone else
        if let Some(target_id) = target {
            if let Some(target_presence) = self.clients.get(&target_id) {
                if target_presence.following.is_some() {
                    // Can't follow someone who is already following
                    return changes;
                }
            } else {
                return changes; // Target doesn't exist
            }
        }

        // Set the follow target
        if let Some(presence) = self.clients.get_mut(&client_id) {
            presence.following = target;
            changes.push((client_id, target));
        }

        // Transitive chain resolution: if anyone was following client_id,
        // and client_id is now following someone, redirect them to the new target.
        if let Some(new_target) = target {
            let followers: Vec<ClientId> = self
                .clients
                .iter()
                .filter(|(cid, p)| **cid != client_id && p.following == Some(client_id))
                .map(|(cid, _)| *cid)
                .collect();

            for follower_id in followers {
                if let Some(presence) = self.clients.get_mut(&follower_id) {
                    presence.following = Some(new_target);
                    changes.push((follower_id, Some(new_target)));
                }
            }
        }

        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::*;
    use lucida_protocol::*;

    fn make_register(id: &str, name: &str) -> DatasetOpened {
        let entity_id = EntityId(format!("{id}-entity"));
        let image_id = ImageId(format!("{id}-image"));
        let manifest = DatasetManifest::new(
            DatasetId(id.to_string()),
            name.to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some(name.to_string()),
                    ..Default::default()
                },
            }],
            vec![],
            vec![ImageSpec {
                image_id: image_id.clone(),
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "z".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".into(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".into(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    downsampling_method: None,
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        );
        let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });
        DatasetOpened {
            manifest,
            fetch,
            catalog: AssetCatalog::default(),
            opener_client_id: None,
        }
    }

    #[test]
    fn new_session_starts_at_seq_zero() {
        let session = Session::new();
        assert_eq!(session.seq, 0);
    }

    #[test]
    fn apply_increments_seq() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        let seq = session.apply(DocumentCommand::DatasetOpened(reg));
        assert_eq!(seq, 1);
    }

    #[test]
    fn apply_mutates_document() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        session.apply(DocumentCommand::DatasetOpened(reg));
        assert_eq!(session.document.manifests.len(), 1);
        assert!(
            session
                .document
                .manifests
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn snapshot_contains_current_state() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        session.apply(DocumentCommand::DatasetOpened(reg));
        let msg = session.snapshot(42);
        match msg {
            ServerMessage::Snapshot {
                seq,
                document,
                your_id,
                ..
            } => {
                assert_eq!(seq, 1);
                assert_eq!(your_id, 42);
                assert_eq!(document.manifests.len(), 1);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn generated_availability_is_runtime_snapshot_state() {
        let mut session = Session::new();
        session.apply_generated_availability_delta(
            DatasetId("ds1".into()),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![GeneratedChunkStatusUpdate {
                    image_id: ImageId("ds1-image".into()),
                    level_index: 1,
                    key: "1/0/0/0/0/0".into(),
                    status: GeneratedChunkStatus::Ready,
                    message: None,
                }],
            },
        );

        let msg = session.snapshot(7);
        match msg {
            ServerMessage::Snapshot {
                generated_availability,
                ..
            } => {
                let snapshot = generated_availability
                    .get(&DatasetId("ds1".into()))
                    .expect("generated availability snapshot");
                assert_eq!(snapshot.chunks.len(), 1);
                assert_eq!(snapshot.chunks[0].status, GeneratedChunkStatus::Ready);
            }
            _ => panic!("expected Snapshot"),
        }
        assert!(session.document.manifests.is_empty());
    }

    #[test]
    fn remove_dataset_clears_generated_availability() {
        let mut session = Session::new();
        let reg = make_register("ds1", "test");
        session.apply(DocumentCommand::DatasetOpened(reg));
        session.apply_generated_availability_delta(
            DatasetId("ds1".into()),
            GeneratedAvailabilityDelta::default(),
        );
        assert!(
            session
                .generated_availability
                .contains_key(&DatasetId("ds1".into()))
        );

        session.apply(DocumentCommand::RemoveDataset {
            id: DatasetId("ds1".into()),
        });

        assert!(
            !session
                .generated_availability
                .contains_key(&DatasetId("ds1".into()))
        );
    }

    #[test]
    fn history_ring_buffer_caps_at_256() {
        let mut session = Session::new();
        for i in 0..300 {
            let reg = make_register(&format!("ds-{i}"), "test");
            session.apply(DocumentCommand::DatasetOpened(reg));
        }
        assert_eq!(session.history.len(), HISTORY_CAPACITY);
    }

    #[test]
    fn add_remove_client() {
        let mut session = Session::new();
        session.add_client(1, None);
        session.add_client(2, None);
        assert_eq!(session.clients.len(), 2);
        session.remove_client(1);
        assert_eq!(session.clients.len(), 1);
        assert!(session.clients.contains_key(&2));
    }

    #[test]
    fn add_client_attaches_identity_to_presence_and_snapshot() {
        // #540: a workspace client connects with a server-authored identity.
        // It rides on the returned presence (broadcast as PeerJoined) AND on
        // the snapshot peer list a late joiner receives.
        let mut session = Session::new();
        let identity = PeerIdentity {
            display_name: "Grace Hopper".into(),
            picture_url: Some("https://example.com/grace.png".into()),
            initial: "G".into(),
        };
        let presence = session.add_client(7, Some(identity.clone()));
        // Returned presence (the PeerJoined payload) carries identity.
        assert_eq!(presence.identity.as_ref(), Some(&identity));

        // And a fresh snapshot's peer list carries it too (late-joiner path).
        match session.snapshot(99) {
            ServerMessage::Snapshot { peers, .. } => {
                let peer = peers
                    .iter()
                    .find(|p| p.client_id == 7)
                    .expect("client 7 in snapshot");
                let got = peer.identity.as_ref().expect("identity on snapshot peer");
                assert_eq!(got.display_name, "Grace Hopper");
                assert_eq!(
                    got.picture_url.as_deref(),
                    Some("https://example.com/grace.png")
                );
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn add_client_without_identity_leaves_presence_anonymous() {
        // The non-workspace `/ws` path passes `None`; the peer still joins and
        // its presence carries no identity (cursor falls back to numeric id).
        let mut session = Session::new();
        let presence = session.add_client(3, None);
        assert_eq!(presence.identity, None);
        assert!(session.clients.get(&3).unwrap().identity.is_none());
    }

    #[test]
    fn follow_and_disconnect_clears_followers() {
        let mut session = Session::new();
        session.add_client(1, None);
        session.add_client(2, None);
        session.add_client(3, None);
        // 2 follows 1, 3 follows 1
        session.set_follow(2, Some(1));
        session.set_follow(3, Some(1));
        // 1 disconnects → 2 and 3 should stop following
        let affected = session.remove_client(1);
        assert_eq!(affected.len(), 2);
        assert_eq!(session.clients.get(&2).unwrap().following, None);
        assert_eq!(session.clients.get(&3).unwrap().following, None);
    }

    #[test]
    fn follow_transitive_chain() {
        let mut session = Session::new();
        session.add_client(1, None); // A
        session.add_client(2, None); // B
        session.add_client(3, None); // C
        // A follows C
        session.set_follow(1, Some(3));
        assert_eq!(session.clients.get(&1).unwrap().following, Some(3));
        // C starts following B → A should be redirected to B
        let changes = session.set_follow(3, Some(2));
        assert!(changes.iter().any(|&(cid, t)| cid == 1 && t == Some(2)));
        assert_eq!(session.clients.get(&1).unwrap().following, Some(2));
        assert_eq!(session.clients.get(&3).unwrap().following, Some(2));
    }

    #[test]
    fn cannot_follow_someone_who_is_following() {
        let mut session = Session::new();
        session.add_client(1, None);
        session.add_client(2, None);
        session.add_client(3, None);
        // 2 follows 1
        session.set_follow(2, Some(1));
        // 3 tries to follow 2 (who is following 1) → should fail
        let changes = session.set_follow(3, Some(2));
        assert!(changes.is_empty());
        assert_eq!(session.clients.get(&3).unwrap().following, None);
    }
}
