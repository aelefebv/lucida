use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::command::DocumentCommand;
use crate::scene::{DisplayState, DocumentState, DatasetDisplaySettings};
use crate::view::ViewState;

pub type ClientId = u64;

/// Per-client ephemeral state broadcast to other clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceState {
    pub client_id: ClientId,
    pub camera: Camera,
    pub view: ViewState,
    pub display: DisplayState,
    /// Who this client is following (`None` = independent).
    pub following: Option<ClientId>,
    pub cursor: Option<[f64; 2]>,
    #[serde(default)]
    pub dataset_order: Vec<String>,
    #[serde(default)]
    pub dataset_settings: HashMap<String, DatasetDisplaySettings>,
}

/// Messages sent from a client to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// A document command (shared, sequenced).
    Command { command: DocumentCommand },
    /// Viewport presence update (ephemeral, latest-wins).
    Presence {
        camera: Camera,
        view: ViewState,
        display: DisplayState,
    },
    /// Cursor position update.
    Cursor { position: [f64; 2] },
    /// Follow another client (or stop following with `target: null`).
    Follow { target: Option<ClientId> },
    /// Layer presence update (ephemeral, latest-wins).
    DatasetPresence {
        dataset_order: Vec<String>,
        dataset_settings: HashMap<String, DatasetDisplaySettings>,
    },
    /// Remote-control another client by making them follow the sender.
    Steer { client: ClientId },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// First message on connect. Full authoritative document state + peer presence.
    Snapshot {
        seq: u64,
        document: DocumentState,
        peers: Vec<PresenceState>,
        your_id: ClientId,
    },
    /// Command from another client, broadcast to all except sender.
    CommandBroadcast { seq: u64, command: DocumentCommand },
    /// Sent only to the command's sender confirming application.
    Ack { seq: u64 },
    /// A new client connected.
    PeerJoined {
        client_id: ClientId,
        presence: PresenceState,
    },
    /// A client disconnected.
    PeerLeft { client_id: ClientId },
    /// A peer's viewport state changed.
    PresenceUpdate {
        client_id: ClientId,
        camera: Camera,
        view: ViewState,
        display: DisplayState,
    },
    /// A peer's cursor moved.
    CursorUpdate {
        client_id: ClientId,
        position: [f64; 2],
    },
    /// A peer's follow target changed.
    FollowChanged {
        client_id: ClientId,
        target: Option<ClientId>,
    },
    /// A peer's layer presence changed.
    DatasetPresenceUpdate {
        client_id: ClientId,
        dataset_order: Vec<String>,
        dataset_settings: HashMap<String, DatasetDisplaySettings>,
    },
}

/// Chunk-related messages exchanged between clients and server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChunkMessage {
    /// Viewer → Server: request a chunk from the dataset's data source.
    ChunkRequest { dataset_id: String, key: String },
    /// Server → Data source: fetch this chunk and send it to `client_id`.
    ChunkFetch {
        client_id: u64,
        dataset_id: String,
        key: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trips() {
        let doc = DocumentState {
            datasets: Vec::new(),
        };
        let msg = ServerMessage::Snapshot {
            seq: 1,
            document: doc,
            peers: Vec::new(),
            your_id: 42,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Snapshot { seq, your_id, .. } => {
                assert_eq!(seq, 1);
                assert_eq!(your_id, 42);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn ack_round_trips() {
        let msg = ServerMessage::Ack { seq: 42 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"ack\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Ack { seq } => assert_eq!(seq, 42),
            _ => panic!("expected Ack"),
        }
    }

    #[test]
    fn chunk_request_round_trips() {
        let msg = ChunkMessage::ChunkRequest {
            dataset_id: "ds1".into(),
            key: "0/0/0/0/0/0".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"chunk_request\""));
        let parsed: ChunkMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ChunkMessage::ChunkRequest { dataset_id, key } => {
                assert_eq!(dataset_id, "ds1");
                assert_eq!(key, "0/0/0/0/0/0");
            }
            _ => panic!("expected ChunkRequest"),
        }
    }

    #[test]
    fn chunk_fetch_round_trips() {
        let msg = ChunkMessage::ChunkFetch {
            client_id: 42,
            dataset_id: "ds1".into(),
            key: "1/0/0/2/3/4".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"chunk_fetch\""));
        let parsed: ChunkMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ChunkMessage::ChunkFetch { client_id, dataset_id, key } => {
                assert_eq!(client_id, 42);
                assert_eq!(dataset_id, "ds1");
                assert_eq!(key, "1/0/0/2/3/4");
            }
            _ => panic!("expected ChunkFetch"),
        }
    }

    #[test]
    fn command_broadcast_round_trips() {
        let cmd = DocumentCommand::RemoveDataset { id: "ds1".into() };
        let msg = ServerMessage::CommandBroadcast { seq: 5, command: cmd };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::CommandBroadcast { seq, command } => {
                assert_eq!(seq, 5);
                match command {
                    DocumentCommand::RemoveDataset { id } => {
                        assert_eq!(id, "ds1");
                    }
                    _ => panic!("expected RemoveDataset command"),
                }
            }
            _ => panic!("expected CommandBroadcast"),
        }
    }

    #[test]
    fn client_message_command_round_trips() {
        let msg = ClientMessage::Command {
            command: DocumentCommand::AddDataset {
                id: "ds1".into(),
                name: "test".into(),
                layers: vec![],
                volume_shape: None,
                volume_scale: None,
                client_metadata: None,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"command\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ClientMessage::Command { .. }));
    }

    #[test]
    fn client_message_presence_round_trips() {
        let msg = ClientMessage::Presence {
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"presence\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ClientMessage::Presence { .. }));
    }

    #[test]
    fn client_message_steer_round_trips() {
        let msg = ClientMessage::Steer { client: 3 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"steer\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Steer { client } => assert_eq!(client, 3),
            _ => panic!("expected Steer"),
        }
    }

    #[test]
    fn client_message_follow_round_trips() {
        let msg = ClientMessage::Follow { target: Some(5) };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"follow\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Follow { target } => assert_eq!(target, Some(5)),
            _ => panic!("expected Follow"),
        }
    }

    #[test]
    fn presence_state_round_trips() {
        let ps = PresenceState {
            client_id: 1,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: Some([100.0, 200.0]),
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
        };
        let json = serde_json::to_string(&ps).unwrap();
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.client_id, 1);
        assert_eq!(parsed.cursor, Some([100.0, 200.0]));
        assert_eq!(parsed.following, None);
    }

    #[test]
    fn peer_joined_round_trips() {
        let presence = PresenceState {
            client_id: 3,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: None,
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
        };
        let msg = ServerMessage::PeerJoined {
            client_id: 3,
            presence,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"peer_joined\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ServerMessage::PeerJoined { client_id: 3, .. }));
    }
}
