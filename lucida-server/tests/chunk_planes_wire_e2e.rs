//! Over a real socket, a request that names some planes of a chunk is sent
//! those planes in a plane frame, cut from the chunk the server decoded, and
//! a request that names none is sent the whole chunk as it always was. Plane
//! frames are decoded bytes, or lz4 for a relayed connection that declared
//! it. A range the chunk cannot cut is answered with the whole chunk.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use common::workspace_rig::WorkspaceRig;
use lucida_core::chunk_codec::decode_relayed;
use lucida_core::protocol::ServerMessage;
use lucida_protocol::codec::{BytesCodec, ChunkRelaySetting, parse_chunk_frame};
use lucida_server::GeneratedConfig;
use lucida_server::dataset_open::{DatasetOpenContext, DatasetOpenOutcome, open_dataset};
use lucida_server::workspace::WorkspaceRuntimeConfig;

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

const DEPTH: usize = 8;
/// One plane of a 16x16 uint16 chunk.
const PLANE_BYTES: usize = 16 * 16 * 2;

fn generated_config(root: &Path) -> GeneratedConfig {
    GeneratedConfig {
        generated_enabled: false,
        generated_cache_dir: root.join("generated"),
        generated_concurrency: 1,
        generated_background_chunk_limit: 4,
        generated_target_long_axis: 64,
        generated_chunk_long_axis: 32,
        generated_max_chunk_bytes: 1024 * 1024,
        generated_disk_budget_bytes: None,
        generated_memory: lucida_server::generated::GeneratedChunkMemory::new(1 << 20),
    }
}

/// Each plane a ramp of its own, so a plane read from the wrong place shows.
fn samples() -> Vec<u8> {
    (0..(DEPTH * 16 * 16) as u16)
        .flat_map(|i| ((i / 256) * 1000 + (i % 256) / 8).to_le_bytes())
        .collect()
}

/// One zstd-compressed uint16 level of two 8x16x16 chunks along `x`: chunk 0
/// written, chunk 1 never written.
fn write_fixture(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    let root = serde_json::json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "multiscales": [{
                    "version": "0.5",
                    "name": "volume",
                    "axes": [
                        {"name": "z", "type": "space"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1.0, 1.0, 1.0]}
                        ]
                    }]
                }]
            }
        }
    });
    fs::write(dir.join("zarr.json"), root.to_string()).unwrap();

    let level = dir.join("0");
    fs::create_dir_all(&level).unwrap();
    let array = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [DEPTH, 16, 32],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [DEPTH, 16, 16]}},
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "zstd", "configuration": {"level": 3, "checksum": false}}
        ],
        "fill_value": 7
    });
    fs::write(level.join("zarr.json"), array.to_string()).unwrap();

    let chunks = level.join("c").join("0").join("0");
    fs::create_dir_all(&chunks).unwrap();
    fs::write(
        chunks.join("0"),
        zstd::encode_all(&samples()[..], 3).unwrap(),
    )
    .unwrap();
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_plane_wire_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    dir
}

async fn connect(server: &WorkspaceRig) -> WsClient {
    let (mut ws, _) = connect_async(server.ws_url()).await.expect("ws connect");
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("the snapshot arrives")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Text(text) = msg
            && let ServerMessage::Snapshot { .. } = serde_json::from_str(text.as_str()).unwrap()
        {
            return ws;
        }
    }
}

/// Ask for `key`, or some of its planes, and return the binary frame that
/// answers it.
async fn request(
    ws: &mut WsClient,
    rid: u32,
    opened: &Opened,
    key: &str,
    planes: Option<[u32; 2]>,
) -> Vec<u8> {
    let mut request = serde_json::json!({
        "type": "chunk_request",
        "rid": rid,
        "dataset_id": opened.dataset,
        "image_id": opened.image,
        "key": key,
    });
    if let Some(planes) = planes {
        request["planes"] = serde_json::json!(planes);
    }
    ws.send(WsMessage::Text(request.to_string().into()))
        .await
        .expect("send");
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("the chunk arrives")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Binary(frame) = msg {
            return frame.to_vec();
        }
    }
}

struct Opened {
    server: WorkspaceRig,
    root: PathBuf,
    dataset: String,
    image: String,
}

