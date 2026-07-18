//! Memory-bounded LRU Chunk Cache wrapping a StorageBackend.
//!
//! Caches chunk bytes fetched from an ObjectStore to reduce repeated reads
//! when multiple Clients view the same region.

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use lru::LruCache;
use object_store::path::Path;
use object_store::{ObjectStore, ObjectStoreExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, broadcast};

use lucida_content::url::{SourceIdentity, SourceVersion};

use crate::budget::{MemoryBudget, MemoryBudgetSnapshot, MemoryCategory, MemoryReservation};

/// Default cap on concurrent backend source reads when no operator override
/// is supplied. Chosen from the conservative middle of the intended 8–16
/// range: enough parallelism to keep a remote store busy without letting a
/// burst of misses fan out into hundreds of simultaneous connections.
const DEFAULT_SOURCE_READ_CONCURRENCY: usize = 12;

/// Environment variable an operator can set to override the process-global
/// concurrent-source-read cap. Read once, the first time the limiter is used.
const SOURCE_READ_CONCURRENCY_ENV: &str = "LUCIDA_SOURCE_READ_CONCURRENCY";

/// The process-global limiter shared by every [`CachedStore`] built via
/// [`CachedStore::new`].
///
/// There is one `CachedStore` per dataset/binding, so a per-instance
/// semaphore would let the effective concurrency scale with the number of
/// open datasets and defeat the cap entirely. A single shared limiter keeps
/// the bound over the whole process regardless of how many datasets are open.
fn global_source_read_limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(configured_source_read_limit())))
}

/// Resolve the source-read cap from the operator override, falling back to
/// [`DEFAULT_SOURCE_READ_CONCURRENCY`]. A non-numeric or zero value is
/// ignored in favour of the default so a typo can never wedge all reads.
fn configured_source_read_limit() -> usize {
    std::env::var(SOURCE_READ_CONCURRENCY_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|&limit| limit > 0)
        .unwrap_or(DEFAULT_SOURCE_READ_CONCURRENCY)
}

/// The classification-relevant shape of a captured backend error.
///
/// The downstream triage of a source-chunk read failure (not-found →
/// zero-filled, permission/credentials → sticky-permanent, everything else →
/// transient/self-healing) is driven by the `object_store::Error` *variant*.
/// A single-flight follower reconstructs its error from a broadcast snapshot,
/// so the snapshot must carry enough of the leader's variant that the
/// follower's reconstructed error triages identically — otherwise a coalesced
/// 403 could look transient (retry storm) or a coalesced 404 could look like a
/// hard failure instead of legitimate sparse data.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SharedErrorKind {
    /// The object does not exist. Reconstructs to `NotFound` so it is treated
    /// as legitimate sparse data (zero-filled), matched by variant rather than
    /// a fragile message substring.
    NotFound,
    /// The store refused the read for lack of permission or valid credentials
    /// (403/401). Reconstructs to `PermissionDenied` so it stays permanent.
    PermissionDenied,
    /// Any other failure — backend fault, throttling, timeout, unreachable
    /// service. Reconstructs to `Generic`, classified as unavailable/transient.
    Other,
}

impl SharedErrorKind {
    fn classify(err: &object_store::Error) -> Self {
        match err {
            object_store::Error::NotFound { .. } => SharedErrorKind::NotFound,
            object_store::Error::PermissionDenied { .. }
            | object_store::Error::Unauthenticated { .. } => SharedErrorKind::PermissionDenied,
            _ => SharedErrorKind::Other,
        }
    }
}

/// A cloneable snapshot of a backend error, broadcast to single-flight
/// followers. `object_store::Error` is not `Clone`, so the leader captures the
/// error's classification [`kind`](SharedErrorKind) plus its display form and
/// each follower reconstructs an equivalent `object_store::Error` — same
/// variant, same message — to surface to its own caller.
#[derive(Clone)]
struct SharedError {
    kind: SharedErrorKind,
    message: Arc<str>,
}

impl SharedError {
    fn capture(err: &object_store::Error) -> Self {
        SharedError {
            kind: SharedErrorKind::classify(err),
            message: Arc::from(err.to_string()),
        }
    }

    fn into_object_store_error(self) -> object_store::Error {
        let source: Box<dyn std::error::Error + Send + Sync> = self.message.to_string().into();
        match self.kind {
            // Path is left empty: it is not part of the reconstruction's
            // purpose (classification is by variant, the leader's message is
            // preserved verbatim) and the true path is already in the message.
            SharedErrorKind::NotFound => object_store::Error::NotFound {
                path: String::new(),
                source,
            },
            SharedErrorKind::PermissionDenied => object_store::Error::PermissionDenied {
                path: String::new(),
                source,
            },
            SharedErrorKind::Other => object_store::Error::Generic {
                store: "source",
                source,
            },
        }
    }
}

/// Budget-owning source bytes. The reservation follows cheap clones, so an
/// LRU eviction cannot release accounting while a decoder still holds the
/// same allocation.
#[derive(Clone)]
pub struct CachedBytes {
    bytes: Bytes,
    _reservation: Arc<MemoryReservation>,
    // The unique-key lease follows returned bytes, so an empty result cannot
    // become free after its LRU entry is evicted while a caller retains it.
    _metadata_reservation: Arc<Mutex<MemoryReservation>>,
}

impl std::fmt::Debug for CachedBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedBytes")
            .field("len", &self.bytes.len())
            .finish_non_exhaustive()
    }
}

impl std::ops::Deref for CachedBytes {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}

impl AsRef<[u8]> for CachedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl PartialEq for CachedBytes {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}

impl Eq for CachedBytes {}

impl CachedBytes {
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// Result shared over the in-flight broadcast. Success carries budget-owning
/// bytes; failure carries a [`SharedError`].
type ShareResult = Result<CachedBytes, SharedError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheStats {
    pub max_bytes: usize,
    pub current_bytes: usize,
    pub entry_count: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub backend_errors: u64,
    /// Single-flight followers served a leader's result without issuing
    /// their own backend read.
    pub coalesced: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    namespace: Arc<str>,
    path: String,
}

/// Process-wide cache state shared by every production dataset binding.
pub struct SharedObjectCache {
    cache: Mutex<LruState>,
    in_flight: InFlight,
    namespace_generations: Arc<NamespaceGenerationRegistry>,
    next_flight_id: AtomicU64,
    #[cfg(test)]
    invalidation_entry_checks: AtomicU64,
    source_read: Arc<Semaphore>,
    budget: Arc<MemoryBudget>,
    max_object_bytes: usize,
}

impl std::fmt::Debug for SharedObjectCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedObjectCache")
            .field("max_object_bytes", &self.max_object_bytes)
            .field("memory", &self.budget.snapshot())
            .finish_non_exhaustive()
    }
}

/// A namespaced view over a process-wide memory-bounded source cache.
pub struct CachedStore {
    inner: Arc<dyn ObjectStore>,
    namespace: Arc<str>,
    shared: Arc<SharedObjectCache>,
    max_object_bytes: usize,
}

struct LruState {
    lru: LruCache<CacheKey, CachedEntry>,
    current_bytes: usize,
    max_bytes: usize,
    hits: u64,
    misses: u64,
    evictions: u64,
    backend_errors: u64,
    coalesced: u64,
}

#[derive(Clone)]
struct CachedEntry {
    bytes: CachedBytes,
    generation: NamespaceGeneration,
    metadata_charge: usize,
}

impl CachedEntry {
    fn accounted_bytes(&self) -> usize {
        self.bytes
            .len()
            .checked_add(self.metadata_charge)
            .expect("body and metadata were admitted under one usize budget")
    }
}

/// One cache-namespace generation captured at leader election. Invalidation
/// removes the namespace's token from the shared registry and increments it,
/// so every leader that retained the old token can finish its caller's read
/// but cannot repopulate the cache afterward.
#[derive(Clone)]
struct NamespaceGeneration {
    token: Arc<GenerationToken>,
    value: u64,
}

struct GenerationToken {
    value: AtomicU64,
    namespace: Arc<str>,
    registry: Weak<NamespaceGenerationRegistry>,
}

struct NamespaceGenerationRegistry {
    generations: Mutex<HashMap<Arc<str>, Weak<GenerationToken>>>,
}

type RetiredNamespaceGenerations = HashMap<Arc<str>, NamespaceGeneration>;

impl Drop for GenerationToken {
    fn drop(&mut self) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let mut generations = registry.generations.lock().unwrap();
        if generations
            .get(self.namespace.as_ref())
            .is_some_and(|registered| std::ptr::eq(registered.as_ptr(), self))
        {
            generations.remove(self.namespace.as_ref());
        }
    }
}

