//! Memory-bounded LRU Chunk Cache wrapping a StorageBackend.
//!
//! Caches chunk bytes fetched from an ObjectStore to reduce repeated reads
//! when multiple Clients view the same region.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use bytes::Bytes;
use lru::LruCache;
use object_store::ObjectStore;
use object_store::path::Path;
use serde::{Deserialize, Serialize};
use tokio::sync::{Semaphore, broadcast};

use crate::metadata_reads::{self, MetadataReadPhase};
use crate::source_limiter::{ReaderId, RequestLabel, SourceReadLimiter};

/// Default cap on concurrent backend source reads when no operator override
/// is supplied.
///
/// Measured, not chosen: `docs/research/source-read-concurrency.md` sweeps this
/// value against the real remote collection from #899 (up to 1,200 reads per level,
/// levels interleaved across passes). Completed reads per second, pooled:
///
/// ```text
///    8 -> 35.7      24 -> 57.1      96 -> 43.7
///   12 -> 50.8      32 -> 59.2     128 -> 42.8
///   16 -> 57.0      48 -> 53.7
/// ```
///
/// The plateau starts at 16 and the aggregate bandwidth flattens with it at
/// ~18 MiB/s, so past 16 the link is the constraint, not the cap. Everything
/// above the plateau still costs: body-transfer p50 runs ~117 ms at 16, ~198 ms
/// at 24 and ~280 ms at 32 for the same bytes, and by 48 throughput is falling.
/// Extra permits past the knee do not deliver chunks sooner, they relocate the
/// wait from our queue into the transfer — the outcome #901 warned about. 16 is
/// the smallest cap that reaches the plateau, so it takes the throughput
/// without the tail.
///
/// The old value of 12 sat just below the plateau, worth ~12 % of throughput.
/// It was not, as #900 supposed, the reason the fetch rate stalls: raising it
/// past 16 makes things worse, because the ceiling is the link.
///
/// This is a bound on lucida's demand, not a property of the store, and the
/// knee moves with the link. An operator on a fatter one can raise it with
/// [`SOURCE_READ_CONCURRENCY_ENV`]; `docs/research/source-read-concurrency-harness/`
/// re-runs the sweep to find where their own knee is.
const DEFAULT_SOURCE_READ_CONCURRENCY: usize = 16;

/// Byte budget for one dataset's source cache. Every production caller sizes
/// its `CachedStore` from this constant so the metadata reads an open performs
/// and the chunk reads that follow share one budget of a known size.
pub const DEFAULT_SOURCE_CACHE_BYTES: usize = 512 * 1024 * 1024;

/// Cap on concurrent backend reads of *metadata* objects, which are bounded
/// separately from chunk reads. Not operator-tunable: unlike the chunk cap it
/// has no pressure to relieve — it tracks the import pipeline's fan-out, and
/// the two move together.
///
/// A metadata object is a few kilobytes of JSON and an open reads hundreds of
/// them back to back, so the cost profile is round trips, not bytes: the two
/// classes want different bounds and sharing one would make an open queue
/// behind the chunk cap for no bandwidth reason. This matches the fan-out the
/// import pipeline already drives (`METADATA_FETCH_CONCURRENCY`).
const DEFAULT_METADATA_READ_CONCURRENCY: usize = 32;

/// How many known-absent object paths
/// [`CachedStore::get_optional_metadata_bytes`] remembers. Each entry is a
/// path string, so the memo is bounded by count rather than charged against
/// the byte budget; 64k paths is far more than any single open probes and
/// still trivially small next to the byte cache.
const ABSENT_MEMO_CAPACITY: usize = 65_536;

/// Environment variable an operator can set to override the process-global
/// concurrent-source-read cap. Read once, the first time the limiter is used.
const SOURCE_READ_CONCURRENCY_ENV: &str = "LUCIDA_SOURCE_READ_CONCURRENCY";

/// The process-global limiter shared by every [`CachedStore`] built via
/// [`CachedStore::new`].
///
/// There is one `CachedStore` per source, so a per-instance limiter would let
/// the effective concurrency scale with the number of open datasets and defeat
/// the cap entirely. A single shared limiter keeps the bound over the whole
/// process regardless of how many datasets are open.
///
/// The *bound* is global; the *admission* is not. Reads queue per reader and
/// are admitted least-in-flight-first, so one client opening a large
/// collection cannot starve another client on the same server — see
/// [`SourceReadLimiter`] and ADR 0053.
fn global_source_read_limiter() -> &'static Arc<SourceReadLimiter> {
    static LIMITER: OnceLock<Arc<SourceReadLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| SourceReadLimiter::new(configured_source_read_limit()))
}

/// The process-global limiter for metadata reads, the counterpart to
/// [`global_source_read_limiter`] for the other read class.
fn global_metadata_read_limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(DEFAULT_METADATA_READ_CONCURRENCY)))
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

/// What a caller is reading, which decides two things a read cannot decide
/// for itself: which concurrency cap bounds it, and whether a not-found
/// answer is a fault or an answer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ReadClass {
    /// A chunk of the data itself. Bounded by the chunk cap; a not-found is
    /// counted as a backend error, as it has always been.
    Chunk,
    /// A metadata object the dataset is expected to have.
    Metadata,
    /// A metadata object the dataset may or may not have (a `labels/`
    /// index). Bounded like other metadata, but a not-found is the answer —
    /// counting it would report a perfectly healthy dataset as degraded.
    OptionalMetadata,
}

