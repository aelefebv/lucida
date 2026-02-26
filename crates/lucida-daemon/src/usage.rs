use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};

use axum::http::{HeaderMap, Method};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::dto::usage::{UsageEvent, UsageRunSummary};

pub const ENV_USAGE_DB_PATH: &str = "LUCIDA_USAGE_DB_PATH";
pub const ENV_USAGE_RETENTION_DAYS: &str = "LUCIDA_USAGE_RETENTION_DAYS";
pub const ENV_USAGE_MAX_EVENTS: &str = "LUCIDA_USAGE_MAX_EVENTS";
pub const ENV_USAGE_MAX_DB_BYTES: &str = "LUCIDA_USAGE_MAX_DB_BYTES";

const DEFAULT_RETENTION_DAYS: i64 = 14;
const DEFAULT_MAX_EVENTS: i64 = 50_000;
const DEFAULT_MAX_DB_BYTES: u64 = 1_073_741_824;
const MAX_PENDING_INSERT_WAIT_MS: u64 = 2_000;
const PRUNE_INTERVAL_SECONDS: u64 = 30;
const PRUNE_BATCH_DIVISOR: i64 = 100;
const PRUNE_BATCH_MAX_INSERTS: usize = 512;
const PRUNE_HARD_MAX_INSERTS: usize = 4_096;

