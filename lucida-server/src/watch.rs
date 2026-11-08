//! The watch stream's relay: who is subscribed, and a small ring
//! of what pages published, kept per workspace so a subscriber that asks for
//! history can read the recent past before the live items.
//!
//! The server stores what it received and computes nothing over it, and the
//! item type has no variant for a lifecycle row. A replay, its end marker, and
//! every live item go into one per-connection queue under one lock, so a
//! subscriber sees them in publish order with nothing repeated.

use std::collections::{HashMap, VecDeque};

use axum::extract::ws::{Message, Utf8Bytes};
use lucida_core::protocol::{ClientId, ServerMessage, WatchItem};

use crate::connection::ClientSender;

/// How many items the ring keeps for a subscriber that asks for history.
///
/// A publishing page sends about four aggregates a second plus a provisional
/// reading every two, so this is roughly half a minute of one page's stream:
/// the recent past, which is what a stall in progress is made of, and not the
/// session. Every item is bounded by the dataset count rather than the chunk
/// count, so the ring's memory is bounded too.
pub const WATCH_RING_CAPACITY: usize = 128;

/// One relayed item, serialised once as the `watch_update` frame every
/// subscriber receives. A replayed item and a live one carry the same bytes,
/// which is why a replay ends with a marker.
#[derive(Debug, Clone)]
struct WatchEntry {
    seq: u64,
    frame: Utf8Bytes,
}

#[derive(Debug, Default)]
pub struct WatchRelay {
    ring: VecDeque<WatchEntry>,
    subscribers: HashMap<ClientId, ClientSender>,
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

    /// Register a connection as a subscriber. With `history`, hand it the
    /// ring first and then a `watch_history_end` frame; without, it reads
    /// only what is published from now on.
    ///
    /// Returns the sequence numbers replayed, oldest first, so a caller can
    /// log what the subscriber started from. Re-subscribing on a connection
    /// that is already subscribed registers the same channel: the stream is
    /// idempotent apart from the replay, and a reader that asks for history
    /// twice is asking to be caught up twice.
    pub fn subscribe(
        &mut self,
        subscriber: ClientId,
        sender: ClientSender,
        history: bool,
    ) -> Vec<u64> {
        let mut replayed = Vec::new();
        if history {
            replayed.reserve(self.ring.len());
            for entry in &self.ring {
                if sender.send(Message::Text(entry.frame.clone())).is_err() {
                    return replayed;
                }
                replayed.push(entry.seq);
            }
            let end = serde_json::to_string(&ServerMessage::WatchHistoryEnd {
                through_seq: self.published,
                replayed: replayed.len() as u64,
            })
            .expect("a history marker serialises");
            if sender.send(Message::Text(end.into())).is_err() {
                return replayed;
            }
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

    fn parsed(message: &Message) -> ServerMessage {
        let Message::Text(text) = message else {
            panic!("expected a text frame, got {message:?}");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    fn relayed(message: &Message) -> (ClientId, u64, u64) {
        match parsed(message) {
            ServerMessage::WatchUpdate {
                client_id,
                seq,
                item: WatchItem::Aggregate { at_epoch_ms, .. },
            } => (client_id, seq, at_epoch_ms),
            other => panic!("expected a relayed aggregate, got {other:?}"),
        }
    }

    fn history_end(message: &Message) -> (u64, u64) {
        match parsed(message) {
            ServerMessage::WatchHistoryEnd {
                through_seq,
                replayed,
            } => (through_seq, replayed),
            other => panic!("expected the history marker, got {other:?}"),
        }
    }

    #[test]
    fn a_subscriber_receives_what_is_published_after_it_joined() {
        let mut relay = WatchRelay::new();
        let (tx, mut rx) = crate::connection::client_queue();
        assert!(relay.subscribe(9, tx, false).is_empty());

        relay.publish(3, aggregate(1));
        relay.publish(3, aggregate(2));

        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 1, 1));
        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 2, 2));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_late_subscriber_reads_only_live_items_unless_it_asks_for_history() {
        let mut relay = WatchRelay::new();
        relay.publish(3, aggregate(1));
        relay.publish(3, aggregate(2));

        let (tx, mut rx) = crate::connection::client_queue();
        assert!(relay.subscribe(9, tx, false).is_empty());
        relay.publish(3, aggregate(3));

        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 3, 3));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn history_is_the_ring_then_a_marker_then_the_live_items() {
        let mut relay = WatchRelay::new();
        relay.publish(3, aggregate(1));
        relay.publish(3, aggregate(2));

        let (tx, mut rx) = crate::connection::client_queue();
        assert_eq!(relay.subscribe(9, tx, true), vec![1, 2]);
        relay.publish(3, aggregate(3));

        assert_eq!(relayed(&rx.try_recv().unwrap()).1, 1);
        assert_eq!(relayed(&rx.try_recv().unwrap()).1, 2);
        assert_eq!(history_end(&rx.try_recv().unwrap()), (2, 2));
        assert_eq!(relayed(&rx.try_recv().unwrap()).1, 3);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn history_of_a_quiet_workspace_is_the_marker_alone() {
        let mut relay = WatchRelay::new();
        let (tx, mut rx) = crate::connection::client_queue();
        assert!(relay.subscribe(9, tx, true).is_empty());

        assert_eq!(history_end(&rx.try_recv().unwrap()), (0, 0));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn the_ring_wraps_and_the_marker_shows_the_gap() {
        let mut relay = WatchRelay::new();
        let published = WATCH_RING_CAPACITY as u64 + 5;
        for at in 0..published {
            relay.publish(3, aggregate(at));
        }
        let (tx, mut rx) = crate::connection::client_queue();
        let replayed = relay.subscribe(9, tx, true);
        assert_eq!(replayed.len(), WATCH_RING_CAPACITY);
        assert_eq!(replayed[0], 6);
        assert_eq!(relayed(&rx.try_recv().unwrap()), (3, 6, 5));
        for _ in 1..WATCH_RING_CAPACITY {
            rx.try_recv().unwrap();
        }
        assert_eq!(
            history_end(&rx.try_recv().unwrap()),
            (published, WATCH_RING_CAPACITY as u64)
        );
    }

    #[test]
    fn several_pages_publish_into_one_stream_and_the_publisher_is_named() {
        let mut relay = WatchRelay::new();
        let (tx, mut rx) = crate::connection::client_queue();
        relay.subscribe(9, tx, false);

        relay.publish(3, aggregate(1));
        relay.publish(4, aggregate(2));

        assert_eq!(relayed(&rx.try_recv().unwrap()).0, 3);
        assert_eq!(relayed(&rx.try_recv().unwrap()).0, 4);
    }

    #[test]
    fn a_departed_subscriber_stops_receiving() {
        let mut relay = WatchRelay::new();
        let (tx, rx) = crate::connection::client_queue();
        relay.subscribe(9, tx, false);
        assert_eq!(relay.subscribers(), 1);

        relay.unsubscribe(9);
        drop(rx);
        relay.publish(3, aggregate(1));
        assert_eq!(relay.subscribers(), 0);
    }

    #[test]
    fn a_closed_channel_is_pruned_on_publish() {
        let mut relay = WatchRelay::new();
        let (tx, rx) = crate::connection::client_queue();
        relay.subscribe(9, tx, false);
        drop(rx);

        relay.publish(3, aggregate(1));
        assert_eq!(relay.subscribers(), 0);
    }
}
