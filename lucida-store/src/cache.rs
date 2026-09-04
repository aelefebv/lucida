//! Memory-bounded LRU Chunk Cache wrapping a StorageBackend.
//!
//! Caches chunk bytes fetched from an ObjectStore to reduce repeated reads
//! when multiple Clients view the same region.
//!
//! An entry is one object or one byte range of one object. See [`ReadKey`].
//!
//! Range reads of one object that are waiting for a permit together — the
//! neighbouring inner chunks of a shard that one pan asked for — reach the
//! backend as one request when their byte ranges are contiguous. The merge
//! lives at the permit queue and nowhere else. See
//! [`CachedStore::lead_range_read`].

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use bytes::Bytes;
use lru::LruCache;
use object_store::path::Path;
use object_store::{GetOptions, GetRange, ObjectStore};
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

/// The key of one cache entry and one in-flight read, and so of one
/// coalescing group. An object path, plus the byte range when the read is
/// partial.
///
/// The range is part of the identity, not a view onto a whole-object entry.
/// The single flight hands a follower the leader's bytes verbatim, so a
/// range read that coalesced onto an in-flight read of the whole object, or
/// of a different range, would receive bytes it did not ask for. A range
/// read and an object read of one path are therefore two keys, and two
/// callers coalesce only when both parts match.
///
/// Nothing is derived across keys in either direction. A resident object
/// does not answer a range, and a resident range does not answer the object.
/// That costs a round trip when both are wanted, which is rare, and keeps
/// every entry exactly what its caller was handed.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct ReadKey {
    path: Path,
    /// `None` is the whole object.
    range: Option<ByteRange>,
}

impl ReadKey {
    fn new(path: &Path, range: Option<ByteRange>) -> Self {
        ReadKey {
            path: path.clone(),
            range,
        }
    }

    /// The bounded range this key reads, when it reads one. Only these can
    /// be merged: a whole object is its own request, and a suffix has no
    /// known offset to be adjacent to.
    fn bounded(&self) -> Option<&Range<u64>> {
        match &self.range {
            Some(ByteRange::Bounded(range)) => Some(range),
            _ => None,
        }
    }
}

/// The part of an object one partial read asks for.
///
/// A suffix is its own kind rather than a bounded range computed from the
/// object's length, because the cached store never learns the length.
/// Learning it would take a HEAD before every read of a shard index kept at
/// the end of its object. The backend resolves the suffix itself, in the same round trip.
/// `object_store`'s own range type is not hashable, so it cannot key the
/// cache directly.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum ByteRange {
    /// Half-open, in bytes.
    Bounded(Range<u64>),
    /// The last `n` bytes of the object.
    Suffix(u64),
}

impl From<ByteRange> for GetRange {
    fn from(range: ByteRange) -> Self {
        match range {
            ByteRange::Bounded(range) => GetRange::Bounded(range),
            ByteRange::Suffix(n) => GetRange::Suffix(n),
        }
    }
}

/// How one read through the cache spent its time, split so a caller can say
/// *which* wait it was.
///
/// The split follows the single flight, because that is what makes the
/// arithmetic honest. A follower performs no backend read and takes no
/// permit: its wait belongs to `coalesced_wait_us` and nothing else, so a
/// sum over `backend_read_us` counts each real round trip exactly once
/// (ADR 0050). Reporting a follower's wait as a backend read would tell a
/// reader the store is slow when the truth is that the same object was
/// already being read.
///
/// A read carried in a neighbour's merged request is a follower of that
/// request in every respect that matters here: no permit, no round trip of
/// its own, and a wait attributed to the request that made the trip.
///
/// Both a coalesced wait and a read appear on one timing only when the read
/// a caller was waiting on vanished mid-flight — its single-flight leader,
/// or the neighbour carrying it — and the caller then really did perform
/// one of its own.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SourceReadTiming {
    /// Queued behind the concurrency cap, for the caller that did the read.
    pub permit_wait_us: Option<u32>,
    /// The backend round trip, for the caller that did the read.
    pub backend_read_us: Option<u32>,
    /// The bytes that round trip returned, for the caller that did the read.
    /// Set exactly when `backend_read_us` is, so a sum over the column is
    /// the bytes the backend moved and a follower adds nothing to it. It is
    /// the length of what was asked for: a whole object, one range of it, or
    /// every range a merged request carried, which is how a trace tells a
    /// shard read by the inner chunk from a shard downloaded whole.
    pub backend_bytes: Option<u32>,
    /// Parked on another caller's in-flight read of the same object.
    pub coalesced_wait_us: Option<u32>,
    /// The label of the request whose read this one waited on. Set only for
    /// a follower, and it is what turns "this request waited 400 ms" into
    /// "it waited on *that* read" — the join ADR 0050 asks a follower row to
    /// carry. Labels are per connection, so a leader from another connection
    /// joins to nothing on this client's side; that is the honest answer,
    /// and it is also why no peer identity travels with it.
    pub coalesced_onto: Option<RequestLabel>,
}

/// There is no time to report for a stretch that never happened; the whole
/// [`SourceReadTiming`] is `None` on every arm.
impl SourceReadTiming {
    /// Everything the store measured, so a caller can attribute the rest of
    /// its own elapsed time honestly rather than losing it.
    pub fn measured_us(&self) -> u64 {
        u64::from(self.permit_wait_us.unwrap_or(0))
            + u64::from(self.backend_read_us.unwrap_or(0))
            + u64::from(self.coalesced_wait_us.unwrap_or(0))
    }

    /// This read's time and then `next`'s, for one answer that took two
    /// reads, such as an inner chunk whose shard index had to be read first.
    ///
    /// Each stretch is the sum of the two reads' stretches, and a stretch
    /// neither read had stays `None`. The sum keeps ADR 0050's arithmetic
    /// honest. Both round trips were this caller's, so both belong on its
    /// row, and a follower's wait on either read is still only a wait. The
    /// leader a follower waited on is the later read's when both had one.
    pub fn followed_by(self, next: SourceReadTiming) -> SourceReadTiming {
        fn sum(first: Option<u32>, second: Option<u32>) -> Option<u32> {
            match (first, second) {
                (None, None) => None,
                (first, second) => Some(first.unwrap_or(0).saturating_add(second.unwrap_or(0))),
            }
        }
        SourceReadTiming {
            permit_wait_us: sum(self.permit_wait_us, next.permit_wait_us),
            backend_read_us: sum(self.backend_read_us, next.backend_read_us),
            backend_bytes: sum(self.backend_bytes, next.backend_bytes),
            coalesced_wait_us: sum(self.coalesced_wait_us, next.coalesced_wait_us),
            coalesced_onto: next.coalesced_onto.or(self.coalesced_onto),
        }
    }
}

/// A read plus how it spent its time. The timing is returned whatever the
/// read answered: a failed read still waited, and a wait that vanishes from
/// the trace when the read fails hides the case most worth seeing.
#[derive(Debug)]
pub struct TimedRead {
    pub result: Result<Bytes, object_store::Error>,
    pub timing: SourceReadTiming,
}

