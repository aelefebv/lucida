/**
 * The watch stream: what the page pushes over the session socket while
 * somebody has turned its watch toggle on (#1068, ADR 0051 as amended).
 *
 * An agent cannot open the reporter's tab, and a session that never settles
 * never produces a run file to send. So a person turns this on and the page
 * publishes what a live surface would draw — the per-tick aggregate, the
 * boundaries of the runs it opens and closes, and a provisional reading on a
 * fixed interval. The server relays it to CLI subscribers and keeps a small
 * ring for late joiners; `lucida trace watch` prints one JSON object per
 * line.
 *
 * Rows never leave. There is no item kind a lifecycle row could ride in, so
 * what travels is bounded by the publish cadence and the dataset count and
 * never by the chunk count: following a stalled session costs a few hundred
 * bytes per tick rather than the run.
 *
 * Nothing here starts itself. Off by default, off again after a reconnect
 * (the socket that carried a stream is not the one that resumes it), and off
 * when the page goes away.
 *
 * It samples rather than drains. Every read behind it is one of the
 * recorder's live reads, so publishing closes no run and walks no row, and an
 * aggregate carries what happened since the previous one rather than the
 * ring. A stretch shorter than the cadence lands on the next aggregate or, at
 * a run's end, on none. The trace still holds every tick for whoever exports
 * it.
 *
 * The stream's own frames go through the bridge like any other message, so
 * the trace's send accounting counts them under `other`. Watching a session
 * is traffic, and the number that names the page's traffic says so rather
 * than hiding its own.
 */

import type { RunBoundary, WatchCursor, WatchSample } from "./liveProgress.ts";
import type { ProvisionalReading } from "./diagnose/provisional.ts";
import { traceRecorder, type TraceRecorder } from "./recorder.ts";
import {
  CLIENT_MESSAGE_TYPES,
  COUNTED_PHASES,
  type CountedPhase,
  type EndReason,
  type RunCause,
  type SendTallies,
  type TraceReading,
  type TraceTick,
} from "./types.ts";

/**
 * What a boundary item marks. The stream's own edges sit beside the runs'
 * so that a reader can tell a quiet page from a lost socket: a stream always
 * opens with `watch_started`, and silence after it is a page with nothing to
 * report.
 */
export type WatchBoundaryEvent = "watch_started" | "watch_stopped" | "run_opened" | "run_closed";

/**
 * One item of the stream. Three kinds, and none of them is a lifecycle row.
 *
 * The item's own fields are the protocol's snake_case; the trace's objects
 * inside them — the reading, the ticks, the cause, the provisional reading —
 * keep the trace's camelCase and are passed through unchanged, so what a
 * watcher prints for a tick is what the trace document holds for it. The
 * Rust mirror of these types is `lucida_core::protocol::WatchItem`, and the
 * wire fixtures lock the two together.
 */
export type WatchItem = WatchAggregateItem | WatchBoundaryItem | WatchProvisionalItem;

export interface WatchAggregateItem {
  kind: "aggregate";
  /** Wall clock at publish, so a reader can place an item the ring replayed. */
  at_epoch_ms: number;
  /** The labelled run open at the sample, or null in the steady state between runs. */
  run_id: string | null;
  /** The newest reading taken since the previous aggregate, or null when the page did not tick. */
  reading: TraceReading | null;
  /** The counted-not-timed phases over the stretch, process-wide. */
  counted: Record<CountedPhase, number>;
  /** What the page sent over the session socket during the stretch, by message type. */
  sent: SendTallies;
  /** At most one per dataset: the newest planning sample since the previous aggregate. */
  ticks: WatchTickSample[];
}

/**
 * A dataset's planning state at one pass. The trace's tick sample without the
 * two process-wide deltas, which are summed onto the aggregate instead.
 */
export type WatchTickSample = Omit<TraceTick, "counted" | "sent">;

