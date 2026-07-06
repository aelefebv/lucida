use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, ImageId};
use lucida_protocol::{
    AssetCatalogDelta, DatasetOpenFailureDiagnostic, DatasetOpenProgressDiagnostic,
    DatasetOpenSuccessDiagnostic, DatasetSourceHealth, GeneratedAvailabilityDelta,
    GeneratedAvailabilitySnapshot, GeneratedChunkStatus,
};

use crate::camera::Camera;
use crate::command::DocumentCommand;
use crate::scene::{DatasetDisplaySettings, DisplayState, DocumentState};
use crate::view::ViewState;

pub type ClientId = u64;

/// Presentational identity of a connected peer, surfaced on their live
/// cursor in collaborative mode (issue #540). Server-authored from the
/// session's authenticated `AuthPrincipal` — clients never send this, so
/// it can't be spoofed and is only ever shown to co-present peers.
///
/// Privacy: the raw email address is NEVER carried here. Collaborator
/// emails are owner-only (the `/sharing` endpoint is `require_owner`-gated),
/// so presence — which every co-present peer receives, including non-owner
/// link-access viewers/editors — must not leak them. Only the
/// non-identifying `display_name`, `picture_url`, and a single-grapheme
/// `initial` cross the wire.
///
/// All fields are best-effort: an unauthenticated/legacy session leaves
/// `identity` as `None` on `PresenceState`, and within an identity a
/// provider may omit `picture_url`. Consumers fall back name → initial
/// chip → numeric id/color.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerIdentity {
    /// Human-facing name (`AuthPrincipal::display_name`). May be empty if
    /// the provider supplied none.
    pub display_name: String,
    /// Avatar URL (`AuthPrincipal::picture_url`). `None` for dev sessions
    /// and providers without a picture — the cursor falls back to an
    /// initial chip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture_url: Option<String>,
    /// Single-grapheme fallback glyph for the avatar chip, computed
    /// server-side from the display name (or, when blank, the email
    /// local-part) so the cursor has a stable initial WITHOUT the raw
    /// email crossing the wire. Empty only when no usable source existed.
    #[serde(default)]
    pub initial: String,
}

impl PeerIdentity {
    /// Build a wire identity from the connection's authenticated principal,
    /// computing the fallback `initial` server-side from the display name —
    /// or, when that is blank, the email local-part — so the raw `email`
    /// never crosses the wire. The returned `PeerIdentity` carries no email.
    pub fn from_principal_parts(
        display_name: String,
        picture_url: Option<String>,
        email: &str,
    ) -> Self {
        let initial = Self::compute_initial(&display_name, email);
        Self {
            display_name,
            picture_url,
            initial,
        }
    }

