//! The watch stream's relay (ADR 0051 as amended): who is subscribed, and a
//! small ring of what pages published, kept per workspace so a subscriber
//! that joins late reads the recent past before the live items.
//!
//! The server stores what it received and computes nothing over it. An item
//! is here because a page's watch toggle was on when it was published, it
//! leaves when the ring wraps, and no lifecycle row is ever among them: the
//! item type has no variant for one. That is what keeps this outside the
//! server-side trace store [ADR 0050] rejected. The ring is seconds of
//! aggregates, never a session of rows.
//!
//! Ordering is why the relay holds each subscriber's channel itself rather
//! than looking one up when it publishes. The ring replay and every live item
//! after it are appended to the same per-connection queue under one lock, so
//! a subscriber reads the recent past and then the present, in the order the
//! workspace published them, with nothing interleaved and nothing repeated.

use std::collections::{HashMap, VecDeque};

use axum::extract::ws::{Message, Utf8Bytes};
use lucida_core::protocol::{ClientId, ServerMessage, WatchItem};
use tokio::sync::mpsc;

/// How many items the ring keeps for a late joiner.
///
/// A publishing page sends about four aggregates a second plus a provisional
/// reading every two, so this is roughly half a minute of one page's stream:
/// the recent past, which is what a stall in progress is made of, and not the
/// session. Every item is bounded by the dataset count rather than the chunk
/// count, so the ring's memory is bounded too.
pub const WATCH_RING_CAPACITY: usize = 128;

/// One relayed item, serialised once as the `watch_update` frame every
/// subscriber receives, so a replayed item and a live one carry the same
/// bytes.
#[derive(Debug, Clone)]
struct WatchEntry {
    seq: u64,
    frame: Utf8Bytes,
}

#[derive(Debug, Default)]
pub struct WatchRelay {
    ring: VecDeque<WatchEntry>,
    subscribers: HashMap<ClientId, mpsc::UnboundedSender<Message>>,
    /// The workspace's running count of relayed items, from 1.
    published: u64,
}

impl WatchRelay {
    pub fn new() -> Self {
        Self {
            ring: VecDeque::with_capacity(WATCH_RING_CAPACITY),
            subscribers: HashMap::new(),
            published: 0,
        }
    }

    /// Connections currently receiving the stream.
    pub fn subscribers(&self) -> usize {
        self.subscribers.len()
    }

    /// Relay one item a page published, and keep it for whoever joins next.
    ///
    /// Drop-oldest: a watch stream is steady state with no privileged start,
    /// and the items worth replaying during a stall are the recent ones.
    /// Returns the sequence number the item was relayed under.
    pub fn publish(&mut self, publisher: ClientId, item: WatchItem) -> u64 {
        self.published += 1;
        let seq = self.published;
        let frame: Utf8Bytes = serde_json::to_string(&ServerMessage::WatchUpdate {
            client_id: publisher,
            seq,
            item,
        })
        .expect("a watch item serialises")
        .into();

        if self.ring.len() == WATCH_RING_CAPACITY {
            self.ring.pop_front();
        }
        self.ring.push_back(WatchEntry {
            seq,
            frame: frame.clone(),
        });

        // A subscriber whose connection went away between its last message
        // and this one leaves a closed channel behind; drop it here rather
        // than waiting for the disconnect path, which a lost socket may never
        // reach in time.
        self.subscribers
            .retain(|_, sender| sender.send(Message::Text(frame.clone())).is_ok());
        seq
    }

    /// Register a connection as a subscriber and hand it the ring.
    ///
    /// Returns the sequence numbers replayed, oldest first, so a caller can
    /// log what a late joiner started from. Re-subscribing on a connection
    /// that is already subscribed replays the ring again and registers the
    /// same channel: the stream is idempotent apart from the replay, and a
    /// reader that asked twice is asking to be caught up twice.
    pub fn subscribe(
        &mut self,
        subscriber: ClientId,
        sender: mpsc::UnboundedSender<Message>,
    ) -> Vec<u64> {
        let mut replayed = Vec::with_capacity(self.ring.len());
        for entry in &self.ring {
            if sender.send(Message::Text(entry.frame.clone())).is_err() {
                return replayed;
            }
            replayed.push(entry.seq);
        }
        self.subscribers.insert(subscriber, sender);
        replayed
    }

