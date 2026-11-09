//! The threads chunks decode on, away from the async workers. Building a
//! generated level's chunk runs here too.
//!
//! Decompressing and framing a chunk takes a millisecond or more of CPU. On
//! an async worker, a burst of it holds up every other task on the runtime,
//! and the wait lands in whichever phase happens to be timing when a worker
//! comes free. Here the work runs on the pool's own threads, and a request
//! waits in the pool's queue before it starts, so the wait is a phase of its
//! own.
//!
//! The threads run below normal priority. There is one per core, so a deep
//! queue keeps every core decoding, and at equal priority an async worker
//! woken by a new request waits its turn for a core behind them. That wait
//! reads as dispatch, though the work behind it was decoding. Below them, the
//! async workers take a core as soon as they have something to do, and the
//! burst waits in this pool's queue, where it is measured as a queue.
//!
//! They are the pool's own threads, not tokio's blocking pool, whose threads
//! also run the store's file reads and so cannot be lowered for decoding alone.

use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use lucida_store::source_limiter::ReaderId;
use tokio::sync::oneshot;

/// Environment variable an operator can set to fix how many chunks decode at
/// once, in place of one per core. Read once, the first time the pool is used.
const DECODE_THREADS_ENV: &str = "LUCIDA_DECODE_THREADS";

/// Bounds how many chunks decode at once, server-wide.
///
/// The bound is what keeps a burst's memory in check: a decode holds its
/// decoded chunk, and a request waiting in the queue holds only the stored
/// bytes it read. Threads are shared out the way source reads are, least in
/// flight first, so one client's burst cannot hold another client's chunk
/// behind it.
pub struct DecodePool {
    shared: Arc<Shared>,
}

struct Shared {
    queue: Mutex<Queue>,
    work_ready: Condvar,
}

type Job = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Queue {
    readers: HashMap<ReaderId, Reader>,
    /// Jobs started so far, the clock the round robin between equally loaded
    /// readers runs on.
    started: u64,
    closed: bool,
}

struct Reader {
    running: usize,
    waiting: VecDeque<Job>,
    last_started: u64,
}

impl DecodePool {
    pub fn new(threads: usize) -> Self {
        let shared = Arc::new(Shared {
            queue: Mutex::default(),
            work_ready: Condvar::new(),
        });
        for _ in 0..threads.max(1) {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("lucida-decode".into())
                .spawn(move || {
                    lower_this_threads_priority();
                    shared.work();
                })
                .expect("spawn a decode thread");
        }
        Self { shared }
    }

    /// The pool every chunk serve and every generated-level build shares.
    pub fn global() -> &'static DecodePool {
        static POOL: OnceLock<DecodePool> = OnceLock::new();
        POOL.get_or_init(|| DecodePool::new(configured_threads()))
    }

    /// Run `work` on a decode thread, in its turn among `reader`'s and
    /// everyone else's, and wait for its answer.
    ///
    /// Work whose caller stopped waiting before a thread took it is dropped
    /// unrun. Work already running finishes, since a decode cannot be stopped
    /// midway, and holds its thread until it does.
    pub async fn run<T, F>(&self, reader: ReaderId, work: F) -> T
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let (answer, answered) = oneshot::channel::<Result<T, Box<dyn Any + Send>>>();
        self.shared.submit(
            reader,
            Box::new(move || {
                if !answer.is_closed() {
                    let _ = answer.send(catch_unwind(AssertUnwindSafe(work)));
                }
            }),
        );
        match answered.await {
            Ok(Ok(value)) => value,
            Ok(Err(panic)) => resume_unwind(panic),
            Err(_) => {
                unreachable!("a decode thread runs or skips every job, and answers each it runs")
            }
        }
    }

    #[cfg(test)]
    fn queued(&self) -> usize {
        let queue = self.shared.queue.lock().unwrap();
        queue
            .readers
            .values()
            .map(|reader| reader.waiting.len())
            .sum()
    }
}

impl Drop for DecodePool {
    fn drop(&mut self) {
        self.shared.queue.lock().unwrap().closed = true;
        self.shared.work_ready.notify_all();
    }
}

impl Shared {
    fn submit(&self, reader: ReaderId, job: Job) {
        let mut queue = self.queue.lock().unwrap();
        let started = queue.started;
        queue
            .readers
            .entry(reader)
            .or_insert_with(|| Reader {
                running: 0,
                waiting: VecDeque::new(),
                // As if just served: a newcomer already wins on `running`,
                // and starting it at 0 would let a reader that comes and goes
                // jump the round robin every time it returns.
                last_started: started,
            })
            .waiting
            .push_back(job);
        drop(queue);
        self.work_ready.notify_one();
    }

    /// One decode thread's life: take the next job in turn, run it, repeat.
    /// A closed pool's threads finish what is queued before they leave.
    fn work(&self) {
        let mut queue = self.queue.lock().unwrap();
        loop {
            if let Some((reader, job)) = queue.next_job() {
                drop(queue);
                job();
                queue = self.queue.lock().unwrap();
                queue.finished(reader);
            } else if queue.closed {
                return;
            } else {
                queue = self.work_ready.wait(queue).unwrap();
            }
        }
    }
}

