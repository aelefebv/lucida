//! Golden-fixture lock tests for the JSON wire protocol.
//!
//! Every convention-governed JSON payload family that crosses the WebSocket
//! between lucida-server and the web client is pinned by a committed fixture
//! under `wire-fixtures/` at the repository root:
//!
//! - session envelopes (`lucida_core::protocol::{ServerMessage, ClientMessage}`),
//!   including every web-live `DocumentCommand` and the open/health
//!   diagnostics the envelopes carry;
//! - the dataset-open payload (`lucida_protocol::DatasetOpened`) and the
//!   `FetchSource` variants;
//! - generated-availability payloads (snapshot/delta/chunk status updates);
//! - the JSON request envelopes `ChunkMessage::ChunkRequest` and
//!   `AssetMessage::AssetRequest`;
//! - the enum vocabulary fixture (`vocab/enum_vocabulary.json`): one exemplar
//!   per variant for every enum whose string form the web switches on.
//!
//! `ViewportCommand` is out of wire scope by design and needs no fixtures:
//! viewport commands never cross the socket — `ClientMessage::Command`
//! carries `DocumentCommand` only, and presence carries viewport *state*,
//! not commands (see wiki/decisions/0001-document-vs-viewport-split.md).
//!
//! This test constructs the exact same values in code, serializes them with
//! serde, and asserts byte-for-byte equality with the committed files. The
//! companion vitest suite (`lucida-web/src/wireGoldens.test.ts`) parses the
//! SAME files through the web client's real consumption paths, so a schema
//! change on either side fails one of the two suites instead of shipping as
//! silent `undefined`s in the browser.
//!
//! # Regenerating
//!
//! After an intentional wire change, regenerate the fixtures with
//!
//! ```text
//! REGEN_WIRE_GOLDENS=1 cargo test -p lucida-server --test wire_goldens
//! ```
//!
//! and then run `cd lucida-web && pnpm test` — the vitest suite failing on
//! the regenerated fixtures is the lock doing its job: update the web's
//! mirror types/expectations to match before shipping. Regeneration only
//! writes files; a fixture removed from the tables below is reported as a
//! stray by `fixture_directory_matches_declared_set` and must be deleted by
//! hand.
//!
//! # What each layer of this test enforces
//!
//! - **Byte lock** (`check`): serde output equals the committed bytes, and
//!   the committed bytes deserialize back into the type (both directions of
//!   the wire). Runs in regen mode too.
//! - **Required-key harness** (`check`, `required` lists): for every listed
//!   JSON pointer, deleting that key from the fixture must make
//!   deserialization FAIL. Making a required field optional (`Option` /
//!   `#[serde(default)]`) therefore forces a visible edit to the pointer
//!   list here — it cannot slip through as a silently-tolerated missing key.
//!   Each required field of each wire type is covered at least once across
//!   the fixture set (not at every occurrence).
//! - **Variant exhaustiveness** (the `*_fixture_paths` matches and the
//!   `vocab!` lists): adding a `ServerMessage`/`ClientMessage`/
//!   `DocumentCommand`/`ChunkMessage`/`AssetMessage` variant, or a variant of
//!   any vocabulary enum, is a COMPILE error until it is wired to a fixture
//!   (or an explicit documented exclusion).
//! - **Maximal fixtures**: every `Option`/`skip_serializing_if` field on the
//!   covered wire types is populated (non-default) in at least one fixture,
//!   so adding `skip_serializing_if` to an existing field changes a fixture
//!   at regen and trips the web-side expectations.
//!
//! # Known limits (deliberate, documented)
//!
//! - A **newly added** serde-skipped field that no fixture populates never
//!   appears in any fixture, so this lock cannot see it. The mitigation is
//!   the maximal-fixture discipline above (populate every optional field in
//!   at least one fixture when adding it) plus review.
//! - The **binary** chunk/proxy frames (length-prefixed `client_id + key +
//!   payload` framing and the 64-byte proxy header) are out of scope here;
//!   the proxy header layout is locked separately by
//!   `lucida-web/src/pipeline/fetch/wireProtocol.test.ts`.
//! - `ChunkMessage::ChunkFetch` is currently unproduced wire vocabulary:
//!   nothing in the repo sends it, and the server's handler accepts and
//!   ignores it. It is excluded below because there is no producer or
//!   consumer to lock.
//!
//! # Fixture-authoring constraint
//!
//! Any `std::collections::HashMap` that crosses the wire (e.g.
//! `Snapshot::generated_availability`, `PresenceState::dataset_settings`)
//! must hold at most ONE entry here, because `HashMap` iteration order is
//! not deterministic and would break byte equality. `IndexMap`-backed fields
//! (`DocumentState::manifests`, `SavedView::dataset_settings`, ...) preserve
//! insertion order and may hold several.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;

use lucida_content::{
    Axis, AxisKind, ChannelInfo, DataType, DatasetId, DatasetKind, DatasetManifest, Entity,
    EntityId, EntityKind, EntityLabels, EntityPlacement, GeneratedLevelInfo,
    GeneratedLevelProvenance, GeneratedLevelRole, ImageId, ImageSpec, LabelColor, LabelSpec,
    LayoutId, LayoutSpec, LevelGeometry, MultiscaleInfo, PinnedAxis, PositioningMode,
    TransformEdge, VoxelTransform,
};
use lucida_core::camera::{Arcball, Camera, ClipMode, Fly, Slice};
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{
    BookmarkAction, ChunkMessage, ClientMessage, PeerIdentity, PresenceState, ServerMessage,
    ViewerInteractionMode, ViewerInterestChunkKey, ViewerInterestHint, ViewerInterestLane,
    ViewerInterestMode, ViewerInterestViewport,
};
use lucida_core::saved_view::{SAVED_VIEW_VERSION, SavedView};
use lucida_core::scene::{
    Annotation, AnnotationKind, BlendMode, ChannelSettings, Colormap, Comment,
    DatasetDisplaySettings, DisplayState, DocumentState, LabelSettings, RenderMode,
};
use lucida_core::view::ViewState;
use lucida_protocol::{
    AssetCatalog, AssetCatalogDelta, AssetMessage, DatasetGeneratedCoarseCacheStats,
    DatasetGeneratedCoarseFailure, DatasetGeneratedCoarseHealth, DatasetHealthComponent,
    DatasetHealthStatus, DatasetOpenFailureDiagnostic, DatasetOpenFailureKind,
    DatasetOpenProgressDiagnostic, DatasetOpenStage, DatasetOpenSuccessDiagnostic, DatasetOpened,
    DatasetSourceCacheStats, DatasetSourceHealth, DirectFetchDescriptor, DirectImageSpec,
    FetchSource, GeneratedAvailabilityDelta, GeneratedAvailabilitySnapshot, GeneratedChunkStatus,
    GeneratedChunkStatusUpdate, GeneratedLevelAvailability, GeneratedLevelSummary, LevelAddress,
    LocalFetchDescriptor, ProxiedFetchDescriptor, ProxiedImageSpec, ProxyAvailability,
    ProxyFootprint, ProxyKind, WireFormat,
};

const REGEN_HINT: &str = "fixture out of date with the Rust wire types. If the wire change is \
     intentional, regenerate with `REGEN_WIRE_GOLDENS=1 cargo test -p lucida-server --test \
     wire_goldens`, then run `cd lucida-web && pnpm test` and update the web-side expectations \
     in lucida-web/src/wireGoldens.test.ts to match.";

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("wire-fixtures")
}

fn regen() -> bool {
    std::env::var_os("REGEN_WIRE_GOLDENS").is_some_and(|v| !v.is_empty() && v != "0")
}

/// First line number (1-based) at which two strings differ, with both lines.
fn first_diff(expected: &str, actual: &str) -> String {
    for (i, (e, a)) in expected.lines().zip(actual.lines()).enumerate() {
        if e != a {
            return format!(
                "first difference at line {}:\n  fixture: {e}\n  rust:    {a}",
                i + 1
            );
        }
    }
    format!(
        "one side is a prefix of the other (fixture {} lines, rust {} lines)",
        expected.lines().count(),
        actual.lines().count()
    )
}

/// Delete the object key addressed by JSON `pointer` (RFC 6901). Returns
/// `false` when the pointer's parent or key does not exist — the harness
/// treats that as a stale pointer list and fails.
fn delete_at(value: &mut serde_json::Value, pointer: &str) -> bool {
    let Some((parent_ptr, key)) = pointer.rsplit_once('/') else {
        return false;
    };
    let Some(parent) = value.pointer_mut(parent_ptr) else {
        return false;
    };
    match parent.as_object_mut() {
        Some(obj) => obj.remove(key).is_some(),
        None => false,
    }
}

/// Prefix each pointer in `keys` with `prefix` (used to reuse one type's
/// required-key list at every path it is embedded under).
fn req(prefix: &str, keys: &[&str]) -> Vec<String> {
    keys.iter().map(|k| format!("{prefix}{k}")).collect()
}

