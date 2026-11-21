//! The chunk requests one connection is still serving, by correlation label,
//! so the client can take back the ones it no longer wants.
//!
//! Cancelling drops the serve. One still queued for a source-read permit
//! leaves the queue without reading, and one holding a permit gives it back,
//! because the permit is released on drop. Bytes already read stay cached for
//! whoever asks next. A serve that already queued its frame withdraws it, so
//! a frame nobody wants no longer spends the client's link ahead of the ones
//! it does.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::task::AbortHandle;

use crate::connection::Withdrawable;

#[derive(Default)]
pub struct ChunkServes {
    /// Each serve under its label, with a token telling it apart from a later
    /// serve a misbehaving client sent under the same label.
    serves: Mutex<HashMap<u32, Serving>>,
    next_token: AtomicU64,
}

struct Serving {
    token: u64,
    task: AbortHandle,
    withdrawn: Arc<AtomicBool>,
}

/// One serve's hold on its label, from the request until its frame leaves the
/// client's queue: hand it to the queue with the frame, as a [`Withdrawable`].
/// While it is held, a cancel for the label withdraws whatever the serve has
/// queued or is about to.
pub struct ChunkServe {
    withdrawn: Arc<AtomicBool>,
    _finished: Finished,
}

impl Withdrawable for ChunkServe {
    fn withdrawn(&self) -> bool {
        self.withdrawn.load(Ordering::Acquire)
    }
}

#[cfg(test)]
impl ChunkServe {
    /// A serve no connection tracks, for calling a serve directly.
    pub fn untracked() -> Self {
        Self {
            withdrawn: Arc::default(),
            _finished: Finished {
                serves: ChunkServes::new(),
                rid: 0,
                token: 0,
            },
        }
    }
}

