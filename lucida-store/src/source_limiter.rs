//! Fair-share admission for backend source reads.
//!
//! One bound over the whole process, handed out fairly between readers. See
//! `wiki/decisions/0053-fair-share-source-read-admission.md` for why the bound
//! stays global while admission does not.
//!
//! A plain semaphore is FIFO, and FIFO is the wrong queue discipline here: the
//! demand a viewer produces is bursty and enormous (one client opening a large
//! collection submits tens of thousands of reads at once), so whoever enqueues
//! first owns the store until their burst drains. This limiter keeps the
//! process-wide cap — the link to the object store is shared and must stay
//! bounded no matter how many clients connect — but chooses *which* waiter is
//! admitted next by least-in-flight, breaking ties by least-recently-served.
//!
//! It is work-conserving: a reader alone on the limiter gets the entire cap.
//! Fairness only bites when someone else is waiting.

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
    /// the proxy's own generation. They share one fairness class between them,
    /// which is what they are: one background population competing with the
    /// interactive ones, not many.
    pub const UNATTRIBUTED: ReaderId = ReaderId(u64::MAX);
}

/// Bounds concurrent backend source reads process-wide and decides, under
/// contention, whose read goes next.
pub struct SourceReadLimiter {
    state: Mutex<State>,
}

struct State {
    /// Permits not currently held by a read.
    available: usize,
    readers: HashMap<ReaderId, ReaderState>,
    /// Monotonic grant counter, the least-recently-served tiebreak.
    granted: u64,
}

struct ReaderState {
    in_flight: usize,
    waiters: VecDeque<oneshot::Sender<SourcePermit>>,
    /// Value of [`State::granted`] when this reader was last admitted.
    last_granted: u64,
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
}

impl SourcePermit {
    fn disarm(mut self) {
        self.limiter = None;
    }
}

impl Drop for SourcePermit {
    fn drop(&mut self) {
        if let Some(limiter) = self.limiter.take() {
            limiter.release(self.reader);
        }
    }
}

impl SourceReadLimiter {
    pub fn new(total_permits: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                available: total_permits,
                readers: HashMap::new(),
                granted: 0,
            }),
        })
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

    /// Wait for a permit to perform one backend read.
    pub async fn acquire(self: &Arc<Self>, reader: ReaderId) -> SourcePermit {
        loop {
            let receiver = {
                let mut state = self.state.lock().expect("limiter state");
                if state.available > 0 {
                    state.admit(reader);
                    return SourcePermit {
                        limiter: Some(self.clone()),
                        reader,
                    };
                }
                let (sender, receiver) = oneshot::channel();
                state.reader_mut(reader).waiters.push_back(sender);
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

    /// Return a permit and pass it straight to the next reader in line, if any.
    fn release(self: &Arc<Self>, reader: ReaderId) {
        let mut state = self.state.lock().expect("limiter state");
        // A permit exists only because `admit` charged it to this reader, and
        // `prune` never drops a reader holding one — so the entry is here.
        // Asserting that keeps a future invariant break loud instead of
        // silently returning a permit nobody was charged for, which would
        // inflate the cap.
        state
            .readers
            .get_mut(&reader)
            .expect("a held permit keeps its reader tracked")
            .in_flight -= 1;
        state.available += 1;
        state.prune(reader);

        // Hand the freed permit to the neediest waiting reader. A waiter that
        // has since gone away is skipped and the permit offered onward, so a
        // cancelled read cannot swallow a permit.
        while state.available > 0 {
            let Some(next) = state.neediest_waiting_reader() else {
                break;
            };
            let sender = state
                .reader_mut(next)
                .waiters
                .pop_front()
                .expect("neediest_waiting_reader only returns readers with waiters");
            state.admit(next);
            let permit = SourcePermit {
                limiter: Some(self.clone()),
                reader: next,
            };
            match sender.send(permit) {
                Ok(()) => break,
                Err(returned) => {
                    // Undo the transfer under the lock we already hold, then
                    // disarm so `Drop` does not try to take it again.
                    returned.disarm();
                    state.available += 1;
                    state.reader_mut(next).in_flight -= 1;
                    state.prune(next);
                }
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

    /// Charge one permit to `reader`.
    fn admit(&mut self, reader: ReaderId) {
        self.available -= 1;
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
            held.push(limiter.acquire(A).await);
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), limiter.acquire(A))
                .await
                .is_err(),
            "the cap still binds once the lone reader has taken all of it"
        );
        drop(held);
    }

    /// The scenario the process-global FIFO semaphore fails: one client with a
    /// deep backlog must not delay a second client's first read. #901.
    #[tokio::test]
    async fn a_deep_backlog_does_not_delay_another_reader() {
        let limiter = SourceReadLimiter::new(4);
        let mut held: Vec<SourcePermit> = Vec::new();
        for _ in 0..4 {
            held.push(limiter.acquire(A).await);
        }

        // A queues a backlog the size of a large collection open.
        let backlogged = Arc::new(AtomicUsize::new(0));
        let mut backlog = Vec::new();
        for _ in 0..500 {
            let limiter = limiter.clone();
            let backlogged = backlogged.clone();
            backlog.push(tokio::spawn(async move {
                let permit = limiter.acquire(A).await;
                backlogged.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(permit);
            }));
        }
        wait_for_queued(&limiter, 500).await;

        // B arrives last, wanting one read.
        let b = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(B).await }
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
                    let permit = limiter.acquire(reader).await;
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
        let held = limiter.acquire(A).await;

        let mut waiter = Box::pin(limiter.acquire(B));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiter)
                .await
                .is_err(),
            "B cannot be admitted while A holds the only permit"
        );
        drop(waiter);
        drop(held);

        tokio::time::timeout(Duration::from_millis(500), limiter.acquire(B))
            .await
            .expect("the permit the cancelled waiter was offered is still available");
    }

    /// Readers come and go with connections; their bookkeeping must not
    /// accumulate for the life of the process.
    #[tokio::test]
    async fn finished_readers_leave_no_bookkeeping_behind() {
        let limiter = SourceReadLimiter::new(4);
        for reader in 0..1000u64 {
            let permit = limiter.acquire(ReaderId(reader)).await;
            drop(permit);
        }
        assert_eq!(limiter.tracked_readers(), 0);
    }

    /// The cap is a hard bound, not a target.
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
                    let permit = limiter.acquire(ReaderId(reader)).await;
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
}
