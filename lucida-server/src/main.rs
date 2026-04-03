mod browse;
mod handler;
mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use lucida_core::protocol::ClientId;
use tokio::sync::{broadcast, mpsc, Mutex};
use tower_http::cors::CorsLayer;

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
pub(crate) type UnicastRoutes = Arc<Mutex<HashMap<ClientId, mpsc::UnboundedSender<Message>>>>;

#[derive(Clone)]
pub(crate) struct AppState {
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    next_id: Arc<AtomicU64>,
    unicast_routes: UnicastRoutes,
    pub(crate) data_dir: Option<PathBuf>,
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let id = state
        .next_id
        .fetch_add(1, Ordering::Relaxed);
    ws.on_upgrade(move |socket| async move {
        eprintln!("client {id} connected");
        handler::handle_client(id, socket, state.session, state.tx, state.unicast_routes).await;
    })
}

#[tokio::main]
async fn main() {
    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _) = broadcast::channel::<BroadcastItem>(256);
    let next_id = Arc::new(AtomicU64::new(0));
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));

    // Parse --data-dir flag.
    let data_dir = {
        let args: Vec<String> = std::env::args().collect();
        args.windows(2)
            .find(|w| w[0] == "--data-dir")
            .map(|w| PathBuf::from(&w[1]))
    };

    let state = AppState {
        session,
        tx,
        next_id,
        unicast_routes,
        data_dir,
    };

    let app = Router::new()
        .route("/", get(ws_handler))
        .route("/ws", get(ws_handler))
        .route("/api/browse", get(browse::browse_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:9876")
        .await
        .expect("failed to bind to port 9876");
    eprintln!("lucida-server listening on http://0.0.0.0:9876");

    axum::serve(listener, app).await.expect("server error");
}
