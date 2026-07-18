//! lucida-server library — shared types and modules used by the binary
//! and by integration tests.
//!
//! The binary entry point lives in [`main.rs`]; everything testable is
//! exported here.

#![deny(clippy::print_stderr)]

pub mod admin;
pub mod auth;
pub mod binding;
pub mod binding_restore;
pub mod browse;
pub mod command_policy;
pub mod dataset_open;
pub mod decode;
pub mod generated_coarse;
pub mod handler;
pub mod health;
pub mod legacy_bookmark_recovery;
pub mod open_diagnostics;
pub mod origin;
pub mod outbox;
pub mod session;
pub(crate) mod source_identity_migration;
pub mod source_policy;
pub(crate) mod source_volume;
pub mod static_serve;
#[cfg(test)]
pub(crate) mod test_fixtures;
pub mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lucida_core::protocol::ClientId;
use tokio::sync::Mutex;

pub use outbox::BroadcastSender;
pub(crate) use outbox::{BroadcastEvent, BroadcastRecvError};

/// Per-client targeted message channels for unicast (chunk routing).
pub type UnicastRoutes = Arc<Mutex<HashMap<ClientId, outbox::UnicastSender>>>;

/// Default root-wide ceiling for recomputable generated coarse data (8 GiB).
/// The active cache therefore cannot consume the other 42 GiB of nominal
/// capacity on the reference 50 GiB deployment volume.
pub const DEFAULT_GENERATED_DISK_BUDGET_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Root-global ceiling for persistent generated-cache filesystem entries.
/// One full 65,536-entry readiness generation fits, while repeated generations
/// must evict before inode exhaustion can outrun the byte budget.
pub const DEFAULT_GENERATED_DISK_ENTRY_BUDGET: u64 = 100_000;

#[derive(Clone)]
pub struct AppState {
    pub data_dir: Option<PathBuf>,
    /// Dataset runtime config, plumbed through to per-dataset bindings when
    /// datasets are opened.
    pub dataset_runtime: DatasetRuntimeConfig,
}

impl AppState {
    /// Typed active + retired roots for the compatibility-named cache-clear
    /// route. Only the active root is used by generated-coarse writes.
    pub fn derived_cache_roots(&self) -> admin::DerivedCacheRoots {
        admin::DerivedCacheRoots::new(
            self.dataset_runtime.generated_cache_dir.clone(),
            self.dataset_runtime.legacy_proxy_cache_dir.clone(),
        )
    }
}

/// Server-wide source and generated-coarse runtime configuration. Loaded once
/// at boot from CLI args / env defaults and shared by dataset bindings.
#[derive(Clone, Debug)]
pub struct DatasetRuntimeConfig {
    /// One immutable, process-wide source admission policy shared by browse,
    /// direct open, and workspace restore.
    pub source_policy: Arc<source_policy::SourceTrustPolicy>,
    /// One process-wide source cache and resident byte budget. Every dataset
    /// binding is a namespaced view over this same allocation.
    pub source_cache: Arc<lucida_store::cache::SharedObjectCache>,
    pub generated_enabled: bool,
    pub generated_cache_dir: PathBuf,
    /// Retired proxy-era cache root retained only for explicit upgrade
    /// cleanup. New generated data is never written here.
    pub legacy_proxy_cache_dir: PathBuf,
    pub generated_concurrency: usize,
    pub generated_background_chunk_limit: usize,
    pub generated_target_long_axis: u64,
    pub generated_chunk_long_axis: u64,
    pub generated_max_chunk_bytes: u64,
    /// Finite root-wide ceiling for all generated-cache source/revision
    /// scopes. Zero is a fail-closed library value and rejected by the CLI.
    pub generated_disk_budget_bytes: u64,
}

impl DatasetRuntimeConfig {
    /// Default generated-coarse cache directory.
    pub fn default_cache_dir() -> PathBuf {
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("lucida")
            .join("generated-coarse")
    }

    pub fn default_generated_cache_dir() -> PathBuf {
        Self::default_cache_dir()
    }

    pub fn default_legacy_proxy_cache_dir() -> PathBuf {
        Self::default_cache_dir()
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("proxies")
    }

    pub fn defaults() -> Self {
        Self {
            source_policy: Arc::new(source_policy::SourceTrustPolicy::deny_all()),
            source_cache: lucida_store::cache::SharedObjectCache::new(
                512 * 1024 * 1024,
                64 * 1024 * 1024,
            ),
            generated_cache_dir: Self::default_generated_cache_dir(),
            legacy_proxy_cache_dir: Self::default_legacy_proxy_cache_dir(),
            generated_enabled: true,
            generated_concurrency: 1,
            generated_background_chunk_limit: 32,
            generated_target_long_axis: 512,
            generated_chunk_long_axis: 256,
            generated_max_chunk_bytes: 2 * 1024 * 1024,
            generated_disk_budget_bytes: DEFAULT_GENERATED_DISK_BUDGET_BYTES,
        }
    }
}
