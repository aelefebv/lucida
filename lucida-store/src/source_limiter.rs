//! Fair-share admission for backend source reads.
//!
//! One process-wide bound, because the link to the object store is shared,
//! but not FIFO: one client opening a large collection submits tens of
//! thousands of reads at once and would own the store until they drain.
//! The next waiter admitted is the reader with the fewest reads in flight,
//! ties broken by least recently served. A reader alone gets the whole bound.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

/// Who a source read is attributed to for fair sharing.
///
/// The server passes the requesting client's id, so one client's backlog
/// cannot delay another's first read.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ReaderId(pub u64);

impl ReaderId {
    /// Reads not made on behalf of a connected client — imports, CLI work, and
    /// generated-level builds. They share one fairness class between them,
    /// which is what they are: one background population competing with the
    /// interactive ones, not many.
    pub const UNATTRIBUTED: ReaderId = ReaderId(u64::MAX);
}

/// The correlation label of the request a read is being performed for.
///
/// Distinct from [`ReaderId`], and both are needed: the reader is the
/// fairness class (a client), the label is the individual request. Fair
/// sharing only ever needs the class, but attributing a permit wait — the
/// rate-setter on a remote store — needs the request.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct RequestLabel(pub u32);

impl RequestLabel {
    /// Reads with no requesting client behind them: metadata imports, CLI
    /// work, and generated-level builds. Nothing joins these to a
    /// browser row, so they carry no label rather than a borrowed one.
    pub const UNATTRIBUTED: RequestLabel = RequestLabel(u32::MAX);
}

/// How many source reads may be in flight at once.
///
/// A read holds its place for a whole round trip whatever its size, so a
/// bound counted in reads suits one read size: the count that fills the link
/// with large reads leaves it mostly idle with small ones. Past `min_reads`,
/// a read is admitted only while the bytes in flight stay within
/// `max_bytes`, so small reads go wider than large ones, up to `max_reads`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SourceReadBounds {
    /// Reads admitted whatever their size. Only reads in flight together
    /// hide the round trip, however large each one is.
    pub min_reads: usize,
    /// Reads never exceeded, however small.
    pub max_reads: usize,
    /// Bytes in flight past `min_reads`.
    pub max_bytes: u64,
}

impl SourceReadBounds {
    /// Exactly `reads` in flight, whatever their size.
    pub fn reads(reads: usize) -> Self {
        Self {
            min_reads: reads,
            max_reads: reads,
            max_bytes: u64::MAX,
        }
    }

    /// What a read is charged when nothing says how large it is: the size at
    /// which `min_reads` of them fill `max_bytes`, so reads of unknown size
    /// go as wide as the floor and no wider.
    pub fn unknown_read_bytes(&self) -> u64 {
        self.max_bytes / self.min_reads.max(1) as u64
    }
}

/// Bounds concurrent backend source reads process-wide and decides, under
/// contention, whose read goes next.
pub struct SourceReadLimiter {
    bounds: SourceReadBounds,
    state: Mutex<State>,
}

struct State {
    in_flight: usize,
    /// What the reads in flight are charged for.
    in_flight_bytes: u64,
    readers: HashMap<ReaderId, ReaderState>,
    /// Monotonic grant counter, the least-recently-served tiebreak.
    granted: u64,
}

struct ReaderState {
    in_flight: usize,
    waiters: VecDeque<Waiter>,
    /// Value of [`State::granted`] when this reader was last admitted.
    last_granted: u64,
}

struct Waiter {
    bytes: u64,
    sender: oneshot::Sender<SourcePermit>,
}

/// Held for the duration of one backend read; releases on drop.
///
/// Dropping is the only way to release, so a cancelled read — routine, since
/// re-planning aborts reads in flight — returns its permit without ceremony.
pub struct SourcePermit {
    /// `None` once the permit has been disarmed or released. Disarming exists
    /// for one case: a permit handed to a waiter that has already gone away
    /// must be reclaimed by the handoff loop, which holds the state lock, and
    /// letting `Drop` reclaim it there would deadlock on that lock.
    limiter: Option<Arc<SourceReadLimiter>>,
    reader: ReaderId,
    bytes: u64,
}

impl SourcePermit {
    fn disarm(mut self) {
        self.limiter = None;
    }

