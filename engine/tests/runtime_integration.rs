use std::fs;
use std::net::SocketAddr;
use std::path::Path;

use futures::{SinkExt, StreamExt};
use lucida_engine::{ChunkAssetKind, ChunkKey, EngineRuntimeConfig, run_runtime_server};
use reqwest::StatusCode;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};
use tokio_tungstenite::tungstenite::Message;

struct RuntimeFixture {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl RuntimeFixture {
    async fn start(cache_root: &Path) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test runtime should bind an ephemeral port");
        let address = listener
            .local_addr()
            .expect("bound runtime should expose local addr");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let config = EngineRuntimeConfig {
            cache_root: cache_root.to_path_buf(),
        };
        let task = tokio::spawn(async move {
            run_runtime_server(listener, config, shutdown_rx)
                .await
                .expect("runtime should run cleanly");
        });
        Self {
            address,
            shutdown: Some(shutdown_tx),
            task,
        }
    }

    fn http_base(&self) -> String {
        format!("http://{}", self.address)
    }

    fn ws_base(&self) -> String {
        format!("ws://{}", self.address)
    }

    async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.task.await;
    }
}

fn unique_path(prefix: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock should be after unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "lucida_runtime_integration_{prefix}_{}_{}",
        std::process::id(),
        nanos
    ))
}

fn preview_payload_path(
    cache_root: &Path,
    source_id: &str,
    generation_seq: u64,
    lod: u8,
) -> String {
    cache_root
        .join(source_id)
        .join(format!("gen_{generation_seq:08}"))
        .join("preview2d")
        .join(format!("lod_{lod}.pgm"))
        .display()
        .to_string()
}

