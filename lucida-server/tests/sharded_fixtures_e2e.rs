//! The committed twin fixtures, served through every path the server reads
//! a source chunk by: the chunk-read pipeline, generated coarse, and a real
//! socket. The twins hold the same samples, one in shards and one as an
//! object per chunk, so every chunk key must come back byte for byte the
//! same from both. That equality is the primary seam of the sharded store.

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
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use lucida_content::{DatasetManifest, ImageId};
use lucida_protocol::DatasetOpened;
use lucida_server::binding::ChunkResolver;
use lucida_server::chunk_read::{ChunkRead, read_chunk};
use lucida_server::dataset_open::{DatasetOpenContext, DatasetOpenOutcome, open_dataset};
use lucida_server::generated::{
    DerivedChunkCache, DerivedChunkLookup, GeneratedCoarseConfig,
    materialize_generated_coarse_plan, plan_generated_coarse_for_manifest,
};
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes, handler};
use lucida_store::cache::{CachedStore, DEFAULT_SOURCE_CACHE_BYTES};
use lucida_store::import::import_dataset;
use lucida_store::import_types::ImportResult;
use lucida_store::source_limiter::{ReaderId, RequestLabel};

const READER: ReaderId = ReaderId(3);
const LABEL: RequestLabel = RequestLabel(5);
const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// Bytes in one wire chunk of the twins: an 8x8 inner chunk of `uint16`.
const WIRE_CHUNK_BYTES: usize = 8 * 8 * 2;

fn fixture_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("ome-zarr")
        .join(name)
}

struct Twin {
    store: Arc<CachedStore>,
    result: ImportResult,
    resolver: Arc<ChunkResolver>,
    image_id: ImageId,
}

async fn import_twin(name: &str) -> Twin {
    let store = Arc::new(CachedStore::new(
        lucida_store::backend::open(fixture_dir(name).to_str().unwrap()).unwrap(),
        DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let result = import_dataset(&store, "twin", "twin").await.unwrap();
    assert!(result.warnings.is_empty(), "{name}: {:?}", result.warnings);
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let image_id = result.manifest.images()[0].image_id.clone();
    Twin {
        store,
        result,
        resolver,
        image_id,
    }
}

fn twin_chunk_keys(manifest: &DatasetManifest) -> Vec<String> {
    let mut keys = Vec::new();
    for level in &manifest.images()[0].multiscale.levels {
        let [_, channels, _, rows, columns] = level.grid_shape;
        for c in 0..channels {
            for y in 0..rows {
                for x in 0..columns {
                    keys.push(format!("{}/0/{c}/0/{y}/{x}", level.level_index));
                }
            }
        }
    }
    assert_eq!(keys.len(), 2 * (25 + 9 + 4));
    keys
}

fn samples(bytes: &[u8]) -> Vec<u16> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    assert!(rest.is_empty(), "odd byte count for uint16 samples");
    pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect()
}

async fn served_bytes(twin: &Twin, key: &str) -> Vec<u8> {
    match read_chunk(
        &twin.resolver,
        &twin.store,
        &twin.image_id,
        key,
        READER,
        LABEL,
        None,
    )
    .await
    .unwrap()
    {
        ChunkRead::Present(bytes) => bytes,
        ChunkRead::Absent { .. } => panic!("chunk key {key} read as absent"),
    }
}

/// The chunks are full 8x8 sample blocks and the two channels differ, so the
/// equality is between two pictures rather than two runs of fill.
#[tokio::test]
async fn every_chunk_key_is_served_identically_from_the_sharded_and_the_unsharded_twin() {
    let sharded = import_twin("twin-sharded.ome.zarr").await;
    let unsharded = import_twin("twin-unsharded.ome.zarr").await;
    assert_eq!(
        sharded.result.manifest.images()[0].multiscale.levels,
        unsharded.result.manifest.images()[0].multiscale.levels,
    );

    let mut channel_pictures: HashMap<u32, Vec<Vec<u16>>> = HashMap::new();
    for key in twin_chunk_keys(&sharded.result.manifest) {
        let from_shard = served_bytes(&sharded, &key).await;
        let from_object = served_bytes(&unsharded, &key).await;
        assert_eq!(from_shard, from_object, "chunk key {key}");
        assert_eq!(from_shard.len(), WIRE_CHUNK_BYTES, "chunk key {key}");
        if key.ends_with("/0/0/0") {
            let level: u32 = key.split('/').next().unwrap().parse().unwrap();
            channel_pictures
                .entry(level)
                .or_default()
                .push(samples(&from_shard));
        }
    }
    for (level, pictures) in channel_pictures {
        assert_ne!(
            pictures[0], pictures[1],
            "level {level}: the channels carry one picture twice"
        );
    }
}

/// The plan resamples the 20x20 level, which is three inner chunks across in
/// two shards, so the output gathers inner chunks from both sides of a shard
/// boundary.
#[tokio::test]
async fn generated_coarse_over_the_sharded_twin_produces_the_unsharded_twins_chunks() {
    let mut outputs = Vec::new();
    for name in ["twin-sharded.ome.zarr", "twin-unsharded.ome.zarr"] {
        let mut twin = import_twin(name).await;
        // The twins are small enough that import names a source level as
        // the coarse level, and a plan is only made where there is none.
        twin.result.manifest.images_mut()[0]
            .multiscale
            .coarse_level_index = None;
        let manifest = Arc::new(twin.result.manifest.clone());
        let plan = plan_generated_coarse_for_manifest(
            &manifest,
            GeneratedCoarseConfig {
                target_long_axis: 20,
                chunk_long_axis: 10,
                max_chunk_bytes: 1 << 20,
            },
        )
        .pop()
        .expect("a plan for the one image");
        let keys = plan.chunk_keys_for_all_tc();
        assert!(
            keys.len() > 2,
            "{name}: more than one output chunk per channel"
        );

        let cache = Arc::new(DerivedChunkCache::default());
        cache.upsert_level(plan.availability.clone());
        let session = Arc::new(Mutex::new(Session::new()));
        let (tx, _rx) = broadcast::channel(16);
        materialize_generated_coarse_plan(
            plan.clone(),
            manifest,
            Arc::clone(&twin.store),
            Arc::clone(&twin.resolver),
            Arc::clone(&cache),
            session,
            tx,
        )
        .await;

        let mut chunks = Vec::new();
        for key in keys {
            match cache.lookup(&twin.image_id, plan.level_index, &key) {
                DerivedChunkLookup::Ready(bytes) => {
                    assert!(
                        samples(&bytes).iter().any(|&v| v != 0),
                        "{name}: generated chunk {key} is all fill"
                    );
                    chunks.push((key, bytes));
                }
                DerivedChunkLookup::Status { status, message } => {
                    panic!("{name}: generated chunk {key} is {status:?}: {message:?}");
                }
            }
        }
        outputs.push(chunks);
    }
    assert_eq!(outputs[0], outputs[1]);
}

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

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_sharded_twins_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    dir
}

