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