impl ChunkServes {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Run the serve `serve` makes as the answer to request `rid` until it
    /// finishes or is cancelled, and keep the label until the [`ChunkServe`]
    /// it is handed drops.
    pub fn spawn<F, Fut>(self: &Arc<Self>, rid: u32, serve: F)
    where
        F: FnOnce(ChunkServe) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let withdrawn = Arc::new(AtomicBool::new(false));
        // Held across the spawn so a serve that finishes at once cannot try
        // to forget itself before it is recorded.
        let mut serves = self.serves.lock().unwrap();
        let handle = ChunkServe {
            withdrawn: Arc::clone(&withdrawn),
            _finished: Finished {
                serves: Arc::clone(self),
                rid,
                token,
            },
        };
        let task = tokio::spawn(async move { serve(handle).await });
        serves.insert(
            rid,
            Serving {
                token,
                task: task.abort_handle(),
                withdrawn,
            },
        );
    }

    /// Drop the serves of `rids` that are still going, and withdraw the
    /// frames of those that queued one. Answers how many there were.
    pub fn cancel(&self, rids: &[u32]) -> usize {
        let cancelled: Vec<_> = {
            let mut serves = self.serves.lock().unwrap();
            rids.iter().filter_map(|rid| serves.remove(rid)).collect()
        };
        for serving in &cancelled {
            serving.withdraw();
        }
        cancelled.len()
    }

    /// Drop every serve: the connection is closing, and nothing it asked for
    /// can reach it.
    pub fn cancel_all(&self) {
        let cancelled: Vec<_> = self.serves.lock().unwrap().drain().collect();
        for (_, serving) in cancelled {
            serving.withdraw();
        }
    }

    pub fn len(&self) -> usize {
        self.serves.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Serving {
    fn withdraw(&self) {
        self.withdrawn.store(true, Ordering::Release);
        self.task.abort();
    }
}

/// Forgets a serve when its [`ChunkServe`] drops, however it ends.
struct Finished {
    serves: Arc<ChunkServes>,
    rid: u32,
    token: u64,
}

impl Drop for Finished {
    fn drop(&mut self) {
        let mut serves = self.serves.serves.lock().unwrap();
        if serves
            .get(&self.rid)
            .is_some_and(|serving| serving.token == self.token)
        {
            serves.remove(&self.rid);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use axum::extract::ws::Message;
    use lucida_store::source_limiter::{ReaderId, SourceReadLimiter};

    use super::*;

    const CLIENT: ReaderId = ReaderId(1);

    /// A serve as the store makes it: wait for a permit, then read for as
    /// long as the test likes.
    fn serve(
        limiter: &Arc<SourceReadLimiter>,
        reads: &Arc<AtomicUsize>,
    ) -> impl FnOnce(ChunkServe) -> BoxFuture + use<> {
        let (limiter, reads) = (Arc::clone(limiter), Arc::clone(reads));
        move |handle| {
            Box::pin(async move {
                let _handle = handle;
                let _permit = limiter.acquire(CLIENT, 0).await;
                reads.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<()>().await;
            })
        }
    }

    type BoxFuture = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

    async fn until(mut done: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !done() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition reached");
    }

    #[tokio::test]
    async fn cancelling_a_read_in_progress_hands_its_permit_on() {
        let limiter = SourceReadLimiter::new(1);
        let reads = Arc::new(AtomicUsize::new(0));
        let serves = ChunkServes::new();

        serves.spawn(1, serve(&limiter, &reads));
        until(|| reads.load(Ordering::SeqCst) == 1).await;
        serves.spawn(2, serve(&limiter, &reads));
        until(|| limiter.queued_reads() == 1).await;

        assert_eq!(serves.cancel(&[1]), 1);
        until(|| reads.load(Ordering::SeqCst) == 2).await;
        assert_eq!(limiter.queued_reads(), 0);
        assert_eq!(serves.len(), 1);
    }

    #[tokio::test]
    async fn a_request_cancelled_while_queued_is_never_read() {
        let limiter = SourceReadLimiter::new(1);
        let reads = Arc::new(AtomicUsize::new(0));
        let serves = ChunkServes::new();

        serves.spawn(1, serve(&limiter, &reads));
        until(|| reads.load(Ordering::SeqCst) == 1).await;
        serves.spawn(2, serve(&limiter, &reads));
        serves.spawn(3, serve(&limiter, &reads));
        until(|| limiter.queued_reads() == 2).await;

        assert_eq!(serves.cancel(&[2]), 1);
        serves.cancel(&[1]);
        until(|| reads.load(Ordering::SeqCst) == 2).await;
        // Let any wrongly surviving serve take its turn.
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        assert_eq!(reads.load(Ordering::SeqCst), 2, "only 1 and 3 read");
    }

    #[tokio::test]
    async fn a_finished_serve_forgets_itself_and_ignores_a_late_cancel() {
        let serves = ChunkServes::new();
        serves.spawn(7, |_handle| async {});
        until(|| serves.is_empty()).await;
        assert_eq!(serves.cancel(&[7]), 0);
    }

    #[tokio::test]
    async fn a_cancel_withdraws_the_frame_a_finished_serve_left_queued() {
        let (client, mut queue) = crate::connection::client_queue();
        let serves = ChunkServes::new();
        let sender = client.clone();
        serves.spawn(4, move |handle| async move {
            sender
                .send_withdrawable(Message::Binary(vec![0u8; 64].into()), Box::new(handle))
                .unwrap();
        });
        until(|| client.queued_bytes() == 64).await;
        assert_eq!(serves.len(), 1, "the queued frame holds the label");

        assert_eq!(serves.cancel(&[4]), 1);
        assert!(queue.try_recv().is_err(), "the frame is never written");
        assert_eq!(client.queued_bytes(), 0);
        assert!(serves.is_empty());
    }

    #[tokio::test]
    async fn a_frame_already_taken_for_the_socket_ignores_a_late_cancel() {
        let (client, mut queue) = crate::connection::client_queue();
        let serves = ChunkServes::new();
        let sender = client.clone();
        serves.spawn(5, move |handle| async move {
            sender
                .send_withdrawable(Message::Binary(vec![0u8; 64].into()), Box::new(handle))
                .unwrap();
        });
        until(|| client.queued_bytes() == 64).await;
        assert!(queue.try_recv().is_ok());
        assert!(serves.is_empty());
        assert_eq!(serves.cancel(&[5]), 0);
    }

    #[tokio::test]
    async fn closing_the_connection_drops_every_serve() {
        let limiter = SourceReadLimiter::new(1);
        let reads = Arc::new(AtomicUsize::new(0));
        let serves = ChunkServes::new();
        serves.spawn(1, serve(&limiter, &reads));
        serves.spawn(2, serve(&limiter, &reads));
        until(|| reads.load(Ordering::SeqCst) == 1 && limiter.queued_reads() == 1).await;

        serves.cancel_all();

        assert!(serves.is_empty());
        until(|| limiter.tracked_readers() == 0).await;
    }
}
