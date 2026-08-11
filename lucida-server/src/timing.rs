//! The server's lifecycle table: one row per served request, buffered per
//! connection and pushed to the client that caused it (ADR 0050).
//!
//! There is no trace store here and no trace endpoint. The buffer holds one
//! flush window, never a session, and the rows only ever travel toward the
//! client whose requests produced them — so the server can be a source of
//! timing without becoming a place where recordings accumulate.
//!
//! Timing is relative to each request's own arrival. Nothing in this module
//! reads a wall clock: the browser stamps the send and the receipt of every
//! label on one clock, and the server's work is strictly nested inside that
//! bracket, so the server's clock never has to be trusted or synchronised.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lucida_protocol::{MetadataReadPhase, ServerTimingBatch, TimingRowFamily, TimingRowOutcome};
use lucida_store::metadata_reads::{MetadataRead, MetadataReadObserver};
use tokio::sync::Notify;

/// How often a connection's buffered rows are flushed to it.
///
/// Derived, not chosen: the server completes reads at roughly 82/s remote
/// and 894/s local, so a 250 ms window is ~20 rows remote and ~220 local —
/// a few kB of columnar JSON, four messages a second, noise beside the chunk
/// payload. The thing being watched is seconds-scale, so the live view lags
/// by a small fraction of the bar being read.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

/// Flush early once this many rows are buffered. A burst guard, not the
/// governor: it only fires above ~2,000 rows/s, which is above any rate
/// measured on this pipeline.
pub const EARLY_FLUSH_ROWS: usize = 512;

/// The pre-flush buffer holds two flush windows and then stops accumulating.
/// Dropping and counting is the only honest bounded answer — a monitor that
/// blocks the pipeline it measures is worse than one that admits a gap.
pub const BUFFER_CAP_ROWS: usize = EARLY_FLUSH_ROWS * 2;

/// Which of the trace's two join paths a row keys on (ADR 0048).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowKey {
    /// A correlation label, minted per connection by the browser. Chunk and
    /// asset rows.
    Label(u32),
    /// A dataset-open `request_id`. Every metadata read under one open
    /// shares it, so it is refcounted rather than copied per row — an open
    /// files hundreds.
    Open(Arc<str>),
}

/// One unit of served work, as the server saw it.
///
/// A chunk row and a metadata-read row are the same shape with different
/// slots filled. That is what a fixed-width row is for: the family says
/// which key and which columns to read, and a second table would buy
/// nothing but a second thing to route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedRow {
    pub key: RowKey,
    pub family: TimingRowFamily,
    /// Arrival → start of serve. On a metadata read, the open's arrival →
    /// the start of that read.
    pub dispatch_offset_us: u32,
    /// Start of serve → handoff to the outbound queue. On a metadata read,
    /// the read itself: the round trip, the wait on a leader, or the local
    /// lookup.
    pub duration_us: u32,
    pub outcome: TimingRowOutcome,
    /// Set on metadata-read rows and nowhere else.
    pub metadata_phase: Option<MetadataReadPhase>,
}

impl ServedRow {
    fn rid(&self) -> u32 {
        match &self.key {
            RowKey::Label(rid) => *rid,
            RowKey::Open(_) => 0,
        }
    }

    fn request_id(&self) -> Option<String> {
        match &self.key {
            RowKey::Label(_) => None,
            RowKey::Open(id) => Some(id.to_string()),
        }
    }
}

#[derive(Default)]
struct BufferState {
    rows: Vec<ServedRow>,
    dropped: u32,
}

/// A connection's row buffer. Created per connection in the handler and
/// shared with the tasks serving that connection's requests, which is what
/// makes "a client receives only rows keyed to itself" structural rather
/// than a filter someone has to remember to apply.
pub struct TimingBuffer {
    state: Mutex<BufferState>,
    flush_now: Notify,
}