fn micros(elapsed: std::time::Duration) -> u32 {
    u32::try_from(elapsed.as_micros()).unwrap_or(u32::MAX)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheStats {
    pub max_bytes: usize,
    pub current_bytes: usize,
    pub entry_count: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub backend_errors: u64,
    /// Reads served without a backend read of their own: single-flight
    /// followers handed a leader's result, and range reads carried in a
    /// neighbour's merged request.
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
    /// In-flight backend reads, and the range reads queued for a permit that
    /// a neighbour's request can carry. See [`Flights`].
    in_flight: InFlight,
    /// Paths the optional metadata reads and [`CachedStore::probe_exists`]
    /// have found absent, so a repeated probe for the same optional object
    /// costs no round trip.
    ///
    /// Deliberately separate from the byte cache and consulted only by those
    /// methods: an absent *chunk* is legitimate sparse data whose absence is a
    /// property of the data, and remembering it would make a chunk that
    /// appears later read as empty. An absent *optional metadata object* — a
    /// `labels/zarr.json` that a dataset simply does not have — is a property
    /// of the dataset's shape, and re-probing it on every open is pure cost:
    /// on a wide remote collection these 404s are a large fraction of the
    /// open's reads.
    ///
    /// Keyed by path alone, unlike the byte cache. Absence is a property of
    /// the object, not of any range of it, so one entry answers a whole-object
    /// read and a range read of the same object alike.
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
    lru: LruCache<ReadKey, Bytes>,
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

/// What a leader broadcasts to the callers waiting on its read.
///
/// The label travels with it because a waiter cannot always know it when it
/// subscribes. A range read carried in a neighbour's merged request is
/// delivered by a leader it never lined up behind, and its row is meant to
/// name the request that made the round trip, not the one it first found in
/// flight (ADR 0050).
#[derive(Clone)]
enum Delivery {
    /// The outcome, and whose request made the round trip.
    Done {
        result: ShareResult,
        leader: RequestLabel,
    },
    /// The leader went away before it had read. Its waiters start again,
    /// and their rows still name the request they waited on.
    Abandoned { leader: RequestLabel },
}

/// Identifies one [`LeaderGuard`], so an in-flight entry can change hands
/// and a guard only ever removes entries that are its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct FlightId(u64);

/// One in-flight read, as a follower finds it: the channel to wait on, who
/// is doing the reading, and which guard answers for the entry. The label is
/// kept so a follower's row can say which read it waited on rather than only
/// how long (ADR 0050).
struct InFlightRead {
    tx: broadcast::Sender<Delivery>,
    leader: RequestLabel,
    /// Starts as the registering caller's guard and moves to a neighbour's
    /// when that neighbour carries the read in its merged request.
    owner: FlightId,
}

/// A bounded chunk-range read that has registered in flight and is waiting
/// for a permit.
struct QueuedRange {
    key: ReadKey,
    owner: FlightId,
}

impl QueuedRange {
    fn range(&self) -> &Range<u64> {
        self.key.bounded().expect("only bounded ranges are queued")
    }
}

/// The single flight and the merge, under one lock.
#[derive(Default)]
struct Flights {
    /// In-flight reads keyed by [`ReadKey`]. Concurrent misses for the same
    /// key subscribe to the leader's broadcast instead of each hitting the
    /// backend.
    reads: HashMap<ReadKey, InFlightRead>,
    /// The bounded chunk-range reads waiting for a permit, by object. These
    /// are the reads a pan across a sharded dataset produces — neighbouring
    /// inner chunks of one shard, admitted in one scheduling window — and
    /// when one of them is admitted, this is where it finds the neighbours
    /// it can carry in its request.
    queued_ranges: HashMap<Path, Vec<QueuedRange>>,
    next_flight: u64,
}

type InFlight = Mutex<Flights>;

/// Where a caller landed when it looked for its key in flight.
enum Placement<'a> {
    /// Nobody was reading the key; this caller leads it. `delivery` is the
    /// leader's own subscription, on which a neighbour's merged request may
    /// deliver the read before the leader ever takes a permit.
    Lead {
        guard: LeaderGuard<'a>,
        delivery: broadcast::Receiver<Delivery>,
    },
    /// Another caller is already reading the key.
    Follow {
        delivery: broadcast::Receiver<Delivery>,
        leader: RequestLabel,
    },
}

impl Flights {
    /// Find `key` in flight, or register it under a new guard. A mergeable
    /// key is also queued by object, where a neighbour admitted first can
    /// find it.
    fn place<'a>(
        &mut self,
        in_flight: &'a InFlight,
        key: &ReadKey,
        label: RequestLabel,
        mergeable: bool,
    ) -> Placement<'a> {
        if let Some(existing) = self.reads.get(key) {
            return Placement::Follow {
                delivery: existing.tx.subscribe(),
                leader: existing.leader,
            };
        }
        self.next_flight += 1;
        let flight = FlightId(self.next_flight);
        let (tx, delivery) = broadcast::channel::<Delivery>(1);
        self.reads.insert(
            key.clone(),
            InFlightRead {
                tx,
                leader: label,
                owner: flight,
            },
        );
        let queued_at = match key.bounded() {
            Some(_) if mergeable => {
                self.queued_ranges
                    .entry(key.path.clone())
                    .or_default()
                    .push(QueuedRange {
                        key: key.clone(),
                        owner: flight,
                    });
                Some(key.path.clone())
            }
            _ => None,
        };
        Placement::Lead {
            guard: LeaderGuard {
                in_flight,
                flight,
                label,
                keys: vec![key.clone()],
                queued_at,
                completed: false,
            },
            delivery,
        }
    }

    /// The group the read `guard` leads carries in its one request: its own
    /// range, and every queued range of the same object whose bytes run on
    /// from it or into it. The neighbours' in-flight entries become the
    /// guard's, and every member leaves the queue.
    ///
    /// `None` when a neighbour admitted first has already carried the
    /// guard's own range; that neighbour delivers it.
    fn claim_group(&mut self, guard: &mut LeaderGuard<'_>) -> Option<Vec<ReadKey>> {
        let path = guard.queued_at.take()?;
        let queue = self.queued_ranges.get_mut(&path)?;
        queue.sort_by_key(|queued| queued.range().start);
        let own = queue
            .iter()
            .position(|queued| queued.owner == guard.flight)?;

        // Never across a gap: the bytes between would be fetched and dropped,
        // since the cache has no key to file them under, and on a shard they
        // are whole inner chunks (docs/research/merged-range-reads.md has the
        // cost). A contiguous group is one fetch under any gap object_store's
        // multi-range read merges on, so one permit stays one request.
        let touches = |end: u64, next: &QueuedRange| next.range().start <= end;
        let mut first = 0;
        let mut end = queue[0].range().end;
        for (rank, queued) in queue.iter().enumerate().take(own + 1).skip(1) {
            if touches(end, queued) {
                end = end.max(queued.range().end);
            } else {
                first = rank;
                end = queued.range().end;
            }
        }
        let mut last = own;
        while last + 1 < queue.len() && touches(end, &queue[last + 1]) {
            last += 1;
            end = end.max(queue[last].range().end);
        }

        let mut keys = Vec::with_capacity(last - first + 1);
        for queued in &mut queue[first..=last] {
            if queued.owner != guard.flight {
                let read = self
                    .reads
                    .get_mut(&queued.key)
                    .expect("a queued range is registered in flight");
                read.owner = guard.flight;
                read.leader = guard.label;
                queued.owner = guard.flight;
                guard.keys.push(queued.key.clone());
            }
            keys.push(queued.key.clone());
        }
        queue.retain(|queued| queued.owner != guard.flight);
        if queue.is_empty() {
            self.queued_ranges.remove(&path);
        }
        Some(keys)
    }

    /// Remove `key`'s entry, if `owner` still answers for it.
    fn take_owned(&mut self, key: &ReadKey, owner: FlightId) -> Option<InFlightRead> {
        if self.reads.get(key)?.owner != owner {
            return None;
        }
        self.reads.remove(key)
    }

    /// Forget the queued range `owner` registered, if it is still queued.
    fn dequeue(&mut self, path: &Path, owner: FlightId) {
        if let Some(queue) = self.queued_ranges.get_mut(path) {
            queue.retain(|queued| queued.owner != owner);
            if queue.is_empty() {
                self.queued_ranges.remove(path);
            }
        }
    }
}

/// RAII owner of a leader's in-flight entries: the key it registered, plus
/// any it took over from neighbours to carry in one request.
///
/// The broadcast senders live in the shared `in_flight` table, not on the
/// leader's stack, so if the leader future is dropped, cancelled, or panics
/// between registering and broadcasting, nothing would otherwise remove the
/// entries or drop the senders — every current follower and every future
/// caller taking the single-flight path for those keys would await
/// `recv()` forever (a permanent wedge). This guard, held on the leader's
/// stack from the moment the entry is registered, closes that gap:
///
/// - On normal completion the leader calls [`LeaderGuard::complete`], which
///   removes its entries and broadcasts each result exactly once.
/// - On any early exit (drop/cancel/panic) `Drop` removes the entries that
///   are still its own and tells their waiters, so followers and carried
///   reads start again, and a later request for the same key starts fresh.
///
/// Entries are matched by owner. One that a neighbour has taken over is that
/// neighbour's to complete or abandon, and this guard leaves it alone.
struct LeaderGuard<'a> {
    in_flight: &'a InFlight,
    flight: FlightId,
    /// The request this guard reads for, named to every waiter it answers.
    label: RequestLabel,
    /// The key registered first, then any taken over from neighbours.
    keys: Vec<ReadKey>,
    /// The object under which the guard's own range is queued, while it is.
    queued_at: Option<Path>,
    /// Set once the guard has handed off or completed everything it owned,
    /// so `Drop` does not take the lock for nothing.
    completed: bool,
}