impl NamespaceGeneration {
    fn matches(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.token, &other.token) && self.value == other.value
    }

    fn is_current(&self) -> bool {
        self.token.value.load(Ordering::Acquire) == self.value
    }
}

struct InFlightEntry {
    id: u64,
    generation: NamespaceGeneration,
    tx: broadcast::Sender<ShareResult>,
}

struct LeaderMetadata {
    charge: usize,
    reservation: Arc<Mutex<MemoryReservation>>,
}

struct FlightElection {
    id: u64,
    follower: Option<broadcast::Receiver<ShareResult>>,
    leader: Option<LeaderMetadata>,
}

/// Fixed logical charge for the simultaneously retained flight/LRU
/// bookkeeping around one unique key. Dynamic string bytes are added below.
/// This deliberately covers more than the Rust structs themselves so hash/LRU
/// nodes, Arc control blocks, broadcast state, and allocator bookkeeping can
/// never become a zero-cost cardinality channel.
const CACHE_ENTRY_AUXILIARY_OVERHEAD_BYTES: usize = 512;
const CACHE_KEY_PEAK_COPIES: usize = 5;

fn cache_entry_metadata_charge(key: &CacheKey) -> Result<usize, object_store::Error> {
    let fixed = size_of::<CacheKey>()
        .checked_mul(CACHE_KEY_PEAK_COPIES)
        .and_then(|bytes| bytes.checked_add(size_of::<CachedEntry>()))
        .and_then(|bytes| bytes.checked_add(size_of::<InFlightEntry>()))
        .and_then(|bytes| bytes.checked_add(size_of::<GenerationToken>()))
        .and_then(|bytes| bytes.checked_add(CACHE_ENTRY_AUXILIARY_OVERHEAD_BYTES))
        .ok_or_else(|| cache_capacity_error("cache entry metadata size overflowed".to_string()))?;
    let dynamic = key
        .path
        .len()
        .checked_mul(CACHE_KEY_PEAK_COPIES)
        .and_then(|bytes| bytes.checked_add(key.namespace.len()))
        .ok_or_else(|| cache_capacity_error("cache key metadata size overflowed".to_string()))?;
    fixed
        .checked_add(dynamic)
        .ok_or_else(|| cache_capacity_error("cache entry metadata charge overflowed".to_string()))
}

/// The shared in-flight registry keyed by source namespace plus object path.
type InFlight = Mutex<HashMap<CacheKey, InFlightEntry>>;

/// RAII owner of a leader's in-flight entry.
///
/// The broadcast sender lives in the shared `in_flight` map, not on the
/// leader's stack, so if the leader future is dropped, cancelled, or panics
/// between registering the entry and broadcasting its result, nothing would
/// otherwise remove the entry or drop the sender — every current follower and
/// every future caller taking the single-flight path for that key would await
/// `rx.recv()` forever (a permanent wedge). This guard, held on the leader's
/// stack from the moment the entry is registered, closes that gap:
///
/// - On normal completion the leader calls [`LeaderGuard::complete`], which
///   removes the entry and broadcasts the result exactly once.
/// - On any early exit (drop/cancel/panic) `Drop` removes the entry and drops
///   the sender, so followers observe a `RecvError` and fall back to their own
///   backend read, and a later request for the same key starts fresh.
struct LeaderGuard<'a> {
    in_flight: &'a InFlight,
    key: CacheKey,
    id: u64,
    // Map removal only detaches followers. The elected task owns the charge
    // through completion/cancellation, including while queued on a semaphore
    // or backend and across namespace invalidation.
    _metadata_reservation: Arc<Mutex<MemoryReservation>>,
    /// Set once [`complete`](Self::complete) has removed the entry, so `Drop`
    /// does not remove it a second time.
    completed: bool,
}

impl<'a> LeaderGuard<'a> {
    fn new(
        in_flight: &'a InFlight,
        key: CacheKey,
        id: u64,
        metadata_reservation: Arc<Mutex<MemoryReservation>>,
    ) -> Self {
        LeaderGuard {
            in_flight,
            key,
            id,
            _metadata_reservation: metadata_reservation,
            completed: false,
        }
    }

    /// Publish the leader's outcome to all current followers and remove the
    /// in-flight entry. Called exactly once on the normal-completion path.
    fn complete(&mut self, result: &Result<CachedBytes, object_store::Error>) {
        let mut in_flight = self.in_flight.lock().unwrap();
        let owns_entry = in_flight
            .get(&self.key)
            .is_some_and(|entry| entry.id == self.id);
        if owns_entry {
            let entry = in_flight
                .remove(&self.key)
                .expect("leader-owned in-flight entry still exists");
            let payload: ShareResult = match result {
                Ok(bytes) => Ok(bytes.clone()),
                Err(error) => Err(SharedError::capture(error)),
            };
            let _ = entry.tx.send(payload);
        }
        self.completed = true;
    }
}

impl Drop for LeaderGuard<'_> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        // Leader vanished before broadcasting (dropped/cancelled/panicked).
        // Remove the entry and let the sender drop so every current and future
        // waiter observes `RecvError` and falls back to its own fetch, rather
        // than awaiting a result that will never be sent.
        let mut in_flight = self.in_flight.lock().unwrap();
        if in_flight
            .get(&self.key)
            .is_some_and(|entry| entry.id == self.id)
        {
            in_flight.remove(&self.key);
        }
    }
}

impl SharedObjectCache {
    /// Build one cache and one hard resident budget for an entire process.
    pub fn new(max_bytes: usize, max_object_bytes: usize) -> Arc<Self> {
        Self::with_budget(
            MemoryBudget::new(max_bytes),
            max_object_bytes,
            global_source_read_limiter().clone(),
        )
    }