    /// Charge the read for `more` bytes than it was admitted with. It does
    /// not wait, since the read is already admitted; later reads wait for the
    /// bytes to drain instead.
    pub fn grow(&mut self, more: u64) {
        if let Some(limiter) = &self.limiter {
            let mut state = limiter.state.lock().expect("limiter state");
            state.in_flight_bytes = state.in_flight_bytes.saturating_add(more);
            self.bytes = self.bytes.saturating_add(more);
        }
    }
}

impl Drop for SourcePermit {
    fn drop(&mut self) {
        if let Some(limiter) = self.limiter.take() {
            limiter.release(self.reader, self.bytes);
        }
    }
}

impl SourceReadLimiter {
    /// A limiter of exactly `total_permits` reads, whatever their size.
    pub fn new(total_permits: usize) -> Arc<Self> {
        Self::with_bounds(SourceReadBounds::reads(total_permits))
    }

    pub fn with_bounds(bounds: SourceReadBounds) -> Arc<Self> {
        Arc::new(Self {
            bounds,
            state: Mutex::new(State {
                in_flight: 0,
                in_flight_bytes: 0,
                readers: HashMap::new(),
                granted: 0,
            }),
        })
    }

    pub fn bounds(&self) -> SourceReadBounds {
        self.bounds
    }

    /// How many readers the limiter is currently tracking. Readers are dropped
    /// as soon as they hold nothing and want nothing, so this stays proportional
    /// to live demand rather than to how many clients have ever connected.
    pub fn tracked_readers(&self) -> usize {
        self.state.lock().expect("limiter state").readers.len()
    }

    /// How many reads are queued for a permit across all readers.
    pub fn queued_reads(&self) -> usize {
        self.state
            .lock()
            .expect("limiter state")
            .readers
            .values()
            .map(|entry| entry.waiters.len())
            .sum()
    }

    /// Wait for a permit to perform one backend read of about `bytes`.
    pub async fn acquire(self: &Arc<Self>, reader: ReaderId, bytes: u64) -> SourcePermit {
        loop {
            let receiver = {
                let mut state = self.state.lock().expect("limiter state");
                if let Some(permit) = self.admit_now(&mut state, reader, bytes) {
                    return permit;
                }
                let (sender, receiver) = oneshot::channel();
                state
                    .reader_mut(reader)
                    .waiters
                    .push_back(Waiter { bytes, sender });
                receiver
            };
            match receiver.await {
                Ok(permit) => return permit,
                // The only way the sender is dropped without sending is a
                // handoff that raced our own cancellation; ask again.
                Err(_) => continue,
            }
        }
    }

    /// A permit for a read that need not wait.
    fn admit_now(
        self: &Arc<Self>,
        state: &mut State,
        reader: ReaderId,
        bytes: u64,
    ) -> Option<SourcePermit> {
        // Never past a waiter, even when this read would fit where the
        // waiter's does not: a stream of small reads must not hold a large
        // one out for good.
        if state.has_waiters() || !state.fits(&self.bounds, bytes) {
            return None;
        }
        state.admit(reader, bytes);
        Some(SourcePermit {
            limiter: Some(self.clone()),
            reader,
            bytes,
        })
    }

    /// Return a permit and pass the room it frees to the readers in line.
    fn release(self: &Arc<Self>, reader: ReaderId, bytes: u64) {
        let mut state = self.state.lock().expect("limiter state");
        // A permit exists only because `admit` charged it to this reader, and
        // `prune` never drops a reader holding one — so the entry is here.
        // Asserting that keeps a future invariant break loud instead of
        // silently returning a permit nobody was charged for, which would
        // inflate the bound.
        state
            .readers
            .get_mut(&reader)
            .expect("a held permit keeps its reader tracked")
            .in_flight -= 1;
        state.in_flight -= 1;
        state.in_flight_bytes -= bytes;
        state.prune(reader);

        // Hand the freed room to the neediest waiting reader, and go on while
        // it lasts, since one large read finishing can make room for several
        // small ones. The neediest reader's next read goes first or nothing
        // does, so no read is overtaken for being large. A waiter that has
        // since gone away is skipped and its room offered onward, so a
        // cancelled read cannot swallow a permit.
        while let Some(next) = state.neediest_waiting_reader() {
            let wanted = state.readers[&next]
                .waiters
                .front()
                .expect("neediest_waiting_reader only returns readers with waiters")
                .bytes;
            if !state.fits(&self.bounds, wanted) {
                break;
            }
            let waiter = state
                .reader_mut(next)
                .waiters
                .pop_front()
                .expect("the reader has a waiter");
            state.admit(next, waiter.bytes);
            let permit = SourcePermit {
                limiter: Some(self.clone()),
                reader: next,
                bytes: waiter.bytes,
            };
            if let Err(returned) = waiter.sender.send(permit) {
                // Undo the transfer under the lock we already hold, then
                // disarm so `Drop` does not try to take it again.
                returned.disarm();
                state.in_flight -= 1;
                state.in_flight_bytes -= waiter.bytes;
                state.reader_mut(next).in_flight -= 1;
                state.prune(next);
            }
        }
    }
}