/// Serialize `value`, compare byte-for-byte against the committed fixture at
/// `rel` (or rewrite it when `REGEN_WIRE_GOLDENS` is set), require the
/// canonical bytes to deserialize back into `T`, and run the required-key
/// deletion harness: for each pointer in `required`, deleting that key must
/// make deserialization fail. The parse-back and the harness run in regen
/// mode too, so loosening a required field goes red at regeneration time.
fn check<T>(rel: &str, value: &T, required: &[String], failures: &mut Vec<String>)
where
    T: Serialize + DeserializeOwned,
{
    let path = fixture_root().join(rel);
    let mut json = serde_json::to_string_pretty(value)
        .unwrap_or_else(|e| panic!("{rel}: failed to serialize fixture value: {e}"));
    json.push('\n');

    if regen() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .unwrap_or_else(|e| panic!("{rel}: failed to create fixture dir: {e}"));
        }
        fs::write(&path, &json).unwrap_or_else(|e| panic!("{rel}: failed to write fixture: {e}"));
    } else {
        match fs::read_to_string(&path) {
            Ok(on_disk) => {
                if on_disk != json {
                    failures.push(format!(
                        "{rel}: {}\n{REGEN_HINT}",
                        first_diff(&on_disk, &json)
                    ));
                }
            }
            Err(e) => {
                failures.push(format!("{rel}: cannot read fixture ({e}); {REGEN_HINT}"));
                return;
            }
        }
    }

    // Both wire directions: the canonical bytes must parse back into T.
    if let Err(e) = serde_json::from_str::<T>(&json) {
        failures.push(format!(
            "{rel}: canonical fixture bytes no longer deserialize into the Rust type: {e}"
        ));
        return;
    }

    // Required-key harness. A pointer that no longer exists means the list is
    // stale; a deletion that still parses means the field was loosened —
    // both demand a reviewed edit to the `required` list for this fixture.
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("canonical fixture is valid JSON");
    for pointer in required {
        let mut mutated = parsed.clone();
        if !delete_at(&mut mutated, pointer) {
            failures.push(format!(
                "{rel}: required-key list is stale — pointer {pointer} does not address an \
                 object key in the fixture"
            ));
            continue;
        }
        if serde_json::from_value::<T>(mutated).is_ok() {
            failures.push(format!(
                "{rel}: deleting required key {pointer} still deserializes — the field became \
                 optional on the Rust side. If intentional, remove the pointer from this \
                 fixture's required-key list (and consider the compatibility story for older \
                 payloads)."
            ));
        }
    }
}

fn assert_no_failures(failures: Vec<String>) {
    assert!(
        failures.is_empty(),
        "wire golden fixtures out of sync:\n\n{}",
        failures.join("\n\n")
    );
}

// ---------------------------------------------------------------------------
// Variant exhaustiveness devices
//
// Each function below maps every enum variant to the fixture path(s) that
// lock it (or to an explicitly documented exclusion). NO wildcard arms:
// adding a variant is a compile error until it is wired here, which is the
// point — a new wire variant cannot land without either a fixture or a
// written-down reason for not having one. The golden tables assert that the
// path they check appears in the variant's declared list, and
// `fixture_directory_matches_declared_set` asserts the declared set matches
// the files on disk.
// ---------------------------------------------------------------------------

fn server_message_fixture_paths(msg: &ServerMessage) -> &'static [&'static str] {
    match msg {
        ServerMessage::Snapshot { .. } => &["session/server_snapshot.json"],
        ServerMessage::CommandBroadcast { .. } => {
            &["session/server_command_broadcast_dataset_opened.json"]
        }
        ServerMessage::Ack { .. } => &["session/server_ack.json"],
        ServerMessage::PeerJoined { .. } => &["session/server_peer_joined.json"],
        ServerMessage::PeerLeft { .. } => &["session/server_peer_left.json"],
        ServerMessage::PresenceUpdate { .. } => &["session/server_presence_update.json"],
        ServerMessage::CursorUpdate { .. } => &["session/server_cursor_update.json"],
        ServerMessage::FollowChanged { .. } => &["session/server_follow_changed.json"],
        ServerMessage::DatasetPresenceUpdate { .. } => {
            &["session/server_dataset_presence_update.json"]
        }
        ServerMessage::DatasetOpenProgress { .. } => &["session/server_dataset_open_progress.json"],
        ServerMessage::OpenDatasetSucceeded { .. } => {
            &["session/server_open_dataset_succeeded.json"]
        }
        ServerMessage::OpenDatasetFailed { .. } => &["session/server_open_dataset_failed.json"],
        ServerMessage::DatasetHealth { .. } => &["session/server_dataset_health.json"],
        ServerMessage::AssetCatalogUpdate { .. } => &["session/server_asset_catalog_update.json"],
        ServerMessage::GeneratedAvailabilityUpdate { .. } => {
            &["session/server_generated_availability_update.json"]
        }
        ServerMessage::GeneratedChunkStatus { .. } => {
            &["session/server_generated_chunk_status.json"]
        }
        ServerMessage::BookmarkChanged { .. } => &["session/server_bookmark_changed.json"],
        ServerMessage::WorkspaceArchived { .. } => &["session/server_workspace_archived.json"],
    }
}

fn client_message_fixture_paths(msg: &ClientMessage) -> &'static [&'static str] {
    match msg {
        // One envelope fixture per web-live DocumentCommand; the per-command
        // mapping lives in `document_command_fixture_paths`.
        ClientMessage::Command { .. } => &[
            "session/client_command_add_annotation.json",
            "session/client_command_move_annotation.json",
            "session/client_command_remove_annotation.json",
            "session/client_command_add_comment.json",
            "session/client_command_remove_comment.json",
            "session/client_command_edit_comment.json",
            "session/client_command_register_layout.json",
            "session/client_command_set_active_layout.json",
            "session/client_command_remove_dataset.json",
            "session/client_command_rename_dataset.json",
            "session/client_command_apply_asset_catalog_delta.json",
        ],
        ClientMessage::Presence { .. } => &["session/client_presence.json"],
        ClientMessage::Cursor { .. } => &["session/client_cursor.json"],
        ClientMessage::Follow { .. } => &["session/client_follow.json"],
        ClientMessage::DatasetPresence { .. } => &["session/client_dataset_presence.json"],
        ClientMessage::Steer { .. } => &["session/client_steer.json"],
        ClientMessage::OpenRemoteDataset { .. } => &["session/client_open_remote_dataset.json"],
        ClientMessage::DatasetHealth { .. } => &["session/client_dataset_health.json"],
        ClientMessage::DatasetRetry { .. } => &["session/client_dataset_retry.json"],
        ClientMessage::ViewerInterest { .. } => &["session/client_viewer_interest.json"],
        ClientMessage::RequestSnapshot => &["session/client_request_snapshot.json"],
    }
}

fn document_command_fixture_paths(cmd: &DocumentCommand) -> &'static [&'static str] {
    match cmd {
        DocumentCommand::DatasetOpened(_) => {
            &["session/server_command_broadcast_dataset_opened.json"]
        }
        DocumentCommand::RemoveDataset { .. } => &["session/client_command_remove_dataset.json"],
        DocumentCommand::RenameDataset { .. } => &["session/client_command_rename_dataset.json"],
        DocumentCommand::RegisterLayout { .. } => &["session/client_command_register_layout.json"],
        DocumentCommand::SetActiveLayout { .. } => {
            &["session/client_command_set_active_layout.json"]
        }
        DocumentCommand::ApplyAssetCatalogDelta { .. } => {
            &["session/client_command_apply_asset_catalog_delta.json"]
        }
        DocumentCommand::AddAnnotation { .. } => &["session/client_command_add_annotation.json"],
        DocumentCommand::RemoveAnnotation { .. } => {
            &["session/client_command_remove_annotation.json"]
        }
        DocumentCommand::AddComment { .. } => &["session/client_command_add_comment.json"],
        DocumentCommand::RemoveComment { .. } => &["session/client_command_remove_comment.json"],
        DocumentCommand::MoveAnnotation { .. } => &["session/client_command_move_annotation.json"],
        DocumentCommand::EditComment { .. } => &["session/client_command_edit_comment.json"],
    }
}

fn chunk_message_fixture_paths(msg: &ChunkMessage) -> &'static [&'static str] {
    match msg {
        ChunkMessage::ChunkRequest { .. } => &["session/chunk_request.json"],
        // Excluded: currently unproduced wire vocabulary. Nothing in the
        // repo sends ChunkFetch — it exists as a type (with a round-trip
        // unit test), and the server's handler accepts and ignores it if a
        // client ever does send one (lucida-server/src/handler.rs). With no
        // producer and no consumer there is nothing to lock; wire a fixture
        // here if a producer ever appears.
        ChunkMessage::ChunkFetch { .. } => &[],
    }
}

fn asset_message_fixture_paths(msg: &AssetMessage) -> &'static [&'static str] {
    match msg {
        AssetMessage::AssetRequest { .. } => &["session/asset_request.json"],
    }
}

/// One exemplar per variant of a unit-variant enum, with a compile-time
/// tripwire: adding a variant makes the inner `match` non-exhaustive until
/// the new variant is added to the list (and thus to the vocabulary
/// fixture).
macro_rules! vocab {
    ($ty:ident :: { $($variant:ident),+ $(,)? }) => {{
        fn exhaustive(value: &$ty) {
            match value { $($ty::$variant => {}),+ }
        }
        let all = vec![$($ty::$variant),+];
        for value in &all {
            exhaustive(value);
        }
        all
    }};
}

/// The wire vocabulary of every enum whose serialized string the web
/// dispatches or renders on — one exemplar per variant, so renaming a
/// variant (or adding one) changes this fixture and trips the web-side
/// expectations, which are typed with the production TS unions.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct EnumVocabulary {
    colormaps: Vec<Colormap>,
    blend_modes: Vec<BlendMode>,
    render_modes: Vec<RenderMode>,
    clip_modes: Vec<ClipMode>,
    annotation_kinds: Vec<AnnotationKind>,
    axis_kinds: Vec<AxisKind>,
    entity_kinds: Vec<EntityKind>,
    data_types: Vec<DataType>,
    positioning_modes: Vec<PositioningMode>,
    proxy_kinds: Vec<ProxyKind>,
    dataset_open_stages: Vec<DatasetOpenStage>,
    dataset_open_failure_kinds: Vec<DatasetOpenFailureKind>,
    dataset_health_statuses: Vec<DatasetHealthStatus>,
    generated_chunk_statuses: Vec<GeneratedChunkStatus>,
    generated_level_roles: Vec<GeneratedLevelRole>,
    bookmark_actions: Vec<BookmarkAction>,
    viewer_interest_modes: Vec<ViewerInterestMode>,
    viewer_interaction_modes: Vec<ViewerInteractionMode>,
    viewer_interest_lanes: Vec<ViewerInterestLane>,
}