impl LeaderGuard<'_> {
    /// Publish each outcome to everyone waiting on it and remove the
    /// entries. Called exactly once on the normal-completion path.
    fn complete(&mut self, outcomes: impl IntoIterator<Item = (ReadKey, ShareResult)>) {
        let mut flights = self.in_flight.lock().unwrap();
        for (key, result) in outcomes {
            if let Some(read) = flights.take_owned(&key, self.flight) {
                let _ = read.tx.send(Delivery::Done {
                    result,
                    leader: self.label,
                });
            }
        }
        self.completed = true;
    }

    /// Drop the guard without touching the table: a neighbour took over its
    /// entry and has delivered or abandoned it.
    fn disarm(mut self) {
        self.completed = true;
    }
}

impl Drop for LeaderGuard<'_> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        // Leader vanished before broadcasting (dropped/cancelled/panicked).
        let mut flights = self.in_flight.lock().unwrap();
        for key in &self.keys {
            if let Some(read) = flights.take_owned(key, self.flight) {
                let _ = read.tx.send(Delivery::Abandoned { leader: self.label });
            }
        }
        if let Some(path) = &self.queued_at {
            flights.dequeue(path, self.flight);
        }
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
            in_flight: Mutex::new(Flights::default()),
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
    pub async fn get_bytes(&self, path: &Path, reader: ReaderId, label: RequestLabel) -> TimedRead {
        self.get_bytes_as(ReadKey::new(path, None), ReadClass::Chunk, reader, label)
            .await
    }

    /// Read one byte range of an object, keyed by the path and the range.
    ///
    /// A range read is a chunk read that happens to be partial. It takes a
    /// permit from the same fair-share limiter as [`get_bytes`], is timed in
    /// the same two phases, and counts as one source read. Only the key
    /// differs. See [`ReadKey`] for why a range and the whole object are two
    /// entries, and why two callers coalesce only on the same path *and*
    /// range.
    ///
    /// Range reads of one object that queue for a permit together may reach
    /// the backend as one request when their byte ranges are contiguous.
    /// Each still lands in its own entry, and each row still
    /// tells the truth: the read that was admitted first owns the permit
    /// and the round trip, and the reads it carried own only a wait on it.
    ///
    /// `range` is half-open, in bytes, and goes to the backend as-is. The
    /// store does not know an object's length, so a range past the end is
    /// the backend's error to raise.
    ///
    /// `reader` and `label` mean what they mean for [`get_bytes`].
    ///
    /// [`get_bytes`]: Self::get_bytes
    pub async fn get_range(
        &self,
        path: &Path,
        range: Range<u64>,
        reader: ReaderId,
        label: RequestLabel,
    ) -> TimedRead {
        self.get_bytes_as(
            ReadKey::new(path, Some(ByteRange::Bounded(range))),
            ReadClass::Chunk,
            reader,
            label,
        )
        .await
    }

    /// Read the last `len` bytes of an object, keyed by the path and the
    /// suffix.
    ///
    /// The same read as [`get_range`] in every respect but the key: one
    /// chunk permit, the same two timed phases, one source read. It exists
    /// because a shard index kept at the end of its object is at an offset
    /// the cached store cannot know without a HEAD, and the backend can
    /// count back from the end itself. An object shorter than `len` answers with all of
    /// its bytes.
    ///
    /// A suffix and the bounded range that covers the same bytes are two
    /// entries, as [`ReadKey`] explains.
    ///
    /// [`get_range`]: Self::get_range
    pub async fn get_suffix(
        &self,
        path: &Path,
        len: u64,
        reader: ReaderId,
        label: RequestLabel,
    ) -> TimedRead {
        self.get_bytes_as(
            ReadKey::new(path, Some(ByteRange::Suffix(len))),
            ReadClass::Chunk,
            reader,
            label,
        )
        .await
    }

    /// Read a metadata object (a `zarr.json` and friends) through the same
    /// cache, bounded by the metadata-read cap rather than the chunk one.
    /// See [`DEFAULT_METADATA_READ_CONCURRENCY`] for why the two classes are
    /// counted apart.
    pub async fn get_metadata_bytes(&self, path: &Path) -> Result<Bytes, object_store::Error> {
        self.get_bytes_as(
            ReadKey::new(path, None),
            ReadClass::Metadata,
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
        )
        .await
        .result
    }

    /// Answer whether an object exists without transferring its body.
    ///
    /// This is a HEAD, not a GET: the caller wants presence, and a chunk body
    /// can be megabytes. Bounded by the metadata cap, since the question is
    /// asked about the shape of a dataset rather than about its data, and a
    /// not-found is the answer rather than a fault — so it never counts as a
    /// backend error. Absence is remembered in the same store as
    /// [`get_optional_metadata_bytes`], and a whole object already resident in
    /// the LRU answers `true` locally.
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
            if state.lru.get(&ReadKey::new(path, None)).is_some() {
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
        key: ReadKey,
        class: ReadClass,
        reader: ReaderId,
        label: RequestLabel,
    ) -> TimedRead {
        // Only metadata reads are watched, and only they pay for the clock
        // read: the chunk path is timed at the request boundary instead.
        let started = class.is_metadata().then(std::time::Instant::now);

        let mergeable = class == ReadClass::Chunk && key.bounded().is_some();

        // A waiter whose leader or carrier dies before delivering goes round
        // again, and its row reports that wait together with whatever the
        // next attempt costs.
        let mut waited = SourceReadTiming::default();
        let mut first_attempt = true;
        loop {
            // Cache hit — served without touching the backend or a permit,
            // and reporting neither. A hit that showed up as a fast backend
            // read would understate how often the store is not touched at
            // all. The miss is counted once per call, not once per attempt.
            {
                let mut state = self.cache.lock().unwrap();
                if let Some(bytes) = state.lru.get(&key) {
                    let bytes = bytes.clone();
                    state.hits += 1;
                    drop(state);
                    if let Some(started) = started {
                        metadata_reads::record(MetadataReadPhase::CacheHit, started, false);
                    }
                    return TimedRead {
                        result: Ok(bytes),
                        timing: waited,
                    };
                }
                if first_attempt {
                    state.misses += 1;
                }
                first_attempt = false;
            }

            let placement = {
                let mut flights = self.in_flight.lock().unwrap();
                flights.place(&self.in_flight, &key, label, mergeable)
            };

            let (delivered, parked, leader) = match placement {
                Placement::Follow {
                    mut delivery,
                    leader,
                } => {
                    let parked = std::time::Instant::now();
                    (delivery.recv().await, parked, Some(leader))
                }
                Placement::Lead { guard, delivery } => {
                    let led = if mergeable {
                        self.lead_range_read(guard, delivery, &key, reader, label)
                            .await
                    } else {
                        let mut guard = guard;
                        let read = self
                            .fetch_from_backend(&key, class, reader, label, started)
                            .await;
                        guard.complete([(key.clone(), share(&read.result))]);
                        Led::Read(read)
                    };
                    match led {
                        Led::Read(read) => {
                            return TimedRead {
                                result: read.result,
                                timing: waited.followed_by(read.timing),
                            };
                        }
                        // A carried read learns its carrier only from the delivery.
                        Led::Carried(delivered, parked) => (delivered, parked, None),
                    }
                }
            };

            let abandoned_by = match delivered {
                // The leader's outcome, with its error variant rebuilt so it
                // triages identically. A shared failure is not cached.
                Ok(Delivery::Done { result, leader }) => {
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
                            result.is_err(),
                        );
                    }
                    return TimedRead {
                        result: result.map_err(SharedError::into_object_store_error),
                        // The whole wait, and only the wait: the leader owns
                        // the permit and the round trip.
                        timing: waited.followed_by(SourceReadTiming {
                            coalesced_wait_us: Some(micros(parked.elapsed())),
                            coalesced_onto: Some(leader),
                            ..SourceReadTiming::default()
                        }),
                    };
                }
                // The leader went away without reading. A closed channel is
                // the same case from a guard that never got to say so, with
                // the subscription-time label standing in. Go round again so
                // this caller still gets a real answer.
                Ok(Delivery::Abandoned { leader }) => Some(leader),
                Err(_) => leader,
            };
            waited = waited.followed_by(SourceReadTiming {
                coalesced_wait_us: Some(micros(parked.elapsed())),
                coalesced_onto: abandoned_by,
                ..SourceReadTiming::default()
            });
        }
    }

    /// Lead the read of one bounded chunk range: queue for a permit, and
    /// once admitted carry every queued neighbour of the range in the one
    /// request.
    ///
    /// The queue is the merge window. Reads that are waiting for a permit
    /// together arrived together — a pan's worth of inner chunks of one
    /// shard — and the first of them admitted takes the whole group on its
    /// permit, as a single-flight leader takes its followers. A neighbour
    /// admitted first may carry this read instead; then it is delivered on
    /// the leader's own subscription and no permit is ever taken for it.
    ///
    /// A group is contiguous bytes, so routing it through object_store's
    /// multi-range read is one fetch whatever gap that read merges on. Each
    /// range still lands in its own entry: the slices come back one per
    /// range, and each is copied out so an entry owns exactly the bytes it
    /// is charged for rather than a view onto the whole fetch.
    async fn lead_range_read(
        &self,
        mut guard: LeaderGuard<'_>,
        mut delivery: broadcast::Receiver<Delivery>,
        key: &ReadKey,
        reader: ReaderId,
        label: RequestLabel,
    ) -> Led {
        let started = std::time::Instant::now();
        let permit = tokio::select! {
            permit = self.source_read.acquire(reader) => permit,
            delivered = delivery.recv() => {
                guard.disarm();
                return Led::Carried(delivered, started);
            }
        };
        let permit_wait = started.elapsed();
        trace_permit_acquired(reader, label, permit_wait);

        let keys = {
            let mut flights = self.in_flight.lock().unwrap();
            flights.claim_group(&mut guard)
        };
        let Some(keys) = keys else {
            // A neighbour claimed this range between the permit grant and this claim.
            drop(permit);
            guard.disarm();
            return Led::Carried(delivery.recv().await, started);
        };

        let fetch = if keys.len() == 1 {
            self.request(key).await.map(|bytes| vec![bytes])
        } else {
            let ranges: Vec<Range<u64>> = keys
                .iter()
                .map(|key| {
                    key.bounded()
                        .expect("a claimed key is a bounded range")
                        .clone()
                })
                .collect();
            self.inner
                .get_ranges(&key.path, &ranges)
                .await
                .map(|slices| {
                    slices
                        .iter()
                        .map(|slice| Bytes::copy_from_slice(slice))
                        .collect()
                })
        };
        drop(permit);
        let elapsed = started.elapsed();
        let timing = permit_and_read(
            permit_wait,
            elapsed,
            fetch
                .as_ref()
                .map_or(0, |slices| slices.iter().map(Bytes::len).sum()),
        );

        let result = match fetch {
            Ok(slices) => {
                let mut state = self.cache.lock().unwrap();
                state.count_round_trip(elapsed, false);
                let mut own = None;
                let mut outcomes = Vec::with_capacity(keys.len());
                for (member, bytes) in keys.iter().zip(slices) {
                    let bytes = state.insert(member, bytes);
                    if member == key {
                        own = Some(bytes.clone());
                    }
                    outcomes.push((member.clone(), Ok(bytes)));
                }
                drop(state);
                guard.complete(outcomes);
                Ok(own.expect("the leader's own range is in its group"))
            }
            Err(error) => {
                self.cache.lock().unwrap().count_round_trip(elapsed, true);
                let shared = SharedError::capture(&error);
                guard.complete(
                    keys.iter()
                        .map(|member| (member.clone(), Err(shared.clone()))),
                );
                Err(error)
            }
        };
        Led::Read(TimedRead { result, timing })
    }

    /// One backend request for `key`: the whole object, or the range or
    /// suffix the key names.
    async fn request(&self, key: &ReadKey) -> Result<Bytes, object_store::Error> {
        let options = GetOptions {
            range: key.range.clone().map(GetRange::from),
            ..GetOptions::default()
        };
        self.inner.get_opts(&key.path, options).await?.bytes().await
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
        self.get_optional_metadata(ReadKey::new(path, None)).await
    }

    /// Read one byte range of an object that may legitimately not exist, as
    /// a metadata read.
    ///
    /// The one range read in the metadata class. It exists for the
    /// unwritten-level probe, which reads a shard's index while an open is
    /// still resolving the dataset's shape. That is a question about the
    /// shape, not the data, so the read queues behind the metadata cap
    /// rather than a chunk permit and files a row in the open's metadata
    /// family, as [`probe_exists`] does. Absence is answered and remembered
    /// as [`get_optional_metadata_bytes`] answers and remembers it. An
    /// object that is not there has no range either.
    ///
    /// [`probe_exists`]: Self::probe_exists
    /// [`get_optional_metadata_bytes`]: Self::get_optional_metadata_bytes
    pub(crate) async fn get_optional_metadata_range(
        &self,
        path: &Path,
        range: ByteRange,
    ) -> Result<Option<Bytes>, object_store::Error> {
        self.get_optional_metadata(ReadKey::new(path, Some(range)))
            .await
    }

    async fn get_optional_metadata(
        &self,
        read: ReadKey,
    ) -> Result<Option<Bytes>, object_store::Error> {
        let key = read.path.to_string();
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
                read,
                ReadClass::OptionalMetadata,
                ReaderId::UNATTRIBUTED,
                RequestLabel::UNATTRIBUTED,
            )
            .await
            .result
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
        key: &ReadKey,
        class: ReadClass,
        reader: ReaderId,
        label: RequestLabel,
        // When the *caller* asked, for a metadata read's row. A leader row
        // and a follower row are then measured from the same origin, which
        // is what makes the two comparable at all; the cache's own counters
        // keep their own clock below.
        called_at: Option<std::time::Instant>,
    ) -> TimedRead {
        // Timed from here, before the permit is acquired: queueing behind our
        // own concurrency cap is part of what a caller waits for, and leaving
        // it out would understate the read by roughly half on a remote store.
        // The cumulative counter keeps that combined number; the two halves
        // are reported apart per read, because "waited for a permit" and
        // "waited for the backend" have different fixes.
        let started = std::time::Instant::now();
        // Assigned by whichever arm of the class match takes a permit.
        let permit_wait: std::time::Duration;
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
                    permit_wait = started.elapsed();
                    trace_permit_acquired(reader, label, permit_wait);
                    permit
                }
                ReadClass::Metadata | ReadClass::OptionalMetadata => {
                    let permit = ReadPermit::Metadata(
                        self.metadata_read
                            .acquire()
                            .await
                            .expect("metadata-read semaphore is never closed"),
                    );
                    permit_wait = started.elapsed();
                    permit
                }
            };
            self.request(key).await
        };
        let elapsed = started.elapsed();
        let timing = permit_and_read(permit_wait, elapsed, fetch.as_ref().map_or(0, Bytes::len));

        // An optional object that is not there answered the question it was
        // asked, so it is not a failed read, for the open's row and the
        // backend-error counter alike.
        let absent_as_expected = class == ReadClass::OptionalMetadata
            && matches!(fetch, Err(object_store::Error::NotFound { .. }));
        if let Some(called_at) = called_at {
            metadata_reads::record(
                MetadataReadPhase::BackendRead,
                called_at,
                fetch.is_err() && !absent_as_expected,
            );
        }

        let result = {
            let mut state = self.cache.lock().unwrap();
            state.count_round_trip(elapsed, fetch.is_err() && !absent_as_expected);
            fetch.map(|bytes| state.insert(key, bytes))
        };
        TimedRead { result, timing }
    }
}

