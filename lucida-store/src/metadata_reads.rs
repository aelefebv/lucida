//! Watching the metadata reads a dataset open performs.
//!
//! A cold open's cost lives here rather than in the chunk pipeline: the
//! reads that resolve a dataset's shape happen before the first chunk
//! exists, so no chunk lane can draw them and a trace without them shows
//! several seconds of silence at the front of every remote open.
//!
//! The observer is a **task-local** rather than a field on [`CachedStore`]
//! or a parameter threaded through the import. A field would misattribute:
//! one cache is shared by every live caller of the same source (ADR 0046),
//! so two concurrent opens would file each other's reads, and the rows only
//! ever travel to the client that caused them. A parameter would thread a
//! tracing concern through every function in the import and the parser,
//! which have no other reason to know that anything is watching. A
//! task-local scopes attribution to exactly the work the open awaits — the
//! import's fan-out is `buffer_unordered` on the open's own task, so it is
//! covered — and a read performed outside any open simply files nowhere.
//!
//! [`CachedStore`]: crate::cache::CachedStore

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub use lucida_protocol::MetadataReadPhase;

/// One metadata object read, as the store performed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetadataRead {
    pub phase: MetadataReadPhase,
    /// When the read began, on the monotonic clock. An instant rather than
    /// a duration because the observer, not the store, knows what it is an
    /// offset from — and an open's rows are only placeable on a timeline if
    /// each one says where inside the open it happened.
    pub started: Instant,
    /// How long the read took, end to end. A backend read's wait behind the
    /// metadata-read cap is inside this: the caller waited for it, and the
    /// two are one interval from the open's point of view.
    pub duration: Duration,
    /// The read ended in an error the caller has to handle. An optional
    /// object that is legitimately absent is an answer, not a failure.
    pub failed: bool,
}

/// Somewhere for an open's metadata reads to be filed. The store knows how
/// a read went; it deliberately does not know who wants to hear about it.
pub trait MetadataReadObserver: Send + Sync {
    fn record(&self, read: MetadataRead);
}

tokio::task_local! {
    static OBSERVER: Arc<dyn MetadataReadObserver>;
}

/// Run `future` with every metadata read it performs filed to `observer`.
///
/// Nesting replaces the observer for the inner scope, which is what an open
/// awaited inside another open would mean anyway.
pub async fn observing<F>(observer: Arc<dyn MetadataReadObserver>, future: F) -> F::Output
where
    F: Future,
{
    OBSERVER.scope(observer, future).await
}

/// File a read against whichever open is currently being awaited, if any.
/// Outside an open there is nothing to attribute the read to, so it is not
/// recorded — a row keyed to no open would be unjoinable at the far end.
pub(crate) fn record(phase: MetadataReadPhase, started: Instant, failed: bool) {
    let _ = OBSERVER.try_with(|observer| {
        observer.record(MetadataRead {
            phase,
            started,
            duration: started.elapsed(),
            failed,
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct Collector {
        reads: Mutex<Vec<MetadataRead>>,
    }

    impl Collector {
        pub(crate) fn taken(&self) -> Vec<MetadataRead> {
            std::mem::take(&mut self.reads.lock().unwrap())
        }
    }

    impl MetadataReadObserver for Collector {
        fn record(&self, read: MetadataRead) {
            self.reads.lock().unwrap().push(read);
        }
    }

    #[tokio::test]
    async fn a_read_inside_a_scope_reaches_that_scope_s_observer() {
        let collector = Arc::new(Collector::default());
        observing(collector.clone(), async {
            record(MetadataReadPhase::BackendRead, Instant::now(), false);
        })
        .await;

        let reads = collector.taken();
        assert_eq!(reads.len(), 1);
        assert_eq!(reads[0].phase, MetadataReadPhase::BackendRead);
    }

    #[tokio::test]
    async fn a_read_outside_every_scope_is_not_an_error_and_files_nowhere() {
        let collector = Arc::new(Collector::default());
        observing(collector.clone(), async {}).await;
        record(MetadataReadPhase::CacheHit, Instant::now(), false);
        assert!(collector.taken().is_empty());
    }

    #[tokio::test]
    async fn two_concurrent_scopes_do_not_file_each_other_s_reads() {
        let first = Arc::new(Collector::default());
        let second = Arc::new(Collector::default());

        let a = observing(first.clone(), async {
            tokio::task::yield_now().await;
            record(MetadataReadPhase::CacheHit, Instant::now(), false);
        });
        let b = observing(second.clone(), async {
            record(MetadataReadPhase::CoalescedWait, Instant::now(), false);
            tokio::task::yield_now().await;
        });
        tokio::join!(a, b);

        assert_eq!(
            first.taken().first().map(|read| read.phase),
            Some(MetadataReadPhase::CacheHit)
        );
        assert_eq!(
            second.taken().first().map(|read| read.phase),
            Some(MetadataReadPhase::CoalescedWait)
        );
    }
}
