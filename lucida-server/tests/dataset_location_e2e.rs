//! What a dataset location becomes over a real workspace socket: a
//! location that does not parse is refused before any storage is touched,
//! echoing the input as given, a `file://` URL opens the path it names, and
//! a restricted source policy refuses what it does not allow with a typed
//! kind.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use futures_util::{SinkExt, StreamExt};
use lucida_content::url::DatasetLocation;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_protocol::{DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenStage};
use lucida_server::GeneratedConfig;
use lucida_server::auth::{
    AuthConfig, AuthMode, BearerToken, BearerTokenStore, DualCredentialExtractor,
    LoginSessionStore, MemoryBearerTokenStore, MemorySessionStore, PrincipalExtractor,
    hash_bearer_token,
};
use lucida_server::storage::{self, DatabaseUrl};
use lucida_server::workspace::WorkspaceManager;
use lucida_store::source_policy::{SourcePolicy, SourcePolicyConfig};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(20);
const RAW_TOKEN: &str = "lucida_pat_location_e2e";

fn owner() -> AuthPrincipal {
    AuthPrincipal {
        email: "owner@example.com".into(),
        display_name: "Owner".into(),
        picture_url: None,
        is_admin: false,
    }
}

/// A live server with one workspace its owner can open datasets in.
struct Rig {
    address: std::net::SocketAddr,
    workspace_id: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn start_server(root: &Path) -> Rig {
    start_server_with(root, SourcePolicy::unrestricted()).await
}

async fn start_server_with(root: &Path, source_policy: SourcePolicy) -> Rig {
    let storage = storage::open(&DatabaseUrl::in_memory()).await.unwrap();
    let workspace = storage
        .workspaces()
        .create_workspace(&owner(), Some("Locations"))
        .await
        .unwrap();
    let mut generated_config = GeneratedConfig::defaults();
    generated_config.generated_cache_dir = root.join("generated-coarse");
    generated_config.generated_enabled = false;
    let manager = Arc::new(
        WorkspaceManager::new(storage.workspaces(), generated_config)
            .with_source_policy(Arc::new(source_policy)),
    );
    let app: Router =
        lucida_server::workspace::router(manager).layer(axum::middleware::from_fn_with_state(
            bearer_extractor().await,
            lucida_server::auth::middleware::auth_middleware,
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Rig {
        address,
        workspace_id: workspace.id,
        server,
    }
}

/// The principal extractor the real server runs, holding one token for
/// the owner.
async fn bearer_extractor() -> Arc<dyn PrincipalExtractor> {
    let now = chrono::Utc::now();
    let tokens = Arc::new(MemoryBearerTokenStore::new());
    let principal = owner();
    tokens
        .create(BearerToken {
            id: "location-e2e".into(),
            token_hash: hash_bearer_token(RAW_TOKEN),
            name: "location e2e".into(),
            email: principal.email.clone(),
            display_name: principal.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        })
        .await
        .unwrap();
    let mut config = AuthConfig::for_tests();
    config.mode = AuthMode::Google;
    Arc::new(DualCredentialExtractor::new(
        Arc::new(config),
        Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
        tokens as Arc<dyn BearerTokenStore>,
    ))
}

/// The terminal reply to one open: its envelope URL, and the failure
/// diagnostic when it failed.
struct OpenReply {
    url: String,
    failure: Option<DatasetOpenFailureDiagnostic>,
}

async fn open(rig: &Rig, url: &str) -> OpenReply {
    let mut request = format!(
        "ws://{}/ws/workspaces/{}",
        rig.address,
        urlencoding::encode(&rig.workspace_id)
    )
    .into_client_request()
    .unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {RAW_TOKEN}").parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
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
    let rig = start_server(tmp.path()).await;

    for input in ["./sample.zarr", "data/sample.zarr"] {
        let reply = open(&rig, input).await;
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
    let rig = start_server(tmp.path()).await;

    let reply = open(&rig, "ftp://host/sample.zarr").await;
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
    let rig = start_server(tmp.path()).await;

    let path = data.to_str().unwrap().replace('\\', "/");
    // A Unix path already starts with the slash that ends `file://`'s empty
    // authority; a drive-letter path needs one.
    let file_url = if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    };
    let reply = open(&rig, &file_url).await;

    assert!(reply.failure.is_none(), "{:?}", reply.failure);
    let expected = DatasetLocation::parse(data.to_str().unwrap()).unwrap();
    assert_eq!(reply.url, expected.as_str());
}

fn restricted(data_roots: Vec<std::path::PathBuf>) -> SourcePolicy {
    SourcePolicy::new(SourcePolicyConfig {
        restricted: true,
        data_roots,
        ..Default::default()
    })
    .unwrap()
}

#[tokio::test]
async fn a_restricted_server_opens_local_paths_only_under_its_data_directories() {
    let tmp = tempfile::tempdir().unwrap();
    let inside = tmp.path().join("data").join("sample.zarr");
    let outside = tmp.path().join("other").join("sample.zarr");
    write_minimal_zarr(&inside);
    write_minimal_zarr(&outside);
    let rig = start_server_with(tmp.path(), restricted(vec![tmp.path().join("data")])).await;

    let opened = open(&rig, inside.to_str().unwrap()).await;
    assert!(opened.failure.is_none(), "{:?}", opened.failure);

    let refused = open(&rig, outside.to_str().unwrap()).await;
    let failure = refused
        .failure
        .expect("a path outside the data roots must fail");
    assert_eq!(failure.stage, DatasetOpenStage::BackendOpen);
    assert_eq!(failure.kind, DatasetOpenFailureKind::SourceNotAllowed);
    assert!(!failure.retryable);
    assert!(
        failure.message.contains("data directories"),
        "{}",
        failure.message
    );
}

#[tokio::test]
async fn a_restricted_server_refuses_http_to_a_non_public_address() {
    let tmp = tempfile::tempdir().unwrap();
    let rig = start_server_with(tmp.path(), restricted(vec![])).await;

    for url in [
        "http://127.0.0.1:9/sample.zarr",
        "http://169.254.169.254/sample.zarr",
    ] {
        let failure = open(&rig, url).await.failure.expect("must fail");
        assert_eq!(
            failure.kind,
            DatasetOpenFailureKind::SourceNotAllowed,
            "{url}"
        );
        assert_eq!(failure.stage, DatasetOpenStage::BackendOpen);
    }
}