impl State {
    fn reader_mut(&mut self, reader: ReaderId) -> &mut ReaderState {
        let granted = self.granted;
        self.readers.entry(reader).or_insert_with(|| ReaderState {
            in_flight: 0,
            waiters: VecDeque::new(),
            // Starts at the current mark, i.e. as if just served. A newcomer
            // does not need help from the tiebreak — it wins on `in_flight`,
            // which is 0 — and starting it at 0 instead would let a reader
            // that has been idle just long enough to be pruned re-enter ahead
            // of everyone and leapfrog the rotation on every reappearance.
            last_granted: granted,
        })
    }

    /// Whether one more read of `bytes` is within `bounds`.
    fn fits(&self, bounds: &SourceReadBounds, bytes: u64) -> bool {
        self.in_flight < bounds.max_reads
            && (self.in_flight < bounds.min_reads
                || self.in_flight_bytes.saturating_add(bytes) <= bounds.max_bytes)
    }

    fn has_waiters(&self) -> bool {
        self.readers.values().any(|entry| !entry.waiters.is_empty())
    }

    /// Charge one read of `bytes` to `reader`.
    fn admit(&mut self, reader: ReaderId, bytes: u64) {
        self.in_flight += 1;
        self.in_flight_bytes += bytes;
        self.granted += 1;
        let granted = self.granted;
        let entry = self.reader_mut(reader);
        entry.in_flight += 1;
        entry.last_granted = granted;
    }

    /// The waiting reader with the fewest reads in flight; ties go to whoever
    /// was served longest ago, which round-robins equally-loaded readers.
    fn neediest_waiting_reader(&self) -> Option<ReaderId> {
        self.readers
            .iter()
            .filter(|(_, entry)| !entry.waiters.is_empty())
            .min_by_key(|(id, entry)| (entry.in_flight, entry.last_granted, id.0))
            .map(|(id, _)| *id)
    }