fn enum_vocabulary() -> EnumVocabulary {
    EnumVocabulary {
        colormaps: vocab!(Colormap::{
            Gray, Magenta, Green, Cyan, Red, Blue, Yellow, Viridis, Inferno, Plasma, Magma,
            Turbo, Hot, Cool, Jet,
        }),
        blend_modes: vocab!(BlendMode::{ Alpha, Additive, Max }),
        render_modes: vocab!(RenderMode::{ Translucent, MaxIntensity }),
        clip_modes: vocab!(ClipMode::{ Plane, Sphere }),
        annotation_kinds: vocab!(AnnotationKind::{ Point, Line, Box }),
        axis_kinds: vocab!(AxisKind::{ Time, Channel, Space }),
        entity_kinds: vocab!(EntityKind::{ Image, Group, Tile }),
        data_types: vocab!(DataType::{ Uint8, Uint16, Uint32, Float32, Float64 }),
        positioning_modes: vocab!(PositioningMode::{ Explicit, Derived }),
        proxy_kinds: vocab!(ProxyKind::{ GroupProxy3D, TileProxy3D }),
        dataset_open_stages: vocab!(DatasetOpenStage::{
            RequestReceived, Authorization, SourceLookup, BackendOpen, MetadataImport,
            BindingBuild, GeneratedCoarsePlanning, WorkspacePersist, Broadcast, Complete,
        }),
        dataset_open_failure_kinds: vocab!(DatasetOpenFailureKind::{
            Authorization, SessionClosed, WorkspaceLookup, UnsupportedScheme, LocalPath,
            MissingObject, Permission, CloudConfiguration, Http, StorageBackend,
            UnsupportedCodec, UnsupportedLayout, MalformedMetadata, MissingMetadata, Import,
            Persistence, Internal,
        }),
        dataset_health_statuses: vocab!(DatasetHealthStatus::{ Healthy, Degraded, Unavailable }),
        generated_chunk_statuses: vocab!(GeneratedChunkStatus::{
            Pending, Unavailable, FailedTransient, FailedPermanent, Ready,
        }),
        generated_level_roles: vocab!(GeneratedLevelRole::{ Coarse }),
        bookmark_actions: vocab!(BookmarkAction::{ Created, Updated, Deleted }),
        viewer_interest_modes: vocab!(ViewerInterestMode::{ Slice, Volume }),
        viewer_interaction_modes: vocab!(ViewerInteractionMode::{
            Idle, Panning, Zooming, Scrubbing,
        }),
        viewer_interest_lanes: vocab!(ViewerInterestLane::{ Visible, Predicted, Background }),
    }
}

// ---------------------------------------------------------------------------
// Shared fixture values
// ---------------------------------------------------------------------------

const SINGLE_DATASET_ID: &str = "wds-0f3a";
const SINGLE_IMAGE_ID: &str = "multiscale-0";
const SINGLE_LABEL_IMAGE_ID: &str = "multiscale-0:label:region-a";
const SINGLE_ENTITY_ID: &str = "img-0";

/// A realistic single-image manifest: multi-level 5D multiscale with a
/// generated coarse level, omero channel metadata, a pinned non-canonical
/// axis, a uint32 segmentation label, and a source layout.
fn single_manifest() -> DatasetManifest {
    let entity_id = EntityId(SINGLE_ENTITY_ID.into());
    let image_id = ImageId(SINGLE_IMAGE_ID.into());

    let multiscale = MultiscaleInfo {
        axes: vec![
            Axis {
                name: "t".into(),
                kind: AxisKind::Time,
            },
            Axis {
                name: "c".into(),
                kind: AxisKind::Channel,
            },
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
        levels: vec![
            LevelGeometry {
                level_index: 0,
                shape: [3, 2, 50, 4096, 4096],
                chunk_shape: [1, 1, 1, 256, 256],
                grid_shape: [3, 2, 50, 16, 16],
                scale: [1.0, 1.0, 2.0, 0.25, 0.25],
            },
            LevelGeometry {
                level_index: 1,
                shape: [3, 2, 50, 2048, 2048],
                chunk_shape: [1, 1, 1, 256, 256],
                grid_shape: [3, 2, 50, 8, 8],
                scale: [1.0, 1.0, 2.0, 0.5, 0.5],
            },
            LevelGeometry {
                level_index: 2,
                shape: [3, 2, 50, 512, 512],
                chunk_shape: [1, 1, 25, 512, 512],
                grid_shape: [3, 2, 2, 1, 1],
                scale: [1.0, 1.0, 2.0, 2.0, 2.0],
            },
        ],
        coarse_level_index: Some(2),
        generated_levels: vec![GeneratedLevelInfo {
            level_index: 2,
            role: GeneratedLevelRole::Coarse,
            provenance: GeneratedLevelProvenance {
                generator: "coarse-v1".into(),
                config_id: "max-axis-1024".into(),
                source_content_id: Some("blake3:9f2ce6".into()),
            },
        }],
        data_type: DataType::Uint16,
        pinned_axes: vec![PinnedAxis {
            name: "m".into(),
            size: 4,
            pinned_index: 0,
        }],
        channel_infos: vec![
            ChannelInfo {
                label: "Channel 0".into(),
                color: Some("0000FF".into()),
            },
            ChannelInfo {
                label: "Channel 1".into(),
                color: None,
            },
        ],
    };

    let label = LabelSpec {
        name: "region-a".into(),
        source_image_id: image_id.clone(),
        image: ImageSpec {
            image_id: ImageId(SINGLE_LABEL_IMAGE_ID.into()),
            owner: entity_id.clone(),
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
                    shape: [1, 1, 50, 1024, 1024],
                    chunk_shape: [1, 1, 1, 256, 256],
                    grid_shape: [1, 1, 50, 4, 4],
                    scale: [1.0, 1.0, 2.0, 1.0, 1.0],
                }],
                coarse_level_index: None,
                generated_levels: vec![],
                data_type: DataType::Uint32,
                pinned_axes: vec![],
                channel_infos: vec![],
            },
        },
        colors: vec![
            LabelColor {
                value: 1,
                rgba: [255, 64, 0, 255],
            },
            LabelColor {
                value: 92801,
                rgba: [0, 128, 255, 128],
            },
        ],
        source_declared: true,
    };

    DatasetManifest::new(
        DatasetId(SINGLE_DATASET_ID.into()),
        "kidney-multiplex.zarr".into(),
        DatasetKind::Single,
        vec![Entity {
            id: entity_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels {
                name: Some("kidney-multiplex.zarr".into()),
                ..Default::default()
            },
        }],
        vec![TransformEdge {
            from: entity_id.clone(),
            to: entity_id.clone(),
            transform: VoxelTransform::from_voxel_translation_2d(128.0, -64.0),
        }],
        vec![ImageSpec {
            image_id,
            owner: entity_id.clone(),
            multiscale,
        }],
        vec![LayoutSpec {
            id: LayoutId("layout-source".into()),
            name: "Source positions".into(),
            placements: vec![EntityPlacement {
                entity_id,
                position: [12.5, -8.0],
            }],
        }],
        Some(LayoutId("layout-source".into())),
    )
    .with_labels(vec![label])
}

fn single_fetch() -> FetchSource {
    FetchSource::Proxied(ProxiedFetchDescriptor {
        images: vec![
            ProxiedImageSpec {
                image_id: ImageId(SINGLE_IMAGE_ID.into()),
                wire_format: WireFormat::Zstd {
                    data_type: DataType::Uint16,
                },
            },
            ProxiedImageSpec {
                image_id: ImageId(SINGLE_LABEL_IMAGE_ID.into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint32,
                },
            },
        ],
    })
}

fn single_catalog() -> AssetCatalog {
    AssetCatalog {
        entries: vec![ProxyAvailability {
            entity_id: EntityId(SINGLE_ENTITY_ID.into()),
            kinds: vec![ProxyKind::TileProxy3D],
            footprints: vec![ProxyFootprint::u16(ProxyKind::TileProxy3D, [50, 128, 128])],
        }],
    }
}

fn single_dataset_opened() -> DatasetOpened {
    DatasetOpened {
        manifest: single_manifest(),
        fetch: single_fetch(),
        catalog: single_catalog(),
        opener_client_id: Some(7),
    }
}