impl Default for TimingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl TimingBuffer {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BufferState {
                rows: Vec::with_capacity(EARLY_FLUSH_ROWS),
                dropped: 0,
            }),
            flush_now: Notify::new(),
        }
    }

    /// Buffer a row, dropping and counting it when the buffer is full.
    pub fn record(&self, row: ServedRow) {
        let mut state = self.state.lock().expect("timing buffer poisoned");
        if state.rows.len() >= BUFFER_CAP_ROWS {
            state.dropped = state.dropped.saturating_add(1);
            return;
        }
        state.rows.push(row);
        if state.rows.len() >= EARLY_FLUSH_ROWS {
            self.flush_now.notify_one();
        }
    }

    /// Take everything buffered, as columns. `None` when there is nothing to
    /// say — an empty tick sends no message.
    pub fn take_batch(&self) -> Option<ServerTimingBatch> {
        let (rows, dropped) = {
            let mut state = self.state.lock().expect("timing buffer poisoned");
            if state.rows.is_empty() && state.dropped == 0 {
                return None;
            }
            (
                std::mem::take(&mut state.rows),
                std::mem::take(&mut state.dropped),
            )
        };

        let mut batch = ServerTimingBatch {
            dropped,
            rid: Vec::with_capacity(rows.len()),
            request_id: Vec::with_capacity(rows.len()),
            family: Vec::with_capacity(rows.len()),
            metadata_phase: Vec::with_capacity(rows.len()),
            dispatch_offset_us: Vec::with_capacity(rows.len()),
            duration_us: Vec::with_capacity(rows.len()),
            outcome: Vec::with_capacity(rows.len()),
        };
        for row in rows {
            batch.rid.push(row.rid());
            batch.request_id.push(row.request_id());
            batch.family.push(row.family);
            batch.metadata_phase.push(row.metadata_phase);
            batch.dispatch_offset_us.push(row.dispatch_offset_us);
            batch.duration_us.push(row.duration_us);
            batch.outcome.push(row.outcome);
        }
        Some(batch)
    }

    /// Resolves when a burst has filled the buffer past the early-flush
    /// threshold. The ticker subsumes every other reason to flush, so there
    /// is no quiescence rule.
    pub async fn wait_for_early_flush(&self) {
        self.flush_now.notified().await;
    }
}

/// Times one served request from its arrival and files the row on drop of
/// the serve — via [`RequestProbe::finish`], which every exit path calls, so
/// an outcome is stated rather than inferred from a missing row.
pub struct RequestProbe {
    rid: u32,
    family: TimingRowFamily,
    dispatch_offset_us: u32,
    dispatched_at: Instant,
    buffer: Arc<TimingBuffer>,
}

impl RequestProbe {
    /// Open the probe at the moment the serve begins; `arrival` is when the
    /// request was parsed off the socket.
    pub fn dispatched(
        rid: u32,
        family: TimingRowFamily,
        arrival: Instant,
        buffer: Arc<TimingBuffer>,
    ) -> Self {
        let dispatched_at = Instant::now();
        Self {
            rid,
            family,
            dispatch_offset_us: micros(dispatched_at.saturating_duration_since(arrival)),
            dispatched_at,
            buffer,
        }
    }

    pub fn rid(&self) -> u32 {
        self.rid
    }

    /// Close the row at handoff. Socket write time is excluded — it happens
    /// in a separate task behind an unbounded queue and is not observable
    /// from the serve path.
    pub fn finish(self, outcome: TimingRowOutcome) {
        self.buffer.record(ServedRow {
            key: RowKey::Label(self.rid),
            family: self.family,
            dispatch_offset_us: self.dispatch_offset_us,
            duration_us: micros(self.dispatched_at.elapsed()),
            outcome,
            metadata_phase: None,
        });
    }
}

/// Files one dataset open's metadata reads into the requesting connection's
/// buffer.
///
/// These rows are the largest thing the monitor would otherwise not see: a
/// cold remote open spends most of its time here, before the first chunk
/// exists, so without them a trace opens with several seconds of silence.
///
/// They ride the timing batch rather than the open's progress push, and
/// they ride it as reads happen rather than being attached to the terminal
/// message. Both are deliberate. `DatasetOpenStage` is documented in-code as
/// a stable user-facing vocabulary and coupling it to the trace schema is a
/// worse trade than one extra family; and attaching rows to the success
/// message would lose them on a *failed* open, which is precisely the open
/// whose timing someone needs (ADR 0050).
pub struct MetadataReadSink {
    request_id: Arc<str>,
    /// When the open began serving. Every row is an offset from here, which
    /// is what lets the exporter lay the reads out *inside* the open's
    /// bracket instead of stacking them all at its midpoint. A monotonic
    /// instant, never a wall clock: the offsets are durations, so the
    /// server's clock is still never compared with the browser's.
    opened_at: Instant,
    buffer: Arc<TimingBuffer>,
}