    pub fn with_budget(
        budget: Arc<MemoryBudget>,
        max_object_bytes: usize,
        source_read: Arc<Semaphore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            cache: Mutex::new(LruState {
                lru: LruCache::unbounded(),
                current_bytes: 0,
                max_bytes: budget.max_bytes(),
                hits: 0,
                misses: 0,
                evictions: 0,
                backend_errors: 0,
                coalesced: 0,
            }),
            in_flight: Mutex::new(HashMap::new()),
            namespace_generations: Arc::new(NamespaceGenerationRegistry {
                generations: Mutex::new(HashMap::new()),
            }),
            next_flight_id: AtomicU64::new(1),
            #[cfg(test)]
            invalidation_entry_checks: AtomicU64::new(0),
            source_read,
            budget,
            max_object_bytes,
        })
    }

    pub fn budget(&self) -> &Arc<MemoryBudget> {
        &self.budget
    }

    pub fn memory_snapshot(&self) -> MemoryBudgetSnapshot {
        self.budget.snapshot()
    }

    fn namespace_generation(&self, namespace: &Arc<str>) -> NamespaceGeneration {
        let mut generations = self.namespace_generations.generations.lock().unwrap();
        let token = generations
            .get(namespace.as_ref())
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let token = Arc::new(GenerationToken {
                    value: AtomicU64::new(0),
                    namespace: Arc::clone(namespace),
                    registry: Arc::downgrade(&self.namespace_generations),
                });
                generations.insert(Arc::clone(namespace), Arc::downgrade(&token));
                token
            });
        // Capture the token and its value under one registry lock. Otherwise an
        // invalidator can remove/increment the token between the clone and this
        // load, letting a retired token masquerade as a current generation.
        let value = token.value.load(Ordering::Acquire);
        NamespaceGeneration { value, token }
    }

    /// Retire namespace generation tokens before removing resident/in-flight
    /// entries. A late leader holds the retired token and therefore cannot
    /// publish into a new generation of the same namespace.
    fn retire_namespaces(&self, matches: impl Fn(&str) -> bool) -> RetiredNamespaceGenerations {
        let mut generations = self.namespace_generations.generations.lock().unwrap();
        let keys = generations
            .keys()
            .filter(|namespace| matches(namespace.as_ref()))
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|namespace| {
                let token = generations.remove(&namespace)?.upgrade()?;
                // Increment while the registry lock is still held. A reader
                // therefore captures either the old value before retirement or
                // a fresh token after removal, never the incremented value of a
                // token that is no longer registered.
                let value = token.value.fetch_add(1, Ordering::AcqRel);
                Some((namespace, NamespaceGeneration { token, value }))
            })
            .collect()
    }

    fn retire_namespace(&self, namespace: &str) -> RetiredNamespaceGenerations {
        let mut generations = self.namespace_generations.generations.lock().unwrap();
        let Some((namespace, token)) = generations.remove_entry(namespace) else {
            return HashMap::new();
        };
        let Some(token) = token.upgrade() else {
            return HashMap::new();
        };
        let value = token.value.fetch_add(1, Ordering::AcqRel);
        HashMap::from([(namespace, NamespaceGeneration { token, value })])
    }

    fn remove_retired_namespaces(&self, retired: &RetiredNamespaceGenerations) -> usize {
        if retired.is_empty() {
            return 0;
        }
        let removed = {
            let mut state = self.cache.lock().unwrap();
            let keys: Vec<CacheKey> = state
                .lru
                .iter()
                .filter(|(key, entry)| {
                    #[cfg(test)]
                    self.invalidation_entry_checks
                        .fetch_add(1, Ordering::Relaxed);
                    retired
                        .get(key.namespace.as_ref())
                        .is_some_and(|generation| entry.generation.matches(generation))
                })
                .map(|(key, _)| key.clone())
                .collect();
            let mut removed = Vec::with_capacity(keys.len());
            for key in keys {
                if let Some(entry) = state.lru.pop(&key) {
                    state.current_bytes -= entry.accounted_bytes();
                    removed.push(entry);
                }
            }
            removed
        };
        let count = removed.len();
        drop(removed);
        let removed_flights = {
            let mut in_flight = self.in_flight.lock().unwrap();
            let keys = in_flight
                .iter()
                .filter(|(key, entry)| {
                    #[cfg(test)]
                    self.invalidation_entry_checks
                        .fetch_add(1, Ordering::Relaxed);
                    retired
                        .get(key.namespace.as_ref())
                        .is_some_and(|generation| entry.generation.matches(generation))
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| in_flight.remove(&key))
                .collect::<Vec<_>>()
        };
        drop(removed_flights);
        count
    }

    fn invalidate_matching_namespaces(&self, matches: impl Fn(&str) -> bool + Copy) -> usize {
        let retired = self.retire_namespaces(matches);
        self.remove_retired_namespaces(&retired)
    }

    /// Drop one exact namespace. Import metadata uses an ephemeral namespace
    /// and calls this when the import context is released.
    pub(crate) fn invalidate_namespace(&self, namespace: &str) -> usize {
        let retired = self.retire_namespace(namespace);
        self.remove_retired_namespaces(&retired)
    }

    /// Drop every cached generation of a locator identity. Production source
    /// namespaces are versioned, so this is used by cache administration and
    /// revision replacement rather than by ordinary reads.
    pub fn invalidate_source(&self, identity: &SourceIdentity) -> usize {
        let dataset_id = identity.dataset_id();
        let version_prefix = format!("{dataset_id}:");
        self.invalidate_matching_namespaces(|namespace| {
            namespace == dataset_id || namespace.starts_with(&version_prefix)
        })
    }

    /// Drop every source-cache entry. In-flight readers are detached so their
    /// current followers retry; versioned namespaces keep any late leader
    /// completion from being mistaken for a different source generation.
    pub fn invalidate_all(&self) -> usize {
        self.invalidate_matching_namespaces(|_| true)
    }

    /// Reserve non-cache resident bytes, evicting source-cache entries across
    /// all datasets first. This lets active decode/generated work use the same
    /// hard ceiling instead of failing merely because reclaimable cache data
    /// occupies it.
    pub fn reserve_resident(
        &self,
        category: MemoryCategory,
        bytes: usize,
    ) -> Option<MemoryReservation> {
        loop {
            if let Some(reservation) = self.budget.try_reserve(category, bytes) {
                return Some(reservation);
            }
            let evicted = {
                let mut state = self.cache.lock().unwrap();
                let evicted = state.lru.pop_lru();
                if let Some((_, entry)) = evicted.as_ref() {
                    state.current_bytes -= entry.accounted_bytes();
                    state.evictions += 1;
                }
                evicted
            };
            let evicted = evicted?;
            // Drop outside the LRU lock; the reservation releases budget.
            drop(evicted);
        }
    }

    fn reserve_source_body(
        &self,
        bytes: usize,
        view_max_object_bytes: usize,
    ) -> Result<MemoryReservation, object_store::Error> {
        let max_object_bytes = self.max_object_bytes.min(view_max_object_bytes);
        if bytes > max_object_bytes {
            return Err(cache_capacity_error(format!(
                "source object is {bytes} bytes; per-object limit is {} bytes",
                max_object_bytes
            )));
        }
        self.reserve_resident(MemoryCategory::SourceInFlight, bytes)
            .ok_or_else(|| {
                cache_capacity_error(format!(
                    "source object needs {bytes} bytes but the process resident budget is {} bytes",
                    self.budget.max_bytes()
                ))
            })
    }

    fn reserve_cache_entry_metadata(
        &self,
        key: &CacheKey,
    ) -> Result<(usize, Arc<Mutex<MemoryReservation>>), object_store::Error> {
        let charge = cache_entry_metadata_charge(key)?;
        let reservation = self
            .reserve_resident(MemoryCategory::SourceInFlight, charge)
            .ok_or_else(|| {
                cache_capacity_error(format!(
                    "cache key metadata needs {charge} bytes but the process resident budget is {} bytes",
                    self.budget.max_bytes()
                ))
            })?;
        Ok((charge, Arc::new(Mutex::new(reservation))))
    }
}

fn cache_capacity_error(message: String) -> object_store::Error {
    object_store::Error::Generic {
        store: "source-cache",
        source: message.into(),
    }
}

impl CachedStore {
    /// Compatibility/test constructor with an isolated byte budget. Production
    /// bindings should use [`CachedStore::with_shared_cache`].
    pub fn new(inner: Arc<dyn ObjectStore>, max_bytes: usize) -> Self {
        Self::with_source_limiter(inner, max_bytes, global_source_read_limiter().clone())
    }

    /// Isolated constructor with an explicit source-read limiter.
    pub fn with_source_limiter(
        inner: Arc<dyn ObjectStore>,
        max_bytes: usize,
        source_read: Arc<Semaphore>,
    ) -> Self {
        let shared =
            SharedObjectCache::with_budget(MemoryBudget::new(max_bytes), max_bytes, source_read);
        Self::with_shared_cache(inner, Arc::<str>::from("isolated"), shared)
    }

    /// Create a dataset-namespaced view over the process-wide cache. The
    /// namespace must be a collision-resistant admitted source identity.
    pub fn with_shared_cache(
        inner: Arc<dyn ObjectStore>,
        namespace: impl Into<Arc<str>>,
        shared: Arc<SharedObjectCache>,
    ) -> Self {
        let max_object_bytes = shared.max_object_bytes;
        Self::with_shared_cache_limit(inner, namespace, shared, max_object_bytes)
    }

    /// Create a namespaced view with a stricter per-object limit than the
    /// process-wide source-object ceiling. Metadata import uses this to keep
    /// JSON bodies small even when chunk reads are configured for larger
    /// objects.
    pub(crate) fn with_shared_cache_limit(
        inner: Arc<dyn ObjectStore>,
        namespace: impl Into<Arc<str>>,
        shared: Arc<SharedObjectCache>,
        max_object_bytes: usize,
    ) -> Self {
        Self {
            inner,
            namespace: namespace.into(),
            max_object_bytes: max_object_bytes.min(shared.max_object_bytes),
            shared,
        }
    }

    /// Production constructor whose namespace changes whenever source
    /// metadata changes at the same locator.
    pub fn with_source_version(
        inner: Arc<dyn ObjectStore>,
        source: &SourceVersion,
        shared: Arc<SharedObjectCache>,
    ) -> Self {
        Self::with_shared_cache(inner, Arc::<str>::from(source.cache_namespace()), shared)
    }

    pub fn stats(&self) -> CacheStats {
        let state = self.shared.cache.lock().unwrap();
        CacheStats {
            max_bytes: state.max_bytes,
            current_bytes: state.current_bytes,
            entry_count: state.lru.len(),
            hits: state.hits,
            misses: state.misses,
            evictions: state.evictions,
            backend_errors: state.backend_errors,
            coalesced: state.coalesced,
        }
    }

    pub fn memory_snapshot(&self) -> MemoryBudgetSnapshot {
        self.shared.memory_snapshot()
    }

    pub fn reserve_resident(
        &self,
        category: MemoryCategory,
        bytes: usize,
    ) -> Option<MemoryReservation> {
        self.shared.reserve_resident(category, bytes)
    }

