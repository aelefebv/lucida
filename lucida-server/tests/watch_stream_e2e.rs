//! The watch stream, end to end: one socket publishes, another subscribes,
//! and what comes out the far end is the relay's contract.
//!
//! Only the live path routes `watch_subscribe` and `watch_publish` and
//! replays the ring into the per-connection channel, so this drives real
//! sockets and asserts that a subscriber reads live items only unless it asks
//! for history, and that history arrives ahead of a marker and the live items,
//! with nothing twice.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use common::workspace_rig::WorkspaceRig;
use lucida_core::protocol::{
    ClientId, ClientMessage, ServerMessage, WatchBoundaryEvent, WatchItem,
};
use lucida_server::ProxyConfig;
use lucida_server::watch::WATCH_RING_CAPACITY;

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Serve a workspace socket on an ephemeral port.
async fn serve() -> WorkspaceRig {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("watch-stream-e2e");
    WorkspaceRig::start(proxy_config(&root)).await
}

/// Connect and consume the snapshot handshake the server always sends first.
async fn join(rig: &WorkspaceRig) -> WsClient {
    let (mut ws, _) = connect_async(rig.ws_url()).await.expect("ws connect");
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

/// The next frame of the watch stream: a relayed item or the history marker.
async fn next_watch_frame(ws: &mut WsClient) -> ServerMessage {
    loop {
        match next_server_message(ws).await {
            message @ (ServerMessage::WatchUpdate { .. }
            | ServerMessage::WatchHistoryEnd { .. }) => return message,
            // Peer joins and leaves share this socket; they are not the
            // stream.
            _ => continue,
        }
    }
}

/// The next relayed item, with the publisher and the sequence it arrived
/// under. Skips a history marker.
async fn next_watch_update(ws: &mut WsClient) -> (ClientId, u64, WatchItem) {
    loop {
        if let ServerMessage::WatchUpdate {
            client_id,
            seq,
            item,
        } = next_watch_frame(ws).await
        {
            return (client_id, seq, item);
        }
    }
}

/// Subscribe live, and return once the server has registered it.
///
/// A live subscribe has no reply, but a socket's messages are handled in
/// order, so the snapshot answering a request sent behind it says the
/// subscription is in place. Without it, a publish on another socket can
/// beat the subscribe and never reach this one.
async fn subscribe_live(ws: &mut WsClient) {
    send(ws, &ClientMessage::WatchSubscribe { history: false }).await;
    send(ws, &ClientMessage::RequestSnapshot).await;
    while !matches!(
        next_server_message(ws).await,
        ServerMessage::Snapshot { .. }
    ) {}
}

/// Publish on `page` and read every item back off its own stream, so the
/// items are known to be in the ring before anyone else subscribes.
async fn publish_and_settle(page: &mut WsClient, epochs: std::ops::RangeInclusive<u64>) {
    subscribe_live(page).await;
    let last = *epochs.end();
    for at in epochs {
        send(page, &aggregate(at)).await;
    }
    while epoch_of(&next_watch_update(page).await.2) != last {}
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
    let rig = serve().await;
    let mut subscriber = join(&rig).await;
    subscribe_live(&mut subscriber).await;
    let mut page = join(&rig).await;

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
async fn a_late_subscriber_reads_only_what_is_published_after_it_joined() {
    let rig = serve().await;
    let mut page = join(&rig).await;
    publish_and_settle(&mut page, 1..=3).await;

    let mut late = join(&rig).await;
    send(&mut late, &ClientMessage::WatchSubscribe { history: false }).await;
    // Published from the subscribing socket, so it lands after the subscribe.
    // A replay would arrive ahead of it.
    send(&mut late, &aggregate(100)).await;

    let (_, seq, item) = next_watch_update(&mut late).await;
    assert_eq!((seq, epoch_of(&item)), (4, 100));
}

#[tokio::test]
async fn history_is_the_ring_then_a_marker_then_the_live_items() {
    let rig = serve().await;
    let mut page = join(&rig).await;
    publish_and_settle(&mut page, 1..=3).await;

    let mut late = join(&rig).await;
    send(&mut late, &ClientMessage::WatchSubscribe { history: true }).await;
    send(&mut late, &aggregate(100)).await;

    let mut seen = Vec::new();
    for _ in 0..5 {
        seen.push(match next_watch_frame(&mut late).await {
            ServerMessage::WatchUpdate { seq, item, .. } => format!("{seq}:{}", epoch_of(&item)),
            ServerMessage::WatchHistoryEnd {
                through_seq,
                replayed,
            } => format!("end through {through_seq}, {replayed} replayed"),
            other => unreachable!("{other:?}"),
        });
    }
    assert_eq!(
        seen,
        ["1:1", "2:2", "3:3", "end through 3, 3 replayed", "4:100"]
    );
}

#[tokio::test]
async fn a_wrapped_ring_replays_its_tail_and_the_marker_shows_the_gap() {
    let rig = serve().await;
    let mut page = join(&rig).await;
    let published = WATCH_RING_CAPACITY as u64 + 3;
    publish_and_settle(&mut page, 1..=published).await;

    let mut late = join(&rig).await;
    send(&mut late, &ClientMessage::WatchSubscribe { history: true }).await;
    let (_, seq, item) = next_watch_update(&mut late).await;
    assert_eq!(seq, published - WATCH_RING_CAPACITY as u64 + 1);
    assert_eq!(epoch_of(&item), seq);

    let marker = loop {
        if let ServerMessage::WatchHistoryEnd {
            through_seq,
            replayed,
        } = next_watch_frame(&mut late).await
        {
            break (through_seq, replayed);
        }
    };
    assert_eq!(marker, (published, WATCH_RING_CAPACITY as u64));
}

/// The stream is opt-in on the reading side as well as on the publishing one.
#[tokio::test]
async fn a_connection_that_never_subscribed_receives_nothing() {
    let rig = serve().await;
    let mut bystander = join(&rig).await;
    let mut subscriber = join(&rig).await;
    subscribe_live(&mut subscriber).await;
    let mut page = join(&rig).await;

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