impl ReadClass {
    /// Whether a read belongs to the dataset-open metadata family. The two
    /// metadata classes differ only in what a not-found answer means, and
    /// both are read while an open is resolving a dataset's shape.
    fn is_metadata(self) -> bool {
        matches!(self, ReadClass::Metadata | ReadClass::OptionalMetadata)
    }
}

/// A read's claim on whichever cap bounds its [`ReadClass`], held for the
/// duration of the backend round trip and released on drop.
///
/// The two classes queue on different machinery — chunks on the fair-share
/// [`SourceReadLimiter`], metadata on a plain semaphore — and this is what
/// lets one `match` on the class cover both. Splitting it into two optional
/// permits would state the same mapping twice, in complementary directions,
/// with nothing keeping them agreeing.
///
/// Neither payload is ever read: a permit is held, not consulted, and the
/// release is its `Drop`.
#[allow(dead_code)]
enum ReadPermit<'a> {
    Chunk(crate::source_limiter::SourcePermit),
    Metadata(tokio::sync::SemaphorePermit<'a>),
}

/// Result shared over the in-flight broadcast. Success carries `Bytes`
/// (cheap, reference-counted clones); failure carries a [`SharedError`].
type ShareResult = Result<Bytes, SharedError>;

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
    /// Backend round trips actually performed (successes and failures).
    /// Distinct from `misses`: a miss that coalesces behind a leader, or one
    /// served by the LRU insert race, costs no round trip.
    pub source_reads: u64,
    /// Cumulative wall time spent in those round trips, in milliseconds.
    /// Measured from the moment a read starts queueing for a source-read
    /// permit to the moment its body is in hand, so it includes lucida's own
    /// queueing behind the concurrency cap — which remote measurement shows
    /// is comparable to the network wait itself. Reads overlap, so this is a
    /// sum of per-read latencies, not elapsed wall time.
    pub source_read_millis: u64,
}

/// A memory-bounded LRU cache wrapping an ObjectStore.
pub struct CachedStore {
    inner: Arc<dyn ObjectStore>,
    cache: Mutex<LruState>,
    /// In-flight backend reads keyed by object path. Concurrent misses for
    /// the same path subscribe to the leader's broadcast instead of each
    /// hitting the backend.
    in_flight: Mutex<HashMap<String, broadcast::Sender<ShareResult>>>,
    /// Paths [`CachedStore::get_optional_metadata_bytes`] has found absent, so a
    /// repeated probe for the same optional object costs no round trip.
    ///
    /// Deliberately separate from the byte cache and consulted only by that
    /// method: an absent *chunk* is legitimate sparse data whose absence is a
    /// property of the data, and remembering it would make a chunk that
    /// appears later read as empty. An absent *optional metadata object* — a
    /// `labels/zarr.json` that a dataset simply does not have — is a property
    /// of the dataset's shape, and re-probing it on every open is pure cost:
    /// on a wide remote collection these 404s are a large fraction of the
    /// open's reads.
    absent: Mutex<LruCache<String, ()>>,
    /// Caps concurrent backend chunk reads and decides whose read goes next.
    /// Shared process-wide by default (see [`global_source_read_limiter`]); a
    /// dedicated limiter can be threaded in via
    /// [`CachedStore::with_source_limiter`].
    source_read: Arc<SourceReadLimiter>,
    /// Caps concurrent backend metadata reads, independently of chunk reads
    /// (see [`DEFAULT_METADATA_READ_CONCURRENCY`]).
    metadata_read: Arc<Semaphore>,
}

struct LruState {
    lru: LruCache<String, Bytes>,
    current_bytes: usize,
    max_bytes: usize,
    hits: u64,
    misses: u64,
    evictions: u64,
    backend_errors: u64,
    coalesced: u64,
    source_reads: u64,
    source_read_nanos: u128,
}

/// The shared in-flight registry keyed by object path.
type InFlight = Mutex<HashMap<String, broadcast::Sender<ShareResult>>>;

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
    key: String,
    /// Set once [`complete`](Self::complete) has removed the entry, so `Drop`
    /// does not remove it a second time.
    completed: bool,
}

impl<'a> LeaderGuard<'a> {
    fn new(in_flight: &'a InFlight, key: String) -> Self {
        LeaderGuard {
            in_flight,
            key,
            completed: false,
        }
    }

