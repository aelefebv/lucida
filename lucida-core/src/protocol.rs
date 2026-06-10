use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, ImageId};
use lucida_protocol::{
    AssetCatalogDelta, DatasetOpenFailureDiagnostic, DatasetOpenSuccessDiagnostic,
    DatasetSourceHealth, GeneratedAvailabilityDelta, GeneratedAvailabilitySnapshot,
    GeneratedChunkStatus,
};

use crate::camera::Camera;
use crate::command::DocumentCommand;
use crate::scene::{DatasetDisplaySettings, DisplayState, DocumentState};
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
    pub dataset_order: Vec<DatasetId>,
    #[serde(default)]
    pub dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
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
    /// Cursor position update (null = cursor left the canvas).
    Cursor { position: Option<[f64; 2]> },
    /// Follow another client (or stop following with `target: null`).
    Follow { target: Option<ClientId> },
    /// Layer presence update (ephemeral, latest-wins).
    DatasetPresence {
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    },
    /// Remote-control another client by making them follow the sender.
    Steer { client: ClientId },
    /// Request the server open a Dataset from a URL.
    /// The server reads metadata via a StorageBackend and broadcasts DatasetOpened.
    OpenRemoteDataset { request_id: String, url: String },
    /// Request server-authored runtime health for loaded datasets.
    DatasetHealth {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dataset_id: Option<DatasetId>,
    },
    /// Advisory, unsequenced scheduling hint for server-generated chunks.
    /// This is session/runtime state only; it is not a document command and
    /// must not be persisted in saved views.
    ViewerInterest { interest: ViewerInterestHint },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewerInterestHint {
    #[serde(default)]
    pub client_id: Option<ClientId>,
    pub dataset_id: DatasetId,
    pub generation: u64,
    pub t: u32,
    pub z: u32,
    #[serde(default)]
    pub channels: Vec<u32>,
    pub mode: ViewerInterestMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<ViewerInterestViewport>,
    #[serde(default)]
    pub desired_keys: Vec<ViewerInterestChunkKey>,
    #[serde(default)]
    pub predicted_keys: Vec<ViewerInterestChunkKey>,
    pub interaction: ViewerInteractionMode,
    pub timestamp_ms: u64,
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInterestMode {
    Slice,
    Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInteractionMode {
    Idle,
    Panning,
    Zooming,
    Scrubbing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewerInterestViewport {
    pub xy_bounds: [f64; 4],
    pub z_range: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewerInterestChunkKey {
    pub image_id: ImageId,
    pub key: String,
    #[serde(default)]
    pub lane: ViewerInterestLane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInterestLane {
    #[default]
    Visible,
    Predicted,
    Background,
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
        /// Server-authored runtime generated-level availability, keyed by
        /// dataset. This is not part of `DocumentState` and is not sequenced as
        /// a document command.
        #[serde(default)]
        generated_availability: HashMap<DatasetId, GeneratedAvailabilitySnapshot>,
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
    /// A peer's cursor moved (null = cursor left the canvas).
    CursorUpdate {
        client_id: ClientId,
        position: Option<[f64; 2]>,
    },
    /// A peer's follow target changed.
    FollowChanged {
        client_id: ClientId,
        target: Option<ClientId>,
    },
    /// A peer's layer presence changed.
    DatasetPresenceUpdate {
        client_id: ClientId,
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    },
    /// Sent to the requester when OpenRemoteDataset succeeds.
    OpenDatasetSucceeded {
        request_id: String,
        url: String,
        seq: u64,
        opened: lucida_protocol::DatasetOpened,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostic: Option<DatasetOpenSuccessDiagnostic>,
    },
    /// Sent to the requester when OpenRemoteDataset cannot be fulfilled.
    OpenDatasetFailed {
        request_id: String,
        url: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostic: Option<DatasetOpenFailureDiagnostic>,
    },
    /// Sent to the requester with server-authored runtime dataset health.
    DatasetHealth {
        request_id: String,
        datasets: Vec<DatasetSourceHealth>,
    },
    /// Incremental update to a dataset's asset catalog.
    AssetCatalogUpdate {
        dataset_id: DatasetId,
        delta: AssetCatalogDelta,
    },
    /// Runtime generated-level metadata/readiness update. Server-authored and
    /// unsequenced; clients merge it into their local availability view.
    GeneratedAvailabilityUpdate {
        dataset_id: DatasetId,
        delta: GeneratedAvailabilityDelta,
    },
    /// Response to a generated chunk request when bytes are not available.
    /// Ready generated chunks still use the normal binary chunk frame.
    GeneratedChunkStatus {
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
        status: GeneratedChunkStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A server-stored bookmark was created, renamed, or deleted.
    /// Broadcast to clients whose session has at least one loaded dataset
    /// that overlaps `dataset_urls`. The client refetches the bookmark by
    /// id (on Created/Updated) or removes it from local state (on
    /// Deleted) — keeping the broadcast payload small.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift (see `wiki/gotchas/scene-document-state-json-compat`).
    BookmarkChanged {
        id: String,
        action: BookmarkAction,
        dataset_urls: Vec<String>,
    },
    /// A workspace was archived while this client was connected.
    /// Workspace clients should stop reconnecting and leave the workspace route.
    WorkspaceArchived { workspace_id: String },
}

/// The kind of mutation a `BookmarkChanged` describes. Wire encoding is
/// the lowercase variant name (`"created"` / `"updated"` / `"deleted"`)
/// so the JSON shape stays stable if the Rust enum is later renamed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookmarkAction {
    Created,
    Updated,
    Deleted,
}

/// Chunk-related messages exchanged between clients and server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChunkMessage {
    /// Viewer -> Server: request a chunk from the dataset's data source.
    ChunkRequest {
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
    },
    /// Server -> Data source: fetch this chunk and send it to `client_id`.
    ChunkFetch {
        client_id: u64,
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trips() {
        let doc = DocumentState::default();
        let msg = ServerMessage::Snapshot {
            seq: 1,
            document: doc,
            peers: Vec::new(),
            your_id: 42,
            generated_availability: HashMap::new(),
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
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "0/0/0/0/0/0".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"chunk_request\""));
        let parsed: ChunkMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ChunkMessage::ChunkRequest {
                dataset_id,
                image_id,
                key,
            } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(image_id, ImageId("img1".into()));
                assert_eq!(key, "0/0/0/0/0/0");
            }
            _ => panic!("expected ChunkRequest"),
        }
    }

    #[test]
    fn chunk_fetch_round_trips() {
        let msg = ChunkMessage::ChunkFetch {
            client_id: 42,
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "1/0/0/2/3/4".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"chunk_fetch\""));
        let parsed: ChunkMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ChunkMessage::ChunkFetch {
                client_id,
                dataset_id,
                image_id,
                key,
            } => {
                assert_eq!(client_id, 42);
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(image_id, ImageId("img1".into()));
                assert_eq!(key, "1/0/0/2/3/4");
            }
            _ => panic!("expected ChunkFetch"),
        }
    }

    #[test]
    fn viewer_interest_round_trips_as_unsequenced_client_message() {
        let msg = ClientMessage::ViewerInterest {
            interest: ViewerInterestHint {
                client_id: None,
                dataset_id: DatasetId("ds1".into()),
                generation: 9,
                t: 2,
                z: 3,
                channels: vec![0, 2],
                mode: ViewerInterestMode::Slice,
                viewport: Some(ViewerInterestViewport {
                    xy_bounds: [0.0, 1.0, 2.0, 3.0],
                    z_range: [3.0, 4.0],
                }),
                desired_keys: vec![ViewerInterestChunkKey {
                    image_id: ImageId("img1".into()),
                    key: "1/2/0/0/0/0".into(),
                    lane: ViewerInterestLane::Visible,
                }],
                predicted_keys: vec![ViewerInterestChunkKey {
                    image_id: ImageId("img1".into()),
                    key: "1/2/0/0/0/1".into(),
                    lane: ViewerInterestLane::Predicted,
                }],
                interaction: ViewerInteractionMode::Scrubbing,
                timestamp_ms: 1234,
                ttl_ms: 2000,
            },
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"viewer_interest\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::ViewerInterest { interest } => {
                assert_eq!(interest.dataset_id, DatasetId("ds1".into()));
                assert_eq!(interest.desired_keys[0].lane, ViewerInterestLane::Visible);
                assert_eq!(
                    interest.predicted_keys[0].lane,
                    ViewerInterestLane::Predicted
                );
                assert_eq!(interest.interaction, ViewerInteractionMode::Scrubbing);
            }
            _ => panic!("expected ViewerInterest"),
        }
    }

    #[test]
    fn command_broadcast_round_trips() {
        let cmd = DocumentCommand::RemoveDataset {
            id: DatasetId("ds1".into()),
        };
        let msg = ServerMessage::CommandBroadcast {
            seq: 5,
            command: cmd,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::CommandBroadcast { seq, command } => {
                assert_eq!(seq, 5);
                match command {
                    DocumentCommand::RemoveDataset { id } => {
                        assert_eq!(id, DatasetId("ds1".into()));
                    }
                    _ => panic!("expected RemoveDataset command"),
                }
            }
            _ => panic!("expected CommandBroadcast"),
        }
    }

    #[test]
    fn client_message_command_round_trips() {
        let reg = crate::scene::test_helpers::make_dataset_opened("ds1", "test", 1);
        let msg = ClientMessage::Command {
            command: DocumentCommand::DatasetOpened(reg),
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
        assert!(matches!(
            parsed,
            ServerMessage::PeerJoined { client_id: 3, .. }
        ));
    }

    #[test]
    fn fly_camera_presence_round_trips() {
        use crate::camera::{ClipMode, Fly};
        let mut fly = Fly::new([1024, 768]);
        fly.position = [1.5, 2.5, 3.5];
        fly.orientation = [0.1, 0.2, 0.3, 0.9273]; // approximately normalized
        fly.clip_distance = 0.42;
        fly.clip_mode = ClipMode::Sphere;

        let ps = PresenceState {
            client_id: 7,
            camera: Camera::Fly(fly),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: Some(3),
            cursor: Some([0.5, 0.5]),
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
        };
        let json = serde_json::to_string(&ps).unwrap();
        assert!(
            json.contains("\"mode\":\"fly\""),
            "JSON should contain fly mode tag"
        );
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.client_id, 7);
        assert_eq!(parsed.following, Some(3));
        assert_eq!(parsed.cursor, Some([0.5, 0.5]));
        // Verify camera round-tripped as Fly with correct state
        match &parsed.camera {
            Camera::Fly(v) => {
                assert_eq!(v.position, [1.5, 2.5, 3.5]);
                assert!((v.orientation[0] - 0.1).abs() < 1e-10);
                assert_eq!(v.clip_distance, 0.42);
                assert_eq!(v.clip_mode, ClipMode::Sphere);
            }
            _ => panic!("expected Camera::Fly, got {:?}", parsed.camera),
        }
    }

    #[test]
    fn fly_camera_presence_update_round_trips() {
        use crate::camera::Fly;
        let fly = Fly::new([800, 600]);
        let msg = ServerMessage::PresenceUpdate {
            client_id: 5,
            camera: Camera::Fly(fly),
            view: ViewState::new(),
            display: DisplayState::default(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"presence_update\""));
        assert!(json.contains("\"mode\":\"fly\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::PresenceUpdate {
                client_id, camera, ..
            } => {
                assert_eq!(client_id, 5);
                assert!(matches!(camera, Camera::Fly(_)));
            }
            _ => panic!("expected PresenceUpdate"),
        }
    }

    #[test]
    fn open_remote_dataset_round_trips() {
        let msg = ClientMessage::OpenRemoteDataset {
            request_id: "req-1".into(),
            url: "/mnt/data/experiment.zarr".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"open_remote_dataset\""));
        assert!(json.contains("\"request_id\":\"req-1\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::OpenRemoteDataset { request_id, url } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(url, "/mnt/data/experiment.zarr");
            }
            _ => panic!("expected OpenRemoteDataset"),
        }
    }

    #[test]
    fn open_dataset_failed_round_trips() {
        use lucida_protocol::{
            DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenStage,
        };

        let msg = ServerMessage::OpenDatasetFailed {
            request_id: "req-1".into(),
            url: "gs://bucket/missing.zarr".into(),
            error: "not found".into(),
            diagnostic: Some(DatasetOpenFailureDiagnostic {
                stage: DatasetOpenStage::BackendOpen,
                kind: DatasetOpenFailureKind::MissingObject,
                retryable: false,
                message: "not found".into(),
                detail: None,
            }),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"open_dataset_failed\""));
        assert!(json.contains("\"kind\":\"missing_object\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::OpenDatasetFailed {
                request_id,
                url,
                error,
                diagnostic,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(url, "gs://bucket/missing.zarr");
                assert_eq!(error, "not found");
                assert_eq!(
                    diagnostic.unwrap().kind,
                    DatasetOpenFailureKind::MissingObject
                );
            }
            _ => panic!("expected OpenDatasetFailed"),
        }
    }

    #[test]
    fn dataset_health_request_round_trips() {
        let msg = ClientMessage::DatasetHealth {
            request_id: "health-1".into(),
            dataset_id: Some(DatasetId("wds-1".into())),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"dataset_health\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::DatasetHealth {
                request_id,
                dataset_id,
            } => {
                assert_eq!(request_id, "health-1");
                assert_eq!(dataset_id, Some(DatasetId("wds-1".into())));
            }
            _ => panic!("expected DatasetHealth"),
        }
    }

    #[test]
    fn asset_catalog_update_round_trips() {
        use lucida_protocol::{AssetCatalogDelta, ProxyAvailability, ProxyKind};

        let msg = ServerMessage::AssetCatalogUpdate {
            dataset_id: DatasetId("ds1".into()),
            delta: AssetCatalogDelta {
                added: vec![ProxyAvailability {
                    entity_id: lucida_content::EntityId("e1".into()),
                    kinds: vec![ProxyKind::WellProxy3D],
                    footprints: vec![],
                }],
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"asset_catalog_update\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::AssetCatalogUpdate { dataset_id, delta } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(delta.added.len(), 1);
                assert_eq!(
                    delta.added[0].entity_id,
                    lucida_content::EntityId("e1".into())
                );
                assert_eq!(delta.added[0].kinds, vec![ProxyKind::WellProxy3D]);
            }
            _ => panic!("expected AssetCatalogUpdate"),
        }
    }

    #[test]
    fn generated_availability_update_round_trips() {
        use lucida_content::{
            GeneratedLevelInfo, GeneratedLevelProvenance, GeneratedLevelRole, LevelGeometry,
        };
        use lucida_protocol::{
            GeneratedAvailabilityDelta, GeneratedChunkStatus, GeneratedChunkStatusUpdate,
            GeneratedLevelAvailability,
        };

        let msg = ServerMessage::GeneratedAvailabilityUpdate {
            dataset_id: DatasetId("ds1".into()),
            delta: GeneratedAvailabilityDelta {
                levels: vec![GeneratedLevelAvailability {
                    image_id: ImageId("img1".into()),
                    info: GeneratedLevelInfo {
                        level_index: 2,
                        role: GeneratedLevelRole::Coarse,
                        provenance: GeneratedLevelProvenance::default(),
                    },
                    level: LevelGeometry {
                        level_index: 2,
                        shape: [1, 1, 1, 64, 64],
                        chunk_shape: [1, 1, 1, 64, 64],
                        grid_shape: [1, 1, 1, 1, 1],
                        scale: [1.0, 1.0, 1.0, 8.0, 8.0],
                    },
                    summary: None,
                }],
                chunks: vec![GeneratedChunkStatusUpdate {
                    image_id: ImageId("img1".into()),
                    level_index: 2,
                    key: "2/0/0/0/0/0".into(),
                    status: GeneratedChunkStatus::Ready,
                    message: None,
                }],
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"generated_availability_update\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::GeneratedAvailabilityUpdate { dataset_id, delta } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(delta.levels.len(), 1);
                assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
            }
            _ => panic!("expected GeneratedAvailabilityUpdate"),
        }
    }

    #[test]
    fn generated_chunk_status_round_trips() {
        let msg = ServerMessage::GeneratedChunkStatus {
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "2/0/0/0/0/0".into(),
            status: GeneratedChunkStatus::Pending,
            message: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"generated_chunk_status\""));
        assert!(json.contains("\"status\":\"pending\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::GeneratedChunkStatus { status, .. } => {
                assert_eq!(status, GeneratedChunkStatus::Pending);
            }
            _ => panic!("expected GeneratedChunkStatus"),
        }
    }

    #[test]
    fn bookmark_action_serializes_lowercase() {
        // Wire-stability assertion: action names are the lowercase enum
        // variant names. The web client matches on these strings; renaming
        // a variant must not change the JSON.
        assert_eq!(
            serde_json::to_string(&BookmarkAction::Created).unwrap(),
            "\"created\"",
        );
        assert_eq!(
            serde_json::to_string(&BookmarkAction::Updated).unwrap(),
            "\"updated\"",
        );
        assert_eq!(
            serde_json::to_string(&BookmarkAction::Deleted).unwrap(),
            "\"deleted\"",
        );
        let parsed: BookmarkAction = serde_json::from_str("\"created\"").unwrap();
        assert_eq!(parsed, BookmarkAction::Created);
    }

    #[test]
    fn bookmark_changed_round_trips() {
        let msg = ServerMessage::BookmarkChanged {
            id: "abc-123".into(),
            action: BookmarkAction::Created,
            dataset_urls: vec!["gs://bucket/a.zarr".into(), "gs://bucket/b.zarr".into()],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"bookmark_changed\""));
        assert!(json.contains("\"action\":\"created\""));
        assert!(json.contains("\"id\":\"abc-123\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::BookmarkChanged {
                id,
                action,
                dataset_urls,
            } => {
                assert_eq!(id, "abc-123");
                assert_eq!(action, BookmarkAction::Created);
                assert_eq!(
                    dataset_urls,
                    vec![
                        "gs://bucket/a.zarr".to_string(),
                        "gs://bucket/b.zarr".to_string()
                    ],
                );
            }
            _ => panic!("expected BookmarkChanged"),
        }
    }

    #[test]
    fn bookmark_changed_updated_and_deleted_actions_round_trip() {
        for action in [BookmarkAction::Updated, BookmarkAction::Deleted] {
            let msg = ServerMessage::BookmarkChanged {
                id: "id".into(),
                action,
                dataset_urls: vec![],
            };
            let json = serde_json::to_string(&msg).unwrap();
            let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
            match parsed {
                ServerMessage::BookmarkChanged { action: a, .. } => assert_eq!(a, action),
                _ => panic!("expected BookmarkChanged"),
            }
        }
    }

    #[test]
    fn workspace_archived_round_trips() {
        let msg = ServerMessage::WorkspaceArchived {
            workspace_id: "workspace-1".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"workspace_archived\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::WorkspaceArchived { workspace_id } => {
                assert_eq!(workspace_id, "workspace-1");
            }
            _ => panic!("expected WorkspaceArchived"),
        }
    }

    #[test]
    fn fly_camera_client_message_presence_round_trips() {
        use crate::camera::Fly;
        let fly = Fly::new([800, 600]);
        let msg = ClientMessage::Presence {
            camera: Camera::Fly(fly),
            view: ViewState::new(),
            display: DisplayState::default(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"presence\""));
        assert!(json.contains("\"mode\":\"fly\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Presence { camera, .. } => {
                assert!(matches!(camera, Camera::Fly(_)));
            }
            _ => panic!("expected Presence"),
        }
    }
}