impl Queue {
    /// The waiting reader with the fewest jobs running goes next; ties go to
    /// whoever started one longest ago.
    fn next_job(&mut self) -> Option<(ReaderId, Job)> {
        let id = self
            .readers
            .iter()
            .filter(|(_, reader)| !reader.waiting.is_empty())
            .min_by_key(|(id, reader)| (reader.running, reader.last_started, id.0))
            .map(|(id, _)| *id)?;
        self.started += 1;
        let started = self.started;
        let reader = self.readers.get_mut(&id).expect("just found");
        let job = reader.waiting.pop_front().expect("has a job waiting");
        reader.running += 1;
        reader.last_started = started;
        Some((id, job))
    }

    fn finished(&mut self, id: ReaderId) {
        let reader = self
            .readers
            .get_mut(&id)
            .expect("a running job keeps its reader");
        reader.running -= 1;
        if reader.running == 0 && reader.waiting.is_empty() {
            self.readers.remove(&id);
        }
    }
}

/// Best effort: a thread left at normal priority still decodes correctly.
fn lower_this_threads_priority() {
    #[cfg(target_os = "linux")]
    // SAFETY: both calls only read or set this thread's scheduling attributes.
    unsafe {
        // Linux keeps a nice value per thread, so this lowers only this one.
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 10);
    }
    #[cfg(windows)]
    // SAFETY: the pseudo-handle names the calling thread and needs no closing.
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
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
        let worker = pool.run(CLIENT, || std::thread::current().id()).await;
        assert_ne!(worker, caller);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_more_decodes_run_than_the_pool_has_threads() {
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
                pool.run(CLIENT, move || {
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
    async fn a_cancelled_serve_keeps_its_thread_until_its_decode_ends() {
        let pool = Arc::new(DecodePool::new(1));
        let started = Arc::new(AtomicUsize::new(0));
        let (release, gate) = mpsc::channel::<()>();

        let first = {
            let (pool, started) = (Arc::clone(&pool), Arc::clone(&started));
            tokio::spawn(async move {
                pool.run(CLIENT, move || {
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
            tokio::spawn(async move { pool.run(CLIENT, || ()).await })
        };
        until(|| pool.queued() == 1).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !second.is_finished(),
            "the thread is still the first decode's"
        );

        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .expect("the thread came free")
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn work_cancelled_while_queued_never_runs() {
        let pool = Arc::new(DecodePool::new(1));
        let (release, gate) = mpsc::channel::<()>();
        let ran = Arc::new(AtomicUsize::new(0));

        let busy = {
            let pool = Arc::clone(&pool);
            tokio::spawn(async move { pool.run(CLIENT, move || gate.recv().unwrap()).await })
        };
        let queued = {
            let (pool, ran) = (Arc::clone(&pool), Arc::clone(&ran));
            tokio::spawn(async move {
                pool.run(CLIENT, move || ran.fetch_add(1, Ordering::SeqCst))
                    .await
            })
        };
        until(|| pool.queued() == 1).await;
        queued.abort();
        let _ = queued.await;

        release.send(()).unwrap();
        busy.await.unwrap();
        // A job queued after the cancelled one runs only once the thread has
        // passed the cancelled one by.
        pool.run(CLIENT, || ()).await;
        assert_eq!(ran.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_panic_reaches_the_caller_and_the_thread_lives_on() {
        let pool = Arc::new(DecodePool::new(1));
        let panicked = {
            let pool = Arc::clone(&pool);
            tokio::spawn(async move { pool.run(CLIENT, || panic!("decode failed")).await })
        };
        assert!(panicked.await.unwrap_err().is_panic());
        assert_eq!(pool.run(CLIENT, || 7).await, 7);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_backlog_does_not_hold_another_readers_work_behind_all_of_it() {
        let pool = Arc::new(DecodePool::new(1));
        let (release, gate) = mpsc::channel::<()>();
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));

        let busy = {
            let pool = Arc::clone(&pool);
            tokio::spawn(async move {
                pool.run(ReaderId::UNATTRIBUTED, move || gate.recv().unwrap())
                    .await
            })
        };
        until(|| pool.queued() == 0).await;
        let mut serves = Vec::new();
        for reader in [CLIENT, CLIENT, CLIENT, ReaderId(2)] {
            let (pool, order) = (Arc::clone(&pool), Arc::clone(&order));
            serves.push(tokio::spawn(async move {
                pool.run(reader, move || order.lock().unwrap().push(reader.0))
                    .await
            }));
            let queued = serves.len();
            until(|| pool.queued() == queued).await;
        }

        release.send(()).unwrap();
        busy.await.unwrap();
        for serve in serves {
            serve.await.unwrap();
        }
        // The two readers take turns once both are waiting.
        assert_eq!(*order.lock().unwrap(), vec![1, 2, 1, 1]);
    }
}
