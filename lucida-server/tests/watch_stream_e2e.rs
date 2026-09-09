//! The watch stream, end to end: one socket publishes, another subscribes,
//! and what came out the far end is the relay's whole contract (ADR 0051 as
//! amended).
//!
//! The relay's unit tests drive `WatchRelay` directly. What they cannot see
//! is the part that only exists on the live path: the inbound loop routing
//! `watch_subscribe` and `watch_publish`, the per-connection channel the ring
//! is replayed into, and the ordering between the two — a late joiner must
//! read the recent past before the live items, and neither twice. So this
//! drives real sockets against a real handler and asserts on the frames.

use std::collections::{BTreeMap, HashMap};
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
use tokio::sync::{Mutex, broadcast};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use lucida_core::protocol::{
    ClientId, ClientMessage, ServerMessage, WatchBoundaryEvent, WatchItem,
};
use lucida_server::session::Session;
use lucida_server::watch::WATCH_RING_CAPACITY;
use lucida_server::{AppState, ProxyConfig, handler};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Serve the session socket on an ephemeral port and answer with its address.
async fn serve() -> SocketAddr {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("watch-stream-e2e");
    let (tx, _) = broadcast::channel(64);
    let state = AppState {
        session: Arc::new(Mutex::new(Session::new())),
        tx,
        next_id: Arc::new(AtomicU64::new(0)),
        unicast_routes: Arc::new(Mutex::new(HashMap::new())),
        data_dir: None,
        proxy_config: proxy_config(&root),
    };
    let app = Router::new().route("/ws", get(ws_route)).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

/// Connect and consume the snapshot handshake the server always sends first.
async fn join(addr: SocketAddr) -> WsClient {
    let (mut ws, _) = connect_async(format!("ws://{addr}/ws"))
        .await
        .expect("ws connect");
    let first = next_server_message(&mut ws).await;
    assert!(
        matches!(first, ServerMessage::Snapshot { .. }),
        "the first frame is the snapshot handshake, got {first:?}"
    );
    ws
}

async fn send(ws: &mut WsClient, message: &ClientMessage) {
    let json = serde_json::to_string(message).unwrap();
    ws.send(WsMessage::Text(json.into()))
        .await
        .expect("send a client message");
}

async fn next_server_message(ws: &mut WsClient) -> ServerMessage {
    loop {
        let frame = timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("a frame arrives before the read timeout")
            .expect("the socket stays open")
            .expect("the frame reads");
        match frame {
            WsMessage::Text(text) => {
                return serde_json::from_str(&text).expect("a known server message");
            }
            WsMessage::Close(_) => panic!("the socket closed"),
            _ => continue,
        }
    }
}

/// The next relayed item, with the publisher and the sequence it arrived
/// under.
async fn next_watch_update(ws: &mut WsClient) -> (ClientId, u64, WatchItem) {
    loop {
        match next_server_message(ws).await {
            ServerMessage::WatchUpdate {
                client_id,
                seq,
                item,
            } => return (client_id, seq, item),
            // Peer joins and leaves share this socket; they are not the
            // stream.
            _ => continue,
        }
    }
}

fn aggregate(at_epoch_ms: u64) -> ClientMessage {
    ClientMessage::WatchPublish {
        item: WatchItem::Aggregate {
            at_epoch_ms,
            run_id: Some("run-1".into()),
            reading: None,
            counted: BTreeMap::new(),
            sent: BTreeMap::new(),
            ticks: Vec::new(),
        },
    }
}

fn epoch_of(item: &WatchItem) -> u64 {
    match item {
        WatchItem::Aggregate { at_epoch_ms, .. }
        | WatchItem::Boundary { at_epoch_ms, .. }
        | WatchItem::Provisional { at_epoch_ms, .. } => *at_epoch_ms,
    }
}

#[tokio::test]
async fn a_subscriber_reads_what_a_publishing_page_sends() {
    let addr = serve().await;
    let mut subscriber = join(addr).await;
    send(&mut subscriber, &ClientMessage::WatchSubscribe).await;
    let mut page = join(addr).await;

    send(&mut page, &aggregate(1)).await;
    send(
        &mut page,
        &ClientMessage::WatchPublish {
            item: WatchItem::Boundary {
                at_epoch_ms: 2,
                event: WatchBoundaryEvent::RunClosed,
                run_id: Some("run-1".into()),
                cause: None,
                end_reason: Some("quiescent".into()),
                duration_us: Some(4_700_000),
            },
        },
    )
    .await;

    let (publisher, seq, item) = next_watch_update(&mut subscriber).await;
    assert_eq!(seq, 1);
    assert!(matches!(item, WatchItem::Aggregate { .. }), "{item:?}");

    let (also_publisher, seq, item) = next_watch_update(&mut subscriber).await;
    assert_eq!(seq, 2);
    assert_eq!(also_publisher, publisher, "both items are the same page's");
    let WatchItem::Boundary {
        event, end_reason, ..
    } = item
    else {
        panic!("expected a boundary, got {item:?}");
    };
    assert_eq!(event, WatchBoundaryEvent::RunClosed);
    assert_eq!(end_reason.as_deref(), Some("quiescent"));
}

#[tokio::test]
async fn a_late_subscriber_reads_the_ring_and_then_the_live_items() {
    let addr = serve().await;
    let mut page = join(addr).await;

    for at in 1..=3 {
        send(&mut page, &aggregate(at)).await;
    }
    // The publishes are relayed on the page's inbound loop; give it the
    // chance to drain them before anyone subscribes, so this test is about
    // the ring rather than about a race with it.
    let mut early = join(addr).await;
    send(&mut early, &ClientMessage::WatchSubscribe).await;
    for expected in 1..=3 {
        assert_eq!(epoch_of(&next_watch_update(&mut early).await.2), expected);
    }

    let mut late = join(addr).await;
    send(&mut late, &ClientMessage::WatchSubscribe).await;
    send(&mut page, &aggregate(4)).await;

    let mut seen = Vec::new();
    for _ in 0..4 {
        let (_, seq, item) = next_watch_update(&mut late).await;
        seen.push((seq, epoch_of(&item)));
    }
    assert_eq!(seen, vec![(1, 1), (2, 2), (3, 3), (4, 4)]);
}

#[tokio::test]
async fn a_wrapped_ring_replays_its_tail_and_says_where_it_starts() {
    let addr = serve().await;
    let mut page = join(addr).await;

    let published = WATCH_RING_CAPACITY as u64 + 3;
    for at in 1..=published {
        send(&mut page, &aggregate(at)).await;
    }
    // Wait for the last publish to be relayed before subscribing, so the ring
    // is known to hold the whole run of them.
    let mut early = join(addr).await;
    send(&mut early, &ClientMessage::WatchSubscribe).await;
    send(&mut page, &aggregate(published + 1)).await;
    loop {
        let (_, _, item) = next_watch_update(&mut early).await;
        if epoch_of(&item) == published + 1 {
            break;
        }
    }

    let mut late = join(addr).await;
    send(&mut late, &ClientMessage::WatchSubscribe).await;
    let (_, seq, item) = next_watch_update(&mut late).await;
    assert_eq!(seq, published + 1 - WATCH_RING_CAPACITY as u64 + 1);
    assert_eq!(epoch_of(&item), seq);
}

/// The stream is opt-in on the reading side as well as on the publishing one.
#[tokio::test]
async fn a_connection_that_never_subscribed_receives_nothing() {
    let addr = serve().await;
    let mut bystander = join(addr).await;
    let mut subscriber = join(addr).await;
    send(&mut subscriber, &ClientMessage::WatchSubscribe).await;
    let mut page = join(addr).await;

    send(&mut page, &aggregate(1)).await;
    assert_eq!(epoch_of(&next_watch_update(&mut subscriber).await.2), 1);

    // By now the item has been relayed. Anything the bystander has is a peer
    // notification, never a watch update.
    while let Ok(Some(Ok(frame))) = timeout(Duration::from_millis(200), bystander.next()).await {
        if let WsMessage::Text(text) = frame {
            let message: ServerMessage = serde_json::from_str(&text).unwrap();
            assert!(
                !matches!(message, ServerMessage::WatchUpdate { .. }),
                "an unsubscribed connection received a watch update"
            );
        }
    }
}
