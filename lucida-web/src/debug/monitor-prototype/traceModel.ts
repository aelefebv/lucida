/**
 * PROTOTYPE — throwaway. Issue #892 (visual timeline surface), map #885.
 *
 * The in-memory trace shape from ADR 0047: a columnar lifecycle table, one
 * fixed-width row per chunk, uint32 microsecond offsets from run start.
 * Chrome Trace Event JSON is a projection produced at export (chromeExport.ts),
 * never the in-memory representation.
 *
 * This file is a *stand-in* for the real recorder so the variants have
 * something realistic to draw. It is not instrumentation and must not be
 * promoted to production.
 */

/** No stamp recorded (phase not reached, or run ended first). */
export const NO_STAMP = 0xffffffff;

/**
 * Browser-side phase enum. A phase is delimited by a handoff where ownership
 * or identity changes (ADR 0047), not by a directory.
 *
 * Six phases sit between seven stamps, so a row is 7 x uint32 = 28 bytes of
 * timing plus identity.
 */
export const BROWSER_PHASES = [
  "plan",
  "queue",
  "wire",
  "decode",
  "upload",
  "present",
] as const;
export type BrowserPhase = (typeof BROWSER_PHASES)[number];

/** Stamp slots, in order. Phase i spans stamp i -> stamp i+1. */
export const BROWSER_STAMPS = [
  "planned",
  "submitted",
  "wireSent",
  "bytesIn",
  "decoded",
  "uploaded",
  "visible",
] as const;
export const STAMP_COUNT = BROWSER_STAMPS.length;

/** Server-side phase enum. Stops at enqueue: socket write is not observable. */
export const SERVER_PHASES = ["permit", "ttfb", "body", "enqueue"] as const;
export type ServerPhase = (typeof SERVER_PHASES)[number];
export const SERVER_STAMPS = [
  "received",
  "permitHeld",
  "firstByte",
  "bodyEnd",
  "enqueued",
] as const;
export const SERVER_STAMP_COUNT = SERVER_STAMPS.length;

/** Metadata-object reads during dataset open — the third table. */
export const META_PHASES = ["permit", "ttfb", "body", "parse"] as const;
export const META_FIRST = 0;
export const META_LAST = META_PHASES.length;

/** Values for `ChunkTable.endReason`. */
export const END_IN_FLIGHT = 0;
/** reached `visible` */
export const END_COMPLETE = 1;
/** stopped on purpose: resident and not wanted by the current view */
export const END_RETIRED = 2;

export const LANES = ["main", "minimap", "label"] as const;
/**
 * `CachedStore.source_read`'s default permit count. The run's central claim is
 * that this cap, not the object store, sets the observed fetch rate, so it is
 * one named constant rather than a literal repeated in a detector and a string.
 */
export const SOURCE_READ_CONCURRENCY = 12;

export type Lane = (typeof LANES)[number];
export type ResidencyTier = "detail" | "coarse";

/** Per-chunk lifecycle table. Column-per-field, row index is the chunk. */
export interface ChunkTable {
  /** count of rows in use */
  n: number;
  /** allocated rows — the column stride for `stamps` */
  cap: number;
  /** stamps[slot * cap + row] — microseconds from run start, or NO_STAMP */
  stamps: Uint32Array;
  /** index into `keys` */
  keyId: Uint32Array;
  /** index into `correlations`, or NO_STAMP if it never hit the wire */
  correlationId: Uint32Array;
  lane: Uint8Array;
  tier: Uint8Array;
  /** pyramid level */
  level: Uint8Array;
  channel: Uint8Array;
  /**
   * Why the row stops where it stops. A stamp array alone cannot tell
   * "never entered the next phase" from "entered and never left", and the two
   * read as opposites: one is a chunk that finished its useful life, the other
   * is a chunk that is stuck. Drawing them the same way turns a healthy lane
   * into a solid slab. One byte per row buys the distinction.
   */
  endReason: Uint8Array;
  /** dictionary of "level/t/c/z/y/x" strings */
  keys: string[];
}

/** Server-side chunk-serve table. Joined to ChunkTable many-to-one. */
export interface ServerTable {
  n: number;
  cap: number;
  stamps: Uint32Array;
  correlationId: Uint32Array;
  /** bytes on the wire */
  bytes: Uint32Array;
}

