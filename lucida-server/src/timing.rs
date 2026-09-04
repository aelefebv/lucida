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

use lucida_protocol::{
    LABEL_NONE, MetadataReadPhase, PHASE_MAX_US, PHASE_UNSET, SERVER_PHASES, ServerPhase,
    ServerTimingBatch, TimingRowFamily, TimingRowOutcome,
};
use lucida_store::cache::SourceReadTiming;
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

/// One unit of served work, as the server saw it: how long it spent in each
/// [`ServerPhase`], plus how it ended.
///
/// Durations rather than absolute instants, all of them relative to this
/// request's own arrival. Phases the request never entered stay
/// [`PHASE_UNSET`], because a generated chunk that never touched the source
/// store and a source read that took no measurable time are different facts.
///
/// A chunk row and a metadata-read row are the same shape with different
/// slots filled. That is what a fixed-width row is for: the family says
/// which key and which columns to read, and a second table would buy
/// nothing but a second thing to route. A metadata read has no dispatch,
/// decompress or encode to fill the phase array with, so it leaves the
/// array unset and states its span in the two columns below instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedRow {
    pub key: RowKey,
    pub family: TimingRowFamily,
    pub outcome: TimingRowOutcome,
    /// One slot per phase, indexed by [`ServerPhase`]'s discriminant. Unset
    /// throughout on a metadata-read row.
    pub phases: [u32; SERVER_PHASES.len()],
    /// The bytes this request's own backend round trips returned; `None`
    /// when it performed none. Travels with [`ServerPhase::BackendRead`] and
    /// obeys the same rule: a follower's row carries neither.
    pub backend_bytes: Option<u32>,
    /// The label of the read this request waited on, for a single-flight
    /// follower; [`LABEL_NONE`] otherwise.
    pub coalesced_onto: u32,
    /// The open's arrival → the start of this read, on a metadata-read row
    /// and zero elsewhere. Its own column because the phase array holds
    /// durations and this is a position: it is what lets the exporter lay
    /// hundreds of reads out across the open rather than stacking them at
    /// its midpoint.
    pub dispatch_offset_us: u32,
    /// The read itself on a metadata-read row — the round trip, the wait on
    /// a leader, or the local lookup — and zero elsewhere.
    pub duration_us: u32,
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