async fn recv_text_frame(
    stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> serde_json::Value {
    let frame = timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("runtime should respond within timeout")
        .expect("websocket stream should stay open")
        .expect("websocket frame should be valid");
    match frame {
        Message::Text(text) => {
            serde_json::from_str(&text).expect("runtime should send valid JSON text frames")
        }
        other => panic!("unexpected non-text websocket frame: {other:?}"),
    }
}

#[tokio::test]
async fn runtime_supports_attach_command_events_and_reconnect() {
    let cache_root = unique_path("ws");
    fs::create_dir_all(&cache_root).expect("cache root should be created");
    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();

    let create_response = client
        .post(format!("{}/v1/sessions", runtime.http_base()))
        .json(&json!({ "name": "runtime-session" }))
        .send()
        .await
        .expect("session creation request should succeed");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created: serde_json::Value = create_response
        .json()
        .await
        .expect("create response should parse as JSON");
    let session_id = created["session_id"]
        .as_str()
        .expect("created session id should be present")
        .to_owned();

    let connect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut socket, _) = tokio_tungstenite::connect_async(connect_url)
        .await
        .expect("websocket connect should succeed");

    socket
        .send(Message::Text(
            json!({
                "message_type": "attach",
                "client_label": "browser-a",
                "requested_permission": "control"
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("attach frame should send");

    let snapshot = recv_text_frame(&mut socket).await;
    assert_eq!(snapshot["message_type"], "session.snapshot");
    assert_eq!(snapshot["session_id"], session_id);
    assert_eq!(
        snapshot["snapshot"]["session"]["session_id"],
        session_id.as_str()
    );

    let client_id = snapshot["snapshot"]["client_view"]["client_id"]
        .as_str()
        .expect("snapshot should include client id")
        .to_owned();

    socket
        .send(Message::Text(
            json!({
                "message_type": "command",
                "schema_version": "lucida-proto-0.1",
                "session_id": session_id,
                "request_id": "req_lease_1",
                "client_id": client_id,
                "client_seq": 1,
                "op": "lease.request",
                "scope": "scene_shared",
                "requires_lease": false,
                "args": {}
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("lease request frame should send");

    socket
        .send(Message::Text(
            json!({
                "message_type": "command",
                "schema_version": "lucida-proto-0.1",
                "session_id": session_id,
                "request_id": "req_layer_1",
                "client_id": client_id,
                "client_seq": 2,
                "op": "scene.layer_add",
                "scope": "scene_shared",
                "requires_lease": true,
                "args": { "name": "runtime-layer" }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("layer add frame should send");

    let mut layer_event_seen = false;
    let mut event_revisions: Vec<u64> = Vec::new();
    for _ in 0..8 {
        let maybe_frame = timeout(Duration::from_millis(500), socket.next()).await;
        let frame = match maybe_frame {
            Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<serde_json::Value>(&text)
                .expect("runtime should send valid JSON text frames"),
            Ok(Some(Ok(Message::Binary(_))))
            | Ok(Some(Ok(Message::Ping(_))))
            | Ok(Some(Ok(Message::Pong(_)))) => continue,
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => break,
            Ok(Some(Err(error))) => panic!("websocket frame should be valid: {error}"),
            Ok(Some(Ok(other))) => panic!("unexpected frame variant: {other:?}"),
        };
        if frame["message_type"] == "event" {
            let session_rev = frame["session_rev"]
                .as_u64()
                .expect("event should include session_rev");
            event_revisions.push(session_rev);
            if frame["event_type"] == "scene_layer_upsert" {
                layer_event_seen = true;
            }
        }
    }
    assert!(
        layer_event_seen,
        "expected scene_layer_upsert event from layer_add"
    );
    assert!(
        event_revisions
            .windows(2)
            .all(|window| window[0] <= window[1]),
        "event session revisions should be monotonic"
    );

    socket
        .close(None)
        .await
        .expect("closing first websocket should succeed");

    let reconnect_url = format!("{}/v1/sessions/{session_id}/connect", runtime.ws_base());
    let (mut reconnect_socket, _) = tokio_tungstenite::connect_async(reconnect_url)
        .await
        .expect("reconnect websocket should succeed");
    reconnect_socket
        .send(Message::Text(
            json!({
                "message_type": "reconnect",
                "client_label": "browser-a",
                "requested_permission": "control",
                "previous_client_id": client_id
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("reconnect frame should send");
    let reconnect_snapshot = recv_text_frame(&mut reconnect_socket).await;
    assert_eq!(reconnect_snapshot["message_type"], "session.snapshot");
    assert_eq!(
        reconnect_snapshot["snapshot"]["session"]["session_id"],
        session_id.as_str()
    );
    let reconnected_client_id = reconnect_snapshot["snapshot"]["client_view"]["client_id"]
        .as_str()
        .expect("reconnect snapshot should include client id");
    assert_ne!(reconnected_client_id, client_id.as_str());

    reconnect_socket
        .close(None)
        .await
        .expect("closing reconnect websocket should succeed");
    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}

#[tokio::test]
async fn runtime_serves_data_plane_get_and_head() {
    let cache_root = unique_path("data");
    fs::create_dir_all(&cache_root).expect("cache root should be created");

    let source_id = "src_runtime";
    let generation_seq = 1_u64;
    let lod = 0_u8;
    let preview_path = preview_payload_path(&cache_root, source_id, generation_seq, lod);
    let preview_parent = Path::new(&preview_path)
        .parent()
        .expect("preview path should have parent");
    fs::create_dir_all(preview_parent).expect("preview dir should be created");
    fs::write(&preview_path, b"P5\n1 1\n255\n\x80").expect("preview payload write should succeed");

    let runtime = RuntimeFixture::start(&cache_root).await;
    let client = reqwest::Client::new();
    let chunk_path = ChunkKey {
        source_id: source_id.to_owned(),
        generation_seq,
        asset_kind: ChunkAssetKind::Preview2d,
        lod,
        t: 0,
        z: 0,
        channel_block: 0,
        y: 0,
        x: 0,
    }
    .format_path();
    let escaped_path = chunk_path.trim_start_matches('/');
    let url = format!("{}/v1/data/{escaped_path}", runtime.http_base());

    let get_response = client
        .get(&url)
        .send()
        .await
        .expect("data GET should succeed");
    assert_eq!(get_response.status(), StatusCode::OK);
    assert_eq!(
        get_response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("image/x-portable-graymap")
    );
    let get_body = get_response
        .bytes()
        .await
        .expect("GET body should be readable");
    assert_eq!(get_body.as_ref(), b"P5\n1 1\n255\n\x80");

    let head_response = client
        .head(&url)
        .send()
        .await
        .expect("data HEAD should succeed");
    assert_eq!(head_response.status(), StatusCode::OK);
    let head_body = head_response
        .bytes()
        .await
        .expect("HEAD body should be readable");
    assert!(
        head_body.is_empty(),
        "HEAD response should not include a body"
    );

    runtime.stop().await;
    fs::remove_dir_all(cache_root).expect("cache root cleanup should succeed");
}