export interface MetaReadRow {
  path: string;
  /** microseconds from run start */
  stamps: number[];
  bytes: number;
  hit: boolean;
}

export type PointKind =
  | "eviction"
  | "rejection"
  | "retry"
  | "failure"
  | "dataset-open";

export interface PointEvent {
  /** microseconds from run start */
  t: number;
  kind: PointKind;
  /** chunk row index, or -1 */
  row: number;
  /** borrowed reason code (typed fetch error / chunk feedback vocabulary) */
  reason: string;
}

/** Per-tick aggregates. Parallel arrays, one entry per render tick. */
export interface TickTable {
  n: number;
  /** microseconds from run start */
  t: Float64Array;
  frameMs: Float32Array;
  queueDepth: Uint32Array;
  inFlight: Uint16Array;
  requestsPerSubmit: Uint32Array;
  minimapProbes: Uint32Array;
  residentMiB: Uint16Array;
  decodedKiB: Uint32Array;
}

export interface TraceHeader {
  schemaVersion: number;
  datasetUrl: string;
  build: string;
  gpu: string;
  /** DPR-1-only verification has hidden whole defect classes here; two runs at
   *  different DPR are not comparable, so it rides in the header. */
  devicePixelRatio: number;
  viewport: [number, number];
  cacheWarmth: "cold" | "warm";
  /** epoch-diff cause that opened the run */
  cause: "content" | "layout" | "view" | "selection" | "asset";
  runLabel: string;
  /** wall-clock microseconds the run covers */
  durationUs: number;
  truncated: boolean;
  /** honesty flags the agent surface (#893) has to echo */
  gaps: string[];
}

export interface Trace {
  header: TraceHeader;
  chunks: ChunkTable;
  server: ServerTable;
  meta: MetaReadRow[];
  points: PointEvent[];
  ticks: TickTable;
}

/** Lane and tier are stored as bytes; these are the only place they are named. */
export function laneName(t: ChunkTable, row: number): Lane {
  return LANES[t.lane[row]];
}

export function tierName(t: ChunkTable, row: number): ResidencyTier {
  return t.tier[row] === 0 ? "detail" : "coarse";
}

/** Wall time a metadata read occupied, first stamp to last. */
export function metaDurationUs(m: MetaReadRow): number {
  return m.stamps[META_LAST] - m.stamps[META_FIRST];
}

/**
 * Bytes the in-memory trace occupies, for the overhead-budget question.
 *
 * Counts everything the export also carries — including the key dictionary,
 * the metadata table and the point events. Summing only the typed arrays would
 * flatter the columnar side against the JSON it is being compared to, and the
 * comparison is the whole point of the number.
 */
export function tableBytes(trace: Trace): number {
  const c = trace.chunks;
  const s = trace.server;
  // UTF-16 in the engine's string table, plus a pointer per entry.
  const keyBytes = c.keys.reduce((n, k) => n + k.length * 2 + 8, 0);
  // Rough but not flattering: 5 numbers, a path string and two flags per read.
  const metaBytes = trace.meta.reduce(
    (n, m) => n + 5 * 8 + m.path.length * 2 + 16,
    0,
  );
  const pointBytes = trace.points.reduce((n, p) => n + 16 + p.reason.length * 2, 0);
  return (
    keyBytes +
    metaBytes +
    pointBytes +
    c.stamps.byteLength +
    c.keyId.byteLength +
    c.correlationId.byteLength +
    c.lane.byteLength +
    c.tier.byteLength +
    c.level.byteLength +
    c.channel.byteLength +
    c.endReason.byteLength +
    s.stamps.byteLength +
    s.correlationId.byteLength +
    s.bytes.byteLength +
    trace.ticks.t.byteLength +
    trace.ticks.frameMs.byteLength +
    trace.ticks.queueDepth.byteLength +
    trace.ticks.inFlight.byteLength +
    trace.ticks.requestsPerSubmit.byteLength +
    trace.ticks.minimapProbes.byteLength +
    trace.ticks.residentMiB.byteLength +
    trace.ticks.decodedKiB.byteLength
  );
}