/// A collection manifest: group/tile entity hierarchy, explicit positioning, and a
/// tile-owned image.
fn collection_dataset_opened() -> DatasetOpened {
    let group_id = EntityId("group-A1".into());
    let tile_id = EntityId("tile-A1-f0".into());
    let image_id = ImageId("tile-A1-f0-image".into());

    let manifest = DatasetManifest::new(
        DatasetId("wds-collection-77".into()),
        "screening-collection-01.zarr".into(),
        DatasetKind::Collection {
            rows: vec!["A".into(), "B".into()],
            columns: vec!["1".into(), "2".into(), "3".into()],
            positioning_mode: PositioningMode::Explicit,
            has_explicit_positions: true,
        },
        vec![
            Entity {
                id: group_id.clone(),
                kind: EntityKind::Group,
                parent: None,
                labels: EntityLabels {
                    name: Some("A1".into()),
                    group_row: Some("A".into()),
                    group_column: Some("1".into()),
                    row_index: Some(0),
                    column_index: Some(0),
                    tile_index: None,
                },
            },
            Entity {
                id: tile_id.clone(),
                kind: EntityKind::Tile,
                parent: Some(group_id.clone()),
                labels: EntityLabels {
                    name: Some("A1/0".into()),
                    tile_index: Some(0),
                    ..Default::default()
                },
            },
        ],
        vec![TransformEdge {
            from: tile_id.clone(),
            to: group_id.clone(),
            transform: VoxelTransform::from_voxel_translation_2d(2048.0, 1024.0),
        }],
        vec![ImageSpec {
            image_id: image_id.clone(),
            owner: tile_id.clone(),
            multiscale: MultiscaleInfo {
                axes: vec![
                    Axis {
                        name: "c".into(),
                        kind: AxisKind::Channel,
                    },
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
                levels: vec![
                    LevelGeometry {
                        level_index: 0,
                        shape: [1, 4, 12, 1024, 1024],
                        chunk_shape: [1, 1, 1, 512, 512],
                        grid_shape: [1, 4, 12, 2, 2],
                        scale: [1.0, 1.0, 5.0, 0.65, 0.65],
                    },
                    LevelGeometry {
                        level_index: 1,
                        shape: [1, 4, 12, 512, 512],
                        chunk_shape: [1, 1, 1, 512, 512],
                        grid_shape: [1, 4, 12, 1, 1],
                        scale: [1.0, 1.0, 5.0, 1.3, 1.3],
                    },
                ],
                coarse_level_index: None,
                generated_levels: vec![],
                data_type: DataType::Uint8,
                pinned_axes: vec![],
                channel_infos: vec![],
            },
        }],
        vec![LayoutSpec {
            id: LayoutId("layout-stage".into()),
            name: "Stage positions".into(),
            placements: vec![
                EntityPlacement {
                    entity_id: group_id,
                    position: [0.0, 0.0],
                },
                EntityPlacement {
                    entity_id: tile_id,
                    position: [2048.0, 1024.0],
                },
            ],
        }],
        Some(LayoutId("layout-stage".into())),
    );

    DatasetOpened {
        manifest,
        fetch: FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id,
                wire_format: WireFormat::Lz4 {
                    data_type: DataType::Uint8,
                },
            }],
        }),
        catalog: AssetCatalog::default(),
        opener_client_id: None,
    }
}

fn peer_display_settings() -> DatasetDisplaySettings {
    DatasetDisplaySettings {
        visible: true,
        opacity: 0.8,
        contrast_min: 120.0,
        contrast_max: 4096.0,
        gamma: 0.85,
        blend_mode: BlendMode::Max,
        render_mode: RenderMode::MaxIntensity,
        channel_settings: vec![
            ChannelSettings {
                visible: true,
                colormap: Colormap::Magenta,
                contrast_min: 100.0,
                contrast_max: 12000.0,
                gamma: 1.0,
                name: Some("Region A".into()),
            },
            ChannelSettings {
                visible: false,
                colormap: Colormap::Green,
                contrast_min: 0.0,
                contrast_max: 65535.0,
                gamma: 1.2,
                name: None,
            },
        ],
        label_settings: vec![LabelSettings {
            visible: true,
            opacity: 0.35,
        }],
        channel_blend_mode: BlendMode::Additive,
        detail_level_override: Some(1),
    }
}

fn arcball_camera() -> Camera {
    Camera::Arcball(Arcball {
        target: [2048.0, 2048.0, 50.0],
        theta: std::f64::consts::FRAC_PI_4,
        phi: std::f64::consts::FRAC_PI_3,
        distance: 6000.0,
        // fov is radians: Camera::sanitize repairs anything outside (0, π),
        // so a degrees-style value would not survive an import intact.
        fov: std::f64::consts::FRAC_PI_4,
        viewport: [1920, 1080],
        near: 1.0,
        far: 50000.0,
        clip_distance: 120.0,
        clip_mode: ClipMode::Sphere,
    })
}

fn slice_camera() -> Camera {
    Camera::Slice(Slice {
        center: [1024.5, -512.25],
        zoom: 1.5,
        viewport: [1920, 1080],
    })
}

fn shared_view_state() -> ViewState {
    ViewState {
        z_range: 10..14,
        t: 2,
        c: 1,
        multi_channel: true,
    }
}

fn shared_display_state() -> DisplayState {
    DisplayState {
        contrast_min: 120.0,
        contrast_max: 4096.0,
        gamma: 0.85,
    }
}

/// The author-view capture embedded on a pin (`Annotation::view` /
/// `AddAnnotation.view`) — the `SavedView` wire shape in
/// workspace-dataset-id form. `datasets` stays EMPTY by invariant (a
/// pin-embedded view must not carry dataset source URLs; membership is owned
/// by the workspace document), while every other optional field is
/// populated, including the `auto_contrast` map that is skipped when empty.
fn pin_saved_view() -> SavedView {
    let mut view = SavedView::empty([1920, 1080]);
    view.v = SAVED_VIEW_VERSION;
    view.camera = arcball_camera();
    view.view = shared_view_state();
    view.display = shared_display_state();
    view.active_layouts.insert(
        DatasetId(SINGLE_DATASET_ID.into()),
        LayoutId("layout-grid".into()),
    );
    view.dataset_order.push(DatasetId(SINGLE_DATASET_ID.into()));
    view.dataset_settings
        .insert(DatasetId(SINGLE_DATASET_ID.into()), peer_display_settings());
    view.auto_contrast
        .insert(DatasetId(SINGLE_DATASET_ID.into()), false);
    view
}

fn peer_presence() -> PresenceState {
    let mut dataset_settings = HashMap::new();
    // At most one entry: HashMap order is nondeterministic (header comment).
    dataset_settings.insert(DatasetId(SINGLE_DATASET_ID.into()), peer_display_settings());
    PresenceState {
        client_id: 3,
        camera: slice_camera(),
        view: shared_view_state(),
        display: shared_display_state(),
        following: Some(9),
        cursor: Some([412.0, 233.5]),
        dataset_order: vec![DatasetId(SINGLE_DATASET_ID.into())],
        dataset_settings,
        identity: Some(PeerIdentity {
            display_name: "Ada Lovelace".into(),
            picture_url: Some("https://example.com/avatars/ada.png".into()),
            initial: "A".into(),
        }),
    }
}

/// Three pins covering every `AnnotationKind` plus the maximal field set:
/// the box pin carries `end`, a comment thread, an `anchor`, and the
/// embedded author view.
fn snapshot_annotations() -> Vec<Annotation> {
    vec![
        Annotation {
            id: "pin-4c1d".into(),
            position: [310.0, 455.5],
            z: 12.5,
            t: 2,
            c: 1,
            author: "ada@example".into(),
            kind: AnnotationKind::Box,
            end: Some([420.0, 505.5]),
            comments: vec![Comment {
                id: "comment-91".into(),
                author: "grace@example".into(),
                text: "glomerulus boundary looks off here".into(),
            }],
            anchor: Some(EntityId(SINGLE_ENTITY_ID.into())),
            view: Some(pin_saved_view()),
        },
        Annotation {
            id: "pin-77b2".into(),
            position: [1500.0, 900.0],
            z: 30.0,
            t: 0,
            c: 0,
            author: "grace@example".into(),
            kind: AnnotationKind::Point,
            end: None,
            comments: vec![],
            anchor: None,
            view: None,
        },
        Annotation {
            id: "pin-a3e9".into(),
            position: [200.0, 240.0],
            z: 5.0,
            t: 1,
            c: 0,
            author: "ada@example".into(),
            kind: AnnotationKind::Line,
            end: Some([260.0, 300.0]),
            comments: vec![],
            anchor: None,
            view: None,
        },
    ]
}

fn grid_layout() -> LayoutSpec {
    LayoutSpec {
        id: LayoutId("layout-grid".into()),
        name: "Grid".into(),
        placements: vec![EntityPlacement {
            entity_id: EntityId(SINGLE_ENTITY_ID.into()),
            position: [0.0, 4224.0],
        }],
    }
}

fn snapshot_document() -> DocumentState {
    let mut document = DocumentState::default();
    let dataset_id = DatasetId(SINGLE_DATASET_ID.into());
    document
        .manifests
        .insert(dataset_id.clone(), single_manifest());
    document
        .registered_layouts
        .insert(dataset_id.clone(), vec![grid_layout()]);
    document
        .active_layout_ids
        .insert(dataset_id.clone(), LayoutId("layout-grid".into()));
    document
        .asset_catalogs
        .insert(dataset_id.clone(), single_catalog());
    document
        .annotations
        .insert(dataset_id, snapshot_annotations());
    document
}

fn generated_level_availability() -> GeneratedLevelAvailability {
    GeneratedLevelAvailability {
        image_id: ImageId(SINGLE_IMAGE_ID.into()),
        info: GeneratedLevelInfo {
            level_index: 2,
            role: GeneratedLevelRole::Coarse,
            provenance: GeneratedLevelProvenance {
                generator: "coarse-v1".into(),
                config_id: "max-axis-1024".into(),
                source_content_id: Some("blake3:9f2ce6".into()),
            },
        },
        level: LevelGeometry {
            level_index: 2,
            shape: [3, 2, 50, 512, 512],
            chunk_shape: [1, 1, 25, 512, 512],
            grid_shape: [3, 2, 2, 1, 1],
            scale: [1.0, 1.0, 2.0, 2.0, 2.0],
        },
        summary: Some(GeneratedLevelSummary {
            total_chunks: 12,
            ready_chunks: 7,
            pending_chunks: 3,
            failed_chunks: 2,
        }),
    }
}

