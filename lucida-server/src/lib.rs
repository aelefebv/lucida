//! lucida-server library — shared types and modules used by the binary
//! and by integration tests.
//!
//! The binary entry point lives in [`main.rs`]; everything testable is
//! exported here.

pub mod auth;
pub mod binding;
pub mod binding_restore;
pub mod browse;
pub mod chunk_read;
pub mod chunk_serves;
pub mod connection;
pub mod dataset_open;
pub mod decode;
mod decode_pool;
pub mod deployment_theme;
pub mod generated;
pub mod handler;
pub mod health;
pub mod inbox;
pub mod link_throttle;
pub mod open_diagnostics;
pub mod origin;
mod sample_histogram;
pub mod session;
mod source_region;
pub mod static_serve;
pub mod status;
pub mod storage;
#[cfg(test)]
pub(crate) mod test_fixtures;
pub mod timing;
pub mod watch;
pub mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lucida_core::protocol::ClientId;
use lucida_store::source_policy::SourcePolicy;
use tokio::sync::Mutex;

use connection::ClientSender;

#[derive(Clone)]
pub enum BroadcastItem {
    /// Document command broadcast (sequenced).
    CommandBroadcast {
        sender: ClientId,
        broadcast_json: String,
        ack_json: String,
    },
    /// A refused document command, for its sender only. It rides this
    /// channel rather than the sender's unicast queue so it arrives in order
    /// with the acks of the sender's other commands.
    CommandRejected { sender: ClientId, json: String },
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
}

/// Per-client targeted message queues for unicast (chunk routing).
pub type UnicastRoutes = Arc<Mutex<HashMap<ClientId, ClientSender>>>;

#[derive(Clone)]
pub struct AppState {
    /// Where datasets may be opened from, and the data roots that bound
    /// `/api/browse`.
    pub source_policy: Arc<SourcePolicy>,
}

/// Server-wide configuration for generated coarse levels. Loaded once at
/// boot from CLI args and env defaults; each opened dataset's derived-chunk
/// cache and generation service are built from it.
#[derive(Clone, Debug)]
pub struct GeneratedConfig {
    pub generated_enabled: bool,
    /// Root under which each dataset's generated chunks are cached, in a
    /// directory named by its URL hash.
    pub generated_cache_dir: PathBuf,
    pub generated_concurrency: usize,
    pub generated_background_chunk_limit: usize,
    pub generated_target_long_axis: u64,
    pub generated_chunk_long_axis: u64,
    pub generated_max_chunk_bytes: u64,
    pub generated_disk_budget_bytes: Option<u64>,
    /// The one budget every dataset's in-memory generated chunks share.
    pub generated_memory: Arc<generated::GeneratedChunkMemory>,
}

impl GeneratedConfig {
    /// Default cache directory: `{user_cache_dir}/lucida/generated-coarse`,
    /// under the working directory if no platform cache dir is known.
    pub fn default_cache_dir() -> PathBuf {
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lucida")
            .join("generated-coarse")
    }

    /// The shape every dataset's generated coarse levels are planned to.
    pub fn coarse_config(&self) -> generated::GeneratedCoarseConfig {
        generated::GeneratedCoarseConfig {
            target_long_axis: self.generated_target_long_axis,
            chunk_long_axis: self.generated_chunk_long_axis,
            max_chunk_bytes: self.generated_max_chunk_bytes,
            ..Default::default()
        }
    }

    pub fn defaults() -> Self {
        Self {
            generated_enabled: true,
            generated_cache_dir: Self::default_cache_dir(),
            generated_concurrency: 1,
            generated_background_chunk_limit: 32,
            generated_target_long_axis: 512,
            generated_chunk_long_axis: 256,
            generated_max_chunk_bytes: 2 * 1024 * 1024,
            generated_disk_budget_bytes: None,
            generated_memory: generated::GeneratedChunkMemory::new(
                generated::DEFAULT_GENERATED_MEMORY_BYTES,
            ),
        }
    }
}