/// A phase's slot in a row. The enum's discriminant *is* the index, so this
/// is a cast rather than a lookup — recording a phase sits under ADR 0049's
/// marginal-cost ceiling and has no business searching a table.
fn phase_index(phase: ServerPhase) -> usize {
    phase as usize
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
            ..ServerTimingBatch::default()
        };
        for phase in SERVER_PHASES {
            batch.column_mut(phase).reserve(rows.len());
        }
        batch.backend_bytes.reserve(rows.len());
        batch.coalesced_onto.reserve(rows.len());
        for row in rows {
            batch.rid.push(row.rid());
            batch.request_id.push(row.request_id());
            batch.family.push(row.family);
            batch.metadata_phase.push(row.metadata_phase);
            batch.dispatch_offset_us.push(row.dispatch_offset_us);
            batch.duration_us.push(row.duration_us);
            batch.outcome.push(row.outcome);
            batch.backend_bytes.push(row.backend_bytes);
            batch.coalesced_onto.push(row.coalesced_onto);
            for (slot, phase) in row.phases.iter().zip(SERVER_PHASES) {
                batch.column_mut(phase).push(*slot);
            }
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

/// Times one served request phase by phase, from the instant its frame came
/// off the socket, and files the row via [`RequestProbe::finish`] — which
/// every exit path calls, so an outcome is stated rather than inferred from
/// a missing row.
///
/// A cursor, not a set of stopwatches: [`mark`](Self::mark) closes whatever
/// has elapsed since the previous boundary and files it under the named
/// phase. Phases are contiguous by construction, so nothing between two
/// marks can go unattributed, and a serve that exits early simply leaves the
/// phases it never reached unset.
pub struct RequestProbe {
    rid: u32,
    family: TimingRowFamily,
    /// Start of the phase currently being timed.
    cursor: Instant,
    phases: [u32; SERVER_PHASES.len()],
    backend_bytes: Option<u32>,
    coalesced_onto: u32,
    buffer: Arc<TimingBuffer>,
}

impl RequestProbe {
    /// Open the probe at `arrival` — the instant the frame came off the
    /// socket, before it was parsed or routed.
    pub fn arrived(
        rid: u32,
        family: TimingRowFamily,
        arrival: Instant,
        buffer: Arc<TimingBuffer>,
    ) -> Self {
        Self {
            rid,
            family,
            cursor: arrival,
            phases: [PHASE_UNSET; SERVER_PHASES.len()],
            backend_bytes: None,
            coalesced_onto: LABEL_NONE,
            buffer,
        }
    }

    pub fn rid(&self) -> u32 {
        self.rid
    }

    /// Close the phase that has been running and record it as `phase`. The
    /// next phase starts here.
    pub fn mark(&mut self, phase: ServerPhase) {
        let now = Instant::now();
        self.phases[phase_index(phase)] = micros(now.saturating_duration_since(self.cursor));
        self.cursor = now;
    }

    /// Close the read: the waits the store measured, and — as
    /// [`ServerPhase::CacheLookup`] — whatever else the read spent inside the
    /// cache.
    ///
    /// The store measures the waits itself because only it knows which side
    /// of the single flight this request landed on, and that distinction is
    /// what keeps a sum over the read column equal to the number of round
    /// trips actually made (ADR 0050). Everything else the call took — the
    /// LRU probe, the single-flight election, the insert and its evictions —
    /// is the remainder, and it goes to `cache-lookup` rather than nowhere.
    /// Dropping it would leave server time inside the browser's bracket with
    /// no phase against it, and the exporter would read that silence as
    /// network.
    pub fn record_read(&mut self, timing: SourceReadTiming) {
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.cursor).as_micros() as u64;
        for (phase, value) in [
            (ServerPhase::PermitWait, timing.permit_wait_us),
            (ServerPhase::BackendRead, timing.backend_read_us),
            (ServerPhase::CoalescedWait, timing.coalesced_wait_us),
        ] {
            if let Some(value) = value {
                self.phases[phase_index(phase)] = value;
            }
        }
        self.phases[phase_index(ServerPhase::CacheLookup)] =
            clamp_us(elapsed.saturating_sub(timing.measured_us()));
        self.backend_bytes = timing.backend_bytes;
        if let Some(leader) = timing.coalesced_onto {
            self.coalesced_onto = leader.0;
        }
        self.cursor = now;
    }

    /// File the row. Socket write time is excluded — it happens in a
    /// separate task behind an unbounded queue and is not observable from
    /// the serve path, which is why [`ServerPhase::Handoff`] is terminal.
    pub fn finish(self, outcome: TimingRowOutcome) {
        self.buffer.record(ServedRow {
            key: RowKey::Label(self.rid),
            family: self.family,
            outcome,
            phases: self.phases,
            backend_bytes: self.backend_bytes,
            coalesced_onto: self.coalesced_onto,
            // A chunk or asset row states its span in the phase array.
            dispatch_offset_us: 0,
            duration_us: 0,
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
            phases: [PHASE_UNSET; SERVER_PHASES.len()],
            // A metadata read is timed by the observer, which sees the
            // round trip and not its body.
            backend_bytes: None,
            coalesced_onto: LABEL_NONE,
            metadata_phase: Some(read.phase),
        });
    }
}

