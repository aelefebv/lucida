//! Captures the `tracing` events a test drives, so it can assert which
//! fired and at what level. In-tree glue rather than the `tracing-test`
//! crate, to avoid a dev-dependency.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::with_default;
use tracing::{Event, Level, Metadata, Subscriber};
use tracing::{field::Field, field::Visit};

/// One captured tracing event: the event name (the message-position
/// string in `tracing::info!(... "auth.signin.success")`), its level,
/// and the structured field values rendered with `Display`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapturedEvent {
    pub(crate) name: String,
    pub(crate) level: Level,
    pub(crate) fields: Vec<(String, String)>,
}

impl CapturedEvent {
    pub(crate) fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Subscriber that records every event it sees into a shared `Vec`.
/// Spans are accepted, so `#[instrument]` does not error, but not
/// recorded.
#[derive(Clone)]
struct CaptureSubscriber {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
    next_id: Arc<AtomicU64>,
}

impl CaptureSubscriber {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    fn handle(&self) -> Arc<Mutex<Vec<CapturedEvent>>> {
        Arc::clone(&self.events)
    }
}

impl Subscriber for CaptureSubscriber {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        // Capture every level. Ignore the global `RUST_LOG` filter —
        // tests want full visibility regardless of the runner's
        // environment.
        true
    }

    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut visitor = FieldRecorder::default();
        event.record(&mut visitor);
        let level = *event.metadata().level();
        // The event-name convention puts `dot.scope` strings in the
        // message position; tracing surfaces the message via the
        // synthetic `message` field.
        let name = visitor
            .message
            .clone()
            .unwrap_or_else(|| event.metadata().name().to_string());
        let fields = visitor
            .fields
            .into_iter()
            .filter(|(k, _)| k != "message")
            .collect();
        self.events
            .lock()
            .expect("capture mutex poisoned")
            .push(CapturedEvent {
                name,
                level,
                fields,
            });
    }
}

/// `Visit` impl that records every field as (name, Display(value)).
#[derive(Default)]
struct FieldRecorder {
    fields: Vec<(String, String)>,
    message: Option<String>,
}

impl Visit for FieldRecorder {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let s = format!("{value:?}");
        if field.name() == "message" {
            // tracing's `record_debug` on the `message` field yields the
            // formatted message text (already a string); strip the
            // surrounding quotes for cleaner asserts.
            let trimmed = s.trim_matches('"').to_string();
            self.message = Some(trimmed.clone());
            self.fields.push((field.name().to_string(), trimmed));
        } else {
            self.fields.push((field.name().to_string(), s));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
            self.fields
                .push((field.name().to_string(), value.to_string()));
        } else {
            self.fields
                .push((field.name().to_string(), value.to_string()));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }
}

/// Run `block` with the capture subscriber installed; return the
/// captured events. Restores the previous default on drop (within the
/// returned closure scope).
pub(crate) fn capture<F, R>(block: F) -> (Vec<CapturedEvent>, R)
where
    F: FnOnce() -> R,
{
    let cap = CaptureSubscriber::new();
    let handle = cap.handle();
    let res = with_default(cap, block);
    let events = handle.lock().expect("capture mutex poisoned").clone();
    (events, res)
}

/// Async variant of [`capture`] — holds the subscriber as the default
/// for the duration of an async block by relying on tokio's
/// single-threaded runtime per #[tokio::test].
pub(crate) async fn capture_async<F, Fut, R>(block: F) -> (Vec<CapturedEvent>, R)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let cap = CaptureSubscriber::new();
    let handle = cap.handle();
    let _guard = tracing::subscriber::set_default(cap);
    let res = block().await;
    let events = handle.lock().expect("capture mutex poisoned").clone();
    (events, res)
}

pub(crate) fn require_event<'a>(
    events: &'a [CapturedEvent],
    name: &str,
    expected_level: Level,
) -> &'a CapturedEvent {
    let evt = events
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("no event named {name:?} in {events:#?}"));
    assert_eq!(
        evt.level, expected_level,
        "event {name:?} fired at unexpected level",
    );
    evt
}