    /// Publish the leader's outcome to all current followers and remove the
    /// in-flight entry. Called exactly once on the normal-completion path.
    fn complete(&mut self, result: &Result<Bytes, object_store::Error>) {
        let mut in_flight = self.in_flight.lock().unwrap();
        if let Some(tx) = in_flight.remove(&self.key) {
            let payload: ShareResult = match result {
                Ok(bytes) => Ok(bytes.clone()),
                Err(error) => Err(SharedError::capture(error)),
            };
            let _ = tx.send(payload);
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
        in_flight.remove(&self.key);
    }
}

/// Live source caches, keyed by the caller's source identity.
///
/// Held weakly on purpose: the registry exists so two bindings on the same
/// source (the same dataset open in two workspaces, or reopened after a
/// workspace wake) read through one warm cache instead of each paying the
/// source's metadata round trips again. It must not, however, keep a
/// half-gigabyte budget alive for a source nothing is looking at any more, so
/// the last binding to drop its `Arc` releases the cache.
fn source_cache_registry() -> &'static Mutex<HashMap<String, std::sync::Weak<CachedStore>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, std::sync::Weak<CachedStore>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

impl CachedStore {
    /// The cache for one source, shared with any live caller that asked for
    /// the same `source_key`.
    ///
    /// `source_key` must identify the *source* (lucida uses the canonical
    /// URL's dataset source id), not the workspace-local dataset: two
    /// workspaces viewing one URL are two datasets over one source, and the
    /// second open should be served from what the first already read.
    /// `inner` and `max_bytes` are used only when no live cache exists for
    /// the key.
    pub fn shared_for_source(
        source_key: &str,
        inner: Arc<dyn ObjectStore>,
        max_bytes: usize,
    ) -> Arc<Self> {
        let mut registry = source_cache_registry().lock().unwrap();
        if let Some(live) = registry.get(source_key).and_then(std::sync::Weak::upgrade) {
            return live;
        }
        let created = Arc::new(Self::new(inner, max_bytes));
        registry.insert(source_key.to_string(), Arc::downgrade(&created));
        // Drop the tombstones left by sources that have since closed. Bounded
        // work proportional to the registry, run only when a source is opened.
        registry.retain(|_, weak| weak.strong_count() > 0);
        created
    }

    /// Create a new CachedStore wrapping `inner` with a maximum cache size of
    /// `max_bytes`. Backend-read concurrency is bounded by the process-global
    /// limiter shared with every other `CachedStore` built this way.
    pub fn new(inner: Arc<dyn ObjectStore>, max_bytes: usize) -> Self {
        Self::with_source_limiter(inner, max_bytes, global_source_read_limiter().clone())
    }

    /// Like [`CachedStore::new`], but with an explicit source-read limiter.
    /// Production code uses [`CachedStore::new`] so all instances share one
    /// process-global cap; threading in a dedicated limiter is useful for
    /// callers that need an isolated, independently sized bound.
    pub fn with_source_limiter(
        inner: Arc<dyn ObjectStore>,
        max_bytes: usize,
        source_read: Arc<SourceReadLimiter>,
    ) -> Self {
        Self {
            inner,
            cache: Mutex::new(LruState {
                lru: LruCache::unbounded(),
                current_bytes: 0,
                max_bytes,
                hits: 0,
                misses: 0,
                evictions: 0,
                backend_errors: 0,
                coalesced: 0,
                source_reads: 0,
                source_read_nanos: 0,
            }),
            in_flight: Mutex::new(HashMap::new()),
            absent: Mutex::new(LruCache::new(
                std::num::NonZeroUsize::new(ABSENT_MEMO_CAPACITY).expect("capacity is non-zero"),
            )),
            source_read,
            metadata_read: global_metadata_read_limiter().clone(),
        }
    }

    pub fn stats(&self) -> CacheStats {
        let state = self.cache.lock().unwrap();
        CacheStats {
            max_bytes: state.max_bytes,
            current_bytes: state.current_bytes,
            entry_count: state.lru.len(),
            hits: state.hits,
            misses: state.misses,
            evictions: state.evictions,
            backend_errors: state.backend_errors,
            coalesced: state.coalesced,
            source_reads: state.source_reads,
            source_read_millis: (state.source_read_nanos / 1_000_000) as u64,
        }
    }

    /// Get bytes by path, returning cached data on hit or fetching from the
    /// inner store on miss.
    ///
    /// Concurrent misses for the same path are coalesced: one caller becomes
    /// the leader and performs the single backend read while the others wait
    /// for its result. On success every waiter receives the same bytes and
    /// the value is inserted into the LRU once. On failure the leader's error
    /// is surfaced to all current waiters and is **not** cached, so a later
    /// read re-attempts the backend.
    ///
    /// `reader` is the fairness class the backend read is charged to — the
    /// requesting client, so no client's backlog delays another's first read.
    /// A follower is charged nothing: it performs no read. Its bytes therefore
    /// arrive on the *leader's* permit, so a read coalesced onto another
    /// client's leader is admitted on that client's share. That is the right
    /// answer — the work happens once and someone has to own it — and it can
    /// only ever make a follower faster than its own share would.
    ///
    /// `label` is the requesting browser's correlation label for this chunk,
    /// carried across the hop so a permit wait can be attributed to a request
    /// rather than only to a client (ADR 0048).
    pub async fn get_bytes(
        &self,
        path: &Path,
        reader: ReaderId,
        label: RequestLabel,
    ) -> Result<Bytes, object_store::Error> {
        self.get_bytes_as(path, ReadClass::Chunk, reader, label)
            .await
    }

    /// Read a metadata object (a `zarr.json` and friends) through the same
    /// cache, bounded by the metadata-read cap rather than the chunk one.
    /// See [`DEFAULT_METADATA_READ_CONCURRENCY`] for why the two classes are
    /// counted apart.
    pub async fn get_metadata_bytes(&self, path: &Path) -> Result<Bytes, object_store::Error> {
        self.get_bytes_as(
            path,
            ReadClass::Metadata,
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
        )
        .await
    }

