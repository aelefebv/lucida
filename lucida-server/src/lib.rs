//! lucida-server library — shared types and modules used by the binary
//! and by integration tests.
//!
//! The binary entry point lives in [`main.rs`]; everything testable is
//! exported here.

pub mod admin;
pub mod auth;
pub mod binding;
pub mod bookmarks;
pub mod browse;
pub mod decode;
pub mod handler;
pub mod proxy;
pub mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use axum::extract::ws::Message;
use lucida_core::protocol::ClientId;
use tokio::sync::{broadcast, mpsc, Mutex};

use session::Session;

#[derive(Clone)]
pub enum BroadcastItem {
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
pub type UnicastRoutes = Arc<Mutex<HashMap<ClientId, mpsc::UnboundedSender<Message>>>>;

#[derive(Clone)]
pub struct AppState {
    pub session: Arc<Mutex<Session>>,
    pub tx: broadcast::Sender<BroadcastItem>,
    pub next_id: Arc<AtomicU64>,
    pub unicast_routes: UnicastRoutes,
    pub data_dir: Option<PathBuf>,
    /// Proxy infrastructure config, plumbed through to per-dataset
    /// `ServerBinding`s when datasets are opened.
    pub proxy_config: ProxyConfig,
}

impl AppState {
    /// Convenience accessor for the configured proxy cache root, used by
    /// the admin clear-cache endpoint so it doesn't have to reach into
    /// `proxy_config` directly.
    pub fn proxy_cache_dir(&self) -> PathBuf {
        self.proxy_config.cache_dir.clone()
    }
}

/// Server-wide proxy infrastructure configuration. Loaded once at boot
/// from CLI args / env defaults; per-dataset `ProxyCache` and
/// `ProxyGenerator` instances are derived from it as datasets open.
#[derive(Clone, Debug)]
pub struct ProxyConfig {
    /// Root directory under which per-dataset proxy caches are written.
    /// `{root}/{url_hash hex}/...` — see [`proxy::ProxyCache`].
    pub cache_dir: PathBuf,
    /// Maximum concurrent proxy generations across all datasets *per
    /// `ProxyGenerator` instance*. Each opened dataset gets its own
    /// generator with this many permits; total system concurrency scales
    /// with the number of opened datasets, which is acceptable for now.
    pub concurrency: usize,
}

impl ProxyConfig {
    /// Default cache directory: `{user_cache_dir}/lucida/proxies`, falling
    /// back to `./.lucida-proxy-cache` if no platform cache dir is known.
    pub fn default_cache_dir() -> PathBuf {
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lucida")
            .join("proxies")
    }

    /// Default concurrency: half the logical CPU count, minimum 1.
    pub fn default_concurrency() -> usize {
        (num_cpus::get() / 2).max(1)
    }

    pub fn defaults() -> Self {
        Self {
            cache_dir: Self::default_cache_dir(),
            concurrency: Self::default_concurrency(),
        }
    }
}
