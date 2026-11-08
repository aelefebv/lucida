//! Limits on one WebSocket connection: how large a message a client may
//! send, how much the server holds for a client that is not reading, and
//! the one way the rest of the server closes a connection.
//!
//! Everything a client receives outside the broadcast channel (chunk
//! frames, open progress, requested snapshots, watch items) waits in that
//! client's [`ClientSender`] queue until the connection's outbound task
//! writes it to the socket.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::extract::ws::{CloseFrame, Message, WebSocketUpgrade};
use tokio::sync::{mpsc, watch};

use crate::inbox::MAX_BUNDLE_BYTES;

/// The largest message a client may send, and the largest frame.
///
/// The largest message a client sends is a report: a bundle of up to
/// [`MAX_BUNDLE_BYTES`], escaped as a JSON string inside its envelope.
/// The page checks the bundle's length in UTF-16 units and this side
/// counts bytes, so the message can reach three times the cap. Four
/// leaves room for the envelope, so an oversize bundle is still refused
/// with a sentence rather than a dropped connection. Browsers send a
/// message as one frame, so the frame cap is the message cap.
pub const MAX_INBOUND_MESSAGE_BYTES: usize = 4 * MAX_BUNDLE_BYTES;

/// How many bytes may wait in one client's queue before the server stops
/// waiting for it.
///
/// Above what a client that is keeping up has outstanding: the web client
/// keeps at most 32 MiB of chunks in flight, and everything else on the
/// queue is small or occasional. A backlog this deep means the client is
/// not reading, and holding more for it grows the server without bound.
pub const OUTBOUND_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// Close code for a client that fell too far behind. 1013 is "try again
/// later": the reconnect starts from a fresh snapshot, so nothing is lost
/// by dropping the backlog.
pub const CLOSE_TOO_FAR_BEHIND: u16 = 1013;

/// Close code for a connection whose principal no longer has access to
/// what it joined. 1008 is "policy violation".
pub const CLOSE_ACCESS_REVOKED: u16 = 1008;

/// Close code for a connection to a live workspace the server stopped
/// serving because the database holds a newer document. 1012 is "service
/// restart": the reconnect loads the workspace fresh.
pub const CLOSE_WORKSPACE_RELOADED: u16 = 1012;

/// Close code for a connection to a workspace that was archived. Private
/// use, numbered after the HTTP 410 its routes answer from then on.
pub const CLOSE_WORKSPACE_ARCHIVED: u16 = 4410;

/// Apply the inbound caps to an upgrade. Every WebSocket route goes
/// through this, so no route accepts a larger message than another.
pub fn limit_inbound(ws: WebSocketUpgrade) -> WebSocketUpgrade {
    ws.max_message_size(MAX_INBOUND_MESSAGE_BYTES)
        .max_frame_size(MAX_INBOUND_MESSAGE_BYTES)
}

/// The message was not queued: the connection is gone, or is closing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotQueued;

struct Shared {
    queued_bytes: AtomicUsize,
    budget: usize,
    close: watch::Sender<Option<CloseRequest>>,
}

/// How a connection is asked to close: the close frame, and optionally a
/// message written just ahead of it. A close skips the queue, so the
/// notice is the only message sure to reach the client before it.
#[derive(Debug, Clone)]
pub struct CloseRequest {
    pub frame: CloseFrame,
    pub notice: Option<String>,
}

impl CloseRequest {
    pub fn new(code: u16, reason: &str) -> Self {
        Self {
            frame: CloseFrame {
                code,
                reason: reason.into(),
            },
            notice: None,
        }
    }

    #[must_use]
    pub fn with_notice(mut self, notice: String) -> Self {
        self.notice = Some(notice);
        self
    }
}

/// The sending half of one client's queue. Cheap to clone; every clone
/// feeds the same queue and can close the same connection.
#[derive(Clone)]
pub struct ClientSender {
    tx: mpsc::UnboundedSender<Message>,
    shared: Arc<Shared>,
}

/// The receiving half, owned by the connection's outbound task.
pub struct ClientReceiver {
    rx: mpsc::UnboundedReceiver<Message>,
    shared: Arc<Shared>,
}

/// Resolves once somebody asks to close the connection.
pub struct CloseSignal(watch::Receiver<Option<CloseRequest>>);

/// A queue with the standard budget.
pub fn client_queue() -> (ClientSender, ClientReceiver) {
    client_queue_with_budget(OUTBOUND_BUDGET_BYTES)
}

pub fn client_queue_with_budget(budget: usize) -> (ClientSender, ClientReceiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (close, _) = watch::channel(None);
    let shared = Arc::new(Shared {
        queued_bytes: AtomicUsize::new(0),
        budget,
        close,
    });
    (
        ClientSender {
            tx,
            shared: Arc::clone(&shared),
        },
        ClientReceiver { rx, shared },
    )
}

fn payload_len(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) => bytes.len(),
        Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
        Message::Close(_) => 0,
    }
}

impl std::fmt::Debug for ClientSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientSender")
            .field("queued_bytes", &self.queued_bytes())
            .field("close_requested", &self.close_requested())
            .finish()
    }
}