export interface WatchBoundaryItem {
  kind: "boundary";
  at_epoch_ms: number;
  event: WatchBoundaryEvent;
  run_id: string | null;
  /** Why the run opened, carried on the closing edge too: a late joiner may have missed the open. */
  cause: RunCause | null;
  end_reason: EndReason | null;
  duration_us: number | null;
}

export interface WatchProvisionalItem {
  kind: "provisional";
  at_epoch_ms: number;
  /**
   * Labelled provisional inside, as everywhere. Never a verdict, and no gate
   * reads it. Named in full because the glossary reserves a bare "reading"
   * for the counter-track sample the aggregate carries.
   */
  provisional_reading: ProvisionalReading;
}

/**
 * How often an aggregate goes out. Four a second: fast enough that a reader
 * watching a stall sees the counts move, slow enough that the stream is a
 * sample of the tick cadence rather than a copy of it — a busy pan plans far
 * more often than this, and one aggregate per planning pass would put the
 * page's own tick rate on the wire.
 */
export const WATCH_AGGREGATE_MS = 250;

/**
 * How often a provisional reading goes out. Slower than the aggregates
 * because it is a statement rather than a sample, and a statement that
 * changes four times a second is not one a reader can act on.
 */
export const WATCH_PROVISIONAL_MS = 2_000;

/** Where the stream's frames go. The bridge, in the product; a spy, in a test. */
export interface WatchTransport {
  send(json: string): void;
}

/** What a surface showing the toggle has to render. */
export interface WatchStreamState {
  /** Publishing right now. A surface has to show this while it is true. */
  on: boolean;
  /** There is a socket to publish over. False between a disconnect and the reconnect. */
  attached: boolean;
}

export interface WatchStreamOptions {
  recorder?: TraceRecorder;
  /** Wall clock for the items' `at_epoch_ms`. */
  now?: () => number;
  aggregateMs?: number;
  provisionalMs?: number;
  /** How far back a provisional reading looks. The derivation's default when absent. */
  provisionalWindowMs?: number;
}

/**
 * One aggregate from one sample: the process-wide totals for the stretch, the
 * newest reading, and the newest planning sample for each dataset that
 * planned.
 *
 * Reducing per dataset keeps an item's size set by how many datasets planned
 * rather than by how often they did. The split below is what makes that
 * lossless. A dataset's counters describe one planning pass, so the newest
 * pass supersedes the ones before it, while the counted phases and the send
 * tallies describe what happened *between* passes: dropping a sample would
 * drop its bytes. Those two are summed over the stretch instead, and they
 * belong to the page rather than to whichever dataset's sample carried them.
 */
export function aggregateItem(
  atEpochMs: number,
  runId: string | null,
  reading: TraceReading | null,
  ticks: TraceTick[],
): WatchAggregateItem {
  const newest = new Map<string, WatchTickSample>();
  const counted = zeroCounted();
  const sent = zeroSendTallies();
  for (const tick of ticks) {
    const { counted: tickCounted, sent: tickSent, ...sample } = tick;
    newest.set(sample.datasetId, sample);
    for (const phase of COUNTED_PHASES) counted[phase] += tickCounted[phase];
    for (const type of CLIENT_MESSAGE_TYPES) {
      sent[type].messages += tickSent[type].messages;
      sent[type].bytes += tickSent[type].bytes;
    }
  }
  return {
    kind: "aggregate",
    at_epoch_ms: atEpochMs,
    run_id: runId,
    reading,
    counted,
    sent,
    ticks: [...newest.values()],
  };
}

function zeroCounted(): Record<CountedPhase, number> {
  const out = {} as Record<CountedPhase, number>;
  for (const phase of COUNTED_PHASES) out[phase] = 0;
  return out;
}

function zeroSendTallies(): SendTallies {
  const out = {} as SendTallies;
  for (const type of CLIENT_MESSAGE_TYPES) out[type] = { messages: 0, bytes: 0 };
  return out;
}

