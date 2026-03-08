use serde::{Deserialize, Serialize};

use crate::command::Command;
use crate::scene::Scene;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// First message on connect. Full authoritative state.
    Snapshot { seq: u64, scene: Scene },
    /// Command from another client, broadcast to all except sender.
    CommandBroadcast { seq: u64, command: Command },
    /// Sent only to the command's sender confirming application.
    Ack { seq: u64 },
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
        let scene = Scene::new([800, 600]);
        let msg = ServerMessage::Snapshot { seq: 1, scene };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Snapshot { seq, .. } => assert_eq!(seq, 1),
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
        let cmd = Command::Pan { dx: 1.0, dy: 2.0 };
        let msg = ServerMessage::CommandBroadcast { seq: 5, command: cmd };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::CommandBroadcast { seq, command } => {
                assert_eq!(seq, 5);
                match command {
                    Command::Pan { dx, dy } => {
                        assert_eq!(dx, 1.0);
                        assert_eq!(dy, 2.0);
                    }
                    _ => panic!("expected Pan command"),
                }
            }
            _ => panic!("expected CommandBroadcast"),
        }
    }
}