/// How a leader's attempt at a bounded range read came out.
enum Led {
    /// This caller made the request, or failed to.
    Read(TimedRead),
    /// A neighbour carried the read: what it delivered, and when this
    /// caller began waiting.
    Carried(
        Result<Delivery, broadcast::error::RecvError>,
        std::time::Instant,
    ),
}

/// The wait behind the cap is the rate-setter on a remote store, and it is
/// only diagnosable if it can be named per request rather than per client.
fn trace_permit_acquired(reader: ReaderId, label: RequestLabel, wait: std::time::Duration) {
    tracing::trace!(
        rid = label.0,
        reader = reader.0,
        wait_us = wait.as_micros() as u64,
        "store.chunk_read.permit_acquired"
    );
}

/// The two timed stretches of a read that took a permit: queued behind the
/// cap, then the round trip. `bytes_moved` is what the round trip returned:
/// the object, the range, or every range a merged request carried. A failed
/// round trip moved nothing, and still was one.
fn permit_and_read(
    permit_wait: std::time::Duration,
    elapsed: std::time::Duration,
    bytes_moved: usize,
) -> SourceReadTiming {
    SourceReadTiming {
        permit_wait_us: Some(micros(permit_wait)),
        backend_read_us: Some(micros(elapsed.saturating_sub(permit_wait))),
        backend_bytes: Some(u32::try_from(bytes_moved).unwrap_or(u32::MAX)),
        ..SourceReadTiming::default()
    }
}

/// A read's outcome in the shape the broadcast carries.
fn share(result: &Result<Bytes, object_store::Error>) -> ShareResult {
    match result {
        Ok(bytes) => Ok(bytes.clone()),
        Err(error) => Err(SharedError::capture(error)),
    }
}