impl MetadataReadSink {
    pub fn new(request_id: &str, buffer: Arc<TimingBuffer>) -> Self {
        Self {
            request_id: Arc::from(request_id),
            opened_at: Instant::now(),
            buffer,
        }
    }
}

impl MetadataReadObserver for MetadataReadSink {
    fn record(&self, read: MetadataRead) {
        self.buffer.record(ServedRow {
            key: RowKey::Open(Arc::clone(&self.request_id)),
            family: TimingRowFamily::MetadataRead,
            dispatch_offset_us: micros(read.started.saturating_duration_since(self.opened_at)),
            duration_us: micros(read.duration),
            outcome: if read.failed {
                TimingRowOutcome::Failed
            } else {
                TimingRowOutcome::Delivered
            },
            metadata_phase: Some(read.phase),
        });
    }
}

fn micros(d: Duration) -> u32 {
    u32::try_from(d.as_micros()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn row(rid: u32) -> ServedRow {
        ServedRow {
            key: RowKey::Label(rid),
            family: TimingRowFamily::Chunk,
            dispatch_offset_us: 10,
            duration_us: 20,
            outcome: TimingRowOutcome::Delivered,
            metadata_phase: None,
        }
    }

    #[test]
    fn empty_buffer_produces_no_batch() {
        let buffer = TimingBuffer::new();
        assert!(buffer.take_batch().is_none());
    }

    #[test]
    fn rows_come_back_as_parallel_columns_and_the_buffer_empties() {
        let buffer = TimingBuffer::new();
        buffer.record(row(1));
        buffer.record(ServedRow {
            outcome: TimingRowOutcome::NotReady,
            family: TimingRowFamily::Asset,
            ..row(2)
        });

        let batch = buffer.take_batch().expect("rows were buffered");
        assert_eq!(batch.rid, vec![1, 2]);
        assert_eq!(
            batch.family,
            vec![TimingRowFamily::Chunk, TimingRowFamily::Asset]
        );
        assert_eq!(
            batch.outcome,
            vec![TimingRowOutcome::Delivered, TimingRowOutcome::NotReady]
        );
        assert_eq!(batch.dropped, 0);
        assert_eq!(batch.len(), 2);

        assert!(buffer.take_batch().is_none(), "a flush drains the buffer");
    }

    #[test]
    fn overflow_drops_and_counts_rather_than_growing() {
        let buffer = TimingBuffer::new();
        for i in 0..(BUFFER_CAP_ROWS + 7) {
            buffer.record(row(i as u32));
        }

        let batch = buffer.take_batch().expect("rows were buffered");
        assert_eq!(batch.len(), BUFFER_CAP_ROWS);
        assert_eq!(batch.dropped, 7, "the loss is declared, not absorbed");
    }

    #[test]
    fn a_dropped_count_alone_still_reports() {
        let buffer = TimingBuffer::new();
        for i in 0..(BUFFER_CAP_ROWS + 1) {
            buffer.record(row(i as u32));
        }
        buffer.take_batch().expect("first batch carries the rows");
        buffer.record(row(9_000));
        let batch = buffer.take_batch().expect("second batch");
        assert_eq!(batch.dropped, 0, "the drop count resets with the flush");
        assert_eq!(batch.rid, vec![9_000]);
    }

    #[tokio::test]
    async fn a_burst_past_the_threshold_wakes_the_flush() {
        let buffer = Arc::new(TimingBuffer::new());
        for i in 0..EARLY_FLUSH_ROWS {
            buffer.record(row(i as u32));
        }
        // `Notify` holds the permit, so the wake is not missed by a waiter
        // that arrives after the burst.
        tokio::time::timeout(Duration::from_millis(50), buffer.wait_for_early_flush())
            .await
            .expect("early flush should have been signalled");
    }

    #[tokio::test]
    async fn a_quiet_connection_never_wakes_the_flush() {
        let buffer = Arc::new(TimingBuffer::new());
        buffer.record(row(1));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), buffer.wait_for_early_flush())
                .await
                .is_err(),
            "a handful of rows waits for the ticker"
        );
    }

    #[test]
    fn an_open_s_metadata_reads_key_on_the_open_and_not_on_a_label() {
        let buffer = Arc::new(TimingBuffer::new());
        let sink = MetadataReadSink::new("web-open-4c1a", Arc::clone(&buffer));
        let started = Instant::now();

        sink.record(MetadataRead {
            phase: MetadataReadPhase::BackendRead,
            started,
            duration: Duration::from_millis(63),
            failed: false,
        });
        sink.record(MetadataRead {
            phase: MetadataReadPhase::CacheHit,
            started,
            duration: Duration::from_micros(2),
            failed: true,
        });

        let batch = buffer.take_batch().expect("the reads filed rows");
        assert_eq!(
            batch.request_id,
            vec![
                Some("web-open-4c1a".to_string()),
                Some("web-open-4c1a".to_string())
            ],
            "every read under one open shares the open's id",
        );
        assert_eq!(batch.rid, vec![0, 0], "a metadata row carries no label");
        assert_eq!(
            batch.family,
            vec![TimingRowFamily::MetadataRead; 2],
            "they ride the timing batch as their own family",
        );
        assert_eq!(
            batch.metadata_phase,
            vec![
                Some(MetadataReadPhase::BackendRead),
                Some(MetadataReadPhase::CacheHit)
            ],
        );
        assert_eq!(batch.duration_us[0], 63_000);
        assert_eq!(
            batch.outcome,
            vec![TimingRowOutcome::Delivered, TimingRowOutcome::Failed],
        );
    }

    #[test]
    fn a_metadata_row_offsets_from_the_open_so_the_reads_can_be_laid_out_in_it() {
        let buffer = Arc::new(TimingBuffer::new());
        let sink = MetadataReadSink::new("web-open-4c1a", Arc::clone(&buffer));
        let opened_at = Instant::now();

        sink.record(MetadataRead {
            phase: MetadataReadPhase::BackendRead,
            started: opened_at + Duration::from_millis(400),
            duration: Duration::from_millis(20),
            failed: false,
        });

        let batch = buffer.take_batch().expect("the read filed a row");
        // The sink stamped its own start a moment before `opened_at`, so the
        // offset is at least the 400 ms and not much more.
        assert!(
            (400_000..401_000).contains(&batch.dispatch_offset_us[0]),
            "offset was {}",
            batch.dispatch_offset_us[0],
        );
    }

    #[test]
    fn a_read_that_predates_its_sink_offsets_to_zero_rather_than_wrapping() {
        let buffer = Arc::new(TimingBuffer::new());
        let sink = MetadataReadSink::new("web-open-4c1a", Arc::clone(&buffer));

        sink.record(MetadataRead {
            phase: MetadataReadPhase::CacheHit,
            started: Instant::now() - Duration::from_secs(30),
            duration: Duration::from_micros(1),
            failed: false,
        });

        let batch = buffer.take_batch().expect("the read filed a row");
        assert_eq!(batch.dispatch_offset_us, vec![0]);
    }

    #[test]
    fn a_probe_files_exactly_one_row_with_its_outcome() {
        let buffer = Arc::new(TimingBuffer::new());
        let probe = RequestProbe::dispatched(
            77,
            TimingRowFamily::Chunk,
            Instant::now(),
            Arc::clone(&buffer),
        );
        assert_eq!(probe.rid(), 77);
        probe.finish(TimingRowOutcome::Failed);

        let batch = buffer.take_batch().expect("the probe filed a row");
        assert_eq!(batch.rid, vec![77]);
        assert_eq!(batch.outcome, vec![TimingRowOutcome::Failed]);
    }
}
