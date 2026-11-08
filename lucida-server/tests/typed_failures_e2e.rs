//! Every request the server does not serve is answered, over a real socket:
//! each way a chunk request can fail gets a status frame that names the
//! failure, and every message the server does not act on gets a rejection.
//! A request that ends in silence fails here by timing out.

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

use lucida_core::protocol::{CommandRejection, MessageRejection, ServerMessage};
use lucida_protocol::{ChunkFailureKind, SourceChunkStatus};
use lucida_server::dataset_open::{DatasetOpenContext, DatasetOpenOutcome, open_dataset};
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes, handler};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

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

/// One zstd-compressed uint16 level of two 4x4 chunks along `x`: chunk 0
/// holds bytes that are not zstd at all, and chunk 1 a valid zstd stream of
/// the wrong length.
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
    fs::write(dir.join("zarr.json"), root.to_string()).unwrap();

    let level = dir.join("0");
    fs::create_dir_all(&level).unwrap();
    let array = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 1, 1, 4, 8],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 1, 4, 4]}},
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "zstd", "configuration": {"level": 1, "checksum": false}}
        ],
        "fill_value": 0
    });
    fs::write(level.join("zarr.json"), array.to_string()).unwrap();

    let chunks = level.join("c").join("0").join("0").join("0").join("0");
    fs::create_dir_all(&chunks).unwrap();
    fs::write(chunks.join("0"), b"not a zstd frame").unwrap();
    fs::write(
        chunks.join("1"),
        zstd::encode_all(&[7_u8; 10][..], 1).unwrap(),
    )
    .unwrap();
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_typed_failures_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    dir
}

/// The next text message, skipping timing batches, which ride the same
/// socket on their own ticker.
async fn next_reply(ws: &mut WsClient) -> ServerMessage {
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a reply: the request was answered with silence")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Text(text) = msg {
            match serde_json::from_str::<ServerMessage>(text.as_str()).unwrap() {
                ServerMessage::TimingBatch { .. } => continue,
                reply => return reply,
            }
        }
    }
}

struct Rig {
    ws: WsClient,
    dataset_id: String,
    image_id: String,
    root: PathBuf,
}

async fn start(name: &str) -> Rig {
    let root = temp_dir(name);
    let data = root.join("dataset.zarr");
    write_fixture(&data);

    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _rx) = broadcast::channel::<BroadcastItem>(256);
    let (progress, _progress_rx) = mpsc::unbounded_channel();
    let opened = open_dataset(
        1,
        &data.to_str().unwrap().parse().unwrap(),
        &DatasetOpenContext {
            session: Arc::clone(&session),
            tx: tx.clone(),
            proxy_config: proxy_config(&root),
            source_policy: Arc::default(),
            workspace: None,
        },
        &progress,
    )
    .await
    .expect("the fixture opens");
    let DatasetOpenOutcome::Opened { opened, .. } = opened else {
        panic!("the open must complete");
    };
    let dataset_id = opened.manifest.dataset_id.0.clone();
    let image_id = opened.manifest.images()[0].image_id.0.clone();

    let state = AppState {
        session,
        tx,
        next_id: Arc::new(AtomicU64::new(0)),
        unicast_routes: UnicastRoutes::new(Mutex::new(HashMap::new())),
        source_policy: Arc::default(),
        proxy_config: proxy_config(&root),
    };
    let app = Router::new().route("/ws", get(ws_route)).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (mut ws, _) = connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("ws connect");
    let ServerMessage::Snapshot { .. } = next_reply(&mut ws).await else {
        panic!("the first message is the snapshot");
    };
    Rig {
        ws,
        dataset_id,
        image_id,
        root,
    }
}

async fn send_text(ws: &mut WsClient, text: String) {
    ws.send(WsMessage::Text(text.into())).await.expect("send");
}