    /// Get bytes by path. Cancelled leaders cause followers to re-enter this
    /// same election loop, so a cancellation herd re-coalesces around exactly
    /// one replacement leader.
    pub async fn get_bytes(&self, path: &Path) -> Result<CachedBytes, object_store::Error> {
        let key = CacheKey {
            namespace: Arc::clone(&self.namespace),
            path: path.to_string(),
        };

        loop {
            let generation = self.shared.namespace_generation(&key.namespace);
            {
                let mut state = self.shared.cache.lock().unwrap();
                if let Some(entry) = state
                    .lru
                    .get(&key)
                    .filter(|entry| entry.generation.matches(&generation))
                {
                    let bytes = entry.bytes.clone();
                    state.hits += 1;
                    return Ok(bytes);
                }
                state.misses += 1;
            }

            let election: Result<FlightElection, object_store::Error> = {
                let mut in_flight = self.shared.in_flight.lock().unwrap();
                match in_flight.get(&key) {
                    Some(entry) if entry.generation.matches(&generation) => Ok(FlightElection {
                        id: entry.id,
                        follower: Some(entry.tx.subscribe()),
                        leader: None,
                    }),
                    None => {
                        let (metadata_charge, metadata_reservation) =
                            self.shared.reserve_cache_entry_metadata(&key)?;
                        let leader_metadata = LeaderMetadata {
                            charge: metadata_charge,
                            reservation: Arc::clone(&metadata_reservation),
                        };
                        let (tx, _rx) = broadcast::channel::<ShareResult>(1);
                        let id = self.shared.next_flight_id.fetch_add(1, Ordering::Relaxed);
                        in_flight.insert(
                            key.clone(),
                            InFlightEntry {
                                id,
                                generation: generation.clone(),
                                tx,
                            },
                        );
                        Ok(FlightElection {
                            id,
                            follower: None,
                            leader: Some(leader_metadata),
                        })
                    }
                    Some(_) => {
                        // The key belongs to a retired generation that raced
                        // with invalidation. Replace it; the old guard's id
                        // prevents it from removing or publishing to this entry.
                        let retired = in_flight
                            .remove(&key)
                            .expect("stale in-flight entry still exists");
                        drop(retired);
                        let (metadata_charge, metadata_reservation) =
                            self.shared.reserve_cache_entry_metadata(&key)?;
                        let leader_metadata = LeaderMetadata {
                            charge: metadata_charge,
                            reservation: Arc::clone(&metadata_reservation),
                        };
                        let (tx, _rx) = broadcast::channel::<ShareResult>(1);
                        let id = self.shared.next_flight_id.fetch_add(1, Ordering::Relaxed);
                        in_flight.insert(
                            key.clone(),
                            InFlightEntry {
                                id,
                                generation: generation.clone(),
                                tx,
                            },
                        );
                        Ok(FlightElection {
                            id,
                            follower: None,
                            leader: Some(leader_metadata),
                        })
                    }
                }
            };
            let FlightElection {
                id: flight_id,
                follower: follower_rx,
                leader: leader_metadata,
            } = election?;

            if let Some(mut rx) = follower_rx {
                match rx.recv().await {
                    Ok(shared) => {
                        self.shared.cache.lock().unwrap().coalesced += 1;
                        return shared.map_err(SharedError::into_object_store_error);
                    }
                    // The leader vanished. Loop through cache lookup and the
                    // shared election again instead of every follower issuing
                    // an independent fallback read.
                    Err(_) => continue,
                }
            }

            let LeaderMetadata {
                charge: metadata_charge,
                reservation: metadata_reservation,
            } = leader_metadata.expect("leader election returns its metadata lease");
            let mut guard = LeaderGuard::new(
                &self.shared.in_flight,
                key.clone(),
                flight_id,
                Arc::clone(&metadata_reservation),
            );
            let result = self
                .fetch_from_backend(
                    path,
                    &key,
                    &generation,
                    flight_id,
                    metadata_charge,
                    metadata_reservation,
                )
                .await;
            guard.complete(&result);
            return result;
        }
    }

    async fn fetch_from_backend(
        &self,
        path: &Path,
        key: &CacheKey,
        generation: &NamespaceGeneration,
        flight_id: u64,
        metadata_charge: usize,
        metadata_reservation: Arc<Mutex<MemoryReservation>>,
    ) -> Result<CachedBytes, object_store::Error> {
        let fetch = async {
            let _permit = self
                .shared
                .source_read
                .acquire()
                .await
                .expect("source-read semaphore is never closed");
            let object = self.inner.get(path).await?;
            let expected_u64 = object
                .range
                .end
                .checked_sub(object.range.start)
                .ok_or_else(|| {
                    cache_capacity_error("source object returned an invalid byte range".to_string())
                })?;
            let expected = usize::try_from(expected_u64).map_err(|_| {
                cache_capacity_error("source object size exceeds this platform".to_string())
            })?;
            let reservation = self
                .shared
                .reserve_source_body(expected, self.max_object_bytes)?;
            collect_exact(object.into_stream(), expected)
                .await
                .map(|bytes| (bytes, reservation))
        }
        .await;

        let (bytes, mut reservation) = match fetch {
            Ok(result) => result,
            Err(error) => {
                self.shared.cache.lock().unwrap().backend_errors += 1;
                return Err(error);
            }
        };

        reservation.reclassify(MemoryCategory::SourceCached);
        let owns_flight = {
            let in_flight = self.shared.in_flight.lock().unwrap();
            in_flight
                .get(key)
                .is_some_and(|entry| entry.id == flight_id && entry.generation.matches(generation))
        };
        metadata_reservation
            .lock()
            .unwrap()
            .reclassify(MemoryCategory::SourceCached);
        let mut state = self.shared.cache.lock().unwrap();
        if !owns_flight {
            return Ok(CachedBytes {
                bytes,
                _reservation: Arc::new(reservation),
                _metadata_reservation: metadata_reservation,
            });
        }
        if !generation.is_current() {
            return Ok(CachedBytes {
                bytes,
                _reservation: Arc::new(reservation),
                _metadata_reservation: metadata_reservation,
            });
        }
        if let Some(existing) = state
            .lru
            .get(key)
            .filter(|entry| entry.generation.matches(generation))
        {
            return Ok(existing.bytes.clone());
        }
        // A replacement generation can finish while invalidation is between
        // retiring its predecessor and removing predecessor entries. Replace
        // that specifically stale resident rather than returning its bytes.
        if let Some(stale) = state.lru.pop(key) {
            state.current_bytes -= stale.accounted_bytes();
        }
        let bytes = CachedBytes {
            bytes,
            _reservation: Arc::new(reservation),
            _metadata_reservation: metadata_reservation,
        };
        let entry = CachedEntry {
            bytes: bytes.clone(),
            generation: generation.clone(),
            metadata_charge,
        };
        state.current_bytes += entry.accounted_bytes();
        state.lru.put(key.clone(), entry);
        Ok(bytes)
    }
}