/// One chunk status update per `GeneratedChunkStatus` variant, so the web
/// side locks the full status vocabulary its counters switch on.
fn generated_chunk_updates() -> Vec<GeneratedChunkStatusUpdate> {
    let chunk = |key: &str, status, message: Option<&str>| GeneratedChunkStatusUpdate {
        image_id: ImageId(SINGLE_IMAGE_ID.into()),
        level_index: 2,
        key: key.into(),
        status,
        message: message.map(String::from),
    };
    vec![
        chunk("2/0/0/0/0/0", GeneratedChunkStatus::Ready, None),
        chunk("2/0/0/1/0/0", GeneratedChunkStatus::Pending, None),
        chunk("2/1/0/0/0/0", GeneratedChunkStatus::Unavailable, None),
        chunk(
            "2/1/0/1/0/0",
            GeneratedChunkStatus::FailedTransient,
            Some("source read timed out"),
        ),
        chunk(
            "2/2/0/0/0/0",
            GeneratedChunkStatus::FailedPermanent,
            Some("chunk exceeds generation budget"),
        ),
    ]
}

fn generated_snapshot() -> GeneratedAvailabilitySnapshot {
    GeneratedAvailabilitySnapshot {
        levels: vec![
            generated_level_availability(),
            GeneratedLevelAvailability {
                image_id: ImageId(SINGLE_LABEL_IMAGE_ID.into()),
                info: GeneratedLevelInfo {
                    level_index: 1,
                    role: GeneratedLevelRole::Coarse,
                    provenance: GeneratedLevelProvenance {
                        generator: "coarse-v1".into(),
                        config_id: "max-axis-512".into(),
                        source_content_id: None,
                    },
                },
                level: LevelGeometry {
                    level_index: 1,
                    shape: [1, 1, 50, 256, 256],
                    chunk_shape: [1, 1, 50, 256, 256],
                    grid_shape: [1, 1, 1, 1, 1],
                    scale: [1.0, 1.0, 2.0, 4.0, 4.0],
                },
                summary: None,
            },
        ],
        chunks: generated_chunk_updates(),
    }
}

fn generated_delta() -> GeneratedAvailabilityDelta {
    GeneratedAvailabilityDelta {
        levels: vec![generated_level_availability()],
        chunks: vec![GeneratedChunkStatusUpdate {
            image_id: ImageId(SINGLE_IMAGE_ID.into()),
            level_index: 2,
            key: "2/0/0/1/0/0".into(),
            status: GeneratedChunkStatus::Ready,
            message: None,
        }],
    }
}

fn source_health() -> DatasetSourceHealth {
    DatasetSourceHealth {
        workspace_dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
        name: "kidney-multiplex.zarr".into(),
        status: DatasetHealthStatus::Degraded,
        source_url: Some("gs://lucida-fixtures/kidney-multiplex.zarr".into()),
        backend: Some("gcs".into()),
        binding: DatasetHealthComponent {
            status: DatasetHealthStatus::Healthy,
            message: Some("bound to gcs source".into()),
        },
        source_cache: Some(DatasetSourceCacheStats {
            max_bytes: 536870912,
            current_bytes: 268435456,
            used_percent: 50,
            entry_count: 1024,
            hits: 9137,
            misses: 421,
            evictions: 17,
            backend_errors: 2,
        }),
        generated_coarse: DatasetGeneratedCoarseHealth {
            status: DatasetHealthStatus::Degraded,
            level_count: 1,
            ready_chunks: 40,
            pending_chunks: 3,
            failed_chunks: 2,
            unavailable_chunks: 1,
            message: Some("2 chunks failed in the last generation pass".into()),
            cache: Some(DatasetGeneratedCoarseCacheStats {
                storage: "disk".into(),
                current_bytes: 73400320,
                max_bytes: Some(1073741824),
                used_percent: Some(6),
                evictions: 4,
                root: Some("/var/cache/lucida/generated".into()),
            }),
            recent_failures: vec![DatasetGeneratedCoarseFailure {
                image_id: SINGLE_IMAGE_ID.into(),
                level_index: 2,
                key: "2/1/0/1/0/0".into(),
                status: GeneratedChunkStatus::FailedTransient,
                message: Some("source read timed out".into()),
            }],
        },
        messages: vec!["generated coarse cache is warming".into()],
    }
}

fn asset_catalog_delta() -> AssetCatalogDelta {
    AssetCatalogDelta {
        added: vec![ProxyAvailability {
            entity_id: EntityId(SINGLE_ENTITY_ID.into()),
            kinds: vec![ProxyKind::GroupProxy3D, ProxyKind::TileProxy3D],
            footprints: vec![ProxyFootprint::u16(ProxyKind::GroupProxy3D, [50, 256, 256])],
        }],
    }
}

// ---------------------------------------------------------------------------
// Required-key lists (JSON pointers), reused across embedding sites
// ---------------------------------------------------------------------------

/// Required fields of `DatasetManifest` and its component types, rooted at
/// the manifest object. Written against `single_manifest()`'s shape.
const MANIFEST_REQUIRED: &[&str] = &[
    "/dataset_id",
    "/name",
    "/kind",
    "/entities",
    "/transforms",
    "/images",
    "/source_layouts",
    "/entities/0/id",
    "/entities/0/kind",
    "/entities/0/labels",
    "/transforms/0/from",
    "/transforms/0/to",
    "/transforms/0/transform",
    "/transforms/0/transform/matrix",
    "/images/0/image_id",
    "/images/0/owner",
    "/images/0/multiscale",
    "/images/0/multiscale/axes",
    "/images/0/multiscale/levels",
    "/images/0/multiscale/data_type",
    "/images/0/multiscale/axes/0/name",
    "/images/0/multiscale/axes/0/kind",
    "/images/0/multiscale/levels/0/level_index",
    "/images/0/multiscale/levels/0/shape",
    "/images/0/multiscale/levels/0/chunk_shape",
    "/images/0/multiscale/levels/0/grid_shape",
    "/images/0/multiscale/levels/0/scale",
    "/images/0/multiscale/generated_levels/0/level_index",
    "/images/0/multiscale/pinned_axes/0/name",
    "/images/0/multiscale/pinned_axes/0/size",
    "/images/0/multiscale/pinned_axes/0/pinned_index",
    "/images/0/multiscale/channel_infos/0/label",
    "/labels/0/name",
    "/labels/0/source_image_id",
    "/labels/0/image",
    "/labels/0/colors/0/value",
    "/labels/0/colors/0/rgba",
    "/source_layouts/0/id",
    "/source_layouts/0/name",
    "/source_layouts/0/placements",
    "/source_layouts/0/placements/0/entity_id",
    "/source_layouts/0/placements/0/position",
];

/// Required fields of the Proxied `FetchSource` shape.
const PROXIED_FETCH_REQUIRED: &[&str] = &[
    "/Proxied/images",
    "/Proxied/images/0/image_id",
    "/Proxied/images/0/wire_format",
    "/Proxied/images/0/wire_format/Zstd/data_type",
];

/// Required fields of the populated `AssetCatalog` shape.
const CATALOG_REQUIRED: &[&str] = &[
    "/entries/0/entity_id",
    "/entries/0/kinds",
    "/entries/0/footprints/0/kind",
    "/entries/0/footprints/0/dims",
    "/entries/0/footprints/0/bytes",
];

/// Required fields of `DatasetOpened` (with the single manifest inside).
fn dataset_opened_required() -> Vec<String> {
    let mut keys = vec!["/manifest".to_string(), "/fetch".to_string()];
    keys.extend(req("/manifest", MANIFEST_REQUIRED));
    keys.extend(req("/fetch", PROXIED_FETCH_REQUIRED));
    keys.extend(req("/catalog", CATALOG_REQUIRED));
    keys
}

/// Required fields of the `SavedView` wire shape (rooted at the view).
const SAVED_VIEW_REQUIRED: &[&str] = &["/v", "/camera", "/view", "/display", "/camera/mode"];

/// Required fields of a `PresenceState` carrying the slice camera and full
/// per-dataset display settings (rooted at the presence object).
fn presence_required() -> Vec<String> {
    let mut keys: Vec<String> = req(
        "",
        &[
            "/client_id",
            "/camera",
            "/view",
            "/display",
            "/camera/mode",
            "/camera/center",
            "/camera/zoom",
            "/camera/viewport",
            "/view/z_range",
            "/view/t",
            "/view/c",
            "/view/z_range/start",
            "/view/z_range/end",
            "/display/contrast_min",
            "/display/contrast_max",
            "/display/gamma",
            "/identity/display_name",
        ],
    );
    let settings = format!("/dataset_settings/{SINGLE_DATASET_ID}");
    keys.extend(req(
        &settings,
        &[
            "/visible",
            "/opacity",
            "/contrast_min",
            "/contrast_max",
            "/gamma",
            "/blend_mode",
            "/channel_settings/0/visible",
            "/channel_settings/0/colormap",
            "/channel_settings/0/contrast_min",
            "/channel_settings/0/contrast_max",
            "/channel_settings/0/gamma",
            "/label_settings/0/visible",
            "/label_settings/0/opacity",
        ],
    ));
    keys
}

/// Required fields of the populated `GeneratedAvailabilitySnapshot` shape
/// (rooted at the snapshot; the delta reuses the level/chunk subset).
const GENERATED_REQUIRED: &[&str] = &[
    "/levels/0/image_id",
    "/levels/0/info",
    "/levels/0/level",
    "/levels/0/info/level_index",
    "/levels/0/level/level_index",
    "/levels/0/level/shape",
    "/levels/0/level/chunk_shape",
    "/levels/0/level/grid_shape",
    "/levels/0/level/scale",
    "/levels/0/summary/total_chunks",
    "/levels/0/summary/ready_chunks",
    "/levels/0/summary/pending_chunks",
    "/levels/0/summary/failed_chunks",
    "/chunks/0/image_id",
    "/chunks/0/level_index",
    "/chunks/0/key",
    "/chunks/0/status",
];