#[tokio::test]
async fn every_failed_chunk_request_gets_a_status_that_names_the_failure() {
    let mut rig = start("chunks").await;
    let (dataset, image) = (rig.dataset_id.clone(), rig.image_id.clone());
    let cases = [
        (
            &dataset,
            &image,
            "0/0/0/0/0",
            ChunkFailureKind::MalformedKey,
        ),
        (
            &dataset,
            &image,
            "0/0/0/0/0/01",
            ChunkFailureKind::MalformedKey,
        ),
        (
            &dataset,
            &image,
            "3/0/0/0/0/0",
            ChunkFailureKind::UnknownLevel,
        ),
        (
            &dataset,
            &"no-such-image".to_string(),
            "0/0/0/0/0/0",
            ChunkFailureKind::UnknownImage,
        ),
        (
            &"no-such-dataset".to_string(),
            &image,
            "0/0/0/0/0/0",
            ChunkFailureKind::UnknownDataset,
        ),
        (
            &dataset,
            &image,
            "0/0/0/0/0/0",
            ChunkFailureKind::CorruptChunk,
        ),
        (&dataset, &image, "0/0/0/0/0/1", ChunkFailureKind::WrongSize),
    ];
    for (rid, (dataset_id, image_id, key, expected)) in cases.into_iter().enumerate() {
        let request = serde_json::json!({
            "type": "chunk_request",
            "rid": rid,
            "dataset_id": dataset_id,
            "image_id": image_id,
            "key": key,
        });
        send_text(&mut rig.ws, request.to_string()).await;
        match next_reply(&mut rig.ws).await {
            ServerMessage::SourceChunkStatus {
                dataset_id: got_dataset,
                image_id: got_image,
                key: got_key,
                status,
                kind,
                message,
            } => {
                assert_eq!(&got_dataset.0, dataset_id, "{key}");
                assert_eq!(&got_image.0, image_id, "{key}");
                assert_eq!(got_key, key, "the reply echoes the key as sent");
                assert_eq!(kind, Some(expected), "{key}");
                assert_eq!(status, expected.status(), "{key}");
                assert!(message.is_some_and(|m| !m.is_empty()), "{key}");
            }
            other => panic!("{key}: expected a source chunk status, got {other:?}"),
        }
    }
    let ServerMessage::SourceChunkStatus { status, .. } = ({
        send_text(
            &mut rig.ws,
            serde_json::json!({
                "type": "chunk_request",
                "rid": 99,
                "dataset_id": "no-such-dataset",
                "image_id": image,
                "key": "0/0/0/0/0/0",
            })
            .to_string(),
        )
        .await;
        next_reply(&mut rig.ws).await
    }) else {
        panic!("expected a source chunk status");
    };
    assert_eq!(
        status,
        SourceChunkStatus::Unavailable,
        "a dataset not bound yet may be bound a moment later"
    );
    let _ = fs::remove_dir_all(&rig.root);
}

#[tokio::test]
async fn every_message_the_server_does_not_act_on_gets_a_rejection() {
    let mut rig = start("messages").await;
    let cases: [(WsMessage, MessageRejection, Option<&str>); 5] = [
        (
            WsMessage::Text("not json".into()),
            MessageRejection::Malformed,
            None,
        ),
        (
            WsMessage::Text(r#"{"type":"frobnicate","request_id":"r-1"}"#.into()),
            MessageRejection::UnknownType,
            Some("frobnicate"),
        ),
        (
            WsMessage::Text(r#"{"type":"open_remote_dataset","request_id":"r-2"}"#.into()),
            MessageRejection::Malformed,
            Some("open_remote_dataset"),
        ),
        (
            WsMessage::Binary(vec![1, 2, 3].into()),
            MessageRejection::BinaryFrame,
            None,
        ),
        (
            WsMessage::Text(
                r#"{"type":"chunk_fetch","client_id":0,"rid":1,"dataset_id":"ds","image_id":"img","key":"0/0/0/0/0/0"}"#
                    .into(),
            ),
            MessageRejection::UnknownType,
            Some("chunk_fetch"),
        ),
    ];
    for (message, expected, expected_type) in cases {
        let sent = format!("{message:?}");
        rig.ws.send(message).await.expect("send");
        match next_reply(&mut rig.ws).await {
            ServerMessage::MessageRejected {
                reason,
                message_type,
                message,
                ..
            } => {
                assert_eq!(reason, expected, "{sent}");
                assert_eq!(message_type.as_deref(), expected_type, "{sent}");
                assert!(!message.is_empty(), "{sent}");
            }
            other => panic!("{sent}: expected a rejection, got {other:?}"),
        }
    }

    send_text(
        &mut rig.ws,
        r#"{"type":"frobnicate","request_id":"r-3","rid":12}"#.to_string(),
    )
    .await;
    let ServerMessage::MessageRejected {
        request_id, rid, ..
    } = next_reply(&mut rig.ws).await
    else {
        panic!("expected a rejection");
    };
    assert_eq!(request_id.as_deref(), Some("r-3"));
    assert_eq!(rid, Some(12));

    // A command whose body does not parse is a refused command, answered
    // where the sender's acks are, so its pending commands stay in order.
    send_text(
        &mut rig.ws,
        r#"{"type":"command","command":{"type":"no_such_command"}}"#.to_string(),
    )
    .await;
    let reply = next_reply(&mut rig.ws).await;
    assert!(
        matches!(
            reply,
            ServerMessage::CommandRejected {
                reason: CommandRejection::Invalid
            }
        ),
        "expected the command to be refused as invalid, got {reply:?}"
    );
    let _ = fs::remove_dir_all(&rig.root);
}
