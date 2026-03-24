use std::collections::{HashMap, VecDeque};

use lucida_core::camera::Camera;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, PresenceState, ServerMessage};
use lucida_core::scene::{DisplayState, DocumentState, DatasetDisplaySettings};
use lucida_core::view::ViewState;

const HISTORY_CAPACITY: usize = 256;

pub struct Session {
    pub document: DocumentState,
    pub seq: u64,
    history: VecDeque<(u64, DocumentCommand)>,
    /// Maps dataset_id → client_id of the data source.
    pub data_sources: HashMap<String, ClientId>,
    /// Per-client ephemeral presence state.
    pub clients: HashMap<ClientId, PresenceState>,
}

impl Session {
    pub fn new() -> Self {
        Self {
            document: DocumentState {
                datasets: Vec::new(),
            },
            seq: 0,
            history: VecDeque::with_capacity(HISTORY_CAPACITY),
            data_sources: HashMap::new(),
            clients: HashMap::new(),
        }
    }

    pub fn snapshot(&self, your_id: ClientId) -> ServerMessage {
        ServerMessage::Snapshot {
            seq: self.seq,
            document: self.document.clone(),
            peers: self.clients.values().cloned().collect(),
            your_id,
        }
    }

    /// Apply a document command. Returns the new seq number.
    pub fn apply(&mut self, cmd: DocumentCommand) -> u64 {
        self.document.apply(cmd.clone());

        self.seq += 1;
        if self.history.len() == HISTORY_CAPACITY {
            self.history.pop_front();
        }
        self.history.push_back((self.seq, cmd));
        self.seq
    }

    /// Add a client with default presence.
    pub fn add_client(&mut self, id: ClientId) -> PresenceState {
        let presence = PresenceState {
            client_id: id,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: None,
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
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

    /// Update a client's presence state.
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

    /// Update a client's cursor position.
    pub fn update_cursor(&mut self, id: ClientId, position: [f64; 2]) {
        if let Some(presence) = self.clients.get_mut(&id) {
            presence.cursor = Some(position);
        }
    }

    /// Update a client's dataset presence.
    pub fn update_dataset_presence(
        &mut self,
        id: ClientId,
        dataset_order: Vec<String>,
        dataset_settings: HashMap<String, DatasetDisplaySettings>,
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

    #[test]
    fn new_session_starts_at_seq_zero() {
        let session = Session::new();
        assert_eq!(session.seq, 0);
    }

    #[test]
    fn apply_increments_seq() {
        let mut session = Session::new();
        let seq = session.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            client_metadata: None,
        });
        assert_eq!(seq, 1);
    }

    #[test]
    fn apply_mutates_document() {
        let mut session = Session::new();
        session.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            client_metadata: None,
        });
        assert_eq!(session.document.datasets.len(), 1);
        assert_eq!(session.document.datasets[0].id, "ds1");
    }

    #[test]
    fn snapshot_contains_current_state() {
        let mut session = Session::new();
        session.apply(DocumentCommand::AddDataset {
            id: "ds1".into(),
            name: "test".into(),
            layers: vec![],
            volume_shape: None,
            volume_scale: None,
            client_metadata: None,
        });
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
                assert_eq!(document.datasets.len(), 1);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn history_ring_buffer_caps_at_256() {
        let mut session = Session::new();
        for _ in 0..300 {
            session.apply(DocumentCommand::SetVolumeScale {
                shape: [1, 1, 1],
                scale: [1.0, 1.0, 1.0],
            });
        }
        assert_eq!(session.history.len(), HISTORY_CAPACITY);
    }

    #[test]
    fn add_remove_client() {
        let mut session = Session::new();
        session.add_client(1);
        session.add_client(2);
        assert_eq!(session.clients.len(), 2);
        session.remove_client(1);
        assert_eq!(session.clients.len(), 1);
        assert!(session.clients.contains_key(&2));
    }

    #[test]
    fn follow_and_disconnect_clears_followers() {
        let mut session = Session::new();
        session.add_client(1);
        session.add_client(2);
        session.add_client(3);
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
        session.add_client(1); // A
        session.add_client(2); // B
        session.add_client(3); // C
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
        session.add_client(1);
        session.add_client(2);
        session.add_client(3);
        // 2 follows 1
        session.set_follow(2, Some(1));
        // 3 tries to follow 2 (who is following 1) → should fail
        let changes = session.set_follow(3, Some(2));
        assert!(changes.is_empty());
        assert_eq!(session.clients.get(&3).unwrap().following, None);
    }
}
