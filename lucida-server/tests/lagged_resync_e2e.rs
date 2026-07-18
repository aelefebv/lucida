//! Broadcast-loss recovery over the real workspace WebSocket route.
//!
//! The rig deliberately uses the production `WorkspaceManager`, durable
//! SQLite store, authorization boundary, and `/ws/workspaces/:id` handler.
//! Large ephemeral dataset-presence frames create socket backpressure without
//! inflating the durable document; interleaved annotation commands prove a
//! lagged reader is repaired by an authoritative snapshot.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Request;
use axum::middleware::from_fn;
use futures_util::{SinkExt, StreamExt};
use lucida_content::{DatasetId, DatasetKind, DatasetManifest};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_core::scene::{AnnotationKind, DocumentState};
use lucida_protocol::{DatasetOpened, FetchSource, ProxiedFetchDescriptor};
use lucida_server::DatasetRuntimeConfig;
use lucida_server::session::Session;
use lucida_server::workspace::{SqliteWorkspaceStore, WorkspaceManager, WorkspaceStore};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const DATASET_ID: &str = "wds-resync";

struct Rig {
    addr: SocketAddr,
    workspace_id: String,
    session: Arc<Mutex<Session>>,
    _tmp: tempfile::TempDir,
}

fn principal() -> AuthPrincipal {
    AuthPrincipal {
        email: "resync@example.test".into(),
        display_name: "Resync Test".into(),
        picture_url: None,
        is_admin: false,
        auth_epoch: 0,
    }
}

fn seed_document() -> DocumentState {
    let mut document = DocumentState::default();
    document.apply(DocumentCommand::DatasetOpened(DatasetOpened {
        manifest: DatasetManifest::new(
            DatasetId(DATASET_ID.into()),
            "Resync dataset".into(),
            DatasetKind::Single,
            vec![],
            vec![],
            vec![],
            vec![],
            None,
        ),
        fetch: FetchSource::Proxied(ProxiedFetchDescriptor { images: vec![] }),
        opener_client_id: None,
    }));
    document
}

async fn start_server() -> Rig {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .create_if_missing(true),
        )
        .await
        .expect("sqlite");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let sqlite = Arc::new(SqliteWorkspaceStore::new(pool));
    let actor = principal();
    let workspace = sqlite
        .create_workspace(&actor, Some("Resync workspace"))
        .await
        .expect("workspace");
    sqlite
        .persist_document(&workspace.id, 1, &seed_document())
        .await
        .expect("seed document");

    let mut runtime = DatasetRuntimeConfig::defaults();
    runtime.generated_cache_dir = tmp.path().join("generated-coarse");
    let store: Arc<dyn WorkspaceStore> = sqlite;
    let manager = Arc::new(WorkspaceManager::new(store, runtime));
    let live = manager
        .live_workspace(&workspace.id, &actor)
        .await
        .expect("live workspace");
    let session = Arc::clone(&live.session);

    let injected = Arc::new(actor);
    let app = lucida_server::workspace::router(manager).layer(from_fn(
        move |mut request: Request<Body>, next: axum::middleware::Next| {
            let actor = Arc::clone(&injected);
            async move {
                request.extensions_mut().insert((*actor).clone());
                next.run(request).await
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    Rig {
        addr,
        workspace_id: workspace.id,
        session,
        _tmp: tmp,
    }
}

async fn connect(rig: &Rig) -> WsClient {
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024 * 1024))
        .max_frame_size(Some(64 * 1024 * 1024));
    let url = format!("ws://{}/ws/workspaces/{}", rig.addr, rig.workspace_id);
    let (ws, _) = connect_async_with_config(url, Some(config), false)
        .await
        .expect("workspace websocket");
    ws
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
                .unwrap_or_else(|error| panic!("unparseable server message: {error}: {text}"));
        }
    }
}

async fn try_next_server_message(ws: &mut WsClient, window: Duration) -> Option<ServerMessage> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let message = match timeout(remaining, ws.next()).await {
            Err(_) => return None,
            Ok(next) => next.expect("stream ended").expect("ws read"),
        };
        if let WsMessage::Text(text) = message {
            return Some(serde_json::from_str(text.as_str()).expect("server message"));
        }
    }
}

async fn send_client_message(ws: &mut WsClient, message: &ClientMessage) {
    let json = serde_json::to_string(message).expect("serialize client message");
    ws.send(WsMessage::Text(json.into())).await.expect("send");
}

#[tokio::test]
async fn legacy_global_websocket_route_is_absent() {
    let rig = start_server().await;
    let error = tokio_tungstenite::connect_async(format!("ws://{}/ws", rig.addr))
        .await
        .expect_err("the retired global websocket route must not upgrade");
    let WsError::Http(response) = error else {
        panic!("expected an HTTP route rejection, got {error}");
    };
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
}

fn annotation_command(index: usize) -> DocumentCommand {
    DocumentCommand::AddAnnotation {
        dataset_id: DatasetId(DATASET_ID.into()),
        id: format!("pin-{index:04}"),
        position: [index as f64, index as f64],
        end: None,
        z: 0.0,
        t: 0,
        c: 0,
        author: String::new(),
        kind: AnnotationKind::Point,
        view: None,
    }
}

fn large_presence() -> ClientMessage {
    let dataset_order = (0..54)
        .map(|index| DatasetId(format!("presence-{index:02}-{}", "x".repeat(900))))
        .collect();
    ClientMessage::DatasetPresence {
        dataset_order,
        dataset_settings: HashMap::new(),
    }
}

