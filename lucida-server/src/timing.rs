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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use lucida_protocol::{ServerTimingBatch, TimingRowFamily, TimingRowOutcome};
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

/// One served request, as the server saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServedRow {
    pub rid: u32,
    pub family: TimingRowFamily,
    /// Arrival → start of serve.
    pub dispatch_offset_us: u32,
    /// Start of serve → handoff to the outbound queue.
    pub duration_us: u32,
    pub outcome: TimingRowOutcome,
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
            family: Vec::with_capacity(rows.len()),
            dispatch_offset_us: Vec::with_capacity(rows.len()),
            duration_us: Vec::with_capacity(rows.len()),
            outcome: Vec::with_capacity(rows.len()),
        };
        for row in rows {
            batch.rid.push(row.rid);
            batch.family.push(row.family);
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
    buffer: std::sync::Arc<TimingBuffer>,
}

impl RequestProbe {
    /// Open the probe at the moment the serve begins; `arrival` is when the
    /// request was parsed off the socket.
    pub fn dispatched(
        rid: u32,
        family: TimingRowFamily,
        arrival: Instant,
        buffer: std::sync::Arc<TimingBuffer>,
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
            rid: self.rid,
            family: self.family,
            dispatch_offset_us: self.dispatch_offset_us,
            duration_us: micros(self.dispatched_at.elapsed()),
            outcome,
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
            rid,
            family: TimingRowFamily::Chunk,
            dispatch_offset_us: 10,
            duration_us: 20,
            outcome: TimingRowOutcome::Delivered,
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
