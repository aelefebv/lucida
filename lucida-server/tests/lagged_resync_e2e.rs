//! Broadcast-loss recovery e2e over real WebSockets.
//!
//! The per-client outbound loop forwards a bounded `tokio::sync::broadcast`
//! stream to the socket. A client that reads too slowly makes its receiver
//! overflow (`RecvError::Lagged`), silently skipping sequenced
//! `CommandBroadcast`s — a divergent document unless repaired. Two repair
//! paths are covered here, both against the REAL `handle_client` stack (an
//! axum server on an ephemeral port, tokio-tungstenite clients):
//!
//! - **Server push on lag**: one client floods large document commands while
//!   another stops reading; when the stalled client resumes, its outbound
//!   loop hits `Lagged` and pushes a fresh `Snapshot` taken under the
//!   session lock after the receiver was repositioned past the loss. The
//!   slow client, following the seq discipline (apply `last+1`, drop stale,
//!   adopt snapshots), converges to the exact server document.
//! - **Client request**: `ClientMessage::RequestSnapshot` is answered with
//!   the same fresh snapshot on the requester's connection — throttled to
//!   one served snapshot per interval per client.
//!
//! The tiny broadcast capacity (8) plus ~64 KiB command payloads make the
//! overflow deterministic: the stalled client's socket backpressure blocks
//! its outbound task after a bounded number of frames while ~600 items
//! pass through the ring.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::{State, ws::WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use lucida_content::{DatasetId, DatasetKind, DatasetManifest};
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_core::scene::DocumentState;
use lucida_protocol::{AssetCatalog, DatasetOpened, FetchSource, ProxiedFetchDescriptor};
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes, handler};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

struct Rig {
    addr: SocketAddr,
    session: Arc<Mutex<Session>>,
    _tmp: tempfile::TempDir,
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

/// Serve the real `/ws` handler on an ephemeral port with a broadcast
/// channel of `broadcast_capacity` items.
async fn start_server(broadcast_capacity: usize) -> Rig {
    let tmp = tempfile::tempdir().expect("tempdir");
    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _) = broadcast::channel::<BroadcastItem>(broadcast_capacity);
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));
    let mut proxy_config = ProxyConfig::defaults();
    proxy_config.cache_dir = tmp.path().join("proxies");
    proxy_config.generated_cache_dir = tmp.path().join("generated-coarse");
    let state = AppState {
        session: Arc::clone(&session),
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
    Rig {
        addr,
        session,
        _tmp: tmp,
    }
}

async fn connect(addr: SocketAddr) -> WsClient {
    // A resync snapshot over a large flooded document exceeds
    // tungstenite's 16 MiB default cap; browsers impose no such limit, so
    // raise it for the test client rather than shrinking the flood below
    // what defeats loopback socket buffering.
    let config = WebSocketConfig::default()
        .max_message_size(Some(256 * 1024 * 1024))
        .max_frame_size(Some(64 * 1024 * 1024));
    let (ws, _) = connect_async_with_config(format!("ws://{addr}/ws"), Some(config), false)
        .await
        .expect("ws connect");
    ws
}

/// Read text frames until one parses as a `ServerMessage`, skipping binary.
async fn next_server_message(ws: &mut WsClient) -> ServerMessage {
    loop {
        let msg = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a server message")
            .expect("stream ended")
            .expect("ws read");
        if let WsMessage::Text(text) = msg {
            match serde_json::from_str::<ServerMessage>(text.as_str()) {
                Ok(parsed) => return parsed,
                Err(e) => panic!("unparseable server message: {e}: {text}"),
            }
        }
    }
}

/// Like [`next_server_message`], but returns `None` if no parseable message
/// arrives within `window` — for asserting silence.
async fn try_next_server_message(ws: &mut WsClient, window: Duration) -> Option<ServerMessage> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let msg = match timeout(remaining, ws.next()).await {
            Err(_) => return None,
            Ok(next) => next.expect("stream ended").expect("ws read"),
        };
        if let WsMessage::Text(text) = msg {
            return Some(
                serde_json::from_str::<ServerMessage>(text.as_str())
                    .unwrap_or_else(|e| panic!("unparseable server message: {e}: {text}")),
            );
        }
    }
}