    /// Forget a reader that holds nothing and wants nothing.
    fn prune(&mut self, reader: ReaderId) {
        if let Some(entry) = self.readers.get(&reader)
            && entry.in_flight == 0
            && entry.waiters.is_empty()
        {
            self.readers.remove(&reader);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    const A: ReaderId = ReaderId(1);
    const B: ReaderId = ReaderId(2);

    /// Spawned waiters register asynchronously, so tests that care about queue
    /// order must wait for the queue to actually contain them.
    async fn wait_for_queued(limiter: &Arc<SourceReadLimiter>, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while limiter.queued_reads() < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("waiters queued");
    }

    /// A reader alone on the limiter gets the whole cap: fairness must not
    /// cost throughput when there is nobody to be fair to.
    #[tokio::test]
    async fn a_lone_reader_can_hold_every_permit() {
        let limiter = SourceReadLimiter::new(4);
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(limiter.acquire(A, 0).await);
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), limiter.acquire(A, 0))
                .await
                .is_err(),
            "the cap still binds once the lone reader has taken all of it"
        );
        drop(held);
    }

    /// The scenario the process-global FIFO semaphore fails: one client with a
    /// deep backlog must not delay a second client's first read.
    #[tokio::test]
    async fn a_deep_backlog_does_not_delay_another_reader() {
        let limiter = SourceReadLimiter::new(4);
        let mut held: Vec<SourcePermit> = Vec::new();
        for _ in 0..4 {
            held.push(limiter.acquire(A, 0).await);
        }

        // A queues a backlog the size of a large collection open.
        let backlogged = Arc::new(AtomicUsize::new(0));
        let mut backlog = Vec::new();
        for _ in 0..500 {
            let limiter = limiter.clone();
            let backlogged = backlogged.clone();
            backlog.push(tokio::spawn(async move {
                let permit = limiter.acquire(A, 0).await;
                backlogged.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(permit);
            }));
        }
        wait_for_queued(&limiter, 500).await;

        // B arrives last, wanting one read.
        let b = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(B, 0).await }
        });
        wait_for_queued(&limiter, 501).await;

        // Exactly one permit comes free. It must go to B, who holds none, not
        // to the head of A's 500-deep queue.
        drop(held.pop().expect("A holds four permits"));

        tokio::time::timeout(Duration::from_secs(2), b)
            .await
            .expect("B waits behind A's whole backlog")
            .expect("B's task ran");
        assert_eq!(
            backlogged.load(Ordering::SeqCst),
            0,
            "the freed permit went to A's backlog instead of the idle reader"
        );

        for task in backlog {
            task.abort();
        }
    }

    /// Two readers sharing a saturated limiter converge on an even split
    /// rather than one starving the other.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_saturated_readers_split_the_cap() {
        let limiter = SourceReadLimiter::new(8);
        let a_reads = Arc::new(AtomicUsize::new(0));
        let b_reads = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for (reader, counter) in [(A, a_reads.clone()), (B, b_reads.clone())] {
            for _ in 0..200 {
                let limiter = limiter.clone();
                let counter = counter.clone();
                tasks.push(tokio::spawn(async move {
                    let permit = limiter.acquire(reader, 0).await;
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    counter.fetch_add(1, Ordering::SeqCst);
                    drop(permit);
                }));
            }
        }
        for task in tasks {
            let _ = task.await;
        }
        let (a, b) = (
            a_reads.load(Ordering::SeqCst),
            b_reads.load(Ordering::SeqCst),
        );
        assert_eq!(a + b, 400);
        assert_eq!(a, 200);
        assert_eq!(b, 200);
    }

    /// A caller that gives up while queued must not carry a permit away with
    /// it — cancellation is routine here, since re-planning aborts reads.
    #[tokio::test]
    async fn a_cancelled_waiter_leaks_no_permit() {
        let limiter = SourceReadLimiter::new(1);
        let held = limiter.acquire(A, 0).await;

        let mut waiter = Box::pin(limiter.acquire(B, 0));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiter)
                .await
                .is_err(),
            "B cannot be admitted while A holds the only permit"
        );
        drop(waiter);
        drop(held);

        tokio::time::timeout(Duration::from_millis(500), limiter.acquire(B, 0))
            .await
            .expect("the permit the cancelled waiter was offered is still available");
    }

    /// Readers come and go with connections; their bookkeeping must not
    /// accumulate for the life of the process.
    #[tokio::test]
    async fn finished_readers_leave_no_bookkeeping_behind() {
        let limiter = SourceReadLimiter::new(4);
        for reader in 0..1000u64 {
            let permit = limiter.acquire(ReaderId(reader), 0).await;
            drop(permit);
        }
        assert_eq!(limiter.tracked_readers(), 0);
    }

    /// The count is a hard bound, not a target.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_reads_never_exceed_the_cap() {
        let limiter = SourceReadLimiter::new(6);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for reader in 0..12u64 {
            for _ in 0..40 {
                let limiter = limiter.clone();
                let in_flight = in_flight.clone();
                let peak = peak.clone();
                tasks.push(tokio::spawn(async move {
                    let permit = limiter.acquire(ReaderId(reader), 0).await;
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    drop(permit);
                }));
            }
        }
        for task in tasks {
            let _ = task.await;
        }
        assert_eq!(peak.load(Ordering::SeqCst), 6);
    }

    // --- The byte bound ---

    const KIB: u64 = 1024;

    /// Two reads whatever their size, up to eight while 400 KiB covers them.
    fn byte_bounded() -> Arc<SourceReadLimiter> {
        SourceReadLimiter::with_bounds(SourceReadBounds {
            min_reads: 2,
            max_reads: 8,
            max_bytes: 400 * KIB,
        })
    }

    /// A permit if `acquire` would grant one without waiting. Probing through
    /// `acquire` with a timeout would leave a cancelled waiter queued, and a
    /// queued waiter holds back every later read.
    fn admitted_now(limiter: &Arc<SourceReadLimiter>, bytes: u64) -> Option<SourcePermit> {
        let mut state = limiter.state.lock().unwrap();
        limiter.admit_now(&mut state, A, bytes)
    }

    /// The point of the byte bound: reads a tenth the size go about ten times
    /// as wide, and the count still caps them.
    #[tokio::test]
    async fn small_reads_go_wider_than_large_ones() {
        let limiter = byte_bounded();
        let large: Vec<_> = std::iter::from_fn(|| admitted_now(&limiter, 200 * KIB)).collect();
        assert_eq!(large.len(), 2, "two 200 KiB reads fill 400 KiB");
        drop(large);

        let small: Vec<_> = std::iter::from_fn(|| admitted_now(&limiter, 20 * KIB)).collect();
        assert_eq!(
            small.len(),
            8,
            "twenty 20 KiB reads would fit; the count stops them at eight"
        );
    }

    /// Reads too large for the byte bound still go as wide as the floor:
    /// fewer than that and the round trip is no longer hidden.
    #[tokio::test]
    async fn the_floor_admits_reads_past_the_byte_bound() {
        let limiter = byte_bounded();
        let first = admitted_now(&limiter, 1024 * KIB);
        let second = admitted_now(&limiter, 1024 * KIB);
        assert!(first.is_some() && second.is_some());
        assert!(admitted_now(&limiter, 1024 * KIB).is_none());
        assert!(
            admitted_now(&limiter, KIB).is_none(),
            "past the floor, even a small read waits for the bytes to drain"
        );
    }

    /// A large read waiting for room is not overtaken by smaller reads that
    /// arrive after it, or a steady stream of them would hold it out for good.
    #[tokio::test]
    async fn a_large_waiter_is_not_overtaken_by_later_small_reads() {
        let limiter = byte_bounded();
        let mut held = vec![
            limiter.acquire(A, 150 * KIB).await,
            limiter.acquire(A, 150 * KIB).await,
        ];
        let large = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(A, 300 * KIB).await }
        });
        wait_for_queued(&limiter, 1).await;
        let small = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(A, 10 * KIB).await }
        });
        wait_for_queued(&limiter, 2).await;
        assert!(
            admitted_now(&limiter, 10 * KIB).is_none(),
            "a small read fits the bytes, but the large one asked first"
        );

        held.pop();
        let large = tokio::time::timeout(Duration::from_secs(1), large)
            .await
            .expect("the large read is admitted once there is room")
            .unwrap();
        assert_eq!(limiter.queued_reads(), 1, "the small read waits its turn");
        drop(large);
        tokio::time::timeout(Duration::from_secs(1), small)
            .await
            .expect("the small read follows")
            .unwrap();
        drop(held);
    }

    /// One large read finishing makes room for several small ones, and all of
    /// them are admitted then rather than one per release.
    #[tokio::test]
    async fn one_release_admits_every_waiter_it_makes_room_for() {
        let limiter = byte_bounded();
        let held = limiter.acquire(A, 300 * KIB).await;
        let _other = limiter.acquire(A, 100 * KIB).await;
        let admitted = Arc::new(AtomicUsize::new(0));
        let mut waiters = Vec::new();
        for _ in 0..5 {
            let limiter = limiter.clone();
            let admitted = admitted.clone();
            waiters.push(tokio::spawn(async move {
                let permit = limiter.acquire(A, 50 * KIB).await;
                admitted.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<()>().await;
                drop(permit);
            }));
        }
        wait_for_queued(&limiter, 5).await;

        drop(held);
        tokio::time::timeout(Duration::from_secs(1), async {
            while admitted.load(Ordering::SeqCst) < 5 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("300 KiB freed admits all five 50 KiB reads");
        for waiter in waiters {
            waiter.abort();
        }
    }

    /// A read that grows after admission, as a merged read does, holds the
    /// bytes it grew by until it ends.
    #[tokio::test]
    async fn a_grown_read_holds_its_extra_bytes() {
        let limiter = byte_bounded();
        let _floor = limiter.acquire(A, 0).await;
        let mut grown = limiter.acquire(A, 50 * KIB).await;
        grown.grow(300 * KIB);
        assert!(admitted_now(&limiter, 100 * KIB).is_none());
        drop(grown);
        assert!(admitted_now(&limiter, 100 * KIB).is_some());
    }
}