async fn collect_exact(
    mut stream: futures_util::stream::BoxStream<'static, object_store::Result<Bytes>>,
    expected: usize,
) -> Result<Bytes, object_store::Error> {
    let mut output = BytesMut::with_capacity(expected);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let next = output.len().checked_add(chunk.len()).ok_or_else(|| {
            cache_capacity_error("source object body length overflowed".to_string())
        })?;
        if next > expected {
            return Err(cache_capacity_error(format!(
                "source object exceeded declared length of {expected} bytes"
            )));
        }
        output.extend_from_slice(&chunk);
    }
    if output.len() != expected {
        return Err(cache_capacity_error(format!(
            "source object ended at {} bytes; expected {expected}",
            output.len()
        )));
    }
    Ok(output.freeze())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_cache_test_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn insert_test_cache_entry(shared: &Arc<SharedObjectCache>, namespace: Arc<str>, path: &str) {
        let key = CacheKey {
            namespace,
            path: path.to_string(),
        };
        let generation = shared.namespace_generation(&key.namespace);
        let body_reservation = shared
            .budget
            .try_reserve(MemoryCategory::SourceCached, 1)
            .unwrap();
        let metadata_charge = cache_entry_metadata_charge(&key).unwrap();
        let metadata_reservation = shared
            .budget
            .try_reserve(MemoryCategory::SourceCached, metadata_charge)
            .unwrap();
        let entry = CachedEntry {
            bytes: CachedBytes {
                bytes: Bytes::from_static(b"x"),
                _reservation: Arc::new(body_reservation),
                _metadata_reservation: Arc::new(Mutex::new(metadata_reservation)),
            },
            generation,
            metadata_charge,
        };
        let mut state = shared.cache.lock().unwrap();
        state.current_bytes += entry.accounted_bytes();
        state.lru.put(key, entry);
    }

    fn test_metadata_charge(namespace: &str, path: &str) -> usize {
        cache_entry_metadata_charge(&CacheKey {
            namespace: Arc::from(namespace),
            path: path.to_string(),
        })
        .unwrap()
    }

    #[test]
    fn idle_namespace_generation_tokens_are_reclaimed_under_churn() {
        let shared = SharedObjectCache::new(1, 1);
        for index in 0..10_000 {
            let namespace: Arc<str> = Arc::from(format!("churn:{index}"));
            let generation = shared.namespace_generation(&namespace);
            assert!(generation.is_current());
            drop(generation);
            assert!(
                shared
                    .namespace_generations
                    .generations
                    .lock()
                    .unwrap()
                    .is_empty(),
                "idle token survived churn iteration {index}"
            );
        }
    }

    #[test]
    fn source_and_global_invalidation_examine_each_resident_entry_once() {
        const VERSION_COUNT: usize = 256;
        let shared = SharedObjectCache::new(4 * 1024 * 1024, 1);
        let identity = SourceIdentity::parse("gs://bucket/churn.zarr").unwrap();
        for revision in 0..VERSION_COUNT {
            let version = SourceVersion::new(
                identity.clone(),
                lucida_content::url::SourceRevision::from_bytes(
                    format!("revision-{revision}").as_bytes(),
                ),
            );
            insert_test_cache_entry(&shared, Arc::from(version.cache_namespace()), "chunk");
        }
        insert_test_cache_entry(&shared, Arc::from("unrelated"), "chunk");

        shared.invalidation_entry_checks.store(0, Ordering::Relaxed);
        assert_eq!(shared.invalidate_source(&identity), VERSION_COUNT);
        assert_eq!(
            shared.invalidation_entry_checks.load(Ordering::Relaxed),
            (VERSION_COUNT + 1) as u64,
            "source invalidation must make one keyed retired-generation lookup per entry"
        );
        assert_eq!(shared.cache.lock().unwrap().lru.len(), 1);
        assert_eq!(
            shared
                .namespace_generations
                .generations
                .lock()
                .unwrap()
                .len(),
            1
        );

        shared.invalidation_entry_checks.store(0, Ordering::Relaxed);
        assert_eq!(shared.invalidate_all(), 1);
        assert_eq!(shared.invalidation_entry_checks.load(Ordering::Relaxed), 1);
        assert!(
            shared
                .namespace_generations
                .generations
                .lock()
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn cache_hit_returns_same_bytes() {
        let dir = temp_dir("hit");
        fs::write(dir.join("chunk1"), b"hello world").unwrap();

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let path = Path::from("chunk1");
        let first = cached.get_bytes(&path).await.unwrap();
        let second = cached.get_bytes(&path).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(&first[..], b"hello world");
        let stats = cached.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.entry_count, 1);
        assert_eq!(
            stats.current_bytes,
            b"hello world".len() + test_metadata_charge("isolated", "chunk1")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_on_budget_exceeded() {
        let dir = temp_dir("evict");
        fs::write(dir.join("a"), vec![0u8; 60]).unwrap();
        fs::write(dir.join("b"), vec![1u8; 60]).unwrap();

        // The budget holds exactly one body plus its positive key metadata.
        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let budget =
            test_metadata_charge("isolated", "a").max(test_metadata_charge("isolated", "b")) + 60;
        let cached = CachedStore::new(inner, budget);

        let pa = Path::from("a");
        let pb = Path::from("b");

        let a = cached.get_bytes(&pa).await.unwrap();
        // Checked-out bytes deliberately retain their reservation after LRU
        // eviction; release the caller clone so this entry is reclaimable.
        drop(a);
        let _b = cached.get_bytes(&pb).await.unwrap();

        // "a" should have been evicted to make room for "b"
        {
            let state = cached.shared.cache.lock().unwrap();
            assert!(state.current_bytes <= budget);
            assert_eq!(state.lru.len(), 1);
        }
        let stats = cached.stats();
        assert_eq!(stats.evictions, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn shared_cache_evicts_across_dataset_namespaces_under_one_budget() {
        let store_a = Arc::new(CountingStore::new(0));
        let store_b = Arc::new(CountingStore::new(0));
        store_a.seed("chunk", &[1; 60]).await;
        store_b.seed("chunk", &[2; 60]).await;
        let gets_a = Arc::clone(&store_a.get_count);
        let budget = test_metadata_charge("dataset-a", "chunk")
            .max(test_metadata_charge("dataset-b", "chunk"))
            + 60;
        let shared = SharedObjectCache::new(budget, 100);
        let cached_a = CachedStore::with_shared_cache(store_a, "dataset-a", Arc::clone(&shared));
        let cached_b = CachedStore::with_shared_cache(store_b, "dataset-b", Arc::clone(&shared));

        cached_a.get_bytes(&Path::from("chunk")).await.unwrap();
        cached_b.get_bytes(&Path::from("chunk")).await.unwrap();

        let snapshot = shared.memory_snapshot();
        assert_eq!(snapshot.total_bytes, cached_b.stats().current_bytes);
        assert_eq!(snapshot.source_cached_bytes, cached_b.stats().current_bytes);
        assert_eq!(cached_a.stats().entry_count, 1);
        assert_eq!(cached_a.stats().evictions, 1);

        // Dataset B displaced dataset A from the one process-wide LRU, so A
        // must fetch again instead of retaining its own independent 100-byte
        // allowance.
        cached_a.get_bytes(&Path::from("chunk")).await.unwrap();
        assert_eq!(gets_a.load(Ordering::SeqCst), 2);
        assert!(shared.memory_snapshot().total_bytes <= budget);
    }

    #[tokio::test]
    async fn multi_namespace_hot_hits_reuse_allocations_and_hold_budget_flat() {
        let store_a = Arc::new(CountingStore::new(0));
        let store_b = Arc::new(CountingStore::new(0));
        store_a.seed("chunk", &[1; 64]).await;
        store_b.seed("chunk", &[2; 64]).await;
        let gets_a = Arc::clone(&store_a.get_count);
        let gets_b = Arc::clone(&store_b.get_count);
        let budget = test_metadata_charge("workspace-a", "chunk")
            + test_metadata_charge("workspace-b", "chunk")
            + 128;
        let shared = SharedObjectCache::new(budget, 128);
        let cached_a = CachedStore::with_shared_cache(store_a, "workspace-a", Arc::clone(&shared));
        let cached_b = CachedStore::with_shared_cache(store_b, "workspace-b", Arc::clone(&shared));
        let path = Path::from("chunk");

        let first_a = cached_a.get_bytes(&path).await.unwrap();
        let first_b = cached_b.get_bytes(&path).await.unwrap();
        let pointer_a = first_a.as_ptr();
        let pointer_b = first_b.as_ptr();
        let baseline = shared.memory_snapshot();
        assert_eq!(baseline.total_bytes, budget);

        for _ in 0..5_000 {
            let hit_a = cached_a.get_bytes(&path).await.unwrap();
            let hit_b = cached_b.get_bytes(&path).await.unwrap();
            assert_eq!(
                hit_a.as_ptr(),
                pointer_a,
                "hot hit copied workspace A bytes"
            );
            assert_eq!(
                hit_b.as_ptr(),
                pointer_b,
                "hot hit copied workspace B bytes"
            );
        }

        let after = shared.memory_snapshot();
        assert_eq!(
            after, baseline,
            "hot hits must not grow resident accounting"
        );
        assert_eq!(gets_a.load(Ordering::SeqCst), 1);
        assert_eq!(gets_b.load(Ordering::SeqCst), 1);
        assert_eq!(cached_a.stats().hits, 10_000);
    }

    #[tokio::test]
    async fn source_revision_isolates_same_locator_and_identity_invalidation_clears_both() {
        let identity = SourceIdentity::parse("gs://bucket/mutable.zarr").unwrap();
        let revision_a = SourceVersion::new(
            identity.clone(),
            lucida_content::url::SourceRevision::from_bytes(b"a"),
        );
        let revision_b = SourceVersion::new(
            identity.clone(),
            lucida_content::url::SourceRevision::from_bytes(b"b"),
        );
        let store = Arc::new(CountingStore::new(0));
        store.seed("chunk", &[1; 16]).await;
        let budget = test_metadata_charge(&revision_a.cache_namespace(), "chunk")
            + test_metadata_charge(&revision_b.cache_namespace(), "chunk")
            + 32;
        let shared = SharedObjectCache::new(budget, 64);
        let cached_a =
            CachedStore::with_source_version(store.clone(), &revision_a, Arc::clone(&shared));
        cached_a.get_bytes(&Path::from("chunk")).await.unwrap();

        store.seed("chunk", &[2; 16]).await;
        let cached_b = CachedStore::with_source_version(store, &revision_b, Arc::clone(&shared));
        let fresh = cached_b.get_bytes(&Path::from("chunk")).await.unwrap();
        assert_eq!(&fresh[..], &[2; 16]);
        assert_eq!(cached_b.stats().entry_count, 2);
        drop(fresh);

        assert_eq!(shared.invalidate_source(&identity), 2);
        assert_eq!(cached_b.stats().entry_count, 0);
        assert_eq!(shared.memory_snapshot().source_cached_bytes, 0);
    }

    #[tokio::test]
    async fn oversized_object_is_rejected_before_body_collection_and_not_cached() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("huge", &[7; 40]).await;
        let shared = SharedObjectCache::new(test_metadata_charge("dataset", "huge") + 100, 32);
        let cached = CachedStore::with_shared_cache(store, "dataset", Arc::clone(&shared));

        let error = cached.get_bytes(&Path::from("huge")).await.unwrap_err();
        assert!(error.to_string().contains("per-object limit"));
        assert_eq!(cached.stats().entry_count, 0);
        assert_eq!(shared.memory_snapshot().total_bytes, 0);
    }

    #[tokio::test]
    async fn unique_empty_object_churn_is_metadata_bounded_and_drop_reclaims_tokens() {
        const REQUESTS: usize = 10_000;
        const RETAINED_ENTRIES: usize = 3;
        let store = Arc::new(CountingStore::new(0));
        for index in 0..REQUESTS {
            store.seed(&format!("empty-{index:05}"), b"").await;
        }
        let one_entry = test_metadata_charge("empty-churn", "empty-00000");
        let budget_bytes = one_entry * RETAINED_ENTRIES;
        let shared = SharedObjectCache::new(budget_bytes, 1);
        let budget = Arc::clone(shared.budget());
        let registry = Arc::clone(&shared.namespace_generations);
        let cached = CachedStore::with_shared_cache(store, "empty-churn", Arc::clone(&shared));

        for index in 0..REQUESTS {
            let bytes = cached
                .get_bytes(&Path::from(format!("empty-{index:05}")))
                .await
                .unwrap();
            assert!(bytes.is_empty());
            drop(bytes);
            assert!(budget.snapshot().total_bytes <= budget_bytes);
        }

        let stats = cached.stats();
        assert_eq!(stats.entry_count, RETAINED_ENTRIES);
        assert_eq!(stats.current_bytes, budget_bytes);
        assert!(stats.evictions >= (REQUESTS - RETAINED_ENTRIES) as u64);
        assert_eq!(budget.snapshot().source_cached_bytes, budget_bytes);

        drop(cached);
        drop(shared);
        assert_eq!(budget.snapshot().total_bytes, 0);
        assert!(registry.generations.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn retained_empty_results_keep_their_positive_lease_until_drop() {
        let store = Arc::new(CountingStore::new(0));
        for path in ["zero-0", "zero-1", "zero-2", "zero-3"] {
            store.seed(path, b"").await;
        }
        let one_entry = test_metadata_charge("retained-empty", "zero-0");
        let budget_bytes = one_entry * 3;
        let shared = SharedObjectCache::new(budget_bytes, 1);
        let cached =
            CachedStore::with_shared_cache(store.clone(), "retained-empty", Arc::clone(&shared));

        let mut retained = Vec::new();
        for path in ["zero-0", "zero-1", "zero-2"] {
            retained.push(cached.get_bytes(&Path::from(path)).await.unwrap());
        }
        assert_eq!(shared.memory_snapshot().total_bytes, budget_bytes);

        let error = cached.get_bytes(&Path::from("zero-3")).await.unwrap_err();
        assert!(error.to_string().contains("cache key metadata"), "{error}");
        assert_eq!(shared.memory_snapshot().total_bytes, budget_bytes);
        assert_eq!(store.get_count.load(Ordering::SeqCst), 3);

        drop(retained.remove(0));
        let retry = cached.get_bytes(&Path::from("zero-3")).await.unwrap();
        assert!(retry.is_empty());
        assert_eq!(store.get_count.load(Ordering::SeqCst), 4);
        assert!(shared.memory_snapshot().total_bytes <= budget_bytes);

        drop(retry);
        drop(retained);
        drop(cached);
        drop(shared);
    }

    #[tokio::test]
    async fn missing_file_returns_error() {
        let dir = temp_dir("missing");

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let result = cached.get_bytes(&Path::from("nonexistent")).await;
        assert!(result.is_err());
        let stats = cached.stats();
        assert_eq!(stats.backend_errors, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Single-flight, cap, and failure-sharing tests ---
    //
    // These use a counting mock `ObjectStore` with a per-GET delay so
    // concurrent reads genuinely overlap. Assertions are on GET counts and
    // observed max concurrency, never wall-clock time.

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use futures_util::stream::BoxStream;
    use object_store::{
        CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta,
        PutMultipartOptions, PutOptions, PutPayload, PutResult,
    };

    /// `ObjectStore` wrapper that counts `get_opts` calls, tracks peak
    /// concurrency, sleeps before each read so overlaps are deterministic,
    /// and can be toggled to fail every read.
    #[derive(Debug)]
    struct CountingStore {
        inner: Arc<dyn ObjectStore>,
        get_count: Arc<AtomicUsize>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
        delay_ms: u64,
        fail: Arc<AtomicBool>,
    }

    impl CountingStore {
        fn new(delay_ms: u64) -> Self {
            Self {
                inner: Arc::new(object_store::memory::InMemory::new()),
                get_count: Arc::new(AtomicUsize::new(0)),
                active: Arc::new(AtomicUsize::new(0)),
                max_active: Arc::new(AtomicUsize::new(0)),
                delay_ms,
                fail: Arc::new(AtomicBool::new(false)),
            }
        }

        async fn seed(&self, path: &str, bytes: &'static [u8]) {
            self.inner
                .put(&Path::from(path), PutPayload::from_static(bytes))
                .await
                .unwrap();
        }
    }

    impl std::fmt::Display for CountingStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "CountingStore({})", self.inner)
        }
    }

    #[async_trait::async_trait]
    impl ObjectStore for CountingStore {
        async fn put_opts(
            &self,
            location: &Path,
            payload: PutPayload,
            opts: PutOptions,
        ) -> object_store::Result<PutResult> {
            self.inner.put_opts(location, payload, opts).await
        }

        async fn put_multipart_opts(
            &self,
            location: &Path,
            opts: PutMultipartOptions,
        ) -> object_store::Result<Box<dyn MultipartUpload>> {
            self.inner.put_multipart_opts(location, opts).await
        }

        async fn get_opts(
            &self,
            location: &Path,
            options: GetOptions,
        ) -> object_store::Result<GetResult> {
            self.get_count.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            if self.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            let result = if self.fail.load(Ordering::SeqCst) {
                Err(object_store::Error::Generic {
                    store: "counting",
                    source: "injected failure".into(),
                })
            } else {
                self.inner.get_opts(location, options).await
            };
            self.active.fetch_sub(1, Ordering::SeqCst);
            result
        }

        fn delete_stream(
            &self,
            locations: BoxStream<'static, object_store::Result<Path>>,
        ) -> BoxStream<'static, object_store::Result<Path>> {
            self.inner.delete_stream(locations)
        }

        fn list(
            &self,
            prefix: Option<&Path>,
        ) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
            self.inner.list(prefix)
        }

        async fn list_with_delimiter(
            &self,
            prefix: Option<&Path>,
        ) -> object_store::Result<ListResult> {
            self.inner.list_with_delimiter(prefix).await
        }

        async fn copy_opts(
            &self,
            from: &Path,
            to: &Path,
            options: CopyOptions,
        ) -> object_store::Result<()> {
            self.inner.copy_opts(from, to, options).await
        }
    }

    /// Store used to deterministically interleave invalidation with two
    /// generations of the same source read. Each gated GET captures its bytes
    /// before waiting, so mutating the inner object cannot blur old/new results.
    #[derive(Debug)]
    struct InvalidationRaceStore {
        inner: Arc<dyn ObjectStore>,
        get_count: Arc<AtomicUsize>,
        captured: Arc<AtomicUsize>,
        first_release: Arc<tokio::sync::Notify>,
        second_release: Arc<tokio::sync::Notify>,
    }

    impl InvalidationRaceStore {
        fn new() -> Self {
            Self {
                inner: Arc::new(object_store::memory::InMemory::new()),
                get_count: Arc::new(AtomicUsize::new(0)),
                captured: Arc::new(AtomicUsize::new(0)),
                first_release: Arc::new(tokio::sync::Notify::new()),
                second_release: Arc::new(tokio::sync::Notify::new()),
            }
        }

        async fn seed(&self, path: &str, bytes: &'static [u8]) {
            self.inner
                .put(&Path::from(path), PutPayload::from_static(bytes))
                .await
                .unwrap();
        }

        async fn wait_for_captures(&self, expected: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.captured.load(Ordering::SeqCst) < expected {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("gated backend read was never captured");
        }
    }

    impl std::fmt::Display for InvalidationRaceStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "InvalidationRaceStore({})", self.inner)
        }
    }

    #[async_trait::async_trait]
    impl ObjectStore for InvalidationRaceStore {
        async fn put_opts(
            &self,
            location: &Path,
            payload: PutPayload,
            opts: PutOptions,
        ) -> object_store::Result<PutResult> {
            self.inner.put_opts(location, payload, opts).await
        }

        async fn put_multipart_opts(
            &self,
            location: &Path,
            opts: PutMultipartOptions,
        ) -> object_store::Result<Box<dyn MultipartUpload>> {
            self.inner.put_multipart_opts(location, opts).await
        }

        async fn get_opts(
            &self,
            location: &Path,
            options: GetOptions,
        ) -> object_store::Result<GetResult> {
            let index = self.get_count.fetch_add(1, Ordering::SeqCst);
            let result = self.inner.get_opts(location, options).await;
            self.captured.fetch_add(1, Ordering::SeqCst);
            match index {
                0 => self.first_release.notified().await,
                1 => self.second_release.notified().await,
                _ => {}
            }
            result
        }

        fn delete_stream(
            &self,
            locations: BoxStream<'static, object_store::Result<Path>>,
        ) -> BoxStream<'static, object_store::Result<Path>> {
            self.inner.delete_stream(locations)
        }

        fn list(
            &self,
            prefix: Option<&Path>,
        ) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
            self.inner.list(prefix)
        }

        async fn list_with_delimiter(
            &self,
            prefix: Option<&Path>,
        ) -> object_store::Result<ListResult> {
            self.inner.list_with_delimiter(prefix).await
        }

        async fn copy_opts(
            &self,
            from: &Path,
            to: &Path,
            options: CopyOptions,
        ) -> object_store::Result<()> {
            self.inner.copy_opts(from, to, options).await
        }
    }

    #[derive(Clone, Copy)]
    enum RaceInvalidation {
        Source,
        All,
    }

    async fn assert_invalidation_retires_old_leader(kind: RaceInvalidation) {
        let identity = SourceIdentity::parse("gs://bucket/mutable.zarr").unwrap();
        let version = SourceVersion::new(
            identity.clone(),
            lucida_content::url::SourceRevision::from_bytes(b"revision"),
        );
        let store = Arc::new(InvalidationRaceStore::new());
        store.seed("chunk", b"old").await;
        let shared = SharedObjectCache::new(
            test_metadata_charge(&version.cache_namespace(), "chunk") * 2 + 128,
            64,
        );
        let cached = Arc::new(CachedStore::with_source_version(
            store.clone(),
            &version,
            Arc::clone(&shared),
        ));

        let old = {
            let cached = Arc::clone(&cached);
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        store.wait_for_captures(1).await;

        match kind {
            RaceInvalidation::Source => {
                shared.invalidate_source(&identity);
            }
            RaceInvalidation::All => {
                shared.invalidate_all();
            }
        }
        store.seed("chunk", b"new").await;
        let replacement = {
            let cached = Arc::clone(&cached);
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        store.wait_for_captures(2).await;

        // Complete the retired leader while the replacement remains live.
        // Its result may satisfy its original caller, but must neither cache
        // stale bytes nor remove the replacement's in-flight entry.
        store.first_release.notify_one();
        assert_eq!(&old.await.unwrap().unwrap()[..], b"old");
        let key = CacheKey {
            namespace: Arc::from(version.cache_namespace()),
            path: "chunk".to_string(),
        };
        assert!(
            shared.in_flight.lock().unwrap().contains_key(&key),
            "retired leader removed the replacement generation's flight"
        );

        let follower = {
            let cached = Arc::clone(&cached);
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        tokio::task::yield_now().await;
        assert_eq!(store.get_count.load(Ordering::SeqCst), 2);

        store.second_release.notify_one();
        assert_eq!(&replacement.await.unwrap().unwrap()[..], b"new");
        assert_eq!(&follower.await.unwrap().unwrap()[..], b"new");

        let hit = cached.get_bytes(&Path::from("chunk")).await.unwrap();
        assert_eq!(&hit[..], b"new");
        assert_eq!(store.get_count.load(Ordering::SeqCst), 2);
        assert_eq!(cached.stats().entry_count, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn source_invalidation_retires_old_leader_without_clobbering_replacement() {
        assert_invalidation_retires_old_leader(RaceInvalidation::Source).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn clear_all_retires_old_leader_without_clobbering_replacement() {
        assert_invalidation_retires_old_leader(RaceInvalidation::All).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn retired_cleanup_preserves_forced_replacement_generation_interleaving() {
        let identity = SourceIdentity::parse("gs://bucket/replacement.zarr").unwrap();
        let version = SourceVersion::new(
            identity,
            lucida_content::url::SourceRevision::from_bytes(b"revision"),
        );
        let namespace: Arc<str> = Arc::from(version.cache_namespace());
        let store = Arc::new(InvalidationRaceStore::new());
        store.seed("chunk", b"replacement").await;
        let shared = SharedObjectCache::new(
            test_metadata_charge(&version.cache_namespace(), "chunk") + 128,
            64,
        );
        let cached = Arc::new(CachedStore::with_source_version(
            store.clone(),
            &version,
            Arc::clone(&shared),
        ));

        // Force the exact invalidation gap: retire the registered generation,
        // then let a reader create the replacement generation before cleanup.
        let original = shared.namespace_generation(&namespace);
        let retired = shared.retire_namespaces(|candidate| candidate == namespace.as_ref());
        assert_eq!(retired.len(), 1);
        assert!(!original.is_current());

        let replacement = {
            let cached = Arc::clone(&cached);
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        store.wait_for_captures(1).await;
        let key = CacheKey {
            namespace: Arc::clone(&namespace),
            path: "chunk".to_string(),
        };

        assert_eq!(shared.remove_retired_namespaces(&retired), 0);
        assert!(
            shared.in_flight.lock().unwrap().contains_key(&key),
            "retired cleanup detached the replacement generation's flight"
        );

        let follower = {
            let cached = Arc::clone(&cached);
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        tokio::task::yield_now().await;
        assert_eq!(store.get_count.load(Ordering::SeqCst), 1);

        store.first_release.notify_one();
        assert_eq!(&replacement.await.unwrap().unwrap()[..], b"replacement");
        assert_eq!(&follower.await.unwrap().unwrap()[..], b"replacement");

        // The same retired cleanup must also leave a completed replacement
        // resident alone; the next read is a hit, not a second backend fetch.
        assert_eq!(shared.remove_retired_namespaces(&retired), 0);
        let hit = cached.get_bytes(&Path::from("chunk")).await.unwrap();
        assert_eq!(&hit[..], b"replacement");
        assert_eq!(store.get_count.load(Ordering::SeqCst), 1);
        assert_eq!(cached.stats().entry_count, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_same_path_misses_collapse_to_one_backend_get() {
        let store = Arc::new(CountingStore::new(50));
        store.seed("chunk", b"payload").await;
        let get_count = store.get_count.clone();

        // Generous limiter so the cap never masks single-flight behavior.
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            Arc::new(Semaphore::new(64)),
        ));

        let waiters = 8;
        let mut handles = Vec::new();
        for _ in 0..waiters {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached.get_bytes(&Path::from("chunk")).await
            }));
        }

        for handle in handles {
            let bytes = handle.await.unwrap().unwrap();
            assert_eq!(&bytes[..], b"payload");
        }

        // Exactly one backend read despite `waiters` concurrent misses.
        assert_eq!(get_count.load(Ordering::SeqCst), 1);

        let stats = cached.stats();
        assert_eq!(stats.coalesced, waiters - 1);
        assert_eq!(stats.entry_count, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shared_failure_is_not_cached_and_reattempts() {
        let store = Arc::new(CountingStore::new(50));
        store.seed("chunk", b"payload").await;
        store.fail.store(true, Ordering::SeqCst);
        let get_count = store.get_count.clone();
        let fail = store.fail.clone();

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            Arc::new(Semaphore::new(64)),
        ));

        // Concurrent failing misses collapse to one backend GET; every
        // waiter surfaces an error.
        let waiters = 6;
        let mut handles = Vec::new();
        for _ in 0..waiters {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached.get_bytes(&Path::from("chunk")).await
            }));
        }
        for handle in handles {
            assert!(handle.await.unwrap().is_err());
        }

        assert_eq!(get_count.load(Ordering::SeqCst), 1);
        {
            let stats = cached.stats();
            // Only the leader records a backend error; followers are spared
            // the GET but still surface the shared failure.
            assert_eq!(stats.backend_errors, 1);
            assert_eq!(stats.coalesced, waiters - 1);
            // The failure was not cached.
            assert_eq!(stats.entry_count, 0);
        }

        // A later read re-attempts the backend and now succeeds.
        fail.store(false, Ordering::SeqCst);
        let bytes = cached.get_bytes(&Path::from("chunk")).await.unwrap();
        assert_eq!(&bytes[..], b"payload");
        assert_eq!(get_count.load(Ordering::SeqCst), 2);
        assert_eq!(cached.stats().entry_count, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_distinct_misses_are_bounded_by_the_cap() {
        let store = Arc::new(CountingStore::new(50));
        let distinct = 8usize;
        for i in 0..distinct {
            // Static leak keeps a `'static` slice for the seed helper; fine
            // for a small, single-run test.
            let bytes: &'static [u8] = Box::leak(vec![b'x'; 4].into_boxed_slice());
            store.seed(&format!("chunk-{i}"), bytes).await;
        }
        let get_count = store.get_count.clone();
        let max_active = store.max_active.clone();

        let cap = 3;
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024 * 1024,
            Arc::new(Semaphore::new(cap)),
        ));

        let mut handles = Vec::new();
        for i in 0..distinct {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached.get_bytes(&Path::from(format!("chunk-{i}"))).await
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        // All distinct paths → no dedup; every one hit the backend.
        assert_eq!(get_count.load(Ordering::SeqCst), distinct);
        // Never more than `cap` backend reads in flight at once.
        assert!(
            max_active.load(Ordering::SeqCst) <= cap,
            "observed max concurrency {} exceeded cap {cap}",
            max_active.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn shared_error_preserves_error_variant_for_classification() {
        use object_store::Error;

        fn boxed(msg: &str) -> Box<dyn std::error::Error + Send + Sync> {
            msg.to_string().into()
        }

        let not_found = Error::NotFound {
            path: "chunk".into(),
            source: boxed("missing"),
        };
        let denied = Error::PermissionDenied {
            path: "chunk".into(),
            source: boxed("403 Forbidden"),
        };
        let unauth = Error::Unauthenticated {
            path: "chunk".into(),
            source: boxed("401 credentials expired"),
        };
        let throttled = Error::Generic {
            store: "source",
            source: boxed("503 Service Unavailable"),
        };

        // Not-found survives as the NotFound *variant*, so a coalesced 404
        // follower is still recognized by variant match (not a brittle
        // message substring) and served as zero-filled sparse data.
        assert!(matches!(
            SharedError::capture(&not_found).into_object_store_error(),
            Error::NotFound { .. }
        ));
        // Both 403 and 401 stay permission-class, so a coalesced follower of a
        // permission failure is still classified permanent — no retry storm.
        assert!(matches!(
            SharedError::capture(&denied).into_object_store_error(),
            Error::PermissionDenied { .. }
        ));
        assert!(matches!(
            SharedError::capture(&unauth).into_object_store_error(),
            Error::PermissionDenied { .. }
        ));
        // Everything else collapses to Generic → unavailable → client
        // transient, so a throttled follower self-heals.
        assert!(matches!(
            SharedError::capture(&throttled).into_object_store_error(),
            Error::Generic { .. }
        ));

        // The leader's message is preserved verbatim for downstream detail.
        let reconstructed = SharedError::capture(&throttled).into_object_store_error();
        assert!(
            reconstructed
                .to_string()
                .contains("503 Service Unavailable"),
            "reconstructed error dropped the leader's message: {reconstructed}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelled_leader_does_not_wedge_the_path() {
        let store = Arc::new(CountingStore::new(200));
        store.seed("chunk", b"payload").await;

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            Arc::new(Semaphore::new(64)),
        ));

        // A leader registers the in-flight entry and begins the (slow) backend
        // read, then is cancelled by the timeout before it can broadcast.
        let cancelled = tokio::time::timeout(
            Duration::from_millis(20),
            cached.get_bytes(&Path::from("chunk")),
        )
        .await;
        assert!(
            cancelled.is_err(),
            "leader should have been cancelled mid-fetch"
        );

        // The guard cleared the in-flight entry rather than leaking it.
        {
            let in_flight = cached.shared.in_flight.lock().unwrap();
            assert!(
                in_flight.is_empty(),
                "cancelled leader left a stranded in-flight entry"
            );
        }

        // A subsequent request for the same path completes normally instead of
        // awaiting a broadcast that will never come.
        let bytes = tokio::time::timeout(
            Duration::from_secs(5),
            cached.get_bytes(&Path::from("chunk")),
        )
        .await
        .expect("subsequent request must not be wedged")
        .expect("subsequent request should succeed");
        assert_eq!(&bytes[..], b"payload");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn follower_falls_back_when_leader_is_cancelled() {
        let store = Arc::new(CountingStore::new(200));
        store.seed("chunk", b"payload").await;

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            Arc::new(Semaphore::new(64)),
        ));

        // Leader claims the path and starts its slow read.
        let leader = {
            let cached = cached.clone();
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        tokio::time::sleep(Duration::from_millis(40)).await;

        // Follower subscribes to the leader's in-flight channel and parks.
        let follower = {
            let cached = cached.clone();
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        tokio::time::sleep(Duration::from_millis(40)).await;

        // Cancel the leader mid-read; awaiting the aborted handle guarantees
        // its guard has run (entry removed, sender dropped) before we proceed.
        leader.abort();
        let _ = leader.await;

        // The follower observed the dropped sender, fell back to its own read,
        // and still gets the bytes — a cancelled leader does not dark-hole the
        // coalesced waiters.
        let bytes = tokio::time::timeout(Duration::from_secs(5), follower)
            .await
            .expect("follower must not be wedged")
            .expect("follower task panicked")
            .expect("follower fetch should succeed");
        assert_eq!(&bytes[..], b"payload");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelled_leader_followers_recoalesce_around_one_replacement() {
        let store = Arc::new(CountingStore::new(200));
        store.seed("chunk", b"payload").await;
        let get_count = Arc::clone(&store.get_count);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            Arc::new(Semaphore::new(64)),
        ));

        let leader = {
            let cached = Arc::clone(&cached);
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;

        let followers = (0..8)
            .map(|_| {
                let cached = Arc::clone(&cached);
                tokio::spawn(async move { cached.get_bytes(&Path::from("chunk")).await })
            })
            .collect::<Vec<_>>();
        tokio::time::sleep(Duration::from_millis(30)).await;
        leader.abort();
        let _ = leader.await;

        for follower in followers {
            let bytes = follower.await.unwrap().unwrap();
            assert_eq!(&bytes[..], b"payload");
        }
        assert_eq!(
            get_count.load(Ordering::SeqCst),
            2,
            "one cancelled leader plus exactly one replacement backend read"
        );
    }

    #[test]
    fn configured_source_read_limit_defaults_and_overrides() {
        // Default when unset.
        // SAFETY: single-threaded test; no other thread reads the env here.
        unsafe {
            std::env::remove_var(SOURCE_READ_CONCURRENCY_ENV);
        }
        assert_eq!(
            configured_source_read_limit(),
            DEFAULT_SOURCE_READ_CONCURRENCY
        );

        unsafe {
            std::env::set_var(SOURCE_READ_CONCURRENCY_ENV, "5");
        }
        assert_eq!(configured_source_read_limit(), 5);

        // Garbage and zero fall back to the default rather than wedging reads.
        unsafe {
            std::env::set_var(SOURCE_READ_CONCURRENCY_ENV, "not-a-number");
        }
        assert_eq!(
            configured_source_read_limit(),
            DEFAULT_SOURCE_READ_CONCURRENCY
        );
        unsafe {
            std::env::set_var(SOURCE_READ_CONCURRENCY_ENV, "0");
        }
        assert_eq!(
            configured_source_read_limit(),
            DEFAULT_SOURCE_READ_CONCURRENCY
        );

        unsafe {
            std::env::remove_var(SOURCE_READ_CONCURRENCY_ENV);
        }
    }
}
