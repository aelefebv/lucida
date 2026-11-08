//! What one connection may do to the server, over real sockets: the size of
//! a message, a binary frame, and a client that stops reading.
//!
//! The route is the workspace router `main.rs` mounts: the inbound caps
//! from `connection::limit_inbound`, then the handler loop.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use common::workspace_rig::WorkspaceRig;
use lucida_core::protocol::{ClientMessage, ServerMessage, WatchItem};
use lucida_server::ProxyConfig;
use lucida_server::connection::{
    CLOSE_TOO_FAR_BEHIND, MAX_INBOUND_MESSAGE_BYTES, OUTBOUND_BUDGET_BYTES,
};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: Duration = Duration::from_secs(30);

struct Rig {
    workspace: WorkspaceRig,
    _tmp: tempfile::TempDir,
}

async fn start_server() -> Rig {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut proxy_config = ProxyConfig::defaults();
    proxy_config.cache_dir = tmp.path().join("proxies");
    proxy_config.generated_cache_dir = tmp.path().join("generated-coarse");
    Rig {
        workspace: WorkspaceRig::start(proxy_config).await,
        _tmp: tmp,
    }
}

async fn connect(rig: &Rig) -> WsClient {
    // The client side must be able to send past the server's cap, or the
    // oversize case would be refused here instead of there.
    let config = WebSocketConfig::default()
        .max_message_size(Some(256 * 1024 * 1024))
        .max_frame_size(Some(256 * 1024 * 1024));
    let (ws, _) = connect_async_with_config(rig.workspace.ws_url(), Some(config), false)
        .await
        .expect("ws connect");
    ws
}

async fn send(ws: &mut WsClient, msg: &ClientMessage) {
    let json = serde_json::to_string(msg).expect("serialize");
    ws.send(WsMessage::Text(json.into())).await.expect("send");
}

/// The next text frame as a server message, or `None` within `window`.
async fn next_message_within(ws: &mut WsClient, window: Duration) -> Option<ServerMessage> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match timeout(remaining, ws.next()).await {
            Err(_) => return None,
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                return Some(serde_json::from_str(text.as_str()).expect("server message"));
            }
            Ok(Some(Ok(_))) => continue,
            Ok(other) => panic!("socket ended while waiting for a message: {other:?}"),
        }
    }
}

async fn next_message(ws: &mut WsClient) -> ServerMessage {
    next_message_within(ws, READ_TIMEOUT)
        .await
        .expect("timed out waiting for a server message")
}

/// Read until the socket ends; the close frame, if one came.
async fn read_until_closed(ws: &mut WsClient) -> Option<(CloseCode, String)> {
    loop {
        match timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("socket never closed")
        {
            Some(Ok(WsMessage::Close(frame))) => {
                return frame.map(|f| (f.code, f.reason.to_string()));
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return None,
        }
    }
}

/// The socket still answers: a snapshot request comes back.
async fn assert_still_open(ws: &mut WsClient) {
    send(ws, &ClientMessage::RequestSnapshot).await;
    loop {
        if let ServerMessage::Snapshot { .. } = next_message(ws).await {
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_binary_frame_from_a_client_goes_nowhere() {
    let rig = start_server().await;
    let mut sender = connect(&rig).await;
    let ServerMessage::Snapshot { your_id: 0, .. } = next_message(&mut sender).await else {
        panic!("first client is id 0");
    };
    let mut target = connect(&rig).await;
    let ServerMessage::Snapshot { your_id: 1, .. } = next_message(&mut target).await else {
        panic!("second client is id 1");
    };

    // The envelope the server uses for chunk frames, addressed to client 1.
    let mut frame = 1u32.to_le_bytes().to_vec();
    frame.extend_from_slice(&3u16.to_le_bytes());
    frame.extend_from_slice(b"key");
    frame.extend_from_slice(&[7u8; 64]);
    sender
        .send(WsMessage::Binary(frame.into()))
        .await
        .expect("send binary");

    let delivered = timeout(Duration::from_millis(500), async {
        loop {
            match target.next().await {
                Some(Ok(WsMessage::Binary(bytes))) => return bytes,
                Some(Ok(_)) => continue,
                other => panic!("target socket ended: {other:?}"),
            }
        }
    })
    .await;
    assert!(
        delivered.is_err(),
        "a client's binary frame reached another client"
    );
    assert_still_open(&mut sender).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_message_over_the_cap_ends_the_connection_and_one_under_it_does_not() {
    let rig = start_server().await;

    let mut client = connect(&rig).await;
    next_message(&mut client).await;
    // Large and unparseable: logged and ignored, the connection lives.
    let under = "x".repeat(MAX_INBOUND_MESSAGE_BYTES - 1024);
    client
        .send(WsMessage::Text(under.into()))
        .await
        .expect("send under the cap");
    assert_still_open(&mut client).await;

    let over = "x".repeat(MAX_INBOUND_MESSAGE_BYTES + 1);
    // The server may drop the connection before the write completes.
    let _ = client.send(WsMessage::Text(over.into())).await;
    read_until_closed(&mut client).await;

    let mut next = connect(&rig).await;
    next_message(&mut next).await;
    assert_eq!(
        rig.workspace.live.session.lock().await.clients.len(),
        1,
        "the first client is gone"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_that_stops_reading_is_closed_with_a_reason() {
    let rig = start_server().await;
    let mut client = connect(&rig).await;
    next_message(&mut client).await;
    send(
        &mut client,
        &ClientMessage::WatchSubscribe { history: false },
    )
    .await;

    // Publish to ourselves without reading: each item comes back on this
    // client's own queue. Twice the budget is far past what the socket
    // buffers can absorb.
    const ITEM_BYTES: usize = 1024 * 1024;
    let items = 2 * OUTBOUND_BUDGET_BYTES / ITEM_BYTES;
    let item = WatchItem::Aggregate {
        at_epoch_ms: 0,
        run_id: Some("r".repeat(ITEM_BYTES)),
        reading: None,
        counted: Default::default(),
        sent: Default::default(),
        ticks: Vec::new(),
    };
    let publish = serde_json::to_string(&ClientMessage::WatchPublish { item }).unwrap();
    let (mut sink, mut stream) = client.split();
    let publisher = tokio::spawn(async move {
        for _ in 0..items {
            if sink
                .send(WsMessage::Text(publish.clone().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        sink
    });
    // Read only once everything is sent, so the backlog builds first.
    let _sink = publisher.await.expect("publisher");

    let close = loop {
        match timeout(READ_TIMEOUT, stream.next())
            .await
            .expect("socket never closed")
        {
            Some(Ok(WsMessage::Close(frame))) => break frame,
            Some(Ok(_)) => continue,
            other => panic!("the socket ended without a close frame: {other:?}"),
        }
    };
    let close = close.expect("the server says why it closed");
    let (code, reason) = (close.code, close.reason.to_string());
    assert_eq!(u16::from(code), CLOSE_TOO_FAR_BEHIND);
    assert!(reason.contains("behind"), "{reason}");
}