    /// Answer whether an object exists without transferring its body.
    ///
    /// This is a HEAD, not a GET: the caller wants presence, and a chunk body
    /// can be megabytes. Bounded by the metadata cap, since the question is
    /// asked about the shape of a dataset rather than about its data, and a
    /// not-found is the answer rather than a fault — so it never counts as a
    /// backend error. Absence is remembered in the same store as
    /// [`get_optional_metadata_bytes`], and a body already resident in the LRU
    /// answers `true` locally.
    ///
    /// [`get_optional_metadata_bytes`]: Self::get_optional_metadata_bytes
    pub async fn probe_exists(&self, path: &Path) -> Result<bool, object_store::Error> {
        let key = path.to_string();
        let started = std::time::Instant::now();
        {
            let mut absent = self.absent.lock().unwrap();
            if absent.get(&key).is_some() {
                drop(absent);
                let mut state = self.cache.lock().unwrap();
                state.hits += 1;
                drop(state);
                metadata_reads::record(MetadataReadPhase::CacheHit, started, false);
                return Ok(false);
            }
        }
        {
            let mut state = self.cache.lock().unwrap();
            if state.lru.get(&key).is_some() {
                state.hits += 1;
                drop(state);
                metadata_reads::record(MetadataReadPhase::CacheHit, started, false);
                return Ok(true);
            }
            state.misses += 1;
        }

        // The cache's own read-cost counter times from the moment the read
        // starts queueing, which is where it has always started. The row
        // above times from the call, because where a read sits inside an
        // open is measured from when the open asked for it.
        let read_started = std::time::Instant::now();
        let head = {
            let _permit = self
                .metadata_read
                .acquire()
                .await
                .expect("source-read semaphore is never closed");
            self.inner.head(path).await
        };
        let elapsed_nanos = read_started.elapsed().as_nanos();
        // A presence probe is a round trip like any other and queues behind
        // the same cap, so it files the same phase.
        metadata_reads::record(
            MetadataReadPhase::BackendRead,
            started,
            !matches!(head, Ok(_) | Err(object_store::Error::NotFound { .. })),
        );

        // The round trip happened whatever it answered, so it is counted once
        // here rather than in each arm below.
        {
            let mut state = self.cache.lock().unwrap();
            state.source_reads += 1;
            state.source_read_nanos += elapsed_nanos;
            if !matches!(head, Ok(_) | Err(object_store::Error::NotFound { .. })) {
                state.backend_errors += 1;
            }
        }

        match head {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => {
                self.absent.lock().unwrap().put(key, ());
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    async fn get_bytes_as(
        &self,
        path: &Path,
        class: ReadClass,
        reader: ReaderId,
        label: RequestLabel,
    ) -> Result<Bytes, object_store::Error> {
        let key = path.to_string();
        // Only metadata reads are watched, and only they pay for the clock
        // read: the chunk path is timed at the request boundary instead.
        let started = class.is_metadata().then(std::time::Instant::now);

        // Cache hit — served without touching the backend or a permit.
        {
            let mut state = self.cache.lock().unwrap();
            if let Some(bytes) = state.lru.get(&key) {
                let bytes = bytes.clone();
                state.hits += 1;
                drop(state);
                if let Some(started) = started {
                    metadata_reads::record(MetadataReadPhase::CacheHit, started, false);
                }
                return Ok(bytes);
            }
            state.misses += 1;
        }

        // Single-flight: claim leadership by registering a broadcast sender,
        // or subscribe to an existing leader's channel as a follower.
        let follower_rx: Option<broadcast::Receiver<ShareResult>> = {
            let mut in_flight = self.in_flight.lock().unwrap();
            match in_flight.get(&key) {
                Some(tx) => Some(tx.subscribe()),
                None => {
                    let (tx, _rx) = broadcast::channel::<ShareResult>(1);
                    in_flight.insert(key.clone(), tx);
                    None
                }
            }
        };

        if let Some(mut rx) = follower_rx {
            return match rx.recv().await {
                // Served by the leader — count the coalesce and surface the
                // leader's outcome, reconstructed with the leader's error
                // variant so it triages identically. A shared failure is not
                // cached.
                Ok(shared) => {
                    {
                        let mut state = self.cache.lock().unwrap();
                        state.coalesced += 1;
                    }
                    // A follower's row owns its wait and nothing else. The
                    // round trip belongs to the leader's row, so a sum over
                    // the backend column counts each one exactly once
                    // rather than reporting thousands of trips for an open
                    // that made hundreds (ADR 0050).
                    if let Some(started) = started {
                        metadata_reads::record(
                            MetadataReadPhase::CoalescedWait,
                            started,
                            shared.is_err(),
                        );
                    }
                    shared.map_err(SharedError::into_object_store_error)
                }
                // Leader vanished without broadcasting (dropped/cancelled/
                // panicked). The guard has removed the in-flight entry, so
                // fall back to a direct backend read: this waiter still gets a
                // real answer and the path is not wedged.
                Err(_) => {
                    self.fetch_from_backend(path, &key, class, reader, label)
                        .await
                }
            };
        }

        // Leader path. Install the cancel-safe guard on the stack immediately
        // — before the first `.await` — so a dropped/cancelled/panicking
        // leader can never leave the in-flight entry stranded. On normal
        // completion `complete` removes the entry and broadcasts the result
        // exactly once; the guard's `Drop` is then a no-op.
        let mut guard = LeaderGuard::new(&self.in_flight, key.clone());
        let result = self
            .fetch_from_backend(path, &key, class, reader, label)
            .await;
        guard.complete(&result);
        result
    }

    /// Read an object that may legitimately not exist, remembering absence.
    ///
    /// `Ok(None)` means the object is not there. Unlike [`get_metadata_bytes`], a
    /// not-found answer is retained (see [`Self::absent`]), so a repeated
    /// probe for the same missing object — the common shape of optional
    /// metadata discovery across a wide collection — is served locally.
    /// Every other error is surfaced unchanged and never remembered.
    ///
    /// [`get_metadata_bytes`]: Self::get_metadata_bytes
    pub async fn get_optional_metadata_bytes(
        &self,
        path: &Path,
    ) -> Result<Option<Bytes>, object_store::Error> {
        let key = path.to_string();
        let started = std::time::Instant::now();
        {
            let mut absent = self.absent.lock().unwrap();
            if absent.get(&key).is_some() {
                drop(absent);
                let mut state = self.cache.lock().unwrap();
                state.hits += 1;
                drop(state);
                // Remembered absence is a read the open did not have to
                // make. It files a row for the same reason a resident hit
                // does: the shape of an open is how many of its reads cost
                // a round trip.
                metadata_reads::record(MetadataReadPhase::CacheHit, started, false);
                return Ok(None);
            }
        }

        match self
            .get_bytes_as(
                path,
                ReadClass::OptionalMetadata,
                ReaderId::UNATTRIBUTED,
                RequestLabel::UNATTRIBUTED,
            )
            .await
        {
            Ok(bytes) => Ok(Some(bytes)),
            Err(object_store::Error::NotFound { .. }) => {
                self.absent.lock().unwrap().put(key, ());
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Perform a single backend read under a source-read permit and, on
    /// success, insert the bytes into the LRU. The permit is held only for
    /// the actual network I/O so cache hits and followers never consume one.
    async fn fetch_from_backend(
        &self,
        path: &Path,
        key: &str,
        class: ReadClass,
        reader: ReaderId,
        label: RequestLabel,
    ) -> Result<Bytes, object_store::Error> {
        // Timed from here, before the permit is acquired: queueing behind our
        // own concurrency cap is part of what a caller waits for, and leaving
        // it out would understate the read by roughly half on a remote store.
        let started = std::time::Instant::now();
        let fetch = {
            // Bound concurrent backend reads process-wide. Scoped to just the
            // GET + body read so the permit is released before the (fast,
            // synchronous) cache insert below. The two read classes are bounded
            // apart: chunk reads queue on the fair-share source limiter, which
            // has contention to arbitrate, while metadata reads take a plain
            // permit from their own cap.
            let _permit = match class {
                ReadClass::Chunk => {
                    let permit = ReadPermit::Chunk(self.source_read.acquire(reader).await);
                    // The wait behind the cap is the rate-setter on a remote
                    // store, and it is only diagnosable if it can be named
                    // per request rather than per client.
                    tracing::trace!(
                        rid = label.0,
                        reader = reader.0,
                        wait_us = started.elapsed().as_micros() as u64,
                        "store.chunk_read.permit_acquired"
                    );
                    permit
                }
                ReadClass::Metadata | ReadClass::OptionalMetadata => ReadPermit::Metadata(
                    self.metadata_read
                        .acquire()
                        .await
                        .expect("metadata-read semaphore is never closed"),
                ),
            };
            match self.inner.get(path).await {
                Ok(object) => object.bytes().await,
                Err(error) => Err(error),
            }
        };
        let elapsed_nanos = started.elapsed().as_nanos();

        if class.is_metadata() {
            // An optional object that is simply not there answered the
            // question it was asked, so it is not a failed read — the same
            // rule the backend-error counter below applies.
            let absent_as_expected = class == ReadClass::OptionalMetadata
                && matches!(fetch, Err(object_store::Error::NotFound { .. }));
            metadata_reads::record(
                MetadataReadPhase::BackendRead,
                started,
                fetch.is_err() && !absent_as_expected,
            );
        }

        let bytes = match fetch {
            Ok(bytes) => bytes,
            Err(error) => {
                let mut state = self.cache.lock().unwrap();
                let absent_as_expected = class == ReadClass::OptionalMetadata
                    && matches!(error, object_store::Error::NotFound { .. });
                if !absent_as_expected {
                    state.backend_errors += 1;
                }
                state.source_reads += 1;
                state.source_read_nanos += elapsed_nanos;
                return Err(error);
            }
        };

        // Insert into cache, evicting LRU entries to stay within budget.
        {
            let mut state = self.cache.lock().unwrap();
            state.source_reads += 1;
            state.source_read_nanos += elapsed_nanos;
            if let Some(existing) = state.lru.get(key) {
                return Ok(existing.clone());
            }
            let new_size = bytes.len();

            while state.current_bytes + new_size > state.max_bytes {
                match state.lru.pop_lru() {
                    Some((_, evicted)) => {
                        state.current_bytes -= evicted.len();
                        state.evictions += 1;
                    }
                    None => break,
                }
            }

            state.current_bytes += new_size;
            state.lru.put(key.to_string(), bytes.clone());
        }

        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// These tests exercise caching and single-flight, not fair sharing, so
    /// they all read as one reader. Fairness has its own tests in
    /// [`crate::source_limiter`].
    const READER: ReaderId = ReaderId(1);
    /// Tests exercise the read path, not the join, so one label serves.
    const LABEL: RequestLabel = RequestLabel(7);

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_cache_test_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn cache_hit_returns_same_bytes() {
        let dir = temp_dir("hit");
        fs::write(dir.join("chunk1"), b"hello world").unwrap();

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let path = Path::from("chunk1");
        let first = cached.get_bytes(&path, READER, LABEL).await.unwrap();
        let second = cached.get_bytes(&path, READER, LABEL).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(&first[..], b"hello world");
        let stats = cached.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.entry_count, 1);
        assert_eq!(stats.current_bytes, b"hello world".len());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn probe_exists_answers_presence_without_caching_the_body() {
        let dir = temp_dir("probe_exists");
        fs::write(dir.join("present"), vec![7u8; 4096]).unwrap();

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1_000_000);

        assert!(cached.probe_exists(&Path::from("present")).await.unwrap());
        assert!(!cached.probe_exists(&Path::from("missing")).await.unwrap());

        // A HEAD must not pull the body into the cache: probing is about the
        // shape of a dataset, and a real chunk body can be megabytes.
        let stats = cached.stats();
        assert_eq!(stats.entry_count, 0);
        assert_eq!(stats.current_bytes, 0);
        // A clean not-found is the answer, not a fault.
        assert_eq!(stats.backend_errors, 0);
        assert_eq!(stats.source_reads, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn probe_exists_remembers_absence() {
        let dir = temp_dir("probe_absent");
        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let path = Path::from("never-written");
        assert!(!cached.probe_exists(&path).await.unwrap());
        assert!(!cached.probe_exists(&path).await.unwrap());

        // The second probe is served locally — one backend round trip total.
        assert_eq!(cached.stats().source_reads, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_on_budget_exceeded() {
        let dir = temp_dir("evict");
        fs::write(dir.join("a"), vec![0u8; 60]).unwrap();
        fs::write(dir.join("b"), vec![1u8; 60]).unwrap();

        // Cache budget = 100 bytes. Each chunk is 60 bytes.
        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 100);

        let pa = Path::from("a");
        let pb = Path::from("b");

        let _a = cached.get_bytes(&pa, READER, LABEL).await.unwrap();
        let _b = cached.get_bytes(&pb, READER, LABEL).await.unwrap();

        // "a" should have been evicted to make room for "b"
        {
            let state = cached.cache.lock().unwrap();
            assert!(state.current_bytes <= 100);
            assert_eq!(state.lru.len(), 1);
        }
        let stats = cached.stats();
        assert_eq!(stats.evictions, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_file_returns_error() {
        let dir = temp_dir("missing");

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let result = cached
            .get_bytes(&Path::from("nonexistent"), READER, LABEL)
            .await;
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
        GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, PutMultipartOptions,
        PutOptions, PutPayload, PutResult,
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

        async fn delete(&self, location: &Path) -> object_store::Result<()> {
            self.inner.delete(location).await
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

        async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
            self.inner.copy(from, to).await
        }

        async fn copy_if_not_exists(&self, from: &Path, to: &Path) -> object_store::Result<()> {
            self.inner.copy_if_not_exists(from, to).await
        }
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
            SourceReadLimiter::new(64),
        ));

        let waiters = 8;
        let mut handles = Vec::new();
        for _ in 0..waiters {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached.get_bytes(&Path::from("chunk"), READER, LABEL).await
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
            SourceReadLimiter::new(64),
        ));

        // Concurrent failing misses collapse to one backend GET; every
        // waiter surfaces an error.
        let waiters = 6;
        let mut handles = Vec::new();
        for _ in 0..waiters {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached.get_bytes(&Path::from("chunk"), READER, LABEL).await
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
        let bytes = cached
            .get_bytes(&Path::from("chunk"), READER, LABEL)
            .await
            .unwrap();
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
            SourceReadLimiter::new(cap),
        ));

        let mut handles = Vec::new();
        for i in 0..distinct {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached
                    .get_bytes(&Path::from(format!("chunk-{i}")), READER, LABEL)
                    .await
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
            SourceReadLimiter::new(64),
        ));

        // A leader registers the in-flight entry and begins the (slow) backend
        // read, then is cancelled by the timeout before it can broadcast.
        let cancelled = tokio::time::timeout(
            Duration::from_millis(20),
            cached.get_bytes(&Path::from("chunk"), READER, LABEL),
        )
        .await;
        assert!(
            cancelled.is_err(),
            "leader should have been cancelled mid-fetch"
        );

        // The guard cleared the in-flight entry rather than leaking it.
        {
            let in_flight = cached.in_flight.lock().unwrap();
            assert!(
                in_flight.is_empty(),
                "cancelled leader left a stranded in-flight entry"
            );
        }

        // A subsequent request for the same path completes normally instead of
        // awaiting a broadcast that will never come.
        let bytes = tokio::time::timeout(
            Duration::from_secs(5),
            cached.get_bytes(&Path::from("chunk"), READER, LABEL),
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
            SourceReadLimiter::new(64),
        ));

        // Leader claims the path and starts its slow read.
        let leader = {
            let cached = cached.clone();
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk"), READER, LABEL).await })
        };
        tokio::time::sleep(Duration::from_millis(40)).await;

        // Follower subscribes to the leader's in-flight channel and parks.
        let follower = {
            let cached = cached.clone();
            tokio::spawn(async move { cached.get_bytes(&Path::from("chunk"), READER, LABEL).await })
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
    async fn stats_report_backend_read_count_and_elapsed_time() {
        // Two distinct paths, each delayed, so the accumulated read time is
        // unambiguously at least the sum of the two delays.
        let delay_ms = 40;
        let store = Arc::new(CountingStore::new(delay_ms));
        store.seed("a", b"aaaa").await;
        store.seed("b", b"bbbb").await;

        let cached = CachedStore::with_source_limiter(store, 1024, SourceReadLimiter::new(1));
        cached
            .get_bytes(&Path::from("a"), READER, LABEL)
            .await
            .unwrap();
        cached
            .get_bytes(&Path::from("b"), READER, LABEL)
            .await
            .unwrap();
        // A hit costs no backend read and no read time.
        cached
            .get_bytes(&Path::from("a"), READER, LABEL)
            .await
            .unwrap();

        let stats = cached.stats();
        assert_eq!(stats.source_reads, 2, "one backend read per distinct path");
        assert!(
            stats.source_read_millis >= 2 * delay_ms,
            "accumulated read time {} ms should cover both delayed reads",
            stats.source_read_millis
        );
        assert_eq!(stats.hits, 1);
    }

    /// Metadata reads must not queue behind the chunk cap. Routing an import
    /// through the cache is only worth doing if it does not also halve the
    /// fan-out the import pipeline drives: measured against a 21k-member
    /// remote collection, sharing one cap cost the cold open ~2x.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn metadata_reads_are_not_bounded_by_the_chunk_read_cap() {
        let store = Arc::new(CountingStore::new(50));
        let distinct = 8usize;
        for i in 0..distinct {
            let bytes: &'static [u8] = Box::leak(vec![b'x'; 4].into_boxed_slice());
            store.seed(&format!("meta-{i}"), bytes).await;
        }
        let max_active = store.max_active.clone();

        // A chunk cap of one: if metadata shared it, the reads would fully
        // serialize.
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024 * 1024,
            SourceReadLimiter::new(1),
        ));

        let mut handles = Vec::new();
        for i in 0..distinct {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached
                    .get_metadata_bytes(&Path::from(format!("meta-{i}")))
                    .await
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        assert!(
            max_active.load(Ordering::SeqCst) > 1,
            "metadata reads serialized behind the chunk cap",
        );
    }

    /// Collects whatever the watched scope files, so a test can assert on
    /// the phases an open would have seen.
    #[derive(Default)]
    struct Watcher {
        reads: Mutex<Vec<crate::metadata_reads::MetadataRead>>,
    }

    impl Watcher {
        fn phases(&self) -> Vec<MetadataReadPhase> {
            self.reads
                .lock()
                .unwrap()
                .iter()
                .map(|read| read.phase)
                .collect()
        }

        fn failures(&self) -> usize {
            self.reads
                .lock()
                .unwrap()
                .iter()
                .filter(|read| read.failed)
                .count()
        }
    }

    impl crate::metadata_reads::MetadataReadObserver for Watcher {
        fn record(&self, read: crate::metadata_reads::MetadataRead) {
            self.reads.lock().unwrap().push(read);
        }
    }

    #[tokio::test]
    async fn a_metadata_read_files_its_round_trip_and_the_repeat_files_a_hit() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("zarr.json", b"{}").await;
        let cached = Arc::new(CachedStore::new(store, 1024));
        let watcher = Arc::new(Watcher::default());

        crate::metadata_reads::observing(watcher.clone(), async {
            let path = Path::from("zarr.json");
            cached.get_metadata_bytes(&path).await.unwrap();
            cached.get_metadata_bytes(&path).await.unwrap();
        })
        .await;

        assert_eq!(
            watcher.phases(),
            vec![MetadataReadPhase::BackendRead, MetadataReadPhase::CacheHit],
            "one row per read, whether or not it cost a round trip",
        );
    }

    #[tokio::test]
    async fn a_coalesced_metadata_read_files_a_wait_and_leaves_the_trip_to_its_leader() {
        let store = Arc::new(CountingStore::new(30));
        store.seed("zarr.json", b"{}").await;
        let cached = Arc::new(CachedStore::new(store, 1024));
        let watcher = Arc::new(Watcher::default());

        crate::metadata_reads::observing(watcher.clone(), async {
            let path = Path::from("zarr.json");
            let leader = cached.get_metadata_bytes(&path);
            let follower = cached.get_metadata_bytes(&path);
            let (a, b) = tokio::join!(leader, follower);
            a.unwrap();
            b.unwrap();
        })
        .await;

        let mut phases = watcher.phases();
        phases.sort_by_key(|phase| format!("{phase:?}"));
        assert_eq!(
            phases,
            vec![
                MetadataReadPhase::BackendRead,
                MetadataReadPhase::CoalescedWait
            ],
            "the follower's wait must not be counted as a second round trip",
        );
    }

    #[tokio::test]
    async fn an_absent_optional_object_is_an_answer_not_a_failed_read() {
        let store = Arc::new(CountingStore::new(0));
        let cached = Arc::new(CachedStore::new(store, 1024));
        let watcher = Arc::new(Watcher::default());

        crate::metadata_reads::observing(watcher.clone(), async {
            let path = Path::from("labels/zarr.json");
            assert!(
                cached
                    .get_optional_metadata_bytes(&path)
                    .await
                    .unwrap()
                    .is_none()
            );
            // The second probe is served by the absent memo.
            assert!(
                cached
                    .get_optional_metadata_bytes(&path)
                    .await
                    .unwrap()
                    .is_none()
            );
        })
        .await;

        assert_eq!(
            watcher.phases(),
            vec![MetadataReadPhase::BackendRead, MetadataReadPhase::CacheHit],
        );
        assert_eq!(
            watcher.failures(),
            0,
            "a 404 answered the question it was asked"
        );
    }

    #[tokio::test]
    async fn a_presence_probe_files_a_row_and_a_chunk_read_files_none() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("chunk", b"data").await;
        let cached = Arc::new(CachedStore::new(store, 1024));
        let watcher = Arc::new(Watcher::default());

        crate::metadata_reads::observing(watcher.clone(), async {
            cached.probe_exists(&Path::from("chunk")).await.unwrap();
            cached
                .get_bytes(&Path::from("chunk"), READER, LABEL)
                .await
                .unwrap();
        })
        .await;

        assert_eq!(
            watcher.phases(),
            vec![MetadataReadPhase::BackendRead],
            "the chunk family has its own rows and must not appear here",
        );
    }

    #[tokio::test]
    async fn one_source_key_shares_one_warm_cache_while_it_is_in_use() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("zarr.json", b"{}").await;
        let get_count = store.get_count.clone();

        let first = CachedStore::shared_for_source("src-a", store.clone(), 1024);
        first
            .get_bytes(&Path::from("zarr.json"), READER, LABEL)
            .await
            .unwrap();

        // A second open of the same source reads what the first one cached.
        let second = CachedStore::shared_for_source("src-a", store.clone(), 1024);
        assert!(Arc::ptr_eq(&first, &second));
        second
            .get_bytes(&Path::from("zarr.json"), READER, LABEL)
            .await
            .unwrap();
        assert_eq!(get_count.load(Ordering::SeqCst), 1);

        // A different source is a different cache.
        let other = CachedStore::shared_for_source("src-b", store.clone(), 1024);
        assert!(!Arc::ptr_eq(&first, &other));
        other
            .get_bytes(&Path::from("zarr.json"), READER, LABEL)
            .await
            .unwrap();
        assert_eq!(get_count.load(Ordering::SeqCst), 2);

        // Once nothing holds the source's cache, its budget is released
        // rather than pinned for the life of the process.
        drop(first);
        drop(second);
        let reopened = CachedStore::shared_for_source("src-a", store.clone(), 1024);
        reopened
            .get_bytes(&Path::from("zarr.json"), READER, LABEL)
            .await
            .unwrap();
        assert_eq!(get_count.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn optional_reads_remember_absence_but_chunk_reads_do_not() {
        let store = Arc::new(CountingStore::new(0));
        let get_count = store.get_count.clone();
        let cached = CachedStore::new(store, 1024);

        let missing = Path::from("labels/zarr.json");
        assert!(
            cached
                .get_optional_metadata_bytes(&missing)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            cached
                .get_optional_metadata_bytes(&missing)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            get_count.load(Ordering::SeqCst),
            1,
            "the second probe for a known-absent object must not hit the backend",
        );
        assert_eq!(cached.stats().hits, 1, "the memoized probe counts as a hit");

        // An absent chunk is data, not shape: `get_bytes` keeps asking, so a
        // sparse region that later has content is never stuck reading empty.
        let sparse = Path::from("0/c/0/0/0/0/0");
        assert!(cached.get_bytes(&sparse, READER, LABEL).await.is_err());
        assert!(cached.get_bytes(&sparse, READER, LABEL).await.is_err());
        assert_eq!(get_count.load(Ordering::SeqCst), 3);
    }

    /// An optional object that isn't there is an answer, not a fault. The
    /// server turns `backend_errors` into a Degraded source-cache health, so
    /// counting label-index probes there would report almost every dataset as
    /// unhealthy — on a wide collection those probes are most of the reads.
    #[tokio::test]
    async fn absent_optional_metadata_is_not_a_backend_error() {
        let store = Arc::new(CountingStore::new(0));
        let cached = CachedStore::new(store, 1024);

        assert!(
            cached
                .get_optional_metadata_bytes(&Path::from("labels/zarr.json"))
                .await
                .unwrap()
                .is_none()
        );

        let stats = cached.stats();
        assert_eq!(
            stats.backend_errors, 0,
            "an absent optional object is not an error"
        );
        // The round trip it cost is still counted.
        assert_eq!(stats.source_reads, 1);
    }

    #[tokio::test]
    async fn optional_read_returns_present_bytes_and_surfaces_other_errors() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("present", b"payload").await;
        let fail = store.fail.clone();
        let cached = CachedStore::new(store, 1024);

        let found = cached
            .get_optional_metadata_bytes(&Path::from("present"))
            .await
            .unwrap()
            .expect("a present object must come back as Some");
        assert_eq!(&found[..], b"payload");

        // A non-not-found failure is an error, not an absence, and is not
        // remembered: the next probe re-attempts the backend.
        fail.store(true, Ordering::SeqCst);
        assert!(
            cached
                .get_optional_metadata_bytes(&Path::from("other"))
                .await
                .is_err()
        );
        fail.store(false, Ordering::SeqCst);
        assert!(
            cached
                .get_optional_metadata_bytes(&Path::from("other"))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn failed_backend_reads_are_counted_and_timed() {
        let store = Arc::new(CountingStore::new(20));
        store.fail.store(true, Ordering::SeqCst);
        let cached = CachedStore::new(store, 1024);

        assert!(
            cached
                .get_bytes(&Path::from("a"), READER, LABEL)
                .await
                .is_err()
        );

        let stats = cached.stats();
        assert_eq!(
            stats.source_reads, 1,
            "a failed read still cost a round trip"
        );
        assert!(stats.source_read_millis >= 20);
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