fn micros(d: Duration) -> u32 {
    clamp_us(u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
}

/// Clamp to [`PHASE_MAX_US`], never onto [`PHASE_UNSET`]: a phase that ran
/// for over 71 minutes must report as very long, not as never having
/// happened. Saturating onto the sentinel would blank out the worst stall in
/// the trace — the one row anybody opened the monitor for.
fn clamp_us(micros: u64) -> u32 {
    u32::try_from(micros)
        .unwrap_or(PHASE_MAX_US)
        .min(PHASE_MAX_US)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn row(rid: u32) -> ServedRow {
        let mut phases = [PHASE_UNSET; SERVER_PHASES.len()];
        phases[phase_index(ServerPhase::Arrival)] = 10;
        phases[phase_index(ServerPhase::Handoff)] = 20;
        ServedRow {
            key: RowKey::Label(rid),
            family: TimingRowFamily::Chunk,
            outcome: TimingRowOutcome::Delivered,
            phases,
            backend_bytes: None,
            coalesced_onto: LABEL_NONE,
            dispatch_offset_us: 0,
            duration_us: 0,
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
        // Every phase is a column of the same length, unset where the row
        // never entered it.
        for phase in SERVER_PHASES {
            assert_eq!(batch.column(phase).len(), 2, "{phase:?} column");
        }
        assert_eq!(batch.arrival_us, vec![10, 10]);
        assert_eq!(batch.handoff_us, vec![20, 20]);
        assert_eq!(batch.backend_read_us, vec![PHASE_UNSET, PHASE_UNSET]);

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
        let probe = RequestProbe::arrived(
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

    /// Phases are contiguous: each mark closes what has elapsed since the
    /// previous one, so no time between two boundaries goes unattributed.
    #[test]
    fn marks_close_contiguous_phases_and_leave_the_rest_unset() {
        let buffer = Arc::new(TimingBuffer::new());
        let arrival = Instant::now();
        let mut probe =
            RequestProbe::arrived(1, TimingRowFamily::Chunk, arrival, Arc::clone(&buffer));

        std::thread::sleep(Duration::from_millis(2));
        probe.mark(ServerPhase::Arrival);
        std::thread::sleep(Duration::from_millis(2));
        probe.mark(ServerPhase::BindingLookup);
        let total_before_finish = arrival.elapsed();
        probe.finish(TimingRowOutcome::Delivered);

        let batch = buffer.take_batch().expect("a row");
        assert!(batch.arrival_us[0] >= 2_000);
        assert!(batch.binding_lookup_us[0] >= 2_000);
        assert!(
            batch.arrival_us[0] + batch.binding_lookup_us[0]
                <= total_before_finish.as_micros() as u32,
            "marked phases must not overlap"
        );
        // The serve never got as far as a read, and says so rather than
        // reporting an instant one.
        assert_eq!(batch.cache_lookup_us, vec![PHASE_UNSET]);
        assert_eq!(batch.permit_wait_us, vec![PHASE_UNSET]);
        assert_eq!(batch.handoff_us, vec![PHASE_UNSET]);
    }

    /// A leader's row owns the permit wait and the round trip; a follower's
    /// owns neither. Reading a follower's wait as a backend read is the
    /// mis-diagnosis this split exists to prevent.
    #[test]
    fn a_read_lands_on_the_phases_the_store_measured() {
        let buffer = Arc::new(TimingBuffer::new());

        let mut leader =
            RequestProbe::arrived(1, TimingRowFamily::Chunk, Instant::now(), buffer.clone());
        leader.record_read(SourceReadTiming {
            permit_wait_us: Some(3_100_000),
            backend_read_us: Some(120_000),
            backend_bytes: Some(131_072),
            ..SourceReadTiming::default()
        });
        leader.finish(TimingRowOutcome::Delivered);

        let mut follower =
            RequestProbe::arrived(2, TimingRowFamily::Chunk, Instant::now(), buffer.clone());
        follower.record_read(SourceReadTiming {
            coalesced_wait_us: Some(400_000),
            coalesced_onto: Some(lucida_store::source_limiter::RequestLabel(1)),
            ..SourceReadTiming::default()
        });
        follower.finish(TimingRowOutcome::Delivered);

        let batch = buffer.take_batch().expect("two rows");
        assert_eq!(batch.permit_wait_us, vec![3_100_000, PHASE_UNSET]);
        assert_eq!(batch.backend_read_us, vec![120_000, PHASE_UNSET]);
        // The bytes travel with the round trip they came from, so a sum
        // over the column is the bytes the backend moved and a follower
        // adds nothing to it.
        assert_eq!(batch.backend_bytes, vec![Some(131_072), None]);
        assert_eq!(batch.coalesced_wait_us, vec![PHASE_UNSET, 400_000]);
        // The follower says which read it waited on, so the join to the
        // leader's row is a plain equi-join and the coalescing count is a
        // group-by over this column.
        assert_eq!(batch.coalesced_onto, vec![LABEL_NONE, 1]);
    }

    /// Time inside the read that the store did not measure — the LRU probe,
    /// the election, the insert — lands on `cache-lookup` rather than
    /// vanishing. The exporter sums the phases and calls the remainder of
    /// the browser's bracket network, so server time with no phase against
    /// it would be read as network time.
    #[test]
    fn the_unmeasured_remainder_of_a_read_is_attributed_not_dropped() {
        let buffer = Arc::new(TimingBuffer::new());
        let mut probe =
            RequestProbe::arrived(1, TimingRowFamily::Chunk, Instant::now(), buffer.clone());
        probe.mark(ServerPhase::Dispatch);
        std::thread::sleep(Duration::from_millis(5));
        probe.record_read(SourceReadTiming {
            permit_wait_us: Some(1_000),
            backend_read_us: Some(1_000),
            ..SourceReadTiming::default()
        });
        probe.finish(TimingRowOutcome::Delivered);

        let batch = buffer.take_batch().expect("a row");
        // ~5 ms elapsed, 2 ms of it measured by the store: the remaining
        // ~3 ms is the cache's own work and is filed as such.
        assert!(
            batch.cache_lookup_us[0] >= 2_000,
            "the remainder was dropped: {} µs",
            batch.cache_lookup_us[0]
        );
    }

    /// A phase longer than the slot can hold must read as very long, not as
    /// never having happened — that row is the one the monitor was opened
    /// for.
    #[test]
    fn an_enormous_phase_saturates_below_the_unset_sentinel() {
        assert_eq!(clamp_us(u64::from(PHASE_UNSET)), PHASE_MAX_US);
        assert_eq!(clamp_us(u64::MAX), PHASE_MAX_US);
        assert_ne!(clamp_us(u64::MAX), PHASE_UNSET);
    }

    /// The client's own permit wait is reported; nothing about anyone else
    /// is. The batch carries durations and a label, and there is nowhere in
    /// it for queue depth, a peer's rate or a peer's dataset to appear.
    #[test]
    fn a_row_carries_its_own_wait_and_nothing_about_other_tenants() {
        let buffer = Arc::new(TimingBuffer::new());
        let mut probe =
            RequestProbe::arrived(5, TimingRowFamily::Chunk, Instant::now(), buffer.clone());
        probe.record_read(SourceReadTiming {
            permit_wait_us: Some(3_100_000),
            backend_read_us: Some(90_000),
            ..SourceReadTiming::default()
        });
        probe.finish(TimingRowOutcome::Delivered);

        let batch = buffer.take_batch().expect("a row");
        assert_eq!(batch.permit_wait_us, vec![3_100_000]);

        let json = serde_json::to_value(&batch).expect("the batch serialises");
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "arrival_us",
                // The bytes this client's own round trips moved. A size is
                // as much this client's number as a duration is, and it
                // says nothing about any other tenant's reads.
                "backend_bytes",
                "backend_read_us",
                "binding_lookup_us",
                "cache_lookup_us",
                "coalesced_onto",
                "coalesced_wait_us",
                "decompress_us",
                // The metadata-read family's own columns. A read's position
                // inside the open that asked for it, its duration, its phase
                // and that open's own identifier: all four are this client's
                // numbers about this client's open.
                "dispatch_offset_us",
                "dispatch_us",
                "dropped",
                "duration_us",
                "family",
                "handoff_us",
                "metadata_phase",
                "outcome",
                "permit_wait_us",
                "request_id",
                "rid",
                "slice_encode_us",
            ],
            "a new column here is a new thing a client learns about the server",
        );
    }
}