impl LruState {
    /// Count one backend round trip, however it answered.
    fn count_round_trip(&mut self, elapsed: std::time::Duration, failed: bool) {
        self.source_reads += 1;
        self.source_read_nanos += elapsed.as_nanos();
        if failed {
            self.backend_errors += 1;
        }
    }

    /// Make `bytes` resident under `key`, evicting from the LRU end to stay
    /// within budget. A key that became resident meanwhile keeps what it
    /// has, and that is what the caller gets back.
    fn insert(&mut self, key: &ReadKey, bytes: Bytes) -> Bytes {
        if let Some(existing) = self.lru.get(key) {
            return existing.clone();
        }
        let new_size = bytes.len();
        while self.current_bytes + new_size > self.max_bytes {
            match self.lru.pop_lru() {
                Some((_, evicted)) => {
                    self.current_bytes -= evicted.len();
                    self.evictions += 1;
                }
                None => break,
            }
        }
        self.current_bytes += new_size;
        self.lru.put(key.clone(), bytes.clone());
        bytes
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
        let first = cached.get_bytes(&path, READER, LABEL).await.result.unwrap();
        let second = cached.get_bytes(&path, READER, LABEL).await.result.unwrap();
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

        let _a = cached.get_bytes(&pa, READER, LABEL).await.result.unwrap();
        let _b = cached.get_bytes(&pb, READER, LABEL).await.result.unwrap();

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
            .await
            .result;
        assert!(result.is_err());
        let stats = cached.stats();
        assert_eq!(stats.backend_errors, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Single-flight, cap, and failure-sharing tests ---
    //
    // These use a counting in-memory `ObjectStore` with a per-GET delay so
    // concurrent reads genuinely overlap. Assertions are on GET counts and
    // observed max concurrency, never wall-clock time.

    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use crate::test_support::CountingStore;

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
            let bytes = handle.await.unwrap().result.unwrap();
            assert_eq!(&bytes[..], b"payload");
        }

        // Exactly one backend read despite `waiters` concurrent misses.
        assert_eq!(get_count.load(Ordering::SeqCst), 1);

        let stats = cached.stats();
        assert_eq!(stats.coalesced, waiters - 1);
        assert_eq!(stats.entry_count, 1);
    }

