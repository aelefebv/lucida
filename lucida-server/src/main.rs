mod handler;
mod session;

use std::collections::HashMap;
use std::sync::Arc;

use lucida_core::protocol::ClientId;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use session::Session;

#[derive(Clone)]
pub(crate) enum BroadcastItem {
    /// Document command broadcast (sequenced).
    CommandBroadcast {
        sender: ClientId,
        broadcast_json: String,
        ack_json: String,
    },
    /// Presence update from a client (ephemeral).
    PresenceUpdate {
        sender: ClientId,
        json: String,
    },
    /// Cursor update from a client.
    CursorUpdate {
        sender: ClientId,
        json: String,
    },
    /// Peer joined.
    PeerJoined {
        sender: ClientId,
        json: String,
    },
    /// Peer left.
    PeerLeft {
        json: String,
    },
    /// Follow changed.
    FollowChanged {
        json: String,
    },
    /// Dataset presence update from a client.
    DatasetPresenceUpdate {
        sender: ClientId,
        json: String,
    },
}

/// Per-client targeted message channels for unicast (chunk routing).
pub(crate) type ClientSenders = Arc<Mutex<HashMap<ClientId, mpsc::UnboundedSender<Message>>>>;

#[tokio::main]
async fn main() {
    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _) = broadcast::channel::<BroadcastItem>(256);
    let next_id = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let clients: ClientSenders = Arc::new(Mutex::new(HashMap::new()));

    let listener = TcpListener::bind("0.0.0.0:9876")
        .await
        .expect("failed to bind to port 9876");
    eprintln!("lucida-server listening on ws://0.0.0.0:9876");

    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };

        let ws = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("websocket handshake error from {addr}: {e}");
                continue;
            }
        };

        let id = next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!("client {id} connected from {addr}");

        let session = Arc::clone(&session);
        let tx = tx.clone();
        let clients = Arc::clone(&clients);

        tokio::spawn(handler::handle_client(id, ws, session, tx, clients));
    }
}
