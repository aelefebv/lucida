// PROTOTYPE — throwaway. The *input* side: a trace as ADR 0047 describes one.
//
// Three lifecycle tables (chunk / server-serve / dataset-open reads), per-tick
// aggregates, point events, and a header. Timestamps are microsecond offsets
// from run start. Nothing here is a design proposal beyond ADR 0047 — it exists
// so the diagnostic renderer has real bytes to read instead of a mock.

export const CHUNK_PHASES = [
  // slot name        label            class        timed?
  ['plan', 'plan', 'compute', true],
  ['queued', 'fetch.queue', 'queue', true],
  ['wire', 'fetch.wire', 'io', true],
  ['decode', 'decode.roundtrip', 'compute', true],
  ['admit', 'cache.admit', 'compute', false], // below the 100 us clock floor (#897)
  ['upload', 'gpu.upload', 'compute', true],
  ['visible', 'render.firstvisible', 'compute', true],
];

export const SERVER_PHASES = [
  ['permit', 'server.permit', 'queue', true],
  ['ttfb', 'server.ttfb', 'io', true],
  ['body', 'server.body', 'io', true],
  ['serve', 'server.slice', 'compute', true],
];

export const OPEN_PHASES = [
  ['openPermit', 'open.permit', 'queue', true],
  ['openTtfb', 'open.ttfb', 'io', true],
  ['openBody', 'open.body', 'io', true],
  ['openParse', 'open.parse', 'compute', true],
];

export const ALL_PHASES = [...CHUNK_PHASES, ...SERVER_PHASES, ...OPEN_PHASES];

export const phaseMeta = (slot) => {
  const row = ALL_PHASES.find((p) => p[0] === slot);
  if (!row) throw new Error(`unknown phase slot: ${slot}`);
  return { slot: row[0], label: row[1], class: row[2], timed: row[3] };
};

export function emptyTrace(header) {
  return {
    schemaVersion: 1,
    header,
    chunks: [], // { key, lane, tier, corrId, bytesOut, durations: {slot: us}, endedAt }
    serves: [], // { corrId, durations: {slot: us}, bytesRead, bytesOut, outcome }
    opens: [], // { object, durations: {slot: us}, bytes }
    aggregates: [], // { tSec, stage, values: {...} }
    events: [], // { tUs, kind, reason, key? }
    limiters: [], // { id, cap, samples: [{tSec, inFlight, pending}] }
    truncated: null, // or { atRow, reason }
  };
}