    /// The assertion the trace's arithmetic rests on: two concurrent readers
    /// of one object path produce exactly one backend read and exactly one
    /// coalesced wait. If a follower reported the leader's read as its own, a
    /// sum over the read column would report thousands of round trips for an
    /// open that made hundreds (ADR 0050).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_readers_of_one_path_yield_one_read_and_one_coalesced_wait() {
        let delay_ms = 50;
        let store = Arc::new(CountingStore::new(delay_ms));
        store.seed("chunk", b"payload").await;
        let get_count = store.get_count.clone();

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            SourceReadLimiter::new(64),
        ));

        // Two labels, because the point of the row is which read a wait was
        // spent on, and one label could not tell them apart.
        const LEADER_LABEL: RequestLabel = RequestLabel(11);
        const FOLLOWER_LABEL: RequestLabel = RequestLabel(12);
        let leader = {
            let cached = cached.clone();
            tokio::spawn(async move {
                cached
                    .get_bytes(&Path::from("chunk"), READER, LEADER_LABEL)
                    .await
            })
        };
        // Long enough that the leader has registered its in-flight entry and
        // is inside the delayed backend read.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let follower = {
            let cached = cached.clone();
            tokio::spawn(async move {
                cached
                    .get_bytes(&Path::from("chunk"), READER, FOLLOWER_LABEL)
                    .await
            })
        };

        let leader = leader.await.unwrap();
        let follower = follower.await.unwrap();
        assert_eq!(&leader.result.unwrap()[..], b"payload");
        assert_eq!(&follower.result.unwrap()[..], b"payload");

        assert_eq!(get_count.load(Ordering::SeqCst), 1, "one backend read");

        // The leader owns the permit, the round trip, and the bytes it moved.
        assert!(leader.timing.permit_wait_us.is_some());
        assert!(
            leader.timing.backend_read_us.unwrap() >= (delay_ms * 1_000) as u32,
            "the leader's read covers the backend delay"
        );
        assert_eq!(leader.timing.backend_bytes, Some(b"payload".len() as u32));
        assert_eq!(leader.timing.coalesced_wait_us, None);
        assert_eq!(leader.timing.coalesced_onto, None, "the leader led");

        // The follower owns only its wait, and it is diagnosed as waiting on
        // an in-flight read rather than as a slow backend. The bytes are the
        // leader's too: a sum over the column counts each byte moved once.
        assert_eq!(follower.timing.permit_wait_us, None);
        assert_eq!(follower.timing.backend_read_us, None);
        assert_eq!(follower.timing.backend_bytes, None);
        assert!(
            follower.timing.coalesced_wait_us.expect("a coalesced wait") > 0,
            "the follower's wait is recorded under the coalesced phase"
        );
        // And it says *which* read it waited on, not merely that it waited.
        assert_eq!(follower.timing.coalesced_onto, Some(LEADER_LABEL));
        assert_eq!(cached.stats().coalesced, 1);
    }

    /// A read the LRU answers costs neither a permit nor a round trip, and
    /// says so — a cache hit must not appear in the trace as a fast backend.
    #[tokio::test]
    async fn a_cache_hit_reports_only_a_lookup() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("chunk", b"payload").await;
        let cached = CachedStore::new(store, 1024);

        let path = Path::from("chunk");
        cached.get_bytes(&path, READER, LABEL).await.result.unwrap();
        let hit = cached.get_bytes(&path, READER, LABEL).await;

        assert!(hit.result.is_ok());
        assert_eq!(hit.timing.permit_wait_us, None);
        assert_eq!(hit.timing.backend_read_us, None);
        assert_eq!(hit.timing.coalesced_wait_us, None);
    }

    /// A read that fails still waited, and the wait is the interesting part.
    #[tokio::test]
    async fn a_failed_read_still_reports_its_permit_wait_and_round_trip() {
        let store = Arc::new(CountingStore::new(20));
        store.fail.store(true, Ordering::SeqCst);
        let cached = CachedStore::new(store, 1024);

        let read = cached.get_bytes(&Path::from("a"), READER, LABEL).await;
        assert!(read.result.is_err());
        assert!(read.timing.permit_wait_us.is_some());
        assert!(read.timing.backend_read_us.unwrap() >= 20_000);
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
            assert!(handle.await.unwrap().result.is_err());
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
            .result
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
                    .result
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
            let flights = cached.in_flight.lock().unwrap();
            assert!(
                flights.reads.is_empty(),
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
        .result
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
            .result
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
            .result
            .unwrap();
        cached
            .get_bytes(&Path::from("b"), READER, LABEL)
            .await
            .result
            .unwrap();
        // A hit costs no backend read and no read time.
        cached
            .get_bytes(&Path::from("a"), READER, LABEL)
            .await
            .result
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
                .result
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
            .result
            .unwrap();

        // A second open of the same source reads what the first one cached.
        let second = CachedStore::shared_for_source("src-a", store.clone(), 1024);
        assert!(Arc::ptr_eq(&first, &second));
        second
            .get_bytes(&Path::from("zarr.json"), READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(get_count.load(Ordering::SeqCst), 1);

        // A different source is a different cache.
        let other = CachedStore::shared_for_source("src-b", store.clone(), 1024);
        assert!(!Arc::ptr_eq(&first, &other));
        other
            .get_bytes(&Path::from("zarr.json"), READER, LABEL)
            .await
            .result
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
            .result
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
        assert!(
            cached
                .get_bytes(&sparse, READER, LABEL)
                .await
                .result
                .is_err()
        );
        assert!(
            cached
                .get_bytes(&sparse, READER, LABEL)
                .await
                .result
                .is_err()
        );
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
                .result
                .is_err()
        );

        let stats = cached.stats();
        assert_eq!(
            stats.source_reads, 1,
            "a failed read still cost a round trip"
        );
        assert!(stats.source_read_millis >= 20);
    }

    /// Two reads that answer one request report their bytes as one sum, in
    /// the same way as their durations, and a stretch neither read had stays
    /// unset rather than becoming a zero-byte read.
    #[test]
    fn followed_by_sums_the_bytes_of_two_reads_and_leaves_none_unset() {
        let index = SourceReadTiming {
            backend_read_us: Some(10),
            backend_bytes: Some(68),
            ..SourceReadTiming::default()
        };
        let inner = SourceReadTiming {
            backend_read_us: Some(20),
            backend_bytes: Some(5),
            ..SourceReadTiming::default()
        };
        assert_eq!(index.followed_by(inner).backend_bytes, Some(73));

        let follower = SourceReadTiming {
            coalesced_wait_us: Some(7),
            ..SourceReadTiming::default()
        };
        assert_eq!(follower.followed_by(inner).backend_bytes, Some(5));
        assert_eq!(
            SourceReadTiming::default()
                .followed_by(follower)
                .backend_bytes,
            None
        );
    }

    // --- Range reads ---
    //
    // These pin the contract the shard reader (#990) builds on.

    #[tokio::test]
    async fn a_range_read_returns_exactly_the_requested_bytes() {
        let dir = temp_dir("range_bytes");
        fs::write(dir.join("object"), b"0123456789abcdef").unwrap();

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let path = Path::from("object");
        let first = cached.get_range(&path, 4..10, READER, LABEL).await;
        // The row reports the range's length, not the object's: that is
        // what lets a trace say a shard was read by the inner chunk and not
        // whole.
        assert_eq!(first.timing.backend_bytes, Some(6));
        let first = first.result.unwrap();
        assert_eq!(&first[..], b"456789");

        let second = cached.get_range(&path, 4..10, READER, LABEL).await;
        assert_eq!(
            second.timing.backend_bytes, None,
            "a resident range moved no bytes from the backend"
        );
        let second = second.result.unwrap();
        assert_eq!(first, second);
        let stats = cached.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.source_reads, 1);
        assert_eq!(stats.entry_count, 1);
        assert_eq!(
            stats.current_bytes, 6,
            "the entry is the range, not the object"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A shard's index sits at the end of an object whose length the cached
    /// store does not know. A suffix read gets it in one round trip, where a
    /// bounded range would first need a HEAD to find the end.
    #[tokio::test]
    async fn a_suffix_read_returns_the_last_bytes_as_its_own_entry() {
        let dir = temp_dir("suffix_bytes");
        fs::write(dir.join("object"), b"0123456789abcdef").unwrap();

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let path = Path::from("object");
        let tail = cached
            .get_suffix(&path, 6, READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(&tail[..], b"abcdef");

        let again = cached
            .get_suffix(&path, 6, READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(tail, again);
        let stats = cached.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.source_reads, 1);
        assert_eq!(stats.entry_count, 1);
        assert_eq!(stats.current_bytes, 6);

        // The same bytes as a bounded range are a second entry: unifying the
        // two keys would take the object's length, which is never fetched.
        let bounded = cached
            .get_range(&path, 10..16, READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(bounded, tail);
        assert_eq!(cached.stats().entry_count, 2);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Four range reads of four objects: nothing to merge, so each is its own
    /// round trip, and each holds a chunk permit for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_range_read_takes_one_chunk_permit() {
        let store = Arc::new(CountingStore::new(50));
        let objects = 4u64;
        for i in 0..objects {
            store
                .seed(&format!("object-{i}"), b"0123456789abcdef")
                .await;
        }
        let get_count = store.get_count.clone();
        let max_active = store.max_active.clone();

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            SourceReadLimiter::new(1),
        ));

        let mut handles = Vec::new();
        for i in 0..objects {
            let cached = cached.clone();
            handles.push(tokio::spawn(async move {
                cached
                    .get_range(&Path::from(format!("object-{i}")), 4..8, READER, LABEL)
                    .await
                    .result
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        assert_eq!(get_count.load(Ordering::SeqCst), objects as usize);
        assert_eq!(
            max_active.load(Ordering::SeqCst),
            1,
            "distinct range reads overlapped under a chunk cap of one"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_range_read_holding_the_chunk_cap_does_not_block_a_metadata_read() {
        let store = Arc::new(CountingStore::new(50));
        store.seed("object", b"0123456789abcdef").await;
        store.seed("zarr.json", b"{}").await;
        let max_active = store.max_active.clone();

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            SourceReadLimiter::new(1),
        ));

        let range = {
            let cached = cached.clone();
            tokio::spawn(async move {
                cached
                    .get_range(&Path::from("object"), 0..4, READER, LABEL)
                    .await
                    .result
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        cached
            .get_metadata_bytes(&Path::from("zarr.json"))
            .await
            .unwrap();
        range.await.unwrap().unwrap();

        assert_eq!(
            max_active.load(Ordering::SeqCst),
            2,
            "the metadata read queued behind the chunk permit a range read held"
        );
    }

    /// The unwritten-level probe reads a shard's index while an open is
    /// resolving the dataset's shape, so the read is metadata however it is
    /// shaped. A chunk permit that a range read holds must not delay it, and
    /// it files a row in the open's metadata family.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_optional_metadata_range_read_takes_no_chunk_permit_and_files_a_metadata_row() {
        let store = Arc::new(CountingStore::new(50));
        store.seed("object", b"0123456789abcdef").await;
        store.seed("0/c/0/0", b"inner-chunks-then-index").await;
        let max_active = store.max_active.clone();
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            SourceReadLimiter::new(1),
        ));

        let range = {
            let cached = cached.clone();
            tokio::spawn(async move {
                cached
                    .get_range(&Path::from("object"), 0..4, READER, LABEL)
                    .await
                    .result
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        let watcher = Arc::new(Watcher::default());
        let index = crate::metadata_reads::observing(watcher.clone(), async {
            cached
                .get_optional_metadata_range(&Path::from("0/c/0/0"), ByteRange::Suffix(5))
                .await
                .unwrap()
        })
        .await;
        range.await.unwrap().unwrap();

        assert_eq!(index.as_deref(), Some(&b"index"[..]));
        assert_eq!(
            max_active.load(Ordering::SeqCst),
            2,
            "the probe's range read queued behind the chunk permit a range read held"
        );
        assert_eq!(watcher.phases(), vec![MetadataReadPhase::BackendRead]);
    }

    /// A shard object that is not there is an answer, not a fault, and the
    /// absence is remembered by path, so a second range of the same object
    /// costs no round trip.
    #[tokio::test]
    async fn an_absent_optional_metadata_range_is_an_answer_and_is_remembered() {
        let store = Arc::new(CountingStore::new(0));
        let get_count = store.get_count.clone();
        let cached = CachedStore::new(store, 1024);
        let missing = Path::from("2/c/0/0");

        let suffix = cached
            .get_optional_metadata_range(&missing, ByteRange::Suffix(68))
            .await
            .unwrap();
        let bounded = cached
            .get_optional_metadata_range(&missing, ByteRange::Bounded(0..68))
            .await
            .unwrap();

        assert_eq!(suffix, None);
        assert_eq!(bounded, None);
        assert_eq!(get_count.load(Ordering::SeqCst), 1);
        assert_eq!(cached.stats().backend_errors, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_callers_for_one_path_and_range_coalesce_onto_one_backend_read() {
        let store = Arc::new(CountingStore::new(50));
        store.seed("object", b"0123456789abcdef").await;
        let get_count = store.get_count.clone();

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
                cached
                    .get_range(&Path::from("object"), 8..12, READER, LABEL)
                    .await
            }));
        }

        let mut round_trips = 0;
        let mut coalesced_waits = 0;
        for handle in handles {
            let read = handle.await.unwrap();
            assert_eq!(&read.result.unwrap()[..], b"89ab");
            if read.timing.backend_read_us.is_some() {
                round_trips += 1;
            }
            if read.timing.coalesced_wait_us.is_some() {
                coalesced_waits += 1;
            }
        }

        assert_eq!(get_count.load(Ordering::SeqCst), 1, "one backend read");
        // One row owns the round trip and every other row owns only its wait
        // (ADR 0050).
        assert_eq!(round_trips, 1);
        assert_eq!(coalesced_waits, waiters - 1);
        let stats = cached.stats();
        assert_eq!(stats.coalesced, waiters - 1);
        assert_eq!(stats.source_reads, 1);
        assert_eq!(stats.entry_count, 1);
    }

    #[tokio::test]
    async fn a_range_read_and_a_whole_object_read_of_one_path_are_distinct_entries() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("object", b"0123456789").await;
        let get_count = store.get_count.clone();
        let cached = CachedStore::new(store, 1024);

        let path = Path::from("object");
        let head = cached
            .get_range(&path, 0..4, READER, LABEL)
            .await
            .result
            .unwrap();
        let whole = cached.get_bytes(&path, READER, LABEL).await.result.unwrap();
        let tail = cached
            .get_range(&path, 4..8, READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(&head[..], b"0123");
        assert_eq!(&whole[..], b"0123456789");
        assert_eq!(&tail[..], b"4567");

        assert_eq!(get_count.load(Ordering::SeqCst), 3);
        let stats = cached.stats();
        assert_eq!(stats.hits, 0);
        assert_eq!(stats.misses, 3);
        assert_eq!(stats.entry_count, 3);
        assert_eq!(stats.current_bytes, 4 + 10 + 4);

        let again = cached
            .get_range(&path, 0..4, READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(&again[..], b"0123");
        assert_eq!(get_count.load(Ordering::SeqCst), 3);
        assert_eq!(cached.stats().hits, 1);
    }

    /// Coalescing is per key. A follower is handed the leader's bytes
    /// verbatim, so a range read parked on an in-flight whole-object read
    /// of the same path would come back with the whole object. That is the
    /// one outcome a range read exists to avoid.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_range_and_whole_object_reads_of_one_path_do_not_coalesce() {
        let store = Arc::new(CountingStore::new(50));
        store.seed("object", b"0123456789").await;
        let get_count = store.get_count.clone();

        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            SourceReadLimiter::new(64),
        ));

        let whole = {
            let cached = cached.clone();
            tokio::spawn(
                async move { cached.get_bytes(&Path::from("object"), READER, LABEL).await },
            )
        };
        // Long enough that the whole-object read has registered in flight.
        tokio::time::sleep(Duration::from_millis(10)).await;
        let range = {
            let cached = cached.clone();
            tokio::spawn(async move {
                cached
                    .get_range(&Path::from("object"), 2..6, READER, LABEL)
                    .await
            })
        };

        let whole = whole.await.unwrap();
        let range = range.await.unwrap();
        assert_eq!(&whole.result.unwrap()[..], b"0123456789");
        assert_eq!(&range.result.unwrap()[..], b"2345");

        assert_eq!(get_count.load(Ordering::SeqCst), 2, "two keys, two reads");
        assert_eq!(range.timing.coalesced_wait_us, None);
        assert_eq!(range.timing.coalesced_onto, None);
        assert_eq!(cached.stats().coalesced, 0);
    }

    #[tokio::test]
    async fn a_range_read_counts_as_one_source_read_with_a_permit_wait_and_a_round_trip() {
        let delay_ms = 20;
        let store = Arc::new(CountingStore::new(delay_ms));
        store.seed("object", b"0123456789").await;
        let cached = Arc::new(CachedStore::new(store, 1024));
        let watcher = Arc::new(Watcher::default());

        let read = crate::metadata_reads::observing(watcher.clone(), async {
            cached
                .get_range(&Path::from("object"), 0..4, READER, LABEL)
                .await
        })
        .await;
        assert!(read.result.is_ok());

        assert!(read.timing.permit_wait_us.is_some());
        assert!(read.timing.backend_read_us.unwrap() >= (delay_ms * 1_000) as u32);
        assert_eq!(read.timing.coalesced_wait_us, None);
        assert_eq!(read.timing.coalesced_onto, None);

        let stats = cached.stats();
        assert_eq!(stats.source_reads, 1);
        assert_eq!(stats.misses, 1);
        assert!(stats.source_read_millis >= delay_ms);
        assert_eq!(stats.backend_errors, 0);

        assert!(
            watcher.phases().is_empty(),
            "a range read is not a metadata read and must not appear in the open's rows",
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

    // --- Merged range reads ---
    //
    // Each test holds the only permit while it spawns a group, so the group
    // is queued together by construction rather than by timing.

    /// Spawned readers register asynchronously, so a test that needs a group
    /// queued together waits until the limiter actually holds them.
    async fn wait_for_queued(limiter: &Arc<SourceReadLimiter>, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while limiter.queued_reads() < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("readers queued");
    }

    /// The backend has begun serving `count` requests, so a leader has been
    /// admitted, has claimed its group, and is inside the delayed request.
    async fn wait_for_requests(get_count: &std::sync::atomic::AtomicUsize, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while get_count.load(Ordering::SeqCst) < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a request reached the backend");
    }

    /// A permit held by a reader outside the test's group, so the group
    /// queues behind it. Dropping it is what admits the first of them.
    const OUTSIDER: ReaderId = ReaderId(99);

    /// Sixteen bytes in four adjacent ranges of four.
    const SHARD_BYTES: &[u8] = b"0123456789abcdef";

    fn spawn_range_read(
        cached: &Arc<CachedStore>,
        path: &str,
        range: Range<u64>,
        label: RequestLabel,
    ) -> tokio::task::JoinHandle<TimedRead> {
        let cached = cached.clone();
        let path = Path::from(path);
        tokio::spawn(async move { cached.get_range(&path, range, READER, label).await })
    }

    /// Four adjacent ranges of one object, queued together behind the one
    /// permit, cost the backend one request — and each range is still its
    /// own entry, so a later read of any one of them is a hit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn adjacent_range_reads_queued_together_share_one_backend_request() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("shard", SHARD_BYTES).await;
        let get_count = store.get_count.clone();
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            limiter.clone(),
        ));

        let held = limiter.acquire(OUTSIDER).await;
        let handles: Vec<_> = (0..4u64)
            .map(|i| spawn_range_read(&cached, "shard", i * 4..i * 4 + 4, RequestLabel(i as u32)))
            .collect();
        wait_for_queued(&limiter, 4).await;
        drop(held);

        for (i, handle) in handles.into_iter().enumerate() {
            let bytes = handle.await.unwrap().result.unwrap();
            assert_eq!(&bytes[..], &SHARD_BYTES[i * 4..i * 4 + 4], "range {i}");
        }
        assert_eq!(
            get_count.load(Ordering::SeqCst),
            1,
            "four adjacent ranges queued together are one request"
        );

        let stats = cached.stats();
        assert_eq!(
            stats.entry_count, 4,
            "one entry per range, not one per request"
        );
        assert_eq!(stats.current_bytes, SHARD_BYTES.len());
        assert_eq!(stats.source_reads, 1);
        assert_eq!(stats.misses, 4);

        for i in 0..4u64 {
            let again = cached
                .get_range(&Path::from("shard"), i * 4..i * 4 + 4, READER, LABEL)
                .await
                .result
                .unwrap();
            assert_eq!(&again[..], &SHARD_BYTES[i as usize * 4..i as usize * 4 + 4]);
        }
        assert_eq!(cached.stats().hits, 4, "every merged range is a later hit");
        assert_eq!(get_count.load(Ordering::SeqCst), 1);
    }

    /// The merged request is one permit and one round trip, and the rows say
    /// so: the read that led it owns the permit wait and the backend read,
    /// and each read it carried owns only a wait, attributed to the leader's
    /// label. A sum over the backend column still counts one trip (ADR 0050).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_merged_read_takes_one_permit_and_the_reads_it_carried_report_a_wait_on_its_leader() {
        let delay_ms = 30;
        let store = Arc::new(CountingStore::new(delay_ms));
        store.seed("shard", SHARD_BYTES).await;
        let max_active = store.max_active.clone();
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            limiter.clone(),
        ));

        let held = limiter.acquire(OUTSIDER).await;
        let handles: Vec<_> = (0..4u64)
            .map(|i| spawn_range_read(&cached, "shard", i * 4..i * 4 + 4, RequestLabel(i as u32)))
            .collect();
        wait_for_queued(&limiter, 4).await;
        drop(held);

        let mut reads = Vec::new();
        for (i, handle) in handles.into_iter().enumerate() {
            reads.push((RequestLabel(i as u32), handle.await.unwrap()));
        }

        let leaders: Vec<_> = reads
            .iter()
            .filter(|(_, read)| read.timing.backend_read_us.is_some())
            .collect();
        assert_eq!(leaders.len(), 1, "exactly one row owns the round trip");
        let (leader_label, leader) = leaders[0];
        assert!(leader.timing.permit_wait_us.is_some());
        assert!(leader.timing.backend_read_us.unwrap() >= (delay_ms * 1_000) as u32);
        assert_eq!(leader.timing.coalesced_wait_us, None);
        assert_eq!(leader.timing.coalesced_onto, None);

        // The leader's row carries every byte the merged request moved, so
        // a trace reads four inner chunks off one row and nothing off the
        // three it carried: the column still sums to the bytes moved.
        assert_eq!(leader.timing.backend_bytes, Some(16));

        for (label, carried) in reads.iter().filter(|(label, _)| label != leader_label) {
            assert_eq!(
                carried.timing.permit_wait_us, None,
                "{label:?} took no permit"
            );
            assert_eq!(
                carried.timing.backend_read_us, None,
                "{label:?} made no trip"
            );
            assert_eq!(
                carried.timing.backend_bytes, None,
                "{label:?} moved no bytes of its own"
            );
            assert!(
                carried
                    .timing
                    .coalesced_wait_us
                    .expect("a carried read waited")
                    > 0,
                "{label:?}"
            );
            assert_eq!(carried.timing.coalesced_onto, Some(*leader_label));
        }

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        let stats = cached.stats();
        assert_eq!(stats.source_reads, 1);
        assert_eq!(
            stats.coalesced, 3,
            "the reads it carried are followers of the merged read"
        );
    }

    /// Only contiguous ranges merge: ranges of one object with a byte
    /// between them, ranges of different objects, and a suffix read beside
    /// a bounded one each cost their own request.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn range_reads_that_are_not_contiguous_are_not_merged() {
        let store = Arc::new(CountingStore::new(0));
        store.seed("gapped", SHARD_BYTES).await;
        store.seed("a", SHARD_BYTES).await;
        store.seed("b", SHARD_BYTES).await;
        let get_count = store.get_count.clone();
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            limiter.clone(),
        ));

        // One byte apart: two requests, and neither fetched the byte between.
        let held = limiter.acquire(OUTSIDER).await;
        let head = spawn_range_read(&cached, "gapped", 0..7, RequestLabel(1));
        let tail = spawn_range_read(&cached, "gapped", 8..16, RequestLabel(2));
        wait_for_queued(&limiter, 2).await;
        drop(held);
        assert_eq!(&head.await.unwrap().result.unwrap()[..], &SHARD_BYTES[0..7]);
        assert_eq!(
            &tail.await.unwrap().result.unwrap()[..],
            &SHARD_BYTES[8..16]
        );
        assert_eq!(get_count.load(Ordering::SeqCst), 2, "a gap of one byte");
        assert_eq!(cached.stats().current_bytes, 15);

        let held = limiter.acquire(OUTSIDER).await;
        let a = spawn_range_read(&cached, "a", 0..8, RequestLabel(3));
        let b = spawn_range_read(&cached, "b", 0..8, RequestLabel(4));
        wait_for_queued(&limiter, 2).await;
        drop(held);
        a.await.unwrap().result.unwrap();
        b.await.unwrap().result.unwrap();
        assert_eq!(get_count.load(Ordering::SeqCst), 4, "two objects");

        let held = limiter.acquire(OUTSIDER).await;
        let bounded = spawn_range_read(&cached, "a", 8..16, RequestLabel(5));
        let suffix = {
            let cached = cached.clone();
            tokio::spawn(async move {
                cached
                    .get_suffix(&Path::from("a"), 8, READER, RequestLabel(6))
                    .await
            })
        };
        wait_for_queued(&limiter, 2).await;
        drop(held);
        assert_eq!(
            &bounded.await.unwrap().result.unwrap()[..],
            &SHARD_BYTES[8..]
        );
        assert_eq!(
            &suffix.await.unwrap().result.unwrap()[..],
            &SHARD_BYTES[8..]
        );
        assert_eq!(
            get_count.load(Ordering::SeqCst),
            6,
            "a suffix beside a range"
        );

        assert_eq!(cached.stats().coalesced, 0);
    }

    /// Within one reader the limiter admits in queue order, so a read queued
    /// alone before its neighbours is the one that leads their merged read.
    async fn queue_leader_then_neighbours(
        cached: &Arc<CachedStore>,
        limiter: &Arc<SourceReadLimiter>,
    ) -> [tokio::task::JoinHandle<TimedRead>; 3] {
        let held = limiter.acquire(OUTSIDER).await;
        let first = spawn_range_read(cached, "shard", 0..4, RequestLabel(1));
        wait_for_queued(limiter, 1).await;
        let second = spawn_range_read(cached, "shard", 4..8, RequestLabel(2));
        let third = spawn_range_read(cached, "shard", 8..12, RequestLabel(3));
        wait_for_queued(limiter, 3).await;
        drop(held);
        [first, second, third]
    }

    fn no_flight_is_left_behind(cached: &CachedStore) {
        let flights = cached.in_flight.lock().unwrap();
        assert!(flights.reads.is_empty(), "an in-flight entry was stranded");
        assert!(
            flights.queued_ranges.is_empty(),
            "a queued range was stranded"
        );
    }

    /// A leader cancelled mid-request leaves the reads it carried without a
    /// result. They fall back to reads of their own rather than waiting on
    /// a request that will never finish, and nothing is left registered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn reads_carried_by_a_cancelled_leader_still_read_their_ranges() {
        let store = Arc::new(CountingStore::new(200));
        store.seed("shard", SHARD_BYTES).await;
        let get_count = store.get_count.clone();
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            limiter.clone(),
        ));

        let [leader, second, third] = queue_leader_then_neighbours(&cached, &limiter).await;
        wait_for_requests(&get_count, 1).await;
        leader.abort();
        let _ = leader.await;

        let second = tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .expect("a carried read must not wait on a dead leader")
            .unwrap();
        let third = tokio::time::timeout(Duration::from_secs(5), third)
            .await
            .expect("a carried read must not wait on a dead leader")
            .unwrap();
        assert_eq!(&second.result.unwrap()[..], &SHARD_BYTES[4..8]);
        assert_eq!(&third.result.unwrap()[..], &SHARD_BYTES[8..12]);
        assert!(second.timing.coalesced_wait_us.is_some());
        assert!(third.timing.coalesced_wait_us.is_some());
        assert!(
            second.timing.backend_read_us.is_some() || third.timing.backend_read_us.is_some(),
            "at least one carried read led the fallback read"
        );

        let requests = get_count.load(Ordering::SeqCst);
        assert!(
            (2..=3).contains(&requests),
            "the cancelled request plus the carried reads' own: {requests}"
        );
        no_flight_is_left_behind(&cached);
    }

    /// A carried read cancelled while it waits changes nothing for the merged
    /// request: the leader still completes, the other carried read is still
    /// served, and the cancelled read's range still lands in the cache.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_cancelled_carried_read_does_not_disturb_the_merged_read() {
        let store = Arc::new(CountingStore::new(100));
        store.seed("shard", SHARD_BYTES).await;
        let get_count = store.get_count.clone();
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            limiter.clone(),
        ));

        let [leader, second, third] = queue_leader_then_neighbours(&cached, &limiter).await;
        wait_for_requests(&get_count, 1).await;
        second.abort();
        let _ = second.await;

        let leader = leader.await.unwrap();
        let third = third.await.unwrap();
        assert_eq!(&leader.result.unwrap()[..], &SHARD_BYTES[0..4]);
        assert_eq!(&third.result.unwrap()[..], &SHARD_BYTES[8..12]);
        assert_eq!(third.timing.coalesced_onto, Some(RequestLabel(1)));

        let orphaned = cached
            .get_range(&Path::from("shard"), 4..8, READER, LABEL)
            .await;
        assert_eq!(&orphaned.result.unwrap()[..], &SHARD_BYTES[4..8]);
        assert_eq!(orphaned.timing, SourceReadTiming::default(), "a hit");
        assert_eq!(get_count.load(Ordering::SeqCst), 1);
        no_flight_is_left_behind(&cached);
    }

    /// A merged request that fails fails every read it carried, with the
    /// leader's error, and caches nothing — so the next read of any of the
    /// ranges tries the backend again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failed_merged_read_fails_every_read_it_carried_and_caches_nothing() {
        let store = Arc::new(CountingStore::new(20));
        store.seed("shard", SHARD_BYTES).await;
        store.fail.store(true, Ordering::SeqCst);
        let get_count = store.get_count.clone();
        let fail = store.fail.clone();
        let limiter = SourceReadLimiter::new(1);
        let cached = Arc::new(CachedStore::with_source_limiter(
            store,
            1024,
            limiter.clone(),
        ));

        let held = limiter.acquire(OUTSIDER).await;
        let handles: Vec<_> = (0..3u64)
            .map(|i| spawn_range_read(&cached, "shard", i * 4..i * 4 + 4, RequestLabel(i as u32)))
            .collect();
        wait_for_queued(&limiter, 3).await;
        drop(held);
        for handle in handles {
            assert!(handle.await.unwrap().result.is_err());
        }
        assert_eq!(get_count.load(Ordering::SeqCst), 1);
        let stats = cached.stats();
        assert_eq!(stats.backend_errors, 1, "one failed round trip");
        assert_eq!(stats.entry_count, 0);
        no_flight_is_left_behind(&cached);

        fail.store(false, Ordering::SeqCst);
        let bytes = cached
            .get_range(&Path::from("shard"), 4..8, READER, LABEL)
            .await
            .result
            .unwrap();
        assert_eq!(&bytes[..], &SHARD_BYTES[4..8]);
        assert_eq!(get_count.load(Ordering::SeqCst), 2);
    }
}