/// Required fields of a fully populated `DatasetSourceHealth` (rooted at the
/// health object).
const SOURCE_HEALTH_REQUIRED: &[&str] = &[
    "/workspace_dataset_id",
    "/name",
    "/status",
    "/binding",
    "/generated_coarse",
    "/binding/status",
    "/source_cache/max_bytes",
    "/source_cache/current_bytes",
    "/source_cache/used_percent",
    "/source_cache/entry_count",
    "/source_cache/hits",
    "/source_cache/misses",
    "/source_cache/evictions",
    "/source_cache/backend_errors",
    "/generated_coarse/status",
    "/generated_coarse/level_count",
    "/generated_coarse/ready_chunks",
    "/generated_coarse/pending_chunks",
    "/generated_coarse/failed_chunks",
    "/generated_coarse/unavailable_chunks",
    "/generated_coarse/cache/storage",
    "/generated_coarse/cache/current_bytes",
    "/generated_coarse/cache/evictions",
    "/generated_coarse/recent_failures/0/image_id",
    "/generated_coarse/recent_failures/0/level_index",
    "/generated_coarse/recent_failures/0/key",
    "/generated_coarse/recent_failures/0/status",
];

// ---------------------------------------------------------------------------
// Golden tables
// ---------------------------------------------------------------------------

fn server_goldens() -> Vec<(&'static str, ServerMessage, Vec<String>)> {
    let mut generated_availability = HashMap::new();
    // At most one entry: HashMap order is nondeterministic (header comment).
    generated_availability.insert(DatasetId(SINGLE_DATASET_ID.into()), generated_snapshot());

    let mut dataset_settings = HashMap::new();
    dataset_settings.insert(DatasetId(SINGLE_DATASET_ID.into()), peer_display_settings());

    let snapshot_required = {
        let mut keys = req("", &["/type", "/seq", "/document", "/peers", "/your_id"]);
        keys.push("/document/manifests".into());
        keys.extend(presence_required().iter().map(|k| format!("/peers/0{k}")));
        let pin = format!("/document/annotations/{SINGLE_DATASET_ID}/0");
        keys.extend(req(
            &pin,
            &[
                "/id",
                "/position",
                "/author",
                "/comments/0/id",
                "/comments/0/author",
                "/comments/0/text",
            ],
        ));
        keys.extend(SAVED_VIEW_REQUIRED.iter().map(|k| format!("{pin}/view{k}")));
        keys
    };

    let broadcast_required = {
        let mut keys = req("", &["/type", "/seq", "/command", "/command/type"]);
        keys.extend(
            dataset_opened_required()
                .iter()
                .map(|k| format!("/command{k}")),
        );
        keys
    };

    vec![
        (
            "session/server_snapshot.json",
            ServerMessage::Snapshot {
                seq: 42,
                document: snapshot_document(),
                peers: vec![peer_presence()],
                your_id: 7,
                generated_availability,
            },
            snapshot_required,
        ),
        (
            "session/server_command_broadcast_dataset_opened.json",
            ServerMessage::CommandBroadcast {
                seq: 43,
                command: DocumentCommand::DatasetOpened(single_dataset_opened()),
            },
            broadcast_required,
        ),
        (
            "session/server_ack.json",
            ServerMessage::Ack { seq: 44 },
            req("", &["/type", "/seq"]),
        ),
        (
            "session/server_peer_joined.json",
            ServerMessage::PeerJoined {
                client_id: 11,
                presence: PresenceState {
                    client_id: 11,
                    camera: Camera::Fly(Fly {
                        position: [512.0, 512.0, -300.0],
                        orientation: [0.1, 0.2, 0.3, 0.9273],
                        // Radians, like every camera fov on the wire.
                        fov: std::f64::consts::FRAC_PI_3,
                        viewport: [1280, 720],
                        near: 0.1,
                        far: 10000.0,
                        speed_multiplier: 2.0,
                        base_speed: 340.5,
                        clip_distance: 0.42,
                        clip_mode: ClipMode::Sphere,
                    }),
                    view: ViewState {
                        z_range: 0..50,
                        t: 0,
                        c: 0,
                        multi_channel: false,
                    },
                    display: DisplayState::default(),
                    following: None,
                    cursor: None,
                    dataset_order: vec![],
                    dataset_settings: HashMap::new(),
                    identity: None,
                },
            },
            req(
                "",
                &[
                    "/type",
                    "/client_id",
                    "/presence",
                    "/presence/client_id",
                    "/presence/camera",
                    "/presence/view",
                    "/presence/display",
                    "/presence/camera/mode",
                    "/presence/camera/position",
                    "/presence/camera/orientation",
                    "/presence/camera/fov",
                    "/presence/camera/viewport",
                    "/presence/camera/near",
                    "/presence/camera/far",
                    "/presence/camera/speed_multiplier",
                ],
            ),
        ),
        (
            "session/server_peer_left.json",
            ServerMessage::PeerLeft { client_id: 11 },
            req("", &["/type", "/client_id"]),
        ),
        (
            "session/server_presence_update.json",
            ServerMessage::PresenceUpdate {
                client_id: 3,
                camera: arcball_camera(),
                view: shared_view_state(),
                display: shared_display_state(),
            },
            req(
                "",
                &[
                    "/type",
                    "/client_id",
                    "/camera",
                    "/view",
                    "/display",
                    "/camera/mode",
                    "/camera/target",
                    "/camera/theta",
                    "/camera/phi",
                    "/camera/distance",
                    "/camera/fov",
                    "/camera/viewport",
                    "/camera/near",
                    "/camera/far",
                ],
            ),
        ),
        (
            "session/server_cursor_update.json",
            ServerMessage::CursorUpdate {
                client_id: 3,
                position: Some([412.0, 233.5]),
            },
            req("", &["/type", "/client_id"]),
        ),
        (
            "session/server_follow_changed.json",
            ServerMessage::FollowChanged {
                client_id: 3,
                target: Some(9),
            },
            req("", &["/type", "/client_id"]),
        ),
        (
            "session/server_dataset_presence_update.json",
            ServerMessage::DatasetPresenceUpdate {
                client_id: 3,
                dataset_order: vec![DatasetId(SINGLE_DATASET_ID.into())],
                dataset_settings,
            },
            req(
                "",
                &["/type", "/client_id", "/dataset_order", "/dataset_settings"],
            ),
        ),
        (
            "session/server_dataset_open_progress.json",
            ServerMessage::DatasetOpenProgress {
                request_id: "web-7d2f45aa".into(),
                url: "gs://lucida-fixtures/kidney-multiplex.zarr".into(),
                diagnostic: DatasetOpenProgressDiagnostic {
                    stage: DatasetOpenStage::GeneratedCoarsePlanning,
                    message: "planning generated coarse levels".into(),
                    workspace_dataset_id: Some(DatasetId(SINGLE_DATASET_ID.into())),
                    dataset_source_id: Some("source-9b31".into()),
                    detail: Some("1 derived level over 2 source levels".into()),
                },
            },
            req(
                "",
                &[
                    "/type",
                    "/request_id",
                    "/url",
                    "/diagnostic",
                    "/diagnostic/stage",
                    "/diagnostic/message",
                ],
            ),
        ),
        (
            "session/server_open_dataset_succeeded.json",
            ServerMessage::OpenDatasetSucceeded {
                request_id: "web-7d2f45aa".into(),
                url: "gs://lucida-fixtures/kidney-multiplex.zarr".into(),
                seq: 43,
                opened: single_dataset_opened(),
                diagnostic: Some(DatasetOpenSuccessDiagnostic {
                    stage: DatasetOpenStage::Complete,
                    source_url: "gs://lucida-fixtures/kidney-multiplex.zarr".into(),
                    workspace_dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                    dataset_source_id: Some("source-9b31".into()),
                    message: "dataset opened".into(),
                }),
            },
            req(
                "",
                &[
                    "/type",
                    "/request_id",
                    "/url",
                    "/seq",
                    "/opened",
                    "/opened/manifest",
                    "/opened/fetch",
                    "/diagnostic/stage",
                    "/diagnostic/source_url",
                    "/diagnostic/workspace_dataset_id",
                    "/diagnostic/message",
                ],
            ),
        ),
        (
            "session/server_open_dataset_failed.json",
            ServerMessage::OpenDatasetFailed {
                request_id: "web-81c09b".into(),
                url: "gs://lucida-fixtures/missing.zarr".into(),
                error: "object not found".into(),
                diagnostic: Some(DatasetOpenFailureDiagnostic {
                    stage: DatasetOpenStage::BackendOpen,
                    kind: DatasetOpenFailureKind::MissingObject,
                    retryable: true,
                    message: "object not found".into(),
                    detail: Some("gs://lucida-fixtures/missing.zarr/.zattrs returned 404".into()),
                }),
            },
            req(
                "",
                &[
                    "/type",
                    "/request_id",
                    "/url",
                    "/error",
                    "/diagnostic/stage",
                    "/diagnostic/kind",
                    "/diagnostic/retryable",
                    "/diagnostic/message",
                ],
            ),
        ),
        (
            "session/server_dataset_health.json",
            ServerMessage::DatasetHealth {
                request_id: "web-health-55e0".into(),
                datasets: vec![source_health()],
            },
            {
                let mut keys = req("", &["/type", "/request_id", "/datasets"]);
                keys.extend(req("/datasets/0", SOURCE_HEALTH_REQUIRED));
                keys
            },
        ),
        (
            "session/server_asset_catalog_update.json",
            ServerMessage::AssetCatalogUpdate {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                delta: asset_catalog_delta(),
            },
            {
                let mut keys = req("", &["/type", "/dataset_id", "/delta", "/delta/added"]);
                keys.extend(req(
                    "/delta/added/0",
                    &[
                        "/entity_id",
                        "/kinds",
                        "/footprints/0/kind",
                        "/footprints/0/dims",
                        "/footprints/0/bytes",
                    ],
                ));
                keys
            },
        ),
        (
            "session/server_generated_availability_update.json",
            ServerMessage::GeneratedAvailabilityUpdate {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                delta: generated_delta(),
            },
            {
                let mut keys = req("", &["/type", "/dataset_id", "/delta"]);
                keys.extend(req(
                    "/delta",
                    &[
                        "/levels/0/image_id",
                        "/levels/0/info",
                        "/levels/0/level",
                        "/chunks/0/image_id",
                        "/chunks/0/level_index",
                        "/chunks/0/key",
                        "/chunks/0/status",
                    ],
                ));
                keys
            },
        ),
        (
            "session/server_generated_chunk_status.json",
            ServerMessage::GeneratedChunkStatus {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                image_id: ImageId(SINGLE_IMAGE_ID.into()),
                key: "2/1/0/1/0/0".into(),
                status: GeneratedChunkStatus::FailedTransient,
                message: Some("source read timed out".into()),
            },
            req(
                "",
                &["/type", "/dataset_id", "/image_id", "/key", "/status"],
            ),
        ),
        (
            "session/server_bookmark_changed.json",
            ServerMessage::BookmarkChanged {
                id: "bookmark-31f7".into(),
                action: BookmarkAction::Updated,
                dataset_urls: vec![
                    "gs://lucida-fixtures/kidney-multiplex.zarr".into(),
                    "gs://lucida-fixtures/screening-collection-01.zarr".into(),
                ],
            },
            req("", &["/type", "/id", "/action", "/dataset_urls"]),
        ),
        (
            "session/server_workspace_archived.json",
            ServerMessage::WorkspaceArchived {
                workspace_id: "workspace-2ac8".into(),
            },
            req("", &["/type", "/workspace_id"]),
        ),
    ]
}

