use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageEvent {
    pub id: i64,
    pub occurred_at_utc: DateTime<Utc>,
    pub endpoint: String,
    pub method: String,
    pub status_code: u16,
    pub latency_ms: f64,
    pub agent_run_id: Option<String>,
    pub agent_step_id: Option<String>,
    pub agent_name: Option<String>,
    pub session_id: Option<String>,
    pub dataset_id: Option<String>,
    pub view_id: Option<String>,
    pub render_id: Option<String>,
    pub request_id: Option<String>,
    pub state_hash: Option<String>,
    pub state_version: Option<u64>,
    pub request_json: Option<Value>,
    pub response_json: Option<Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageEventsResponse {
    pub schema_version: u8,
    pub events: Vec<UsageEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageRunSummary {
    pub agent_run_id: String,
    pub started_at_utc: DateTime<Utc>,
    pub last_activity_at_utc: DateTime<Utc>,
    pub event_count: u64,
    pub error_count: u64,
    pub render_count: u64,
    pub p50_latency_ms: Option<f64>,
    pub p95_latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageRunsResponse {
    pub schema_version: u8,
    pub runs: Vec<UsageRunSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UsageRunDetailResponse {
    pub schema_version: u8,
    pub run: UsageRunSummary,
    pub events: Vec<UsageEvent>,
}
