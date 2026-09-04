//! lucida-server library — shared types and modules used by the binary
//! and by integration tests.
//!
//! The binary entry point lives in [`main.rs`]; everything testable is
//! exported here.

pub mod admin;
pub mod auth;
pub mod binding;
pub mod binding_restore;
pub mod bookmarks;
pub mod browse;
pub mod chunk_read;
pub mod dataset_open;
pub mod decode;
pub mod generated;
pub mod handler;
pub mod health;
pub mod open_diagnostics;
pub mod proxy;
pub mod session;
pub mod static_serve;
pub mod storage;
#[cfg(test)]
pub(crate) mod test_fixtures;
pub mod timing;
pub mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use axum::extract::ws::Message;
use lucida_core::protocol::ClientId;
use tokio::sync::{Mutex, broadcast, mpsc};

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
    PresenceUpdate { sender: ClientId, json: String },
    /// Cursor update from a client.
    CursorUpdate { sender: ClientId, json: String },
    /// Peer joined.
    PeerJoined { sender: ClientId, json: String },
    /// Peer left.
    PeerLeft { json: String },
    /// Follow changed.
    FollowChanged { json: String },
    /// Dataset presence update from a client.
    DatasetPresenceUpdate { sender: ClientId, json: String },
    /// Server-authored generated level metadata/readiness update.
    GeneratedAvailabilityUpdate { json: String },
    /// Workspace was archived; connected workspace clients should leave.
    WorkspaceArchived { json: String },
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
    /// Temporary bridge flag for the retired proxy fallback path. The
    /// default server path leaves this false so DatasetOpened carries no
    /// proxy catalog and asset requests are ignored.
    pub legacy_proxy_enabled: bool,
    /// Maximum concurrent proxy generations across all datasets *per
    /// `ProxyGenerator` instance*. Each opened dataset gets its own
    /// generator with this many permits; total system concurrency scales
    /// with the number of opened datasets, which is acceptable for now.
    pub concurrency: usize,
    pub generated_enabled: bool,
    pub generated_cache_dir: PathBuf,
    pub generated_concurrency: usize,
    pub generated_background_chunk_limit: usize,
    pub generated_target_long_axis: u64,
    pub generated_chunk_long_axis: u64,
    pub generated_max_chunk_bytes: u64,
    pub generated_disk_budget_bytes: Option<u64>,
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

    pub fn default_generated_cache_dir() -> PathBuf {
        Self::default_cache_dir().join("generated-coarse")
    }

    pub fn defaults() -> Self {
        let cache_dir = Self::default_cache_dir();
        Self {
            generated_cache_dir: cache_dir.join("generated-coarse"),
            cache_dir,
            legacy_proxy_enabled: false,
            concurrency: Self::default_concurrency(),
            generated_enabled: true,
            generated_concurrency: 1,
            generated_background_chunk_limit: 32,
            generated_target_long_axis: 512,
            generated_chunk_long_axis: 256,
            generated_max_chunk_bytes: 2 * 1024 * 1024,
            generated_disk_budget_bytes: None,
        }
    }
}