/** One run's edge, as the recorder announced it. */
export function runBoundaryItem(atEpochMs: number, boundary: RunBoundary): WatchBoundaryItem {
  return {
    kind: "boundary",
    at_epoch_ms: atEpochMs,
    event: boundary.endReason === null ? "run_opened" : "run_closed",
    run_id: boundary.runId,
    cause: boundary.cause,
    end_reason: boundary.endReason,
    duration_us: boundary.durationUs,
  };
}

/**
 * The stream's own edge. It names the run open at that moment, so a reader
 * that joined mid-run knows which run the aggregates that follow belong to.
 */
export function streamBoundaryItem(
  atEpochMs: number,
  event: "watch_started" | "watch_stopped",
  run: { runId: string; cause: RunCause } | null,
): WatchBoundaryItem {
  return {
    kind: "boundary",
    at_epoch_ms: atEpochMs,
    event,
    run_id: run?.runId ?? null,
    cause: run?.cause ?? null,
    end_reason: null,
    duration_us: null,
  };
}

export function provisionalItem(
  atEpochMs: number,
  reading: ProvisionalReading,
): WatchProvisionalItem {
  return { kind: "provisional", at_epoch_ms: atEpochMs, provisional_reading: reading };
}

/**
 * Where a sample leaves the next one to start: the newest offset it carried,
 * or where the previous cursor already stood when it carried nothing.
 *
 * The newest offset published, not the instant of publishing. A sample reads
 * strictly past its cursor, so a tick stamped at the sample's own offset
 * would fall in neither aggregate if the cursor were that instant.
 */
function cursorAfter(sample: WatchSample, previous: WatchCursor | null): WatchCursor {
  const carried = Math.max(
    sample.reading?.atUs ?? -1,
    sample.ticks.at(-1)?.atUs ?? -1,
    // A cursor from a previous interval says nothing about this one, so the
    // sample's own instant stands in.
    previous?.intervalId === sample.intervalId ? previous.atUs : sample.atUs,
  );
  return { intervalId: sample.intervalId, atUs: carried };
}

/**
 * The page's end of the watch stream: the toggle, the cadence, and the
 * publishing.
 *
 * One instance per page ({@link watchStream}), because the toggle is
 * per session and the socket is too. It owns no UI and reads no DOM: a
 * surface flips it and renders {@link on}, and everything else here is the
 * recorder and the transport.
 */
export class WatchStream {
  private readonly recorder: TraceRecorder;
  private readonly now: () => number;
  private readonly aggregateMs: number;
  private readonly provisionalMs: number;
  private readonly provisionalWindowMs: number | undefined;

  private transport: WatchTransport | null = null;
  private streaming = false;
  private cursor: WatchCursor | null = null;
  private aggregateTimer: ReturnType<typeof setInterval> | null = null;
  private provisionalTimer: ReturnType<typeof setInterval> | null = null;
  private stopListening: (() => void) | null = null;
  private snapshot: WatchStreamState = { on: false, attached: false };
  private readonly listeners = new Set<(state: WatchStreamState) => void>();

  constructor(options: WatchStreamOptions = {}) {
    this.recorder = options.recorder ?? traceRecorder;
    this.now = options.now ?? (() => Date.now());
    this.aggregateMs = options.aggregateMs ?? WATCH_AGGREGATE_MS;
    this.provisionalMs = options.provisionalMs ?? WATCH_PROVISIONAL_MS;
    this.provisionalWindowMs = options.provisionalWindowMs;
  }

  /** Whether the stream is publishing right now. */
  get on(): boolean {
    return this.streaming;
  }

  /**
   * The toggle and the socket behind it, as a surface has to render them.
   *
   * The same object until something changes, so a subscriber can compare
   * snapshots by identity rather than by field.
   */
  get state(): WatchStreamState {
    return this.snapshot;
  }