/// The chunk envelope is `[client_id: u32][key_len: u16][key][data]`.
fn split_chunk_frame(frame: &[u8]) -> (String, Vec<u8>) {
    let key_len = u16::from_le_bytes(frame[4..6].try_into().unwrap()) as usize;
    let key = std::str::from_utf8(&frame[6..6 + key_len])
        .unwrap()
        .to_string();
    (key, frame[6 + key_len..].to_vec())
}

async fn collect_chunk_frames(
    ws: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    count: usize,
) -> HashMap<String, Vec<u8>> {
    let mut frames = HashMap::new();
    while frames.len() < count {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a chunk frame")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Binary(bytes) = msg {
            let (key, payload) = split_chunk_frame(&bytes);
            frames.insert(key, payload);
        }
    }
    frames
}

#[tokio::test]
async fn the_server_frames_the_same_bytes_for_the_sharded_and_the_unsharded_twin() {
    let root = temp_dir("served_twins");
    fs::create_dir_all(&root).unwrap();

    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _rx) = broadcast::channel::<BroadcastItem>(256);
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));
    let context = DatasetOpenContext {
        session: Arc::clone(&session),
        tx: tx.clone(),
        proxy_config: proxy_config(&root),
        workspace: None,
    };

    let mut opened_twins = Vec::new();
    for name in ["twin-sharded.ome.zarr", "twin-unsharded.ome.zarr"] {
        let (progress, _progress_rx) = mpsc::unbounded_channel();
        let outcome = open_dataset(1, fixture_dir(name).to_str().unwrap(), &context, &progress)
            .await
            .unwrap_or_else(|e| panic!("{name} opens: {e:?}"));
        let DatasetOpenOutcome::Opened { opened, .. } = outcome else {
            panic!("{name}: the open must complete");
        };
        opened_twins.push(opened);
    }
    let [sharded, unsharded] = <[_; 2]>::try_from(opened_twins).ok().unwrap();
    let keys = twin_chunk_keys(&sharded.manifest);
    let ids = |opened: &DatasetOpened| {
        (
            opened.manifest.dataset_id.clone(),
            opened.manifest.images()[0].image_id.clone(),
        )
    };
    let (sharded_id, sharded_image) = ids(&sharded);
    let (unsharded_id, unsharded_image) = ids(&unsharded);
    assert_ne!(sharded_id, unsharded_id);

    let state = AppState {
        session,
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

    let mut rid = 0u32;
    for key in &keys {
        for (dataset_id, image_id) in [
            (&sharded_id, &sharded_image),
            (&unsharded_id, &unsharded_image),
        ] {
            rid += 1;
            let request = serde_json::json!({
                "type": "chunk_request",
                "rid": rid,
                "dataset_id": dataset_id,
                "image_id": image_id,
                "key": key,
            });
            ws.send(WsMessage::Text(request.to_string().into()))
                .await
                .expect("send the chunk request");
        }
    }

    let frames = collect_chunk_frames(&mut ws, 2 * keys.len()).await;
    for key in &keys {
        let from_shard = &frames[&format!("{sharded_id}/{sharded_image}/{key}")];
        let from_object = &frames[&format!("{unsharded_id}/{unsharded_image}/{key}")];
        assert_eq!(from_shard, from_object, "chunk key {key}");
        assert_eq!(from_shard.len(), WIRE_CHUNK_BYTES, "chunk key {key}");
    }

    let _ = fs::remove_dir_all(&root);
}
