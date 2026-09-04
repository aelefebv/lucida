//! The server's lifecycle rows, end to end: request a real chunk over a
//! real socket against a real binding, and read back the row the server
//! pushed for it.
//!
//! The phase enum only earns its cost if the phases are actually filled on
//! the live path. Every one of them is set somewhere other than where a unit
//! test can see: `arrival` and `binding lookup` happen in the inbound loop,
//! `dispatch` in a spawned task, and the store phases inside `CachedStore`.
//! So this drives the whole stack and asserts on what came out the other end
//! (ADR 0050).

use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use lucida_core::protocol::ServerMessage;
use lucida_protocol::{PHASE_UNSET, ServerTimingBatch, TimingRowFamily, TimingRowOutcome};
use lucida_server::dataset_open::{DatasetOpenContext, DatasetOpenOutcome, open_dataset};
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes, handler};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// A 4x4 uint16 level-0 chunk, uncompressed: the point here is the phases a
/// serve passes through, not the codec it passes them with.
const VOXELS: usize = 16;

async fn ws_route(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    ws.on_upgrade(move |socket| async move {
        handler::handle_client(
            id,
            socket,
            state.session,
            state.tx,
            state.unicast_routes,
            state.proxy_config,
        )
        .await;
    })
}

fn proxy_config(root: &Path) -> ProxyConfig {
    ProxyConfig {
        cache_dir: root.join("proxies"),
        legacy_proxy_enabled: false,
        concurrency: 1,
        generated_enabled: false,
        generated_cache_dir: root.join("generated"),
        generated_concurrency: 1,
        generated_background_chunk_limit: 4,
        generated_target_long_axis: 64,
        generated_chunk_long_axis: 32,
        generated_max_chunk_bytes: 1024 * 1024,
        generated_disk_budget_bytes: None,
    }
}

/// Write a minimal single-chunk OME-Zarr the real open path can import.
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
                        {"name": "t", "type": "time"},
                        {"name": "c", "type": "channel"},
                        {"name": "z", "type": "space"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [
                            {"type": "scale", "scale": [1.0, 1.0, 1.0, 1.0, 1.0]}
                        ]
                    }]
                }]
            }
        }
    });
    fs::write(
        dir.join("zarr.json"),
        serde_json::to_string_pretty(&root).unwrap(),
    )
    .unwrap();

    let level = dir.join("0");
    fs::create_dir_all(&level).unwrap();
    let array = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 1, 1, 4, 4],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 1, 4, 4]}},
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "fill_value": 0
    });
    fs::write(
        level.join("zarr.json"),
        serde_json::to_string_pretty(&array).unwrap(),
    )
    .unwrap();

    let chunk_dir = level.join("c").join("0").join("0").join("0").join("0");
    fs::create_dir_all(&chunk_dir).unwrap();
    let bytes: Vec<u8> = (0..VOXELS as u16).flat_map(|v| v.to_le_bytes()).collect();
    fs::write(chunk_dir.join("0"), bytes).unwrap();
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_timing_rows_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    dir
}

/// Read frames until a timing batch arrives, ignoring everything else — the
/// batch rides the same socket as chunk frames and presence traffic.
async fn next_timing_batch(ws: &mut WsClient) -> ServerTimingBatch {
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a timing batch")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Text(text) = msg
            && let Ok(ServerMessage::TimingBatch { batch }) =
                serde_json::from_str::<ServerMessage>(text.as_str())
        {
            return batch;
        }
    }
}

#[tokio::test]
async fn a_served_chunk_reports_every_phase_it_passed_through() {
    let root = temp_dir("served_chunk");
    let data = root.join("dataset.zarr");
    write_fixture(&data);

    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _rx) = broadcast::channel::<BroadcastItem>(256);
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));

    // The binding goes in through the real open path, so the lookup the row
    // measures is the one production takes.
    let (progress, _progress_rx) = mpsc::unbounded_channel();
    let opened = open_dataset(
        1,
        data.to_str().unwrap(),
        &DatasetOpenContext {
            session: Arc::clone(&session),
            tx: tx.clone(),
            proxy_config: proxy_config(&root),
            workspace: None,
        },
        &progress,
    )
    .await
    .expect("the fixture opens");
    let DatasetOpenOutcome::Opened { opened, .. } = opened else {
        panic!("the open must complete");
    };
    let dataset_id = opened.manifest.dataset_id.clone();
    let image_id = opened
        .manifest
        .images()
        .first()
        .expect("the fixture has one image")
        .image_id
        .clone();

    let state = AppState {
        session: Arc::clone(&session),
        tx,
        next_id: Arc::new(AtomicU64::new(0)),
        unicast_routes,
        data_dir: None,
        proxy_config: proxy_config(&root),
    };
    let app = Router::new().route("/ws", get(ws_route)).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (mut ws, _) = connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("ws connect");

    let request = serde_json::json!({
        "type": "chunk_request",
        "rid": 7,
        "dataset_id": dataset_id,
        "image_id": image_id,
        "key": "0/0/0/0/0/0",
    });
    ws.send(WsMessage::Text(request.to_string().into()))
        .await
        .expect("send the chunk request");

    let batch = next_timing_batch(&mut ws).await;
    let index = batch
        .rid
        .iter()
        .position(|rid| *rid == 7)
        .expect("a row for the label this client sent");
    assert_eq!(batch.family[index], TimingRowFamily::Chunk);
    assert_eq!(batch.outcome[index], TimingRowOutcome::Delivered);

    // Every phase a source-chunk serve passes through is filled. `set` means
    // the phase was entered, whatever it measured — a zero here would be a
    // real sub-microsecond stage, not an unentered one.
    for (name, column) in [
        ("arrival", &batch.arrival_us),
        ("binding_lookup", &batch.binding_lookup_us),
        ("dispatch", &batch.dispatch_us),
        ("cache_lookup", &batch.cache_lookup_us),
        ("permit_wait", &batch.permit_wait_us),
        ("backend_read", &batch.backend_read_us),
        ("decompress", &batch.decompress_us),
        ("slice_encode", &batch.slice_encode_us),
        ("handoff", &batch.handoff_us),
    ] {
        assert_ne!(
            column[index], PHASE_UNSET,
            "{name} was never measured on the live path"
        );
    }

    // This serve led its own read, so it has no coalesced wait: only a
    // follower does, and reading one here would double-count the round trip.
    assert_eq!(batch.coalesced_wait_us[index], PHASE_UNSET);

    // The row says how many bytes that read moved: the whole chunk object,
    // because this level is not sharded. On a sharded level the same column
    // is what shows a shard was read by the inner chunk and not whole.
    assert_eq!(batch.backend_bytes[index], Some((VOXELS * 2) as u32));

    let _ = fs::remove_dir_all(&root);
}