/// The web-live `DocumentCommand`s, each as its client `Command` envelope
/// fixture: (path, command, required keys under `/command`).
fn command_goldens() -> Vec<(&'static str, DocumentCommand, Vec<&'static str>)> {
    vec![
        (
            "session/client_command_add_annotation.json",
            DocumentCommand::AddAnnotation {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                id: "pin-4c1d".into(),
                position: [310.0, 455.5],
                end: Some([420.0, 505.5]),
                z: 12.5,
                t: 2,
                c: 1,
                author: "ada@example".into(),
                kind: AnnotationKind::Box,
                view: Some(Box::new(pin_saved_view())),
            },
            vec![
                "/dataset_id",
                "/id",
                "/position",
                "/author",
                "/view/v",
                "/view/camera",
                "/view/view",
                "/view/display",
            ],
        ),
        (
            "session/client_command_move_annotation.json",
            DocumentCommand::MoveAnnotation {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                id: "pin-4c1d".into(),
                position: [355.0, 470.5],
                end: Some([465.0, 520.5]),
                z: 12.5,
            },
            vec!["/dataset_id", "/id", "/position"],
        ),
        (
            "session/client_command_remove_annotation.json",
            DocumentCommand::RemoveAnnotation {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                id: "pin-4c1d".into(),
            },
            vec!["/dataset_id", "/id"],
        ),
        (
            "session/client_command_add_comment.json",
            DocumentCommand::AddComment {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                annotation_id: "pin-4c1d".into(),
                id: "comment-92".into(),
                author: "7".into(),
                text: "agreed — recheck at t=3".into(),
            },
            vec!["/dataset_id", "/annotation_id", "/id", "/author", "/text"],
        ),
        (
            "session/client_command_remove_comment.json",
            DocumentCommand::RemoveComment {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                annotation_id: "pin-4c1d".into(),
                id: "comment-92".into(),
            },
            vec!["/dataset_id", "/annotation_id", "/id"],
        ),
        (
            "session/client_command_edit_comment.json",
            DocumentCommand::EditComment {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                annotation_id: "pin-4c1d".into(),
                id: "comment-91".into(),
                text: "glomerulus boundary confirmed".into(),
            },
            vec!["/dataset_id", "/annotation_id", "/id", "/text"],
        ),
        (
            "session/client_command_register_layout.json",
            DocumentCommand::RegisterLayout {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                layout: grid_layout(),
            },
            vec![
                "/dataset_id",
                "/layout",
                "/layout/id",
                "/layout/name",
                "/layout/placements",
            ],
        ),
        (
            "session/client_command_set_active_layout.json",
            DocumentCommand::SetActiveLayout {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                layout_id: LayoutId("layout-grid".into()),
            },
            vec!["/dataset_id", "/layout_id"],
        ),
        (
            "session/client_command_remove_dataset.json",
            DocumentCommand::RemoveDataset {
                id: DatasetId(SINGLE_DATASET_ID.into()),
            },
            vec!["/id"],
        ),
        (
            "session/client_command_rename_dataset.json",
            DocumentCommand::RenameDataset {
                id: DatasetId(SINGLE_DATASET_ID.into()),
                name: "kidney multiplex (deconvolved)".into(),
            },
            vec!["/id", "/name"],
        ),
        (
            "session/client_command_apply_asset_catalog_delta.json",
            DocumentCommand::ApplyAssetCatalogDelta {
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                delta: asset_catalog_delta(),
            },
            vec!["/dataset_id", "/delta", "/delta/added"],
        ),
    ]
}

