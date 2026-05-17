//! Bounded-concurrency proxy generator with in-flight dedup.
//!
//! `request(spec, priority)` flow:
//!
//! 1. Compute the expected `source_content_hash` for `spec` from the
//!    [`DatasetManifest`].
//! 2. Cache check via [`ProxyCache::get`]. Hit → return `Arc<ProxyAsset>`.
//! 3. In-flight check: if another caller is already generating `spec`,
//!    subscribe to its broadcast channel and await the result.
//! 4. Otherwise: register a fresh broadcast sender in the in-flight map,
//!    drop the lock, acquire a [`Semaphore`] permit, do the actual work,
//!    write to the cache, broadcast the result, and remove the in-flight
//!    entry.
//!
//! The actual work is split into an **async pre-fetch** stage
//! ([`build_server_proxy_source`]) and a **sync compute** stage
//! ([`generate_proxy`] called via `tokio::task::spawn_blocking`). This
//! keeps the runtime-blocking generator on the blocking pool and the
//! tokio worker thread free for I/O.
//!
//! ## Priority
//!
//! `priority` is accepted for API stability but **not yet used to order
//! requests**. The semaphore awakes waiters in roughly FIFO order; a real
//! priority scheduler is deferred. See module docs.

use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::DatasetManifest;
use lucida_proxy::{GenerateError, ProxyAsset, ProxySpec, generate_proxy, source_content_hash};
use lucida_store::cache::CachedStore;
use tokio::sync::{Mutex, Semaphore, broadcast};

use crate::binding::ChunkResolver;

use super::cache::ProxyCache;
use super::server_source::{BuildSourceError, build_server_proxy_source};

/// Errors returned by [`ProxyGenerator::request`].
#[derive(thiserror::Error, Debug, Clone)]
pub enum GeneratorError {
    #[error("source data prep failed: {0}")]
    Source(String),
    #[error("proxy generation failed: {0}")]
    Generate(String),
    #[error("cache I/O error: {0}")]
    Cache(String),
    #[error("in-flight broadcast lost (sender dropped)")]
    BroadcastLost,
}

impl From<BuildSourceError> for GeneratorError {
    fn from(e: BuildSourceError) -> Self {
        GeneratorError::Source(e.to_string())
    }
}

impl From<GenerateError> for GeneratorError {
    fn from(e: GenerateError) -> Self {
        GeneratorError::Generate(e.to_string())
    }
}

impl From<std::io::Error> for GeneratorError {
    fn from(e: std::io::Error) -> Self {
        GeneratorError::Cache(e.to_string())
    }
}

/// Bounded-concurrency proxy generator. Wraps a [`ProxyCache`] for
/// persistence and a tokio [`Semaphore`] for concurrency control.
pub struct ProxyGenerator {
    cache: Arc<ProxyCache>,
    store: Arc<CachedStore>,
    resolver: Arc<ChunkResolver>,
    content: Arc<DatasetManifest>,
    semaphore: Arc<Semaphore>,
    in_flight: Arc<Mutex<HashMap<ProxySpec, broadcast::Sender<BroadcastPayload>>>>,
}

/// Result type sent over in-flight broadcasts. We can't put a non-Clone
/// Result over `broadcast`, so we wrap success in `Arc` and use a clonable
/// error.
type BroadcastPayload = Result<Arc<ProxyAsset>, GeneratorError>;

impl ProxyGenerator {
    pub fn new(
        cache: Arc<ProxyCache>,
        store: Arc<CachedStore>,
        resolver: Arc<ChunkResolver>,
        content: Arc<DatasetManifest>,
        concurrency: usize,
    ) -> Self {
        let concurrency = concurrency.max(1);
        Self {
            cache,
            store,
            resolver,
            content,
            semaphore: Arc::new(Semaphore::new(concurrency)),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Request a proxy for `spec`. See module docs for the full flow.
    ///
    /// `priority` is accepted but not yet used to order requests; see
    /// module docs.
    pub async fn request(
        &self,
        spec: ProxySpec,
        _priority: u8,
    ) -> Result<Arc<ProxyAsset>, GeneratorError> {
        let expected_hash =
            source_content_hash(self.content.as_ref(), &spec.entity_id, spec.t, spec.c);

        // 1. Cache check (sync I/O; cheap on miss).
        match self.cache.get(&spec, &expected_hash) {
            Ok(Some(asset)) => return Ok(Arc::new(asset)),
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(error = %e, "proxy cache get failed; proceeding to generate");
            }
        }

        // 2. In-flight dedup: subscribe to an existing generation, or
        // claim leadership by inserting a fresh sender.
        let rx_opt: Option<broadcast::Receiver<BroadcastPayload>> = {
            let mut map = self.in_flight.lock().await;
            if let Some(tx) = map.get(&spec) {
                Some(tx.subscribe())
            } else {
                let (tx, _rx) = broadcast::channel::<BroadcastPayload>(1);
                map.insert(spec.clone(), tx);
                None
            }
        };

        if let Some(mut rx) = rx_opt {
            // Follower path: wait for the leader's broadcast.
            return match rx.recv().await {
                Ok(result) => result,
                Err(_) => Err(GeneratorError::BroadcastLost),
            };
        }

        // Leader path: do the work, broadcast, and clean up.
        //
        // Note: if `generate_one` panics, the in_flight entry is *not*
        // cleaned up — the broadcast sender is dropped on unwind,
        // which signals followers via `RecvError::Closed`, but the
        // leftover map entry would prevent retries within the same
        // process. Acceptable for MVP; revisit with a scope guard
        // (`scopeguard` crate or a custom `Drop`-based wrapper) if
        // panics become a concern.
        let result = self.generate_one(spec.clone(), expected_hash).await;

        // Send the broadcast under the same lock as removal so no later
        // request can see a stale entry without a live receiver queue.
        let mut map = self.in_flight.lock().await;
        if let Some(tx) = map.remove(&spec) {
            let _ = tx.send(result.clone());
        }
        drop(map);

        result
    }

    /// Actually generate a proxy: acquire a semaphore permit, pre-fetch
    /// source data, run the synchronous generator on the blocking pool,
    /// and write to the cache.
    async fn generate_one(
        &self,
        spec: ProxySpec,
        expected_hash: [u8; 32],
    ) -> Result<Arc<ProxyAsset>, GeneratorError> {
        let _permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| GeneratorError::Generate(format!("semaphore closed: {e}")))?;

        // Pre-fetch chunks (async I/O).
        let source =
            build_server_proxy_source(&spec, self.content.as_ref(), &self.store, &self.resolver)
                .await?;

        // Synchronous compute on the blocking pool — the algorithm is CPU
        // bound and we don't want to monopolize a tokio worker.
        let content = self.content.clone();
        let spec_for_blocking = spec.clone();
        let asset = tokio::task::spawn_blocking(move || {
            generate_proxy(&spec_for_blocking, content.as_ref(), &source)
        })
        .await
        .map_err(|join_err| {
            GeneratorError::Generate(format!("generation task join failed: {join_err}"))
        })?
        .map_err(GeneratorError::from)?;

        debug_assert_eq!(asset.header.source_content_hash, expected_hash);

        if let Err(e) = self.cache.put(&spec, &asset) {
            tracing::warn!(error = %e, "proxy cache put failed; returning generated asset anyway");
        }

        Ok(Arc::new(asset))
    }
}

impl ProxyGenerator {
    /// Approximate available concurrency (number of permits not currently
    /// held). Intended for diagnostics / tests.
    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }
}
