/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * The borrowed path. #887 chose Chrome Trace Event JSON as the export format
 * and ADR 0047 made it a *projection*: a lifecycle row fans out into its spans
 * only here, at serialisation. This is the only module that knows about spans.
 *
 * The emit shape below is not the obvious one, and the difference was measured
 * against ui.perfetto.dev rather than assumed:
 *
 *   Async events (`ph: "b"/"e"`, one id per chunk) are the natural fit for
 *   work that is not a call stack, and Perfetto *ingests* them correctly —
 *   13,842 slices, queryable, complete. But it renders them as one "Global
 *   Legacy Events" group per process, named after whichever slice arrived
 *   first, collapsed by default, and hundreds of rows deep with every phase
 *   interleaved. The phase is a slice name, so there is no lane to read.
 *
 *   One thread per phase plus `thread_name` metadata, with complete events
 *   (`ph: "X"`), renders as one named lane per phase with the counter tracks
 *   below it — i.e. the whole raw-span surface, for free. It is also smaller:
 *   2.4 MB against 3.9 MB, because a complete event is one object, not two.
 *
 * Thread here is a *display* lane, not a real thread. That is a lie the format
 * requires and it is worth paying: the alternative is a viewer nobody can read.
 */

import {
  BROWSER_PHASES,
  END_IN_FLIGHT,
  NO_STAMP,
  SERVER_PHASES,
  SERVER_STAMP_COUNT,
  type Trace,
} from "./traceModel.ts";

interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

const PID_BROWSER = 1;
const PID_SERVER = 2;
/** Lane tids start here; 0-9 are reserved for counters and point events. */
const LANE_TID_BASE = 10;
const META_TID = 5;
const POINT_TID = 6;

export function toChromeTrace(trace: Trace): TraceEvent[] {
  const events: TraceEvent[] = [];
  const { chunks, server, ticks, meta, points } = trace;

  events.push(
    named(PID_BROWSER, 0, "process_name", "browser"),
    named(PID_SERVER, 0, "process_name", "lucida-server"),
  );
  BROWSER_PHASES.forEach((p, i) =>
    events.push(named(PID_BROWSER, LANE_TID_BASE + i, "thread_name", p)),
  );
  SERVER_PHASES.forEach((p, i) =>
    events.push(named(PID_SERVER, LANE_TID_BASE + i, "thread_name", p)),
  );
  events.push(named(PID_SERVER, META_TID, "thread_name", "dataset-open"));
  events.push(named(PID_BROWSER, POINT_TID, "thread_name", "events"));

  for (let r = 0; r < chunks.n; r++) {
    const key = chunks.keys[chunks.keyId[r]];
    const lane = ["main", "minimap", "label"][chunks.lane[r]];
    const tier = chunks.tier[r] === 0 ? "detail" : "coarse";
    for (let p = 0; p < BROWSER_PHASES.length; p++) {
      const a = chunks.stamps[p * chunks.cap + r];
      const b = chunks.stamps[(p + 1) * chunks.cap + r];
      if (a === NO_STAMP) break;
      if (b === NO_STAMP) {
        // An unfinished phase only becomes a span if the row was in flight.
        // Emitting a span for a retired row would invent a stall in the
        // borrowed viewer that the native surface does not show.
        if (chunks.endReason[r] === END_IN_FLIGHT) {
          events.push({
            name: BROWSER_PHASES[p],
            cat: `chunk,${lane},${tier},unfinished`,
            ph: "X",
            ts: a,
            dur: Math.max(1, trace.header.durationUs - a),
            pid: PID_BROWSER,
            tid: LANE_TID_BASE + p,
            args: { key, lane, tier, unfinishedAtRunEnd: true },
          });
        }
        break;
      }
      events.push({
        name: BROWSER_PHASES[p],
        cat: `chunk,${lane},${tier}`,
        ph: "X",
        ts: a,
        dur: Math.max(1, b - a),
        pid: PID_BROWSER,
        tid: LANE_TID_BASE + p,
        args: {
          key,
          lane,
          tier,
          level: chunks.level[r],
          channel: chunks.channel[r],
          correlation:
            chunks.correlationId[r] === NO_STAMP
              ? null
              : chunks.correlationId[r],
        },
      });
    }
  }

  for (let r = 0; r < server.n; r++) {
    for (let p = 0; p < SERVER_STAMP_COUNT - 1; p++) {
      const a = server.stamps[p * server.cap + r];
      const b = server.stamps[(p + 1) * server.cap + r];
      if (a === NO_STAMP || b === NO_STAMP) break;
      events.push({
        name: SERVER_PHASES[p],
        cat: "serve",
        ph: "X",
        ts: a,
        dur: Math.max(1, b - a),
        pid: PID_SERVER,
        tid: LANE_TID_BASE + p,
        args: { bytes: server.bytes[r], correlation: server.correlationId[r] },
      });
    }
  }

  for (const m of meta) {
    events.push({
      name: m.path,
      cat: "dataset-open",
      ph: "X",
      ts: m.stamps[0],
      dur: Math.max(1, m.stamps[4] - m.stamps[0]),
      pid: PID_SERVER,
      tid: META_TID,
      args: { bytes: m.bytes, sourceCacheHit: m.hit },
    });
  }

  for (const p of points) {
    events.push({
      name: `${p.kind}: ${p.reason}`,
      cat: "point",
      ph: "i",
      ts: p.t,
      pid: PID_BROWSER,
      tid: POINT_TID,
      args: { row: p.row, reason: p.reason },
    });
  }

  // Counter tracks. Perfetto renders `C` events as counter lanes — queue depth,
  // in-flight, frame time and residency all come for free, and this is the part
  // of the borrowed viewer that would otherwise be real build effort.
  for (let i = 0; i < ticks.n; i++) {
    events.push({
      name: "queue",
      cat: "counters",
      ph: "C",
      ts: ticks.t[i],
      pid: PID_BROWSER,
      tid: 0,
      args: { depth: ticks.queueDepth[i], inFlight: ticks.inFlight[i] },
    });
    events.push({
      name: "frame",
      cat: "counters",
      ph: "C",
      ts: ticks.t[i],
      pid: PID_BROWSER,
      tid: 0,
      args: { ms: ticks.frameMs[i], residentMiB: ticks.residentMiB[i] },
    });
  }

  return events;
}

function named(
  pid: number,
  tid: number,
  kind: "process_name" | "thread_name",
  name: string,
): TraceEvent {
  return { name: kind, ph: "M", ts: 0, pid, tid, args: { name } };
}

/**
 * The file the header travels in. Chrome Trace Event's object form carries
 * `otherData`, which is where the run header lands — a bare array would drop
 * DPR, GPU and cache warmth, and two runs at different DPR are not comparable.
 */
export function toChromeTraceFile(trace: Trace): string {
  return JSON.stringify({
    traceEvents: toChromeTrace(trace),
    displayTimeUnit: "ms",
    otherData: trace.header as unknown as Record<string, unknown>,
  });
}
