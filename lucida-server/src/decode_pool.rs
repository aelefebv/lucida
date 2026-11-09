//! The threads chunks decode on, away from the async workers. Building a
//! generated level's chunk runs here too.
//!
//! Decompressing and framing a chunk takes a millisecond or more of CPU. On
//! an async worker, a burst of it holds up every other task on the runtime,
//! and the wait lands in whichever phase happens to be timing when a worker
//! comes free. Here the work runs on blocking threads, and a request waits for
//! a slot before it starts, so the wait is a phase of its own.

use std::sync::{Arc, OnceLock};

use lucida_store::source_limiter::{ReaderId, SourcePermit, SourceReadLimiter};

/// Environment variable an operator can set to fix how many chunks decode at
/// once, in place of one per core. Read once, the first time the pool is used.
const DECODE_THREADS_ENV: &str = "LUCIDA_DECODE_THREADS";

/// Bounds how many chunks decode at once, server-wide.
///
/// The bound is what keeps a burst's memory in check: a decode holds its
/// decoded chunk, and a request waiting for a slot holds only the stored bytes
/// it read. Slots are shared out the way source reads are, least in flight
/// first, so one client's burst cannot hold another client's chunk behind it.
pub struct DecodePool {
    slots: Arc<SourceReadLimiter>,
}

impl DecodePool {
    pub fn new(threads: usize) -> Self {
        Self {
            slots: SourceReadLimiter::new(threads.max(1)),
        }
    }

    /// The pool every chunk serve and every generated-level build shares.
    pub fn global() -> &'static DecodePool {
        static POOL: OnceLock<DecodePool> = OnceLock::new();
        POOL.get_or_init(|| DecodePool::new(configured_threads()))
    }

    /// Wait for a slot, charged to `reader`.
    pub async fn acquire(&self, reader: ReaderId) -> DecodeSlot {
        DecodeSlot {
            _permit: self.slots.acquire(reader, 0).await,
        }
    }

    #[cfg(test)]
    fn queued(&self) -> usize {
        self.slots.queued_reads()
    }
}

/// One chunk's turn on the pool. Dropping it unused gives the turn back.
pub struct DecodeSlot {
    _permit: SourcePermit,
}

impl DecodeSlot {
    /// Run `work` on a blocking thread and wait for its answer.
    ///
    /// The slot travels with the work and comes free when the work ends, not
    /// when the caller stops waiting. A cancelled serve cannot stop a decode
    /// already running, so freeing its slot early would let a burst of
    /// cancellations run more decodes than the bound.
    pub async fn run<T, F>(self, work: F) -> T
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let task = tokio::task::spawn_blocking(move || {
            let _slot = self;
            work()
        });
        match task.await {
            Ok(value) => value,
            Err(error) => match error.try_into_panic() {
                Ok(panic) => std::panic::resume_unwind(panic),
                // Only a runtime shutting down cancels blocking work, and it
                // drops this task too.
                Err(_) => std::future::pending().await,
            },
        }
    }
}

fn configured_threads() -> usize {
    std::env::var(DECODE_THREADS_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|&threads| threads > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    const CLIENT: ReaderId = ReaderId(1);

    async fn until(mut done: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !done() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("condition reached");
    }

    #[tokio::test]
    async fn work_runs_off_the_async_worker() {
        let pool = DecodePool::new(1);
        let caller = std::thread::current().id();
        let worker = pool
            .acquire(CLIENT)
            .await
            .run(|| std::thread::current().id())
            .await;
        assert_ne!(worker, caller);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_more_decodes_run_than_the_pool_has_slots() {
        let pool = Arc::new(DecodePool::new(2));
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (release, gate) = mpsc::channel::<()>();
        let gate = Arc::new(std::sync::Mutex::new(gate));

        let mut serves = Vec::new();
        for _ in 0..6 {
            let (pool, running, peak, gate) = (
                Arc::clone(&pool),
                Arc::clone(&running),
                Arc::clone(&peak),
                Arc::clone(&gate),
            );
            serves.push(tokio::spawn(async move {
                pool.acquire(CLIENT)
                    .await
                    .run(move || {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        gate.lock().unwrap().recv().unwrap();
                        running.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await;
            }));
        }
        until(|| running.load(Ordering::SeqCst) == 2 && pool.queued() == 4).await;
        for _ in 0..6 {
            release.send(()).unwrap();
        }
        for serve in serves {
            serve.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_serve_keeps_its_slot_until_its_decode_ends() {
        let pool = Arc::new(DecodePool::new(1));
        let started = Arc::new(AtomicUsize::new(0));
        let (release, gate) = mpsc::channel::<()>();

        let first = {
            let (pool, started) = (Arc::clone(&pool), Arc::clone(&started));
            tokio::spawn(async move {
                pool.acquire(CLIENT)
                    .await
                    .run(move || {
                        started.fetch_add(1, Ordering::SeqCst);
                        gate.recv().unwrap();
                    })
                    .await;
            })
        };
        until(|| started.load(Ordering::SeqCst) == 1).await;
        first.abort();

        let second = {
            let pool = Arc::clone(&pool);
            tokio::spawn(async move { pool.acquire(CLIENT).await.run(|| ()).await })
        };
        until(|| pool.queued() == 1).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !second.is_finished(),
            "the slot is still the first decode's"
        );

        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .expect("the slot came free")
            .unwrap();
    }
}