async fn open(name: &str, chunk_relay: ChunkRelaySetting) -> Opened {
    let root = temp_dir(name);
    let data = root.join("dataset.zarr");
    write_fixture(&data);

    let server = WorkspaceRig::start_with(
        generated_config(&root),
        WorkspaceRuntimeConfig {
            chunk_relay,
            ..WorkspaceRuntimeConfig::default()
        },
    )
    .await;
    let (progress, _progress_rx) = mpsc::unbounded_channel();
    let opened = open_dataset(
        1,
        &data.to_str().unwrap().parse().unwrap(),
        &DatasetOpenContext {
            generated_config: generated_config(&root),
            source_policy: Arc::default(),
            workspace: server.scope(),
        },
        &progress,
    )
    .await
    .expect("the fixture opens");
    let DatasetOpenOutcome::Opened { opened, .. } = opened else {
        panic!("the open must complete");
    };
    Opened {
        dataset: opened.manifest.dataset_id.0.clone(),
        image: opened.manifest.images()[0].image_id.0.clone(),
        server,
        root,
    }
}

#[tokio::test]
async fn a_request_for_planes_is_sent_those_planes_and_one_without_the_whole_chunk() {
    let opened = open("planes", ChunkRelaySetting::Never).await;
    let mut ws = connect(&opened.server).await;

    let whole = request(&mut ws, 0, &opened, "0/0/0/0/0/0", None).await;
    let whole = parse_chunk_frame(&whole).unwrap();
    assert_eq!(whole.planes, None);
    assert_eq!(whole.payload, samples());

    let planes = request(&mut ws, 1, &opened, "0/0/0/0/0/0", Some([3, 5])).await;
    let planes = parse_chunk_frame(&planes).unwrap();
    assert_eq!(planes.composite_key, whole.composite_key);
    assert_eq!(planes.planes, Some([3, 5]));
    assert!(
        planes.codecs.is_empty(),
        "a connection that is not relayed to gets decoded planes"
    );
    assert_eq!(planes.payload, &samples()[3 * PLANE_BYTES..5 * PLANE_BYTES]);

    // An absent chunk's planes are its fill.
    let absent = request(&mut ws, 2, &opened, "0/0/0/0/0/1", Some([0, 1])).await;
    let absent = parse_chunk_frame(&absent).unwrap();
    assert_eq!(absent.planes, Some([0, 1]));
    assert_eq!(absent.payload, 7u16.to_le_bytes().repeat(PLANE_BYTES / 2));
    let _ = fs::remove_dir_all(&opened.root);
}

#[tokio::test]
async fn planes_the_chunk_cannot_cut_are_answered_with_the_whole_chunk() {
    let opened = open("uncut", ChunkRelaySetting::Never).await;
    let mut ws = connect(&opened.server).await;
    for (rid, planes) in [(0, [2, 2]), (1, [6, 9]), (2, [0, DEPTH as u32])] {
        let frame = request(&mut ws, rid, &opened, "0/0/0/0/0/0", Some(planes)).await;
        let frame = parse_chunk_frame(&frame).unwrap();
        assert_eq!(frame.planes, None, "{planes:?}");
        assert_eq!(frame.payload, samples(), "{planes:?}");
    }
    let _ = fs::remove_dir_all(&opened.root);
}

#[tokio::test]
async fn a_relayed_connection_that_decodes_lz4_gets_its_planes_compressed() {
    let opened = open("relayed", ChunkRelaySetting::Always).await;
    let mut ws = connect(&opened.server).await;
    ws.send(WsMessage::Text(
        r#"{"type":"chunk_codecs","codecs":["zstd","lz4"]}"#.into(),
    ))
    .await
    .expect("send");

    let frame = request(&mut ws, 0, &opened, "0/0/0/0/0/0", Some([1, 4])).await;
    let frame = parse_chunk_frame(&frame).unwrap();
    assert_eq!(frame.planes, Some([1, 4]));
    assert_eq!(frame.codecs, [BytesCodec::Lz4]);
    let expected = &samples()[PLANE_BYTES..4 * PLANE_BYTES];
    assert!(frame.payload.len() * 4 <= expected.len() * 3);
    assert_eq!(
        decode_relayed(&frame.codecs, frame.payload, expected.len()).unwrap(),
        expected
    );

    // The whole chunk is still relayed as it is stored.
    let whole = request(&mut ws, 1, &opened, "0/0/0/0/0/0", None).await;
    assert_eq!(
        parse_chunk_frame(&whole).unwrap().codecs,
        [BytesCodec::Zstd]
    );
    let _ = fs::remove_dir_all(&opened.root);
}