impl ClientSender {
    /// Queue a message for the client. Never waits.
    ///
    /// A message is admitted while the backlog is under budget, however
    /// large it is: one big snapshot or chunk is normal, and refusing it
    /// would disconnect a client that is keeping up. Once the backlog
    /// reaches the budget the connection is closed and nothing more is
    /// queued.
    pub fn send(&self, message: Message) -> Result<(), NotQueued> {
        if self.close_requested() {
            return Err(NotQueued);
        }
        let len = payload_len(&message);
        let backlog = self.shared.queued_bytes.fetch_add(len, Ordering::AcqRel);
        if backlog >= self.shared.budget {
            self.shared.queued_bytes.fetch_sub(len, Ordering::AcqRel);
            self.close(CLOSE_TOO_FAR_BEHIND, "client fell too far behind");
            return Err(NotQueued);
        }
        self.tx.send(message).map_err(|_| {
            self.shared.queued_bytes.fetch_sub(len, Ordering::AcqRel);
            NotQueued
        })
    }

    /// Ask the connection to close with `code` and `reason`. The first
    /// request wins; later ones are ignored.
    pub fn close(&self, code: u16, reason: &str) {
        self.request_close(CloseRequest::new(code, reason));
    }

    /// Ask the connection to close as `request` says. The first request
    /// wins; later ones are ignored.
    pub fn request_close(&self, request: CloseRequest) {
        self.shared.close.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(request);
            true
        });
    }

    pub fn close_requested(&self) -> bool {
        self.shared.close.borrow().is_some()
    }

    pub fn close_signal(&self) -> CloseSignal {
        CloseSignal(self.shared.close.subscribe())
    }

    /// Bytes waiting in the queue.
    pub fn queued_bytes(&self) -> usize {
        self.shared.queued_bytes.load(Ordering::Acquire)
    }
}

impl ClientReceiver {
    pub async fn recv(&mut self) -> Option<Message> {
        let message = self.rx.recv().await?;
        self.release(&message);
        Some(message)
    }

    pub fn try_recv(&mut self) -> Result<Message, mpsc::error::TryRecvError> {
        let message = self.rx.try_recv()?;
        self.release(&message);
        Ok(message)
    }

    fn release(&self, message: &Message) {
        self.shared
            .queued_bytes
            .fetch_sub(payload_len(message), Ordering::AcqRel);
    }
}

impl CloseSignal {
    /// The close request, if one has been made.
    pub fn current(&self) -> Option<CloseRequest> {
        self.0.borrow().clone()
    }

    /// The close frame, once one is requested. Never resolves for a
    /// connection nobody closes.
    pub async fn requested(&mut self) -> CloseFrame {
        // Clone out of the borrow before any further await: the borrow
        // holds the channel's lock and is not `Send`.
        let request = match self.0.wait_for(Option::is_some).await {
            Ok(request) => request.clone(),
            Err(_) => None,
        };
        match request {
            Some(request) => request.frame,
            None => std::future::pending().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(len: usize) -> Message {
        Message::Text("x".repeat(len).into())
    }

    #[test]
    fn a_message_larger_than_the_budget_is_admitted_into_an_empty_queue() {
        let (tx, mut rx) = client_queue_with_budget(10);
        assert_eq!(tx.send(text(50)), Ok(()));
        assert!(!tx.close_requested());
        assert!(rx.try_recv().is_ok());
        assert_eq!(tx.queued_bytes(), 0);
    }

    #[test]
    fn a_backlog_at_the_budget_closes_the_connection() {
        let (tx, _rx) = client_queue_with_budget(10);
        tx.send(text(6)).unwrap();
        tx.send(text(6)).unwrap();
        assert_eq!(tx.send(text(1)), Err(NotQueued));
        assert!(tx.close_requested());
        // Nothing more is queued once closing, even a message that fits.
        assert_eq!(tx.send(text(0)), Err(NotQueued));
        assert_eq!(tx.queued_bytes(), 12);
    }

    #[test]
    fn draining_the_queue_frees_its_budget() {
        let (tx, mut rx) = client_queue_with_budget(10);
        tx.send(text(8)).unwrap();
        rx.try_recv().unwrap();
        tx.send(text(8)).unwrap();
        assert!(!tx.close_requested());
    }

    #[tokio::test]
    async fn the_first_close_request_is_the_one_delivered() {
        let (tx, _rx) = client_queue();
        let mut signal = tx.close_signal();
        tx.close(CLOSE_ACCESS_REVOKED, "first");
        tx.close(CLOSE_TOO_FAR_BEHIND, "second");
        let frame = signal.requested().await;
        assert_eq!(frame.code, CLOSE_ACCESS_REVOKED);
        assert_eq!(frame.reason.as_str(), "first");
        // A signal taken after the close still sees it.
        assert_eq!(
            tx.close_signal().requested().await.code,
            CLOSE_ACCESS_REVOKED
        );
    }

    #[test]
    fn a_dropped_receiver_refuses_the_message_and_keeps_the_count() {
        let (tx, rx) = client_queue();
        drop(rx);
        assert_eq!(tx.send(text(5)), Err(NotQueued));
        assert_eq!(tx.queued_bytes(), 0);
    }
}