/// A dataset-open document command with a `name` payload of `name_bytes`
/// so a flood of them overwhelms socket buffering quickly.
fn dataset_opened_command(idx: usize, name_bytes: usize) -> DocumentCommand {
    let manifest = DatasetManifest::new(
        DatasetId(format!("ds-{idx:04}")),
        "n".repeat(name_bytes),
        DatasetKind::Single,
        vec![],
        vec![],
        vec![],
        vec![],
        None,
    );
    DocumentCommand::DatasetOpened(DatasetOpened {
        manifest,
        fetch: FetchSource::Proxied(ProxiedFetchDescriptor { images: vec![] }),
        catalog: AssetCatalog::default(),
        opener_client_id: None,
    })
}

async fn send_client_message(ws: &mut WsClient, msg: &ClientMessage) {
    let json = serde_json::to_string(msg).expect("serialize client message");
    ws.send(WsMessage::Text(json.into())).await.expect("send");
}

/// The client-side seq discipline, mirrored for the test consumer: apply
/// contiguous broadcasts, drop stale ones, hold gapped ones until a
/// snapshot re-baselines, then drain in order.
struct SequencedConsumer {
    doc: DocumentState,
    last: u64,
    buffered: BTreeMap<u64, DocumentCommand>,
    saw_gap: bool,
    snapshots_applied: usize,
}

impl SequencedConsumer {
    fn from_join_snapshot(msg: ServerMessage) -> Self {
        let ServerMessage::Snapshot { seq, document, .. } = msg else {
            panic!("first message must be the join snapshot");
        };
        Self {
            doc: document,
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
                self.doc.apply(command);
                self.last = seq;
            } else {
                break;
            }
        }
    }

    fn observe(&mut self, msg: ServerMessage) {
        match msg {
            ServerMessage::Snapshot { seq, document, .. } => {
                // A mid-session snapshot that jumps past `last + 1` is the
                // visible face of server-side loss: the skipped seqs were
                // never (and will never be) delivered as broadcasts — the
                // snapshot repairs them wholesale. (The retained tail that
                // follows carries seqs <= the snapshot's and is dropped as
                // stale below, so the gap may ONLY ever be observable here.)
                if seq > self.last + 1 {
                    self.saw_gap = true;
                }
                self.doc = document;
                self.last = seq;
                self.snapshots_applied += 1;
                self.drain_buffered();
            }
            ServerMessage::CommandBroadcast { seq, command } => {
                if seq == self.last + 1 {
                    self.doc.apply(command);
                    self.last = seq;
                    self.drain_buffered();
                } else if seq > self.last + 1 {
                    self.saw_gap = true;
                    self.buffered.insert(seq, command);
                }
                // seq <= last: stale (already covered by a snapshot) — drop.
            }
            _ => {}
        }
    }
}

