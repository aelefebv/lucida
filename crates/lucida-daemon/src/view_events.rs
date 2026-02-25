use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewEventType {
    ViewStateCommitted,
    RenderCompleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ViewEventThumbnail {
    pub url: String,
    pub sha256: String,
    pub width_px: u64,
    pub height_px: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewEvent {
    pub schema_version: u8,
    pub event_type: ViewEventType,
    pub occurred_at_utc: DateTime<Utc>,
    pub endpoint: String,
    pub view_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<ViewEventThumbnail>,
}

#[derive(Debug)]
pub struct ViewEventBus {
    event_tx: broadcast::Sender<ViewEvent>,
}

pub type SharedViewEventBus = Arc<ViewEventBus>;

pub fn new_shared_view_event_bus() -> SharedViewEventBus {
    let (event_tx, _) = broadcast::channel(512);
    Arc::new(ViewEventBus { event_tx })
}

impl ViewEventBus {
    pub fn subscribe(&self) -> broadcast::Receiver<ViewEvent> {
        self.event_tx.subscribe()
    }

    pub fn publish(&self, event: ViewEvent) {
        let _ = self.event_tx.send(event);
    }
}
