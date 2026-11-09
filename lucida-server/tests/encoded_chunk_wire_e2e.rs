//! Over a real socket, a connection that declares the codecs it decodes is
//! sent a chunk still in the codecs it was stored in, and an absent chunk's
//! fill compressed, while a connection that declares nothing is sent the
//! decoded frames it always was. Both decode to the same bytes.

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
use lucida_protocol::codec::{BytesCodec, parse_chunk_frame};
use lucida_server::GeneratedConfig;
use lucida_server::dataset_open::{DatasetOpenContext, DatasetOpenOutcome, open_dataset};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// One chunk of 32x32 uint16 samples decoded.
const CHUNK_BYTES: usize = 32 * 32 * 2;

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

/// A smooth ramp, which zstd stores in a fraction of its size.
fn samples() -> Vec<u8> {
    (0..32u16 * 32)
        .flat_map(|i| (i / 8).to_le_bytes())
        .collect()
}

/// One zstd-compressed uint16 level of two 32x32 chunks along `x`: chunk 0
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
                    "name": "img",
                    "axes": [
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1.0, 1.0]}
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
        "shape": [32, 64],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [32, 32]}},
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "zstd", "configuration": {"level": 3, "checksum": false}}
        ],
        "fill_value": 0
    });
    fs::write(level.join("zarr.json"), array.to_string()).unwrap();

    let chunks = level.join("c").join("0");
    fs::create_dir_all(&chunks).unwrap();
    fs::write(
        chunks.join("0"),
        zstd::encode_all(&samples()[..], 3).unwrap(),
    )
    .unwrap();
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_encoded_wire_{}", std::process::id()))
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

/// Ask for `key` and return the binary frame that answers it.
async fn request(
    ws: &mut WsClient,
    rid: u32,
    dataset_id: &str,
    image_id: &str,
    key: &str,
) -> Vec<u8> {
    let request = serde_json::json!({
        "type": "chunk_request",
        "rid": rid,
        "dataset_id": dataset_id,
        "image_id": image_id,
        "key": key,
    });
    ws.send(WsMessage::Text(request.to_string().into()))
        .await
        .expect("send");
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("the chunk arrives")
            .expect("stream ended")
            .expect("ws read");
        // Presence and timing batches ride the same socket; only the
        // binary frame answers the request.
        if let WsMessage::Binary(frame) = msg {
            return frame.to_vec();
        }
    }
}

#[tokio::test]
async fn a_client_that_declares_codecs_is_sent_chunks_encoded_and_others_decoded() {
    let root = temp_dir("relay");
    let data = root.join("dataset.zarr");
    write_fixture(&data);

    let server = WorkspaceRig::start(generated_config(&root)).await;
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
    let dataset = opened.manifest.dataset_id.0.clone();
    let image = opened.manifest.images()[0].image_id.0.clone();

    let mut plain = connect(&server).await;
    let mut declaring = connect(&server).await;
    declaring
        .send(WsMessage::Text(
            r#"{"type":"chunk_codecs","codecs":["zstd","lz4","a-codec-from-later"]}"#.into(),
        ))
        .await
        .expect("send");

    for (rid, key, stored_codecs) in [
        (0, "0/0/0/0/0/0", vec![BytesCodec::Zstd]),
        (1, "0/0/0/0/0/1", vec![BytesCodec::Lz4]),
    ] {
        let decoded = request(&mut plain, rid, &dataset, &image, key).await;
        let decoded = parse_chunk_frame(&decoded).unwrap();
        assert!(
            decoded.codecs.is_empty(),
            "{key}: a plain client gets decoded bytes"
        );
        assert_eq!(decoded.payload.len(), CHUNK_BYTES, "{key}");

        let encoded = request(&mut declaring, rid, &dataset, &image, key).await;
        let encoded = parse_chunk_frame(&encoded).unwrap();
        assert_eq!(encoded.composite_key, decoded.composite_key);
        assert_eq!(encoded.codecs, stored_codecs, "{key}");
        assert!(encoded.payload.len() * 4 <= CHUNK_BYTES * 3, "{key}");
        assert_eq!(
            decode_relayed(&encoded.codecs, encoded.payload, CHUNK_BYTES).unwrap(),
            decoded.payload,
            "{key}: both decode to the same bytes"
        );
    }
    assert_eq!(
        parse_chunk_frame(&request(&mut plain, 2, &dataset, &image, "0/0/0/0/0/0").await)
            .unwrap()
            .payload,
        samples()
    );
    let _ = fs::remove_dir_all(&root);
}
