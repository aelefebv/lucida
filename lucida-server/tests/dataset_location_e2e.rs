//! What a dataset location becomes over a real WebSocket, against the real
//! `handle_client` stack: a location that does not parse is refused before
//! any storage is touched, echoing the input as given, and a `file://` URL
//! opens the path it names.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::{State, ws::WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use lucida_content::url::DatasetLocation;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_protocol::{DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenStage};
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes, handler};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

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

async fn start_server(root: &Path) -> SocketAddr {
    let (tx, _) = broadcast::channel::<BroadcastItem>(64);
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));
    let mut proxy_config = ProxyConfig::defaults();
    proxy_config.cache_dir = root.join("proxies");
    proxy_config.generated_cache_dir = root.join("generated-coarse");
    proxy_config.generated_enabled = false;
    let state = AppState {
        session: Arc::new(Mutex::new(Session::new())),
        tx,
        next_id: Arc::new(AtomicU64::new(0)),
        unicast_routes,
        data_dir: None,
        proxy_config,
    };
    let app = Router::new().route("/ws", get(ws_route)).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    addr
}

/// The terminal reply to one open: its envelope URL, and the failure
/// diagnostic when it failed.
struct OpenReply {
    url: String,
    failure: Option<DatasetOpenFailureDiagnostic>,
}

async fn open(addr: SocketAddr, url: &str) -> OpenReply {
    let (mut ws, _) = connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("ws connect");
    let request = ClientMessage::OpenRemoteDataset {
        request_id: "open-1".to_string(),
        url: url.to_string(),
    };
    ws.send(WsMessage::Text(
        serde_json::to_string(&request).unwrap().into(),
    ))
    .await
    .expect("send");
    loop {
        match next_server_message(&mut ws).await {
            ServerMessage::OpenDatasetFailed {
                request_id,
                url,
                diagnostic,
                ..
            } if request_id == "open-1" => {
                return OpenReply {
                    url,
                    failure: Some(diagnostic.expect("a failure carries its diagnostic")),
                };
            }
            ServerMessage::OpenDatasetSucceeded {
                request_id, url, ..
            } if request_id == "open-1" => return OpenReply { url, failure: None },
            _ => {}
        }
    }
}

async fn next_server_message(ws: &mut WsClient) -> ServerMessage {
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a server message")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Text(text) = msg {
            return serde_json::from_str(text.as_str())
                .unwrap_or_else(|e| panic!("unparseable server message: {e}: {text}"));
        }
    }
}

/// A metadata-only OME-Zarr v0.5 store: an open imports metadata and reads
/// no chunks.
fn write_minimal_zarr(dir: &Path) {
    let level = dir.join("0");
    std::fs::create_dir_all(&level).unwrap();
    let root = serde_json::json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {"ome": {"version": "0.5", "multiscales": [{
            "version": "0.5",
            "name": "img",
            "axes": [
                {"name": "t", "type": "time"},
                {"name": "c", "type": "channel"},
                {"name": "z", "type": "space"},
                {"name": "y", "type": "space"},
                {"name": "x", "type": "space"}
            ],
            "datasets": [{"path": "0", "coordinateTransformations": [
                {"type": "scale", "scale": [1.0, 1.0, 1.0, 1.0, 1.0]}
            ]}]
        }]}}
    });
    let array = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 1, 1, 4, 4],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 1, 4, 4]}},
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "fill_value": 0
    });
    std::fs::write(dir.join("zarr.json"), root.to_string()).unwrap();
    std::fs::write(level.join("zarr.json"), array.to_string()).unwrap();
}

#[tokio::test]
async fn a_relative_path_is_refused_before_storage_echoing_the_input() {
    let tmp = tempfile::tempdir().unwrap();
    let addr = start_server(tmp.path()).await;

    for input in ["./sample.zarr", "data/sample.zarr"] {
        let reply = open(addr, input).await;
        let failure = reply.failure.expect("a relative path must fail");
        assert_eq!(reply.url, input, "the envelope echoes the input as given");
        assert_eq!(failure.stage, DatasetOpenStage::RequestReceived);
        assert_eq!(failure.kind, DatasetOpenFailureKind::InvalidLocation);
        assert!(!failure.retryable);
        assert!(failure.message.contains(input), "{}", failure.message);
        assert!(failure.message.contains("absolute"), "{}", failure.message);
    }
}

#[tokio::test]
async fn an_unknown_scheme_is_refused_naming_the_scheme() {
    let tmp = tempfile::tempdir().unwrap();
    let addr = start_server(tmp.path()).await;

    let reply = open(addr, "ftp://host/sample.zarr").await;
    let failure = reply.failure.expect("an unknown scheme must fail");
    assert_eq!(reply.url, "ftp://host/sample.zarr");
    assert_eq!(failure.stage, DatasetOpenStage::RequestReceived);
    assert_eq!(failure.kind, DatasetOpenFailureKind::UnsupportedScheme);
    assert!(failure.message.contains("ftp://"), "{}", failure.message);
}

#[tokio::test]
async fn a_file_url_opens_the_absolute_path_it_names() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("sample.zarr");
    write_minimal_zarr(&data);
    let addr = start_server(tmp.path()).await;

    let path = data.to_str().unwrap().replace('\\', "/");
    // A Unix path already starts with the slash that ends `file://`'s empty
    // authority; a drive-letter path needs one.
    let file_url = if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    };
    let reply = open(addr, &file_url).await;

    assert!(reply.failure.is_none(), "{:?}", reply.failure);
    let expected = DatasetLocation::parse(data.to_str().unwrap()).unwrap();
    assert_eq!(reply.url, expected.as_str());
}