const AGENT_RUN_HEADER: &str = "x-lucida-agent-run-id";
const AGENT_STEP_HEADER: &str = "x-lucida-agent-step-id";
const AGENT_NAME_HEADER: &str = "x-lucida-agent-name";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentContext {
    pub agent_run_id: Option<String>,
    pub agent_step_id: Option<String>,
    pub agent_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UsageEventInsert {
    pub endpoint: String,
    pub method: String,
    pub status_code: u16,
    pub latency_ms: f64,
    pub agent_context: AgentContext,
    pub request_json: Option<Value>,
    pub response_json: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct UsageEventsFilter {
    pub limit: u32,
    pub before_id: Option<i64>,
    pub run_id: Option<String>,
    pub endpoint: Option<String>,
    pub status_code: Option<u16>,
    pub from_ts: Option<DateTime<Utc>>,
    pub to_ts: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct UsageRunsFilter {
    pub limit: u32,
    pub before_start_ts: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct UsageConfig {
    pub db_path: PathBuf,
    pub retention_days: i64,
    pub max_events: i64,
    pub max_db_bytes: u64,
}

impl Default for UsageConfig {
    fn default() -> Self {
        Self {
            db_path: default_usage_db_path(),
            retention_days: parse_env_i64(ENV_USAGE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
            max_events: parse_env_i64(ENV_USAGE_MAX_EVENTS, DEFAULT_MAX_EVENTS),
            max_db_bytes: parse_env_u64(ENV_USAGE_MAX_DB_BYTES, DEFAULT_MAX_DB_BYTES),
        }
    }
}

#[derive(Debug)]
pub struct UsageTelemetry {
    db_path: PathBuf,
    retention_days: i64,
    max_events: i64,
    max_db_bytes: u64,
    conn: Mutex<Connection>,
    event_tx: broadcast::Sender<UsageEvent>,
    pending_inserts: AtomicUsize,
    inserts_since_prune: AtomicUsize,
    last_prune_at: Mutex<Instant>,
}

pub type SharedUsageTelemetry = Arc<UsageTelemetry>;

pub fn new_shared_usage_telemetry() -> Result<SharedUsageTelemetry, String> {
    new_shared_usage_telemetry_with_config(UsageConfig::default())
}

pub fn new_shared_usage_telemetry_with_config(
    config: UsageConfig,
) -> Result<SharedUsageTelemetry, String> {
    if let Some(parent) = config.db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create usage db directory '{}': {error}",
                parent.display()
            )
        })?;
    }

    let mut conn = Connection::open(&config.db_path).map_err(|error| {
        format!(
            "failed to open usage db '{}': {error}",
            config.db_path.display()
        )
    })?;
    conn.busy_timeout(StdDuration::from_secs(5))
        .map_err(|error| format!("failed to configure sqlite busy timeout: {error}"))?;
    initialize_usage_schema(&mut conn)?;

    let (event_tx, _) = broadcast::channel(512);
    let telemetry = Arc::new(UsageTelemetry {
        db_path: config.db_path,
        retention_days: config.retention_days.max(1),
        max_events: config.max_events.max(1),
        max_db_bytes: config.max_db_bytes.max(1),
        conn: Mutex::new(conn),
        event_tx,
        pending_inserts: AtomicUsize::new(0),
        inserts_since_prune: AtomicUsize::new(0),
        last_prune_at: Mutex::new(Instant::now()),
    });

    telemetry.prune_retention()?;
    Ok(telemetry)
}

impl UsageTelemetry {
    pub fn begin_async_insert(&self) {
        self.pending_inserts.fetch_add(1, Ordering::AcqRel);
    }

    pub fn finish_async_insert(&self) {
        let mut current = self.pending_inserts.load(Ordering::Acquire);
        loop {
            if current == 0 {
                return;
            }
            match self.pending_inserts.compare_exchange(
                current,
                current - 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<UsageEvent> {
        self.event_tx.subscribe()
    }

    pub fn record_http_event(&self, payload: UsageEventInsert) -> Result<(), String> {
        let now = Utc::now();
        let ids = UsageIdentifiers::from_payloads(
            payload.request_json.as_ref(),
            payload.response_json.as_ref(),
        );
        let error =
            UsageErrorInfo::from_response(payload.response_json.as_ref(), payload.status_code);
        let request_json_text = json_text(payload.request_json.as_ref())?;
        let response_json_text = json_text(payload.response_json.as_ref())?;

        let inserted_event = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "failed to lock usage db connection".to_owned())?;
            conn.execute(
                "INSERT INTO usage_events (
                    occurred_at_utc, endpoint, method, status_code, latency_ms,
                    agent_run_id, agent_step_id, agent_name,
                    session_id, dataset_id, view_id, render_id, request_id,
                    state_hash, state_version,
                    request_json, response_json, error_code, error_message
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8,
                    ?9, ?10, ?11, ?12, ?13,
                    ?14, ?15,
                    ?16, ?17, ?18, ?19
                )",
                params![
                    now.to_rfc3339(),
                    payload.endpoint,
                    payload.method,
                    i64::from(payload.status_code),
                    payload.latency_ms,
                    payload.agent_context.agent_run_id,
                    payload.agent_context.agent_step_id,
                    payload.agent_context.agent_name,
                    ids.session_id,
                    ids.dataset_id,
                    ids.view_id,
                    ids.render_id,
                    ids.request_id,
                    ids.state_hash,
                    ids.state_version.map(|value| value as i64),
                    request_json_text,
                    response_json_text,
                    error.code,
                    error.message,
                ],
            )
            .map_err(|error| format!("failed to insert usage event: {error}"))?;

            let id = conn.last_insert_rowid();
            self.maybe_prune_after_insert_locked(&conn)?;
            self.load_event_by_id_locked(&conn, id)?
        };

        if let Some(event) = inserted_event {
            let _ = self.event_tx.send(event);
        }
        Ok(())
    }

    pub fn list_events(&self, filter: UsageEventsFilter) -> Result<Vec<UsageEvent>, String> {
        self.wait_for_pending_inserts();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "failed to lock usage db connection".to_owned())?;
        self.list_events_locked(&conn, filter)
    }

    fn list_events_locked(
        &self,
        conn: &Connection,
        filter: UsageEventsFilter,
    ) -> Result<Vec<UsageEvent>, String> {
        let mut query = String::from(
            "SELECT
                id, occurred_at_utc, endpoint, method, status_code, latency_ms,
                agent_run_id, agent_step_id, agent_name,
                session_id, dataset_id, view_id, render_id, request_id,
                state_hash, state_version, request_json, response_json, error_code, error_message
             FROM usage_events
             WHERE 1 = 1",
        );
        let mut params: Vec<SqlValue> = Vec::new();

        if let Some(before_id) = filter.before_id {
            query.push_str(" AND id < ?");
            params.push(SqlValue::Integer(before_id));
        }
        if let Some(run_id) = filter.run_id {
            query.push_str(" AND agent_run_id = ?");
            params.push(SqlValue::Text(run_id));
        }
        if let Some(endpoint) = filter.endpoint {
            query.push_str(" AND endpoint = ?");
            params.push(SqlValue::Text(endpoint));
        }
        if let Some(status_code) = filter.status_code {
            query.push_str(" AND status_code = ?");
            params.push(SqlValue::Integer(i64::from(status_code)));
        }
        if let Some(from_ts) = filter.from_ts {
            query.push_str(" AND occurred_at_utc >= ?");
            params.push(SqlValue::Text(from_ts.to_rfc3339()));
        }
        if let Some(to_ts) = filter.to_ts {
            query.push_str(" AND occurred_at_utc <= ?");
            params.push(SqlValue::Text(to_ts.to_rfc3339()));
        }

        query.push_str(" ORDER BY id DESC LIMIT ?");
        params.push(SqlValue::Integer(i64::from(filter.limit)));

        let mut statement = conn
            .prepare(&query)
            .map_err(|error| format!("failed to prepare usage event query: {error}"))?;
        let mut rows = statement
            .query(params_from_iter(params.iter()))
            .map_err(|error| format!("failed to execute usage event query: {error}"))?;

        let mut events = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("failed to read usage event row: {error}"))?
        {
            events.push(row_to_usage_event(row)?);
        }
        Ok(events)
    }

    pub fn list_runs(&self, filter: UsageRunsFilter) -> Result<Vec<UsageRunSummary>, String> {
        self.wait_for_pending_inserts();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "failed to lock usage db connection".to_owned())?;

        let mut query = String::from(
            "SELECT
                agent_run_id,
                MIN(occurred_at_utc) AS started_at_utc,
                MAX(occurred_at_utc) AS last_activity_at_utc,
                COUNT(*) AS event_count,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
                SUM(CASE WHEN endpoint = '/render/image' THEN 1 ELSE 0 END) AS render_count
             FROM usage_events
             WHERE agent_run_id IS NOT NULL",
        );
        let mut params: Vec<SqlValue> = Vec::new();
        if let Some(before_start_ts) = filter.before_start_ts {
            query.push_str(" GROUP BY agent_run_id HAVING MIN(occurred_at_utc) < ?");
            params.push(SqlValue::Text(before_start_ts.to_rfc3339()));
        } else {
            query.push_str(" GROUP BY agent_run_id");
        }
        query.push_str(" ORDER BY started_at_utc DESC LIMIT ?");
        params.push(SqlValue::Integer(i64::from(filter.limit)));

        let mut statement = conn
            .prepare(&query)
            .map_err(|error| format!("failed to prepare usage run query: {error}"))?;
        let mut rows = statement
            .query(params_from_iter(params.iter()))
            .map_err(|error| format!("failed to execute usage run query: {error}"))?;

        let mut runs = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("failed to read usage run row: {error}"))?
        {
            let run_id: String = row
                .get(0)
                .map_err(|error| format!("failed to decode run id: {error}"))?;
            let started_at_utc = parse_rfc3339_utc(
                &row.get::<_, String>(1)
                    .map_err(|error| format!("failed to decode run start timestamp: {error}"))?,
            )?;
            let last_activity_at_utc =
                parse_rfc3339_utc(&row.get::<_, String>(2).map_err(|error| {
                    format!("failed to decode run last-activity timestamp: {error}")
                })?)?;
            let event_count = row
                .get::<_, i64>(3)
                .map_err(|error| format!("failed to decode run event_count: {error}"))?
                .max(0) as u64;
            let error_count = row
                .get::<_, i64>(4)
                .map_err(|error| format!("failed to decode run error_count: {error}"))?
                .max(0) as u64;
            let render_count = row
                .get::<_, i64>(5)
                .map_err(|error| format!("failed to decode run render_count: {error}"))?
                .max(0) as u64;

            let latency_values = self.latencies_for_run_locked(&conn, &run_id)?;
            runs.push(UsageRunSummary {
                agent_run_id: run_id,
                started_at_utc,
                last_activity_at_utc,
                event_count,
                error_count,
                render_count,
                p50_latency_ms: percentile(&latency_values, 50.0),
                p95_latency_ms: percentile(&latency_values, 95.0),
            });
        }
        Ok(runs)
    }

    pub fn get_run(
        &self,
        run_id: &str,
        event_limit: u32,
    ) -> Result<Option<(UsageRunSummary, Vec<UsageEvent>)>, String> {
        self.wait_for_pending_inserts();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "failed to lock usage db connection".to_owned())?;

        let mut statement = conn
            .prepare(
                "SELECT
                    MIN(occurred_at_utc) AS started_at_utc,
                    MAX(occurred_at_utc) AS last_activity_at_utc,
                    COUNT(*) AS event_count,
                    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
                    SUM(CASE WHEN endpoint = '/render/image' THEN 1 ELSE 0 END) AS render_count
                 FROM usage_events
                 WHERE agent_run_id = ?1",
            )
            .map_err(|error| format!("failed to prepare usage run detail query: {error}"))?;

        let aggregate = statement
            .query_row(params![run_id], |row| {
                let started: Option<String> = row.get(0)?;
                let last: Option<String> = row.get(1)?;
                let event_count: i64 = row.get(2)?;
                let error_count: i64 = row.get(3)?;
                let render_count: i64 = row.get(4)?;
                Ok((started, last, event_count, error_count, render_count))
            })
            .optional()
            .map_err(|error| format!("failed to query usage run detail: {error}"))?;

        let Some((
            Some(started_at),
            Some(last_activity_at),
            event_count,
            error_count,
            render_count,
        )) = aggregate
        else {
            return Ok(None);
        };

        let latencies = self.latencies_for_run_locked(&conn, run_id)?;
        let run_summary = UsageRunSummary {
            agent_run_id: run_id.to_owned(),
            started_at_utc: parse_rfc3339_utc(&started_at)?,
            last_activity_at_utc: parse_rfc3339_utc(&last_activity_at)?,
            event_count: event_count.max(0) as u64,
            error_count: error_count.max(0) as u64,
            render_count: render_count.max(0) as u64,
            p50_latency_ms: percentile(&latencies, 50.0),
            p95_latency_ms: percentile(&latencies, 95.0),
        };

        let events = self.list_events_locked(
            &conn,
            UsageEventsFilter {
                limit: event_limit.max(1),
                before_id: None,
                run_id: Some(run_id.to_owned()),
                endpoint: None,
                status_code: None,
                from_ts: None,
                to_ts: None,
            },
        )?;

        Ok(Some((run_summary, events)))
    }

    pub fn prune_retention(&self) -> Result<(), String> {
        self.wait_for_pending_inserts();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "failed to lock usage db connection".to_owned())?;
        self.prune_locked(&conn)
    }

    fn maybe_prune_after_insert_locked(&self, conn: &Connection) -> Result<(), String> {
        let inserts_since_prune = self.inserts_since_prune.fetch_add(1, Ordering::AcqRel) + 1;
        if self.should_prune_after_insert(inserts_since_prune)? {
            self.prune_locked(conn)?;
        }
        Ok(())
    }

    fn should_prune_after_insert(&self, inserts_since_prune: usize) -> Result<bool, String> {
        if inserts_since_prune >= PRUNE_HARD_MAX_INSERTS {
            return Ok(true);
        }
        if inserts_since_prune >= self.prune_insert_batch_size() {
            return Ok(true);
        }

        let last_prune_at = self
            .last_prune_at
            .lock()
            .map_err(|_| "failed to lock usage prune schedule".to_owned())?;
        Ok(last_prune_at.elapsed() >= StdDuration::from_secs(PRUNE_INTERVAL_SECONDS))
    }

    fn prune_insert_batch_size(&self) -> usize {
        let scaled = self.max_events / PRUNE_BATCH_DIVISOR;
        let clamped = scaled.clamp(1, PRUNE_BATCH_MAX_INSERTS as i64);
        clamped as usize
    }

    fn prune_locked(&self, conn: &Connection) -> Result<(), String> {
        let cutoff = Utc::now() - Duration::days(self.retention_days.max(1));
        conn.execute(
            "DELETE FROM usage_events WHERE occurred_at_utc < ?1",
            params![cutoff.to_rfc3339()],
        )
        .map_err(|error| format!("failed to prune usage events by age: {error}"))?;

        let event_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| row.get(0))
            .map_err(|error| format!("failed to count usage events for pruning: {error}"))?;
        if event_count > self.max_events {
            let remove_count = event_count - self.max_events;
            conn.execute(
                "DELETE FROM usage_events WHERE id IN (
                    SELECT id FROM usage_events ORDER BY id ASC LIMIT ?1
                )",
                params![remove_count],
            )
            .map_err(|error| format!("failed to prune usage events by count: {error}"))?;
        }

        while usage_db_total_size(&self.db_path) > self.max_db_bytes {
            let removed = conn
                .execute(
                    "DELETE FROM usage_events WHERE id IN (
                        SELECT id FROM usage_events ORDER BY id ASC LIMIT 1000
                    )",
                    [],
                )
                .map_err(|error| format!("failed to prune usage events by size: {error}"))?;
            if removed == 0 {
                break;
            }
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| {
                    format!("failed to checkpoint usage db during pruning: {error}")
                })?;
        }
        self.prune_thumbnail_files(cutoff.date_naive())?;
        self.inserts_since_prune.store(0, Ordering::Release);
        let mut last_prune_at = self
            .last_prune_at
            .lock()
            .map_err(|_| "failed to lock usage prune schedule".to_owned())?;
        *last_prune_at = Instant::now();
        Ok(())
    }

    fn prune_thumbnail_files(&self, cutoff_date: NaiveDate) -> Result<(), String> {
        let thumb_root = usage_thumbnail_root();
        if !thumb_root.exists() {
            return Ok(());
        }
        let entries = fs::read_dir(&thumb_root).map_err(|error| {
            format!(
                "failed to list thumbnail directory '{}': {error}",
                thumb_root.display()
            )
        })?;
        for entry_result in entries {
            let entry =
                entry_result.map_err(|error| format!("failed to read thumbnail entry: {error}"))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Ok(date) = NaiveDate::parse_from_str(name, "%Y-%m-%d") else {
                continue;
            };
            if date < cutoff_date {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!(
                        "failed to remove pruned thumbnail directory '{}': {error}",
                        path.display()
                    )
                })?;
            }
        }
        Ok(())
    }

    fn load_event_by_id_locked(
        &self,
        conn: &Connection,
        id: i64,
    ) -> Result<Option<UsageEvent>, String> {
        let mut statement = conn
            .prepare(
                "SELECT
                    id, occurred_at_utc, endpoint, method, status_code, latency_ms,
                    agent_run_id, agent_step_id, agent_name,
                    session_id, dataset_id, view_id, render_id, request_id,
                    state_hash, state_version, request_json, response_json, error_code, error_message
                 FROM usage_events
                 WHERE id = ?1",
            )
            .map_err(|error| format!("failed to prepare usage event lookup: {error}"))?;

        let mut rows = statement
            .query(params![id])
            .map_err(|error| format!("failed to execute usage event lookup: {error}"))?;
        let maybe_row = rows
            .next()
            .map_err(|error| format!("failed to read usage event lookup row: {error}"))?;
        match maybe_row {
            Some(row) => row_to_usage_event(row).map(Some),
            None => Ok(None),
        }
    }

    fn latencies_for_run_locked(
        &self,
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<f64>, String> {
        let mut statement = conn
            .prepare(
                "SELECT latency_ms
                 FROM usage_events
                 WHERE agent_run_id = ?1
                 ORDER BY latency_ms ASC",
            )
            .map_err(|error| {
                format!("failed to prepare latency query for run '{run_id}': {error}")
            })?;

        let mut rows = statement
            .query(params![run_id])
            .map_err(|error| format!("failed to query latencies for run '{run_id}': {error}"))?;

        let mut latencies: Vec<f64> = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("failed to iterate run latency rows: {error}"))?
        {
            let value: f64 = row
                .get(0)
                .map_err(|error| format!("failed to decode latency value: {error}"))?;
            latencies.push(value.max(0.0));
        }
        Ok(latencies)
    }

    fn wait_for_pending_inserts(&self) {
        if self.pending_inserts.load(Ordering::Acquire) == 0 {
            return;
        }

        let deadline = Instant::now() + StdDuration::from_millis(MAX_PENDING_INSERT_WAIT_MS);
        while self.pending_inserts.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
            std::thread::sleep(StdDuration::from_millis(1));
        }
    }
}