/// A stalled reader whose broadcast receiver overflows mid-flood receives a
/// server-pushed fresh snapshot and converges to the flooding client's
/// document.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lagged_client_receives_snapshot_and_converges() {
    // Sized to overwhelm loopback socket buffering (which can absorb
    // several MB per direction with kernel auto-tuning): ~38 MiB of frames
    // guarantees the stalled client's outbound task blocks on backpressure
    // while the capacity-8 ring is lapped.
    const FLOOD: usize = 600;
    const NAME_BYTES: usize = 64 * 1024;

    let rig = start_server(8).await;

    let mut flooder = connect(rig.addr).await;
    let ServerMessage::Snapshot { .. } = next_server_message(&mut flooder).await else {
        panic!("flooder join snapshot");
    };

    let mut slow = connect(rig.addr).await;
    let mut consumer = SequencedConsumer::from_join_snapshot(next_server_message(&mut slow).await);

    // Flood while the slow client does NOT read: its outbound task blocks on
    // socket backpressure after a bounded number of ~64 KiB frames while the
    // ring (capacity 8) is lapped many times over.
    for idx in 0..FLOOD {
        send_client_message(
            &mut flooder,
            &ClientMessage::Command {
                command: dataset_opened_command(idx, NAME_BYTES),
            },
        )
        .await;
    }

    // Wait until the server has applied the whole flood.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let seq = rig.session.lock().await.seq;
        if seq == FLOOD as u64 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "server never applied the full flood (seq = {seq})"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Now the slow client starts reading: buffered head of the stream, then
    // the Lagged-triggered snapshot, then whatever retained tail follows.
    while consumer.last < FLOOD as u64 {
        let msg = next_server_message(&mut slow).await;
        consumer.observe(msg);
    }

    assert!(
        consumer.saw_gap,
        "the flood never produced a seq gap — the lag scenario did not trigger \
         (increase FLOOD/NAME_BYTES or shrink the broadcast capacity)"
    );
    assert!(
        consumer.snapshots_applied >= 1,
        "the server never pushed a snapshot after Lagged"
    );

    // Convergence: byte-equal document state with the server (which is what
    // the flooding client's acked view mirrors).
    let server_doc = rig.session.lock().await.document.clone();
    assert_eq!(
        serde_json::to_value(&consumer.doc).unwrap(),
        serde_json::to_value(&server_doc).unwrap(),
        "slow client's document must converge to the server document"
    );
    assert_eq!(consumer.last, rig.session.lock().await.seq);
    assert_eq!(consumer.doc.manifests.len(), FLOOD);
}

/// `request_snapshot` is answered with a fresh snapshot carrying the current
/// seq and full document.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_snapshot_returns_fresh_snapshot() {
    let rig = start_server(256).await;

    let mut client = connect(rig.addr).await;
    let ServerMessage::Snapshot { seq, .. } = next_server_message(&mut client).await else {
        panic!("join snapshot");
    };
    assert_eq!(seq, 0);

    // Apply a few commands (acked back to us as the sender).
    for idx in 0..3 {
        send_client_message(
            &mut client,
            &ClientMessage::Command {
                command: dataset_opened_command(idx, 8),
            },
        )
        .await;
    }
    for _ in 0..3 {
        let ServerMessage::Ack { .. } = next_server_message(&mut client).await else {
            panic!("expected ack");
        };
    }

    // The exact wire envelope the web client emits on a detected gap.
    client
        .send(WsMessage::Text(r#"{"type":"request_snapshot"}"#.into()))
        .await
        .expect("send request_snapshot");

    let ServerMessage::Snapshot {
        seq,
        document,
        your_id,
        ..
    } = next_server_message(&mut client).await
    else {
        panic!("expected snapshot in response to request_snapshot");
    };
    assert_eq!(seq, 3);
    assert_eq!(your_id, 0);
    let server_doc = rig.session.lock().await.document.clone();
    assert_eq!(
        serde_json::to_value(&document).unwrap(),
        serde_json::to_value(&server_doc).unwrap(),
    );
    assert_eq!(document.manifests.len(), 3);
}

/// Rapid-fire `request_snapshot`s are throttled per client: within the
/// minimum interval only the first is served; after the interval elapses a
/// new request is served again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_snapshot_is_throttled_per_client() {
    let rig = start_server(256).await;

    let mut client = connect(rig.addr).await;
    let ServerMessage::Snapshot { .. } = next_server_message(&mut client).await else {
        panic!("join snapshot");
    };

    let request = || WsMessage::Text(r#"{"type":"request_snapshot"}"#.into());

    // Two back-to-back requests: the inbound loop is sequential per client,
    // so the second is deterministically inside the throttle window.
    client.send(request()).await.expect("send request 1");
    client.send(request()).await.expect("send request 2");

    let ServerMessage::Snapshot { .. } = next_server_message(&mut client).await else {
        panic!("first request must be served");
    };
    assert!(
        try_next_server_message(&mut client, Duration::from_millis(400))
            .await
            .is_none(),
        "second request inside the throttle window must be ignored"
    );

    // Past the interval, requests are served again.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    client.send(request()).await.expect("send request 3");
    let ServerMessage::Snapshot { seq, .. } = next_server_message(&mut client).await else {
        panic!("request after the throttle window must be served");
    };
    assert_eq!(seq, 0);
}