fn client_goldens() -> Vec<(&'static str, ClientMessage, Vec<String>)> {
    let mut dataset_settings = HashMap::new();
    // At most one entry: HashMap order is nondeterministic (header comment).
    dataset_settings.insert(DatasetId(SINGLE_DATASET_ID.into()), peer_display_settings());

    let mut goldens: Vec<(&'static str, ClientMessage, Vec<String>)> = command_goldens()
        .into_iter()
        .map(|(rel, command, required)| {
            let mut keys = req("", &["/type", "/command", "/command/type"]);
            keys.extend(req("/command", &required));
            (rel, ClientMessage::Command { command }, keys)
        })
        .collect();

    goldens.extend(vec![
        (
            "session/client_presence.json",
            ClientMessage::Presence {
                camera: slice_camera(),
                view: shared_view_state(),
                display: shared_display_state(),
            },
            req(
                "",
                &["/type", "/camera", "/view", "/display", "/camera/mode"],
            ),
        ),
        (
            "session/client_cursor.json",
            ClientMessage::Cursor {
                position: Some([412.0, 233.5]),
            },
            req("", &["/type"]),
        ),
        (
            "session/client_follow.json",
            ClientMessage::Follow { target: Some(9) },
            req("", &["/type"]),
        ),
        (
            "session/client_dataset_presence.json",
            ClientMessage::DatasetPresence {
                dataset_order: vec![DatasetId(SINGLE_DATASET_ID.into())],
                dataset_settings,
            },
            req("", &["/type", "/dataset_order", "/dataset_settings"]),
        ),
        (
            "session/client_steer.json",
            ClientMessage::Steer { client: 3 },
            req("", &["/type", "/client"]),
        ),
        (
            "session/client_open_remote_dataset.json",
            ClientMessage::OpenRemoteDataset {
                request_id: "web-7d2f45aa".into(),
                url: "gs://lucida-fixtures/kidney-multiplex.zarr".into(),
            },
            req("", &["/type", "/request_id", "/url"]),
        ),
        (
            "session/client_dataset_health.json",
            ClientMessage::DatasetHealth {
                request_id: "web-health-55e0".into(),
                dataset_id: Some(DatasetId(SINGLE_DATASET_ID.into())),
            },
            req("", &["/type", "/request_id"]),
        ),
        (
            "session/client_dataset_retry.json",
            ClientMessage::DatasetRetry {
                request_id: "web-retry-90aa".into(),
                dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
            },
            req("", &["/type", "/request_id", "/dataset_id"]),
        ),
        (
            "session/client_request_snapshot.json",
            ClientMessage::RequestSnapshot,
            req("", &["/type"]),
        ),
        (
            "session/client_viewer_interest.json",
            ClientMessage::ViewerInterest {
                interest: ViewerInterestHint {
                    client_id: None,
                    dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
                    generation: 9,
                    t: 2,
                    z: 12,
                    channels: vec![0, 1],
                    mode: ViewerInterestMode::Slice,
                    viewport: Some(ViewerInterestViewport {
                        xy_bounds: [0.0, 0.0, 4096.0, 4096.0],
                        z_range: [10.0, 14.0],
                    }),
                    desired_keys: vec![
                        ViewerInterestChunkKey {
                            image_id: ImageId(SINGLE_IMAGE_ID.into()),
                            key: "1/2/1/12/3/4".into(),
                            lane: ViewerInterestLane::Visible,
                        },
                        // The tick coordinator routes non-visible,
                        // non-prefetch lanes into `desired_keys` as
                        // background entries.
                        ViewerInterestChunkKey {
                            image_id: ImageId(SINGLE_IMAGE_ID.into()),
                            key: "0/2/1/12/3/4".into(),
                            lane: ViewerInterestLane::Background,
                        },
                    ],
                    predicted_keys: vec![ViewerInterestChunkKey {
                        image_id: ImageId(SINGLE_IMAGE_ID.into()),
                        key: "1/2/1/13/3/4".into(),
                        lane: ViewerInterestLane::Predicted,
                    }],
                    interaction: ViewerInteractionMode::Scrubbing,
                    timestamp_ms: 1767225600123,
                    ttl_ms: 2000,
                },
            },
            req(
                "",
                &[
                    "/type",
                    "/interest",
                    "/interest/dataset_id",
                    "/interest/generation",
                    "/interest/t",
                    "/interest/z",
                    "/interest/mode",
                    "/interest/interaction",
                    "/interest/timestamp_ms",
                    "/interest/ttl_ms",
                    "/interest/viewport/xy_bounds",
                    "/interest/viewport/z_range",
                    "/interest/desired_keys/0/image_id",
                    "/interest/desired_keys/0/key",
                ],
            ),
        ),
    ]);
    goldens
}

const DATASET_OPEN_FILES: &[&str] = &[
    "dataset-open/dataset_opened_single.json",
    "dataset-open/dataset_opened_collection.json",
    "dataset-open/fetch_source_proxied.json",
    "dataset-open/fetch_source_direct.json",
    "dataset-open/fetch_source_local.json",
];

const GENERATED_FILES: &[&str] = &[
    "generated/availability_snapshot.json",
    "generated/availability_delta.json",
];

const REQUEST_FILES: &[&str] = &["session/chunk_request.json", "session/asset_request.json"];

const VOCAB_FILES: &[&str] = &["vocab/enum_vocabulary.json"];

fn chunk_request_golden() -> ChunkMessage {
    ChunkMessage::ChunkRequest {
        dataset_id: DatasetId(SINGLE_DATASET_ID.into()),
        image_id: ImageId(SINGLE_IMAGE_ID.into()),
        key: "1/2/1/12/3/4".into(),
    }
}

fn asset_request_golden() -> AssetMessage {
    AssetMessage::AssetRequest {
        dataset_id: DatasetId("wds-collection-77".into()),
        entity_id: EntityId("tile-A1-f0".into()),
        kind: ProxyKind::TileProxy3D,
        t: 0,
        c: 2,
    }
}

// ---------------------------------------------------------------------------
// Golden tests
// ---------------------------------------------------------------------------

#[test]
fn server_messages_match_goldens() {
    let mut failures = Vec::new();
    for (rel, msg, required) in server_goldens() {
        assert!(
            server_message_fixture_paths(&msg).contains(&rel),
            "{rel}: not declared for its ServerMessage variant in server_message_fixture_paths"
        );
        check(rel, &msg, &required, &mut failures);
    }
    assert_no_failures(failures);
}

#[test]
fn client_messages_match_goldens() {
    let mut failures = Vec::new();
    for (rel, msg, required) in client_goldens() {
        assert!(
            client_message_fixture_paths(&msg).contains(&rel),
            "{rel}: not declared for its ClientMessage variant in client_message_fixture_paths"
        );
        if let ClientMessage::Command { command } = &msg {
            assert!(
                document_command_fixture_paths(command).contains(&rel),
                "{rel}: not declared for its DocumentCommand variant in \
                 document_command_fixture_paths"
            );
        }
        check(rel, &msg, &required, &mut failures);
    }
    assert_no_failures(failures);
}

#[test]
fn request_envelopes_match_goldens() {
    let mut failures = Vec::new();

    let chunk = chunk_request_golden();
    assert!(chunk_message_fixture_paths(&chunk).contains(&"session/chunk_request.json"));
    check(
        "session/chunk_request.json",
        &chunk,
        &req("", &["/type", "/dataset_id", "/image_id", "/key"]),
        &mut failures,
    );

    let asset = asset_request_golden();
    assert!(asset_message_fixture_paths(&asset).contains(&"session/asset_request.json"));
    check(
        "session/asset_request.json",
        &asset,
        &req(
            "",
            &["/type", "/dataset_id", "/entity_id", "/kind", "/t", "/c"],
        ),
        &mut failures,
    );

    assert_no_failures(failures);
}

#[test]
fn dataset_open_payloads_match_goldens() {
    let mut failures = Vec::new();

    check(
        "dataset-open/dataset_opened_single.json",
        &single_dataset_opened(),
        &dataset_opened_required(),
        &mut failures,
    );
    check(
        "dataset-open/dataset_opened_collection.json",
        &collection_dataset_opened(),
        &req(
            "",
            &[
                "/manifest",
                "/fetch",
                "/manifest/kind/Collection/rows",
                "/manifest/kind/Collection/columns",
                "/manifest/kind/Collection/positioning_mode",
                "/manifest/kind/Collection/has_explicit_positions",
            ],
        ),
        &mut failures,
    );
    check(
        "dataset-open/fetch_source_proxied.json",
        &single_fetch(),
        &req("", PROXIED_FETCH_REQUIRED),
        &mut failures,
    );

    check(
        "dataset-open/fetch_source_direct.json",
        &FetchSource::Direct(DirectFetchDescriptor {
            images: vec![DirectImageSpec {
                image_id: ImageId(SINGLE_IMAGE_ID.into()),
                wire_format: WireFormat::Zstd {
                    data_type: DataType::Uint16,
                },
                levels: vec![
                    LevelAddress {
                        level_index: 0,
                        path: "kidney-multiplex.zarr/0".into(),
                    },
                    LevelAddress {
                        level_index: 1,
                        path: "kidney-multiplex.zarr/1".into(),
                    },
                ],
                store_prefix: Some("gs://lucida-fixtures".into()),
            }],
        }),
        &req(
            "",
            &[
                "/Direct/images",
                "/Direct/images/0/image_id",
                "/Direct/images/0/wire_format",
                "/Direct/images/0/levels",
                "/Direct/images/0/levels/0/level_index",
                "/Direct/images/0/levels/0/path",
            ],
        ),
        &mut failures,
    );

    check(
        "dataset-open/fetch_source_local.json",
        &FetchSource::Local(LocalFetchDescriptor {
            images: vec![DirectImageSpec {
                image_id: ImageId(SINGLE_IMAGE_ID.into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Float32,
                },
                levels: vec![LevelAddress {
                    level_index: 0,
                    path: "/data/kidney-multiplex.zarr/0".into(),
                }],
                store_prefix: None,
            }],
        }),
        &req("", &["/Local/images"]),
        &mut failures,
    );

    assert_no_failures(failures);
}

#[test]
fn generated_availability_payloads_match_goldens() {
    let mut failures = Vec::new();
    check(
        "generated/availability_snapshot.json",
        &generated_snapshot(),
        &req("", GENERATED_REQUIRED),
        &mut failures,
    );
    check(
        "generated/availability_delta.json",
        &generated_delta(),
        &req(
            "",
            &[
                "/levels/0/image_id",
                "/levels/0/info",
                "/levels/0/level",
                "/chunks/0/image_id",
                "/chunks/0/level_index",
                "/chunks/0/key",
                "/chunks/0/status",
            ],
        ),
        &mut failures,
    );
    assert_no_failures(failures);
}

#[test]
fn enum_vocabulary_matches_golden() {
    let mut failures = Vec::new();
    // Every top-level list is a required key: the web asserts the whole
    // object, so a dropped list must fail deserialization, not default.
    let required = req(
        "",
        &[
            "/colormaps",
            "/blend_modes",
            "/render_modes",
            "/clip_modes",
            "/annotation_kinds",
            "/axis_kinds",
            "/entity_kinds",
            "/data_types",
            "/positioning_modes",
            "/proxy_kinds",
            "/dataset_open_stages",
            "/dataset_open_failure_kinds",
            "/dataset_health_statuses",
            "/generated_chunk_statuses",
            "/generated_level_roles",
            "/bookmark_actions",
            "/viewer_interest_modes",
            "/viewer_interaction_modes",
            "/viewer_interest_lanes",
        ],
    );
    check(
        "vocab/enum_vocabulary.json",
        &enum_vocabulary(),
        &required,
        &mut failures,
    );
    assert_no_failures(failures);
}

/// The set of fixture files on disk must equal the set declared by the
/// golden tables — a fixture without a Rust golden (stale file, or a path
/// declared in an exhaustiveness arm without a golden entry) fails here,
/// and the vitest inventory test fails on any fixture the web side does not
/// assert.
#[test]
fn fixture_directory_matches_declared_set() {
    // Under REGEN_WIRE_GOLDENS the sibling tests are writing files
    // concurrently with this listing; the enforcement pass is the normal
    // (non-regen) run.
    if regen() {
        return;
    }
    let mut declared: BTreeSet<String> = BTreeSet::new();
    for (rel, _, _) in server_goldens() {
        declared.insert(rel.to_string());
    }
    for (rel, _, _) in client_goldens() {
        declared.insert(rel.to_string());
    }
    for rel in DATASET_OPEN_FILES
        .iter()
        .chain(GENERATED_FILES)
        .chain(REQUEST_FILES)
        .chain(VOCAB_FILES)
    {
        declared.insert((*rel).to_string());
    }

    let mut on_disk = BTreeSet::new();
    let root = fixture_root();
    for dir in fs::read_dir(&root).expect("wire-fixtures directory exists") {
        let dir = dir.expect("readable dir entry");
        if !dir.file_type().expect("file type").is_dir() {
            continue;
        }
        let dir_name = dir.file_name().to_string_lossy().into_owned();
        for file in fs::read_dir(dir.path()).expect("readable fixture dir") {
            let file = file.expect("readable file entry");
            on_disk.insert(format!("{dir_name}/{}", file.file_name().to_string_lossy()));
        }
    }

    assert_eq!(
        on_disk, declared,
        "wire-fixtures/ content differs from the declared golden set — delete stray files, or \
         add a golden (and web-side coverage) for new ones"
    );
}