fn initialize_usage_schema(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS usage_events (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             occurred_at_utc TEXT NOT NULL,
             endpoint TEXT NOT NULL,
             method TEXT NOT NULL,
             status_code INTEGER NOT NULL,
             latency_ms REAL NOT NULL,
             agent_run_id TEXT,
             agent_step_id TEXT,
             agent_name TEXT,
             session_id TEXT,
             dataset_id TEXT,
             view_id TEXT,
             render_id TEXT,
             request_id TEXT,
             state_hash TEXT,
             state_version INTEGER,
             request_json TEXT,
             response_json TEXT,
             error_code TEXT,
             error_message TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_usage_events_occurred_at
             ON usage_events (occurred_at_utc DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_events_agent_run_id
             ON usage_events (agent_run_id, id DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_events_endpoint
             ON usage_events (endpoint, id DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_events_status_code
             ON usage_events (status_code, id DESC);",
    )
    .map_err(|error| format!("failed to initialize usage db schema: {error}"))?;
    Ok(())
}

fn json_text(payload: Option<&Value>) -> Result<Option<String>, String> {
    match payload {
        None => Ok(None),
        Some(value) => serde_json::to_string(value)
            .map(Some)
            .map_err(|error| format!("failed to serialize telemetry JSON payload: {error}")),
    }
}

fn parse_rfc3339_utc(value: &str) -> Result<DateTime<Utc>, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|ts| ts.with_timezone(&Utc))
        .map_err(|error| format!("failed to parse RFC3339 timestamp '{value}': {error}"))
}

fn row_to_usage_event(row: &Row<'_>) -> Result<UsageEvent, String> {
    let occurred_at_text: String = row
        .get(1)
        .map_err(|error| format!("failed to decode occurred_at_utc: {error}"))?;
    let status_code_i64: i64 = row
        .get(4)
        .map_err(|error| format!("failed to decode status_code: {error}"))?;
    let request_json_text: Option<String> = row
        .get(16)
        .map_err(|error| format!("failed to decode request_json: {error}"))?;
    let response_json_text: Option<String> = row
        .get(17)
        .map_err(|error| format!("failed to decode response_json: {error}"))?;
    let state_version_i64: Option<i64> = row
        .get(15)
        .map_err(|error| format!("failed to decode state_version: {error}"))?;

    Ok(UsageEvent {
        id: row
            .get(0)
            .map_err(|error| format!("failed to decode id: {error}"))?,
        occurred_at_utc: parse_rfc3339_utc(&occurred_at_text)?,
        endpoint: row
            .get(2)
            .map_err(|error| format!("failed to decode endpoint: {error}"))?,
        method: row
            .get(3)
            .map_err(|error| format!("failed to decode method: {error}"))?,
        status_code: u16::try_from(status_code_i64.max(0)).unwrap_or(u16::MAX),
        latency_ms: row
            .get::<_, f64>(5)
            .map_err(|error| format!("failed to decode latency_ms: {error}"))?,
        agent_run_id: row
            .get(6)
            .map_err(|error| format!("failed to decode agent_run_id: {error}"))?,
        agent_step_id: row
            .get(7)
            .map_err(|error| format!("failed to decode agent_step_id: {error}"))?,
        agent_name: row
            .get(8)
            .map_err(|error| format!("failed to decode agent_name: {error}"))?,
        session_id: row
            .get(9)
            .map_err(|error| format!("failed to decode session_id: {error}"))?,
        dataset_id: row
            .get(10)
            .map_err(|error| format!("failed to decode dataset_id: {error}"))?,
        view_id: row
            .get(11)
            .map_err(|error| format!("failed to decode view_id: {error}"))?,
        render_id: row
            .get(12)
            .map_err(|error| format!("failed to decode render_id: {error}"))?,
        request_id: row
            .get(13)
            .map_err(|error| format!("failed to decode request_id: {error}"))?,
        state_hash: row
            .get(14)
            .map_err(|error| format!("failed to decode state_hash: {error}"))?,
        state_version: state_version_i64.and_then(|value| {
            if value >= 0 {
                Some(value as u64)
            } else {
                None
            }
        }),
        request_json: parse_optional_json_text(request_json_text.as_deref())?,
        response_json: parse_optional_json_text(response_json_text.as_deref())?,
        error_code: row
            .get(18)
            .map_err(|error| format!("failed to decode error_code: {error}"))?,
        error_message: row
            .get(19)
            .map_err(|error| format!("failed to decode error_message: {error}"))?,
    })
}

fn parse_optional_json_text(value: Option<&str>) -> Result<Option<Value>, String> {
    match value {
        None => Ok(None),
        Some(payload) => serde_json::from_str::<Value>(payload)
            .map(Some)
            .map_err(|error| format!("failed to parse stored JSON payload: {error}")),
    }
}

fn usage_db_total_size(path: &Path) -> u64 {
    let mut total = file_size(path);
    let wal_path = format!("{}-wal", path.to_string_lossy());
    total = total.saturating_add(file_size(Path::new(&wal_path)));
    total
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn parse_env_i64(name: &str, fallback: i64) -> i64 {
    match std::env::var(name) {
        Ok(raw) => raw.parse::<i64>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn parse_env_u64(name: &str, fallback: u64) -> u64 {
    match std::env::var(name) {
        Ok(raw) => raw.parse::<u64>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn default_usage_db_path() -> PathBuf {
    if let Ok(configured) = std::env::var(ENV_USAGE_DB_PATH) {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("output")
        .join("usage")
        .join("lucida_usage.sqlite")
}

pub fn usage_data_root() -> PathBuf {
    default_usage_db_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("output")
                .join("usage")
        })
}

pub fn usage_thumbnail_root() -> PathBuf {
    usage_data_root().join("thumbs")
}

pub fn normalize_instrumented_endpoint(method: &Method, path: &str) -> Option<String> {
    match (method.as_str(), path) {
        ("POST", "/session/create") => Some("/session/create".to_owned()),
        ("POST", "/dataset/open") => Some("/dataset/open".to_owned()),
        ("POST", "/view/create") => Some("/view/create".to_owned()),
        ("POST", "/view/update") => Some("/view/update".to_owned()),
        ("POST", "/export/viewstate") => Some("/export/viewstate".to_owned()),
        ("POST", "/import/viewstate") => Some("/import/viewstate".to_owned()),
        ("POST", "/render/image") => Some("/render/image".to_owned()),
        ("GET", path) if path.starts_with("/view/") => Some("/view/{view_id}".to_owned()),
        _ => None,
    }
}

pub fn extract_agent_context(headers: &HeaderMap) -> AgentContext {
    AgentContext {
        agent_run_id: header_value(headers, AGENT_RUN_HEADER),
        agent_step_id: header_value(headers, AGENT_STEP_HEADER),
        agent_name: header_value(headers, AGENT_NAME_HEADER),
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|value| {
        value.to_str().ok().and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        })
    })
}

#[derive(Debug, Clone, Default)]
struct UsageIdentifiers {
    session_id: Option<String>,
    dataset_id: Option<String>,
    view_id: Option<String>,
    render_id: Option<String>,
    request_id: Option<String>,
    state_hash: Option<String>,
    state_version: Option<u64>,
}

impl UsageIdentifiers {
    fn from_payloads(request_json: Option<&Value>, response_json: Option<&Value>) -> Self {
        let req = request_json.unwrap_or(&Value::Null);
        let resp = response_json.unwrap_or(&Value::Null);

        Self {
            session_id: first_some(vec![
                value_string(req, &["session_id"]),
                value_string(req, &["view_state", "session_id"]),
                value_string(resp, &["session_id"]),
                value_string(resp, &["view_state", "session_id"]),
            ]),
            dataset_id: first_some(vec![
                value_string(req, &["dataset_id"]),
                value_string(req, &["view_state", "datasets", "0", "dataset_id"]),
                value_string(resp, &["dataset_summary", "dataset_id"]),
                value_string(resp, &["meta", "dataset_id"]),
                value_string(resp, &["view_state", "datasets", "0", "dataset_id"]),
            ]),
            view_id: first_some(vec![
                value_string(req, &["view_id"]),
                value_string(req, &["view_state", "view_id"]),
                value_string(resp, &["view_id"]),
                value_string(resp, &["view_state", "view_id"]),
                value_string(resp, &["source_view_id"]),
            ]),
            render_id: value_string(resp, &["render_id"]),
            request_id: first_some(vec![
                value_string(req, &["request_id"]),
                value_string(resp, &["request_id"]),
            ]),
            state_hash: first_some(vec![
                value_string(resp, &["state_hash"]),
                value_string(resp, &["view_state", "state_hash"]),
            ]),
            state_version: first_some(vec![
                value_u64(resp, &["state_version"]),
                value_u64(resp, &["view_state", "state_version"]),
            ]),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct UsageErrorInfo {
    code: Option<String>,
    message: Option<String>,
}

impl UsageErrorInfo {
    fn from_response(response_json: Option<&Value>, status_code: u16) -> Self {
        if status_code < 400 {
            return Self::default();
        }
        let payload = response_json.unwrap_or(&Value::Null);
        Self {
            code: value_string(payload, &["code"]),
            message: value_string(payload, &["message"]),
        }
    }
}

fn first_some<T>(values: Vec<Option<T>>) -> Option<T> {
    values.into_iter().flatten().next()
}

fn value_string(value: &Value, path: &[&str]) -> Option<String> {
    value_at_path(value, path).and_then(|candidate| match candidate {
        Value::String(text) if !text.trim().is_empty() => Some(text.to_owned()),
        _ => None,
    })
}

fn value_u64(value: &Value, path: &[&str]) -> Option<u64> {
    value_at_path(value, path).and_then(|candidate| {
        candidate.as_u64().or_else(|| {
            candidate
                .as_i64()
                .and_then(|number| (number >= 0).then_some(number as u64))
        })
    })
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cursor = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            let array = cursor.as_array()?;
            cursor = array.get(index)?;
        } else {
            let object = cursor.as_object()?;
            cursor = object.get(*segment)?;
        }
    }
    Some(cursor)
}

fn percentile(sorted_values: &[f64], percentile: f64) -> Option<f64> {
    if sorted_values.is_empty() {
        return None;
    }
    let clamped = percentile.clamp(0.0, 100.0);
    let position = ((clamped / 100.0) * ((sorted_values.len() - 1) as f64)).round() as usize;
    sorted_values.get(position).copied()
}

pub fn invalid_usage_query_error(field: &str, message: &str) -> crate::error::ApiError {
    crate::error::ApiError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_usage_query",
        "Usage query validation failed.",
        Some(json!({
            "field": field,
            "message": message,
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn prune_batch_size_scales_with_max_events() {
        let tiny = new_test_usage(3);
        assert_eq!(tiny.prune_insert_batch_size(), 1);

        let medium = new_test_usage(10_000);
        assert_eq!(medium.prune_insert_batch_size(), 100);

        let huge = new_test_usage(1_000_000);
        assert_eq!(huge.prune_insert_batch_size(), PRUNE_BATCH_MAX_INSERTS);
    }

    #[test]
    fn insert_prune_runs_in_batches() {
        let usage = new_test_usage(1_000);
        assert_eq!(usage.prune_insert_batch_size(), 10);

        for step in 0..9 {
            usage
                .record_http_event(test_event(step))
                .expect("record usage event");
            assert_eq!(
                usage.inserts_since_prune.load(Ordering::Acquire),
                (step + 1) as usize
            );
        }

        usage
            .record_http_event(test_event(9))
            .expect("record usage event");
        assert_eq!(usage.inserts_since_prune.load(Ordering::Acquire), 0);
        assert_eq!(stored_event_count(&usage), 10);
    }

    #[test]
    fn insert_prune_runs_when_interval_elapses() {
        let usage = new_test_usage(50_000);
        {
            let mut last_prune_at = usage.last_prune_at.lock().expect("lock prune schedule");
            *last_prune_at = Instant::now() - StdDuration::from_secs(PRUNE_INTERVAL_SECONDS + 1);
        }
        usage
            .record_http_event(test_event(0))
            .expect("record usage event");
        assert_eq!(usage.inserts_since_prune.load(Ordering::Acquire), 0);
    }

    fn new_test_usage(max_events: i64) -> SharedUsageTelemetry {
        let root = std::env::temp_dir()
            .join("lucida-usage-unit-tests")
            .join(Uuid::new_v4().simple().to_string());
        fs::create_dir_all(&root).expect("create test directory");
        let config = UsageConfig {
            db_path: root.join("usage.sqlite"),
            retention_days: 14,
            max_events,
            max_db_bytes: DEFAULT_MAX_DB_BYTES,
        };
        new_shared_usage_telemetry_with_config(config).expect("initialize usage telemetry")
    }

    fn test_event(step: usize) -> UsageEventInsert {
        UsageEventInsert {
            endpoint: "/session/create".to_owned(),
            method: "POST".to_owned(),
            status_code: 200,
            latency_ms: 10.0 + step as f64,
            agent_context: AgentContext {
                agent_run_id: Some(format!("run-{step}")),
                agent_step_id: Some(format!("step-{step}")),
                agent_name: Some("unit-test".to_owned()),
            },
            request_json: Some(json!({
                "schema_version": 1,
                "request_id": format!("request-{step}"),
            })),
            response_json: Some(json!({
                "session_id": format!("session-{step}"),
            })),
        }
    }

    fn stored_event_count(usage: &SharedUsageTelemetry) -> i64 {
        let conn = usage.conn.lock().expect("lock usage db connection");
        conn.query_row("SELECT COUNT(*) FROM usage_events", [], |row| row.get(0))
            .expect("count usage events")
    }
}