  /**
   * Watch the toggle, for a surface that has to show it while it is on.
   * Every attach and detach reports too, so a control can offer itself when
   * there is a socket and say so when there is not.
   */
  subscribe(listener: (state: WatchStreamState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Take the connection the stream would publish over, and turn the toggle
   * off.
   *
   * Off on every attach, which is what makes it off after a reconnect: the
   * server saw the old connection close and forgot the publisher behind it,
   * and a stream that resumed itself on a new socket would be a page pushing
   * without anyone having asked on that socket.
   */
  attach(transport: WatchTransport): void {
    this.teardown();
    this.transport = transport;
    this.streaming = false;
    this.notify();
  }

  /** The connection went away. The toggle goes off with it, silently: the socket that would carry a `watch_stopped` is the one that dropped. */
  detach(): void {
    this.teardown();
    this.transport = null;
    this.streaming = false;
    this.notify();
  }

  /**
   * Turn the stream on. A no-op with no connection to publish over, and a
   * no-op while it is already on.
   */
  start(): void {
    if (this.streaming || !this.transport) return;
    // Where the stream begins. Taken now rather than at the first aggregate,
    // so the first one covers the cadence that just elapsed instead of
    // silently dropping it — and so nothing recorded before anyone asked to
    // watch is replayed into it.
    const opening = this.recorder.watchSample(null);
    this.cursor = opening ? cursorAfter(opening, null) : null;
    this.publish(streamBoundaryItem(this.now(), "watch_started", this.openRun()));
    this.stopListening = this.recorder.onRunBoundary((boundary) => {
      this.publish(runBoundaryItem(this.now(), boundary));
    });
    this.aggregateTimer = setInterval(() => this.publishAggregate(), this.aggregateMs);
    this.provisionalTimer = setInterval(() => this.publishProvisional(), this.provisionalMs);
    this.streaming = true;
    this.notify();
  }

  /** Turn the stream off, telling its readers so before the frames stop. */
  stop(): void {
    if (!this.streaming) return;
    this.publish(streamBoundaryItem(this.now(), "watch_stopped", this.openRun()));
    this.teardown();
    this.streaming = false;
    this.notify();
  }

  /**
   * One aggregate, when there is something to say. Four empty frames a second
   * would be a stream of the instrument's own traffic, so silence between a
   * `watch_started` and a `watch_stopped` means a page with nothing to report.
   */
  private publishAggregate(): void {
    const sample = this.recorder.watchSample(this.cursor);
    if (!sample) return;
    this.cursor = cursorAfter(sample, this.cursor);
    if (!sample.reading && sample.ticks.length === 0) return;
    this.publish(aggregateItem(this.now(), sample.runId, sample.reading, sample.ticks));
  }

  /** One provisional reading, when a labelled run is open to read. */
  private publishProvisional(): void {
    const reading = this.recorder.provisionalReading(
      this.provisionalWindowMs === undefined ? {} : { windowMs: this.provisionalWindowMs },
    );
    if (!reading) return;
    this.publish(provisionalItem(this.now(), reading));
  }

  private openRun(): { runId: string; cause: RunCause } | null {
    const progress = this.recorder.liveProgress;
    return progress ? { runId: progress.runId, cause: progress.cause } : null;
  }

  private publish(item: WatchItem): void {
    this.transport?.send(JSON.stringify({ type: "watch_publish", item }));
  }

  /** Stop publishing without saying anything. The callers decide what to say. */
  private teardown(): void {
    this.cursor = null;
    if (this.aggregateTimer !== null) clearInterval(this.aggregateTimer);
    if (this.provisionalTimer !== null) clearInterval(this.provisionalTimer);
    this.aggregateTimer = null;
    this.provisionalTimer = null;
    this.stopListening?.();
    this.stopListening = null;
  }

  private notify(): void {
    this.snapshot = { on: this.streaming, attached: this.transport !== null };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/**
 * The page's watch stream. One per page because the toggle is per session,
 * reached by the surface that shows the toggle and by the session controller
 * that hands it a socket.
 */
export const watchStream = new WatchStream();