struct SequencedConsumer {
    document: DocumentState,
    last: u64,
    buffered: BTreeMap<u64, DocumentCommand>,
    saw_gap: bool,
    snapshots_applied: usize,
}

impl SequencedConsumer {
    fn from_join_snapshot(message: ServerMessage) -> Self {
        let ServerMessage::Snapshot { seq, document, .. } = message else {
            panic!("first message must be the join snapshot");
        };
        Self {
            document,
            last: seq,
            buffered: BTreeMap::new(),
            saw_gap: false,
            snapshots_applied: 0,
        }
    }

    fn drain_buffered(&mut self) {
        while let Some((&seq, _)) = self.buffered.first_key_value() {
            if seq <= self.last {
                self.buffered.pop_first();
            } else if seq == self.last + 1 {
                let (_, command) = self.buffered.pop_first().expect("entry");
                self.document.apply(command);
                self.last = seq;
            } else {
                break;
            }
        }
    }

    fn observe(&mut self, message: ServerMessage) {
        match message {
            ServerMessage::Snapshot { seq, document, .. } => {
                if seq > self.last + 1 {
                    self.saw_gap = true;
                }
                self.document = document;
                self.last = seq;
                self.snapshots_applied += 1;
                self.drain_buffered();
            }
            ServerMessage::CommandBroadcast { seq, command } if seq == self.last + 1 => {
                self.document.apply(command);
                self.last = seq;
                self.drain_buffered();
            }
            ServerMessage::CommandBroadcast { seq, command } if seq > self.last + 1 => {
                self.saw_gap = true;
                self.buffered.insert(seq, command);
            }
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lagged_workspace_client_receives_snapshot_and_converges() {
    const PRESENCE_FRAMES: usize = 800;
    const COMMANDS: usize = 200;

    let rig = start_server().await;
    let mut flooder = connect(&rig).await;
    let ServerMessage::Snapshot { seq: 1, .. } = next_server_message(&mut flooder).await else {
        panic!("flooder join snapshot");
    };
    let mut slow = connect(&rig).await;
    let mut consumer = SequencedConsumer::from_join_snapshot(next_server_message(&mut slow).await);
    let presence = large_presence();

    for frame in 0..PRESENCE_FRAMES {
        send_client_message(&mut flooder, &presence).await;
        if frame % (PRESENCE_FRAMES / COMMANDS) == 0 {
            let command_index = frame / (PRESENCE_FRAMES / COMMANDS);
            send_client_message(
                &mut flooder,
                &ClientMessage::Command {
                    request_id: format!("flood-{command_index}"),
                    command: annotation_command(command_index),
                },
            )
            .await;
        }
    }

    let target_seq = 1 + COMMANDS as u64;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let seq = rig.session.lock().await.seq;
        if seq == target_seq {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "server never applied the full flood (seq = {seq})"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    while consumer.last < target_seq {
        consumer.observe(next_server_message(&mut slow).await);
    }
    assert!(consumer.saw_gap, "the flood never produced a sequence gap");
    assert!(
        consumer.snapshots_applied >= 1,
        "lag did not trigger a snapshot"
    );

    let server_document = rig.session.lock().await.document.clone();
    assert_eq!(
        serde_json::to_value(&consumer.document).unwrap(),
        serde_json::to_value(&server_document).unwrap(),
    );
    assert_eq!(consumer.last, target_seq);
    assert_eq!(
        consumer.document.annotations[&DatasetId(DATASET_ID.into())].len(),
        COMMANDS
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_snapshot_returns_fresh_workspace_snapshot() {
    let rig = start_server().await;
    let mut client = connect(&rig).await;
    let ServerMessage::Snapshot { seq: 1, .. } = next_server_message(&mut client).await else {
        panic!("join snapshot");
    };

    for index in 0..3 {
        send_client_message(
            &mut client,
            &ClientMessage::Command {
                request_id: format!("command-{index}"),
                command: annotation_command(index),
            },
        )
        .await;
    }
    for _ in 0..3 {
        let ServerMessage::Ack { .. } = next_server_message(&mut client).await else {
            panic!("expected ack");
        };
    }

    send_client_message(&mut client, &ClientMessage::RequestSnapshot).await;
    let ServerMessage::Snapshot {
        seq,
        document,
        your_id,
        ..
    } = next_server_message(&mut client).await
    else {
        panic!("expected requested snapshot");
    };
    assert_eq!(seq, 4);
    assert_eq!(your_id, 0);
    assert_eq!(
        serde_json::to_value(&document).unwrap(),
        serde_json::to_value(&rig.session.lock().await.document).unwrap(),
    );
    assert_eq!(document.annotations[&DatasetId(DATASET_ID.into())].len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_snapshot_is_throttled_per_workspace_client() {
    let rig = start_server().await;
    let mut client = connect(&rig).await;
    let ServerMessage::Snapshot { .. } = next_server_message(&mut client).await else {
        panic!("join snapshot");
    };

    send_client_message(&mut client, &ClientMessage::RequestSnapshot).await;
    send_client_message(&mut client, &ClientMessage::RequestSnapshot).await;
    let ServerMessage::Snapshot { .. } = next_server_message(&mut client).await else {
        panic!("first request must be served");
    };
    assert!(
        try_next_server_message(&mut client, Duration::from_millis(400))
            .await
            .is_none(),
        "second request inside the throttle window must be ignored"
    );

    tokio::time::sleep(Duration::from_millis(1100)).await;
    send_client_message(&mut client, &ClientMessage::RequestSnapshot).await;
    let ServerMessage::Snapshot { seq, .. } = next_server_message(&mut client).await else {
        panic!("request after the throttle window must be served");
    };
    assert_eq!(seq, 1);
}