    /// First uppercased character of the display name, falling back to the
    /// email local-part (the bit before `@`), else empty. Only this single
    /// grapheme — never the full address — is exposed to peers.
    fn compute_initial(display_name: &str, email: &str) -> String {
        let from = |s: &str| s.trim().chars().next();
        let ch = from(display_name).or_else(|| from(email.split('@').next().unwrap_or("")));
        ch.map(|c| c.to_uppercase().to_string()).unwrap_or_default()
    }
}

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
    /// Presentational identity for the peer's cursor (#540). Server-set
    /// from the authed principal; `None` for sessions without auth (the
    /// non-workspace `/ws` path) so older/anonymous peers still render
    /// via the numeric-id fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<PeerIdentity>,
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
    /// Retry rebuilding a persisted workspace dataset's server binding.
    DatasetRetry {
        request_id: String,
        dataset_id: DatasetId,
    },
    /// Advisory, unsequenced scheduling hint for server-generated chunks.
    /// This is session/runtime state only; it is not a document command and
    /// must not be persisted in saved views.
    ViewerInterest { interest: ViewerInterestHint },
    /// Request a fresh authoritative [`ServerMessage::Snapshot`] for this
    /// session. Sent when the client detects a gap in the sequenced
    /// `CommandBroadcast`/`Ack` stream (the server's per-client broadcast
    /// queue overflowed and dropped messages). The server answers on the
    /// requester's connection with the same snapshot a (re)connect
    /// receives, and the client resumes seq tracking from the snapshot's
    /// `seq`. Carries no fields: the snapshot is self-describing, and the
    /// client's seq discipline makes a redundant snapshot harmless.
    RequestSnapshot,
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
    /// Sent to the requester while OpenRemoteDataset is moving through
    /// coarse, stable server-authored stages.
    DatasetOpenProgress {
        request_id: String,
        url: String,
        diagnostic: DatasetOpenProgressDiagnostic,
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
    fn request_snapshot_round_trips() {
        let msg = ClientMessage::RequestSnapshot;
        let json = serde_json::to_string(&msg).unwrap();
        // Wire-stability assertion: the resync request is exactly this
        // envelope — the web client emits it as a literal.
        assert_eq!(json, r#"{"type":"request_snapshot"}"#);
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ClientMessage::RequestSnapshot));
    }

    #[test]
    fn client_message_request_snapshot_matches_wire_envelope() {
        // The exact client->server envelope the web sends on a detected
        // seq gap.
        let json = r#"{"type":"request_snapshot"}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(parsed, ClientMessage::RequestSnapshot));
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
    fn client_message_add_annotation_matches_wire_envelope() {
        // The exact client->server envelope from the slice wire contract.
        let json = r#"{"type":"command","command":{"type":"add_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"author":"alice","kind":"point"}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command:
                    DocumentCommand::AddAnnotation {
                        dataset_id,
                        id,
                        position,
                        author,
                        ..
                    },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [3.0, 4.0]);
                assert_eq!(author, "alice");
            }
            _ => panic!("expected Command(AddAnnotation)"),
        }
    }

    #[test]
    fn add_annotation_broadcast_is_byte_identical_to_inbound_command() {
        // Client-supplied id means the inbound command and its rebroadcast
        // carry the same command object byte-for-byte (only seq differs). The
        // depth `z` rides along unchanged, so a peer receives the pin's z.
        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [3.0, 4.0],
            end: None,
            z: 8.5,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: None,
        };
        let inbound = ClientMessage::Command {
            command: cmd.clone(),
        };
        let broadcast = ServerMessage::CommandBroadcast {
            seq: 7,
            command: cmd,
        };

        let inbound_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&inbound).unwrap()).unwrap();
        let broadcast_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&broadcast).unwrap()).unwrap();
        assert_eq!(inbound_v["command"], broadcast_v["command"]);
        assert_eq!(broadcast_v["command"]["z"], 8.5);
        assert_eq!(broadcast_v["type"], "command_broadcast");
        assert_eq!(broadcast_v["seq"], 7);
    }

    #[test]
    fn add_annotation_with_multi_dataset_view_rebroadcasts_byte_identical() {
        // The companion to the test above, but for an `AddAnnotation` carrying
        // an embedded `SavedView` with >=2 datasets — and asserting byte-identity
        // of the wire STRING, not a `serde_json::Value` compare. The Value compare
        // above is order-insensitive, so it would pass even if the embedded view's
        // per-dataset maps re-serialized in a different order; THIS test would not.
        //
        // It mimics the server's exact rebroadcast: parse the inbound
        // `ClientMessage` bytes, then re-serialize the parsed command inside a
        // `CommandBroadcast` (handler.rs: `from_str::<ClientMessage>` ->
        // `to_string(CommandBroadcast { seq, command })`). The `command` substring
        // of the broadcast must be byte-identical to the `command` substring of
        // the inbound message. This holds because `SavedView`'s maps are
        // `IndexMap` (insertion/parse order preserved); with `HashMap` the >=2
        // dataset maps re-emit in randomized order and this diverges.
        use crate::saved_view::SavedView;
        use lucida_content::LayoutId;

        let mut view = SavedView::empty([1024, 768]);
        for k in ["ds-aaaa", "ds-bbbb", "ds-cccc"] {
            view.active_layouts
                .insert(DatasetId(k.into()), LayoutId(format!("L-{k}")));
            view.dataset_settings
                .insert(DatasetId(k.into()), DatasetDisplaySettings::default());
            view.auto_contrast.insert(DatasetId(k.into()), false);
            view.dataset_order.push(DatasetId(k.into()));
        }

        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [3.0, 4.0],
            end: None,
            z: 0.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: Some(Box::new(view)),
        };

        // Inbound wire bytes the author broadcasts.
        let inbound_json = serde_json::to_string(&ClientMessage::Command {
            command: cmd.clone(),
        })
        .unwrap();

        // SERVER: parse the inbound message, then re-serialize the parsed command
        // inside a broadcast (the real from_str -> to_string path).
        let parsed: ClientMessage = serde_json::from_str(&inbound_json).unwrap();
        let ClientMessage::Command { command } = parsed else {
            panic!("expected Command");
        };
        let broadcast_json =
            serde_json::to_string(&ServerMessage::CommandBroadcast { seq: 7, command }).unwrap();

        // Extract the raw `command` value substring from each (NOT via Value,
        // which would normalize order). In BOTH messages `command` is the LAST
        // field, so everything from `"command":` to the message's final closing
        // brace is the command value followed by exactly one `}` — identical
        // framing for both, so comparing those suffixes compares the command
        // bytes verbatim.
        fn command_suffix(s: &str) -> &str {
            let start = s.find("\"command\":").unwrap();
            &s[start..]
        }
        let inbound_cmd = command_suffix(&inbound_json);
        let broadcast_cmd = command_suffix(&broadcast_json);
        assert_eq!(
            inbound_cmd, broadcast_cmd,
            "rebroadcast command bytes must be byte-identical to inbound for a \
             >=2-dataset embedded view"
        );
        // Guard the embedded view actually rode along with >=2 datasets.
        assert!(inbound_cmd.contains("ds-aaaa"));
        assert!(inbound_cmd.contains("ds-bbbb"));
        assert!(inbound_cmd.contains("ds-cccc"));
    }

    #[test]
    fn snapshot_carries_annotations_under_document() {
        // A late joiner loads pins from snapshot.document.annotations,
        // including each pin's depth `z`.
        let mut doc = DocumentState::default();
        doc.apply(DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [10.0, 20.0],
            end: None,
            z: 12.5,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: None,
        });
        let msg = ServerMessage::Snapshot {
            seq: 3,
            document: doc,
            peers: Vec::new(),
            your_id: 1,
            generated_availability: HashMap::new(),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        assert_eq!(v["type"], "snapshot");
        let pin = &v["document"]["annotations"]["wds-1"][0];
        assert_eq!(pin["id"], "pin-1");
        assert_eq!(pin["position"][0], 10.0);
        assert_eq!(pin["position"][1], 20.0);
        assert_eq!(pin["z"], 12.5);
        assert_eq!(pin["author"], "alice");
        assert_eq!(pin["kind"], "point");

        // And it round-trips back into a usable DocumentState with z intact.
        let parsed: ServerMessage =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        match parsed {
            ServerMessage::Snapshot { document, .. } => {
                let pins = &document.annotations[&DatasetId("wds-1".into())];
                assert_eq!(pins.len(), 1);
                assert_eq!(pins[0].z, 12.5);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn client_message_remove_annotation_matches_wire_envelope() {
        let json = r#"{"type":"command","command":{"type":"remove_annotation","dataset_id":"wds-1","id":"pin-1"}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command: DocumentCommand::RemoveAnnotation { dataset_id, id },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
            }
            _ => panic!("expected Command(RemoveAnnotation)"),
        }
    }

    #[test]
    fn client_message_move_annotation_matches_wire_envelope() {
        // The exact client->server envelope from the slice wire contract.
        let json = r#"{"type":"command","command":{"type":"move_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"z":5.0}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command:
                    DocumentCommand::MoveAnnotation {
                        dataset_id,
                        id,
                        position,
                        end,
                        z,
                    },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [3.0, 4.0]);
                // No `end` in this slice-#776 wire payload → defaults to None.
                assert_eq!(end, None);
                assert_eq!(z, 5.0);
            }
            _ => panic!("expected Command(MoveAnnotation)"),
        }
    }

    #[test]
    fn client_message_edit_comment_matches_wire_envelope() {
        // The exact client->server envelope from the slice wire contract.
        let json = r#"{"type":"command","command":{"type":"edit_comment","dataset_id":"wds-1","annotation_id":"pin-1","id":"c-1","text":"edited"}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command:
                    DocumentCommand::EditComment {
                        dataset_id,
                        annotation_id,
                        id,
                        text,
                    },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
                assert_eq!(text, "edited");
            }
            _ => panic!("expected Command(EditComment)"),
        }
    }

    #[test]
    fn snapshot_reflects_moved_position_and_edited_text() {
        // A late joiner loads the pin at its moved position/z and the comment at
        // its edited text, straight from snapshot.document.annotations.
        let mut doc = DocumentState::default();
        doc.apply(DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [10.0, 20.0],
            end: None,
            z: 1.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: None,
        });
        doc.apply(DocumentCommand::AddComment {
            dataset_id: DatasetId("wds-1".into()),
            annotation_id: "pin-1".into(),
            id: "c-1".into(),
            author: "alice".into(),
            text: "before".into(),
        });
        // Now update both. A whole-shape move (no `end`) — the rigid #776 path.
        doc.apply(DocumentCommand::MoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [55.0, 66.0],
            end: None,
            z: 7.5,
        });
        doc.apply(DocumentCommand::EditComment {
            dataset_id: DatasetId("wds-1".into()),
            annotation_id: "pin-1".into(),
            id: "c-1".into(),
            text: "after".into(),
        });

        let msg = ServerMessage::Snapshot {
            seq: 5,
            document: doc,
            peers: Vec::new(),
            your_id: 1,
            generated_availability: HashMap::new(),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        let pin = &v["document"]["annotations"]["wds-1"][0];
        assert_eq!(pin["position"][0], 55.0);
        assert_eq!(pin["position"][1], 66.0);
        assert_eq!(pin["z"], 7.5);
        assert_eq!(pin["comments"][0]["id"], "c-1");
        assert_eq!(pin["comments"][0]["text"], "after");
        // Author is preserved across the edit.
        assert_eq!(pin["comments"][0]["author"], "alice");
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
            identity: None,
        };
        let json = serde_json::to_string(&ps).unwrap();
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.client_id, 1);
        assert_eq!(parsed.cursor, Some([100.0, 200.0]));
        assert_eq!(parsed.following, None);
        assert_eq!(parsed.identity, None);
    }

    #[test]
    fn presence_state_carries_identity_round_trip() {
        // #540: a peer's presence carries the server-authored display name +
        // avatar URL so the cursor overlay can render them.
        let ps = PresenceState {
            client_id: 9,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: Some([1.0, 2.0]),
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
            identity: Some(PeerIdentity {
                display_name: "Ada Lovelace".into(),
                picture_url: Some("https://example.com/ada.png".into()),
                initial: "A".into(),
            }),
        };
        let json = serde_json::to_string(&ps).unwrap();
        assert!(json.contains("\"display_name\":\"Ada Lovelace\""));
        assert!(json.contains("\"picture_url\":\"https://example.com/ada.png\""));
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        let identity = parsed.identity.expect("identity present");
        assert_eq!(identity.display_name, "Ada Lovelace");
        assert_eq!(
            identity.picture_url.as_deref(),
            Some("https://example.com/ada.png")
        );
        assert_eq!(identity.initial, "A");
    }

    #[test]
    fn peer_identity_never_carries_raw_email_on_the_wire() {
        // Privacy invariant (#540 review): collaborator emails are owner-only,
        // so the identity broadcast to every co-present peer must NOT contain
        // the raw address. The server computes a single-grapheme `initial`
        // from display-name-or-email instead; the email itself never crosses.
        let identity =
            PeerIdentity::from_principal_parts("Ada Lovelace".into(), None, "ada@example.com");
        assert_eq!(identity.initial, "A");
        let json = serde_json::to_string(&identity).unwrap();
        assert!(
            !json.contains("ada@example.com"),
            "raw email must not appear in the identity JSON: {json}"
        );
        assert!(
            !json.contains("email"),
            "no email field on the wire: {json}"
        );
        assert!(
            !json.contains('@'),
            "no address local-part@domain leaks: {json}"
        );

        // Blank display name → initial falls back to the email local-part's
        // first letter, but STILL never exposes the address.
        let blank = PeerIdentity::from_principal_parts("   ".into(), None, "zoe@example.com");
        assert_eq!(blank.initial, "Z");
        let blank_json = serde_json::to_string(&blank).unwrap();
        assert!(!blank_json.contains("zoe@example.com"));
        assert!(!blank_json.contains('@'));
    }

    #[test]
    fn presence_state_without_identity_is_backward_tolerant() {
        // A peer (older client, or the anonymous `/ws` path) sends presence
        // with no `identity` key. It must still parse, with `identity = None`,
        // so the cursor falls back to the numeric-id rendering.
        let legacy = r#"{
            "client_id": 4,
            "camera": {"mode":"slice","center":[0.0,0.0],"zoom":1.0,"viewport":[800,600]},
            "view": {"z_range":{"start":0,"end":1},"t":0,"c":0},
            "display": {"contrast_min":0.0,"contrast_max":1.0,"gamma":1.0},
            "following": null,
            "cursor": null
        }"#;
        let parsed: PresenceState = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.client_id, 4);
        assert_eq!(parsed.identity, None);
        assert!(parsed.dataset_order.is_empty());
    }

    #[test]
    fn peer_identity_without_picture_url_round_trips() {
        // Dev sessions / providers with no avatar: `picture_url` is omitted on
        // the wire (skip_serializing_if) and parses back to None.
        let identity = PeerIdentity {
            display_name: "Dev User".into(),
            picture_url: None,
            initial: "D".into(),
        };
        let json = serde_json::to_string(&identity).unwrap();
        assert!(!json.contains("picture_url"));
        let parsed: PeerIdentity = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.display_name, "Dev User");
        assert_eq!(parsed.picture_url, None);
        assert_eq!(parsed.initial, "D");
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
            identity: None,
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
            identity: None,
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
    fn dataset_open_progress_round_trips() {
        use lucida_protocol::{DatasetOpenProgressDiagnostic, DatasetOpenStage};

        let msg = ServerMessage::DatasetOpenProgress {
            request_id: "req-1".into(),
            url: "/mnt/data/experiment.zarr".into(),
            diagnostic: DatasetOpenProgressDiagnostic {
                stage: DatasetOpenStage::GeneratedCoarsePlanning,
                message: "planning generated coarse levels".into(),
                workspace_dataset_id: Some(DatasetId("wds-1".into())),
                dataset_source_id: Some("source-1".into()),
                detail: Some("2 derived levels".into()),
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"dataset_open_progress\""));
        assert!(json.contains("\"stage\":\"generated_coarse_planning\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::DatasetOpenProgress {
                request_id,
                url,
                diagnostic,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(url, "/mnt/data/experiment.zarr");
                assert_eq!(diagnostic.stage, DatasetOpenStage::GeneratedCoarsePlanning);
                assert_eq!(
                    diagnostic.workspace_dataset_id,
                    Some(DatasetId("wds-1".into()))
                );
            }
            _ => panic!("expected DatasetOpenProgress"),
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
    fn dataset_retry_request_round_trips() {
        let msg = ClientMessage::DatasetRetry {
            request_id: "retry-1".into(),
            dataset_id: DatasetId("wds-1".into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"dataset_retry\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::DatasetRetry {
                request_id,
                dataset_id,
            } => {
                assert_eq!(request_id, "retry-1");
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
            }
            _ => panic!("expected DatasetRetry"),
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