    /// Forget a connection. Called when it disconnects; a no-op for a
    /// connection that never subscribed.
    pub fn unsubscribe(&mut self, subscriber: ClientId) {
        self.subscribers.remove(&subscriber);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn aggregate(at_epoch_ms: u64) -> WatchItem {
        WatchItem::Aggregate {
            at_epoch_ms,
            run_id: None,
            reading: None,
            counted: BTreeMap::new(),
            sent: BTreeMap::new(),
            ticks: Vec::new(),
        }
    }

    fn relayed(message: &Message) -> (ClientId, u64, u64) {
        let Message::Text(text) = message else {
            panic!("expected a text frame, got {message:?}");
        };
        match serde_json::from_str::<ServerMessage>(text.as_str()).unwrap() {
            ServerMessage::WatchUpdate {
                client_id,
                seq,
                item: WatchItem::Aggregate { at_epoch_ms, .. },
            } => (client_id, seq, at_epoch_ms),
            other => panic!("expected a relayed aggregate, got {other:?}"),
        }
    }

    #[test]
    fn a_subscriber_receives_what_is_published_after_it_joined() {
        let mut relay = WatchRelay::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert!(relay.subscribe(9, tx).is_empty());

        relay.publish(3, aggregate(1));
        relay.publish(3, aggregate(2));

        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 1, 1));
        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 2, 2));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_late_subscriber_receives_the_ring_and_then_the_live_items() {
        let mut relay = WatchRelay::new();
        relay.publish(3, aggregate(1));
        relay.publish(3, aggregate(2));

        let (tx, mut rx) = mpsc::unbounded_channel();
        assert_eq!(relay.subscribe(9, tx), vec![1, 2]);
        relay.publish(3, aggregate(3));

        let seen: Vec<u64> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| relayed(&message).1)
            .collect();
        assert_eq!(seen, vec![1, 2, 3]);
    }

    #[test]
    fn the_ring_wraps_and_the_sequence_shows_the_gap() {
        let mut relay = WatchRelay::new();
        for at in 0..(WATCH_RING_CAPACITY as u64 + 5) {
            relay.publish(3, aggregate(at));
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let replayed = relay.subscribe(9, tx);
        assert_eq!(replayed.len(), WATCH_RING_CAPACITY);
        assert_eq!(replayed[0], 6);
        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 6, 5));
    }

    #[test]
    fn several_pages_publish_into_one_stream_and_the_publisher_is_named() {
        let mut relay = WatchRelay::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        relay.subscribe(9, tx);

        relay.publish(3, aggregate(1));
        relay.publish(4, aggregate(2));

        assert_eq!(relayed(&rx.try_recv().unwrap()).0, 3);
        assert_eq!(relayed(&rx.try_recv().unwrap()).0, 4);
    }

    #[test]
    fn a_departed_subscriber_stops_receiving() {
        let mut relay = WatchRelay::new();
        let (tx, rx) = mpsc::unbounded_channel();
        relay.subscribe(9, tx);
        assert_eq!(relay.subscribers(), 1);

        relay.unsubscribe(9);
        drop(rx);
        relay.publish(3, aggregate(1));
        assert_eq!(relay.subscribers(), 0);
    }

    #[test]
    fn a_closed_channel_is_pruned_on_publish() {
        let mut relay = WatchRelay::new();
        let (tx, rx) = mpsc::unbounded_channel();
        relay.subscribe(9, tx);
        drop(rx);

        relay.publish(3, aggregate(1));
        assert_eq!(relay.subscribers(), 0);
    }
}
