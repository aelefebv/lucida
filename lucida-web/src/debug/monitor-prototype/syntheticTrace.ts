/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * Two synthetic runs, calibrated to the measured numbers the map already has,
 * so the variants are judged against realistic volume and realistic shape
 * rather than a toy. Every constant below is traceable to a source:
 *
 * (The two research write-ups cited below live on their own branches,
 * `research/remote-rates` and `research/trace-volumes`, not on main.)
 *
 *   #899 (`remote-rates.md`), run2, GCS us-west1:
 *     permit wait p50 165.6 ms / p95 223.6 / max 426
 *     TTFB       p50  97.5 ms / p95 169.2 / max 321
 *     body       p50  51.6 ms / p95 106.7 / max 928
 *     fetch rate peak 82/s (this is our own 12-permit cap, not the network)
 *     evictions  0 on the remote path in every phase
 *     0 retries and 0 real failures across 3,781 reads
 *     plan.requests_per_submit p50 = 21,400 (every member, every rebuild)
 *     minimap probes 213,710/s
 *   #888 (`trace-volumes.md`):
 *     cold open touches 20-37 chunks; warm re-open 2,559
 *     idle emits nothing
 *   #902 / ADR 0046: warm metadata reads come back from the source cache in
 *     ~0.02 s; a cold remote open spends 2.8-7.7 s in them
 *   #897: 100 us clock floor, so nothing sub-floor gets a duration slot
 *
 * The two exceptions, both deliberate and both flagged in the header `gaps`:
 * a handful of rejections and one retry are injected into the warm run even
 * though #899 observed zero, because the prototype has to show what the
 * surface does when they fire.
 */

import {
  END_COMPLETE,
  END_RETIRED,
  NO_STAMP,
  STAMP_COUNT,
  SERVER_STAMP_COUNT,
  type ChunkTable,
  type MetaReadRow,
  type PointEvent,
  type ServerTable,
  type TickTable,
  type Trace,
} from "./traceModel.ts";

/** Deterministic PRNG — the same trace every reload, so variants compare. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw from a lognormal shaped to hit a target median and p95, in us. */
function lognormal(rnd: () => number, medianUs: number, p95Us: number): number {
  const mu = Math.log(medianUs);
  const sigma = Math.log(p95Us / medianUs) / 1.645;
  // Box-Muller
  const u1 = Math.max(rnd(), 1e-9);
  const u2 = rnd();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(100, Math.exp(mu + sigma * z));
}

interface RunSpec {
  label: string;
  cause: Trace["header"]["cause"];
  warmth: "cold" | "warm";
  /** chunks planned in the run */
  chunks: number;
  /** planner submits this many requests per rebuild (most are cache hits) */
  requestsPerSubmit: number;
  /** how many of the planned chunks actually reach the wire */
  fetched: number;
  /** our own admission rate ceiling, chunks/s (the 12-permit semaphore) */
  fetchRatePerSec: number;
  durationMs: number;
  /** dataset-open metadata object reads */
  metaReads: number;
  metaCached: boolean;
  seed: number;
}

const COLD: RunSpec = {
  label: "cold open (remote, 21,371-member collection)",
  cause: "content",
  warmth: "cold",
  chunks: 36,
  requestsPerSubmit: 36,
  fetched: 36,
  fetchRatePerSec: 82,
  durationMs: 12000,
  // Enough objects to land the total in #899's measured 2.8-7.7 s band for a
  // cold remote open of a collection this wide. A collection reads one
  // zarr.json per member group, not one per dataset.
  metaReads: 148,
  metaCached: false,
  seed: 0x5eed,
};

const WARM: RunSpec = {
  label: "warm re-open (remote, camera restored)",
  cause: "content",
  warmth: "warm",
  chunks: 2559,
  requestsPerSubmit: 21400,
  fetched: 1500,
  fetchRatePerSec: 82,
  durationMs: 21000,
  metaReads: 24,
  metaCached: true,
  seed: 0xbeef,
};

export const RUN_SPECS = { cold: COLD, warm: WARM } as const;
export type RunKey = keyof typeof RUN_SPECS;

function makeChunkTable(cap: number): ChunkTable {
  return {
    n: 0,
    cap,
    stamps: new Uint32Array(cap * STAMP_COUNT).fill(NO_STAMP),
    keyId: new Uint32Array(cap),
    correlationId: new Uint32Array(cap).fill(NO_STAMP),
    lane: new Uint8Array(cap),
    tier: new Uint8Array(cap),
    level: new Uint8Array(cap),
    channel: new Uint8Array(cap),
    endReason: new Uint8Array(cap),
    keys: [],
  };
}

function makeServerTable(cap: number): ServerTable {
  return {
    n: 0,
    cap,
    stamps: new Uint32Array(cap * SERVER_STAMP_COUNT).fill(NO_STAMP),
    correlationId: new Uint32Array(cap).fill(NO_STAMP),
    bytes: new Uint32Array(cap),
  };
}

function makeTickTable(cap: number): TickTable {
  return {
    n: 0,
    t: new Float64Array(cap),
    frameMs: new Float32Array(cap),
    queueDepth: new Uint32Array(cap),
    inFlight: new Uint16Array(cap),
    requestsPerSubmit: new Uint32Array(cap),
    minimapProbes: new Uint32Array(cap),
    residentMiB: new Uint16Array(cap),
    decodedKiB: new Uint32Array(cap),
  };
}

export function buildTrace(key: RunKey): Trace {
  const spec = RUN_SPECS[key];
  const rnd = mulberry32(spec.seed);
  const durUs = spec.durationMs * 1000;

  const chunks = makeChunkTable(spec.chunks);
  const server = makeServerTable(spec.fetched);
  const points: PointEvent[] = [];
  const meta: MetaReadRow[] = [];

  // --- Dataset-open metadata reads (the third table) ------------------------
  // Warm: served by the source cache, ~0.02 s total (ADR 0046 / #902).
  // Cold: 2.8-7.7 s, the single slowest phase of a remote open (#899).
  let metaT = 2000;
  for (let i = 0; i < spec.metaReads; i++) {
    const permit = spec.metaCached ? 0 : lognormal(rnd, 90_000, 260_000);
    const ttfb = spec.metaCached ? 120 : lognormal(rnd, 98_000, 170_000);
    const body = spec.metaCached ? 90 : lognormal(rnd, 40_000, 120_000);
    const parse = spec.metaCached ? 400 : lognormal(rnd, 1_800, 6_000);
    const s0 = metaT;
    const s1 = s0 + permit;
    const s2 = s1 + ttfb;
    const s3 = s2 + body;
    const s4 = s3 + parse;
    meta.push({
      path:
        i === 0
          ? "zarr.json"
          : i === 1
            ? "OME/METADATA.ome.xml"
            : `member-${String(i - 2).padStart(3, "0")}/zarr.json`,
      stamps: [s0, s1, s2, s3, s4],
      bytes: 1200 + Math.floor(rnd() * 40000),
      hit: spec.metaCached,
    });
    // Cold reads run 12-wide behind the source-read semaphore; warm are serial
    // and instant. Stagger by 1/12 of a read either way.
    metaT += spec.metaCached ? parse + 200 : (s4 - s0) / 12;
  }
  const metaEndUs = meta.length ? meta[meta.length - 1].stamps[4] : 2000;
  points.push({
    t: metaEndUs,
    kind: "dataset-open",
    row: -1,
    reason: spec.metaCached ? "source-cache-hit" : "source-cache-miss",
  });

  // --- Per-chunk lifecycle rows --------------------------------------------
  // Planning is one burst: p50 21,400 requests in a single submit, of which
  // `chunks` are misses that become rows. The rest are cache hits and never
  // enter the table — which is exactly why the table stays small.
  const planStart = metaEndUs + 4000;
  let correlations = 0;

  for (let i = 0; i < spec.chunks; i++) {
    const row = chunks.n++;
    const level = 1 + Math.floor(rnd() * 3);
    const c = Math.floor(rnd() * 2);
    const key = `${level}/0/${c}/${Math.floor(rnd() * 8)}/${Math.floor(rnd() * 24)}/${Math.floor(rnd() * 9)}`;
    chunks.keys.push(key);
    chunks.keyId[row] = row;
    chunks.level[row] = level;
    chunks.channel[row] = c;
    // Lane mix: the minimap seed-scan is the highest-frequency thing in the
    // system, so a real trace is not all main-lane.
    const laneRoll = rnd();
    chunks.lane[row] = laneRoll < 0.72 ? 0 : laneRoll < 0.96 ? 1 : 2;
    chunks.tier[row] = rnd() < 0.7 ? 0 : 1;

    const set = (slot: number, v: number) => {
      chunks.stamps[slot * chunks.cap + row] = Math.min(
        Math.round(v),
        NO_STAMP - 1,
      );
    };

    // 0 planned — the whole burst lands inside one frame
    const tPlanned = planStart + rnd() * 3000;
    set(0, tPlanned);
    // 1 submitted — plan -> submit is sub-floor; it is counted, not timed,
    // but the stamp exists because the queue phase has to start somewhere.
    set(1, tPlanned + 200 + rnd() * 400);

    // 2 wireSent — this is the queue. Admission is rank / rate: the wait is
    // throughput, not network (#899, #900). Chunks past the run's end never
    // get here, and their rows stay NO_STAMP: the run ended mid-flight.
    // Never earlier than the submit stamp: a chunk cannot be admitted before
    // it is queued, and a negative phase duration is a broken row, not a fast one.
    const admitAt = Math.max(
      chunks.stamps[1 * chunks.cap + row] + 100,
      planStart + (i / spec.fetchRatePerSec) * 1e6,
    );
    if (i >= spec.fetched || admitAt > durUs) {
      continue;
    }
    set(2, admitAt);
    // Server row for this wire request. The join is many-to-one: the client
    // coalesces duplicate in-flight fetches, so ~6% of rows share a
    // correlation id with the row before them.
    let corr: number;
    let bytesIn: number;
    if (row > 0 && rnd() < 0.06 && correlations > 0) {
      corr = correlations - 1;
      bytesIn = admitAt + lognormal(rnd, 120_000, 260_000);
    } else {
      corr = correlations++;
      const sRow = server.n++;
      const sSet = (slot: number, v: number) => {
        server.stamps[slot * server.cap + sRow] = Math.round(v);
      };
      const recv = admitAt + 300; // loopback WS relay adds nothing measurable
      const permit = lognormal(rnd, 165_600, 223_600);
      const ttfb = lognormal(rnd, 97_500, 169_200);
      const body = lognormal(rnd, 51_600, 106_700);
      sSet(0, recv);
      sSet(1, recv + permit);
      sSet(2, recv + permit + ttfb);
      sSet(3, recv + permit + ttfb + body);
      sSet(4, recv + permit + ttfb + body + 150);
      server.correlationId[sRow] = corr;
      server.bytes[sRow] = 300_000 + Math.floor(rnd() * 120_000);
      bytesIn = recv + permit + ttfb + body + 400;
    }
    chunks.correlationId[row] = corr;
    if (bytesIn > durUs) continue;
    set(3, bytesIn);

    // 4 decoded — main thread brackets the worker round trip, so this
    // includes worker queue wait. Named for the round trip, not CPU time.
    const decodeRt = lognormal(rnd, 9_000, 42_000);
    const tDecoded = bytesIn + decodeRt;
    if (tDecoded > durUs) continue;
    set(4, tDecoded);

    // 5 uploaded — only a fraction of decoded chunks are posted to the render
    // worker in a run this short (#888: 2,559 decoded / 880 uploaded).
    if (rnd() > 0.35) {
      // Decoded, resident, and not wanted by the current view. It is done,
      // not stuck — and the difference is one byte, not a timestamp.
      chunks.endReason[row] = END_RETIRED;
      continue;
    }
    const tUploaded = tDecoded + lognormal(rnd, 1_400, 5_000);
    if (tUploaded > durUs) continue;
    set(5, tUploaded);

    // 6 visible — next frame boundary
    const tVisible = tUploaded + 8_000 + rnd() * 8_000;
    if (tVisible > durUs) continue;
    set(6, tVisible);
    chunks.endReason[row] = END_COMPLETE;
  }

  // --- Point events ---------------------------------------------------------
  // Evictions are zero on the remote path (#899) — the flat zero is a finding,
  // not a healthy reading, and the surface has to not present it as health.
  // Rejections and one retry are INJECTED (never observed) so the prototype
  // shows what they look like.
  if (key === "warm") {
    for (const [t, reason] of [
      [7_400_000, "superseded-epoch"],
      [11_900_000, "superseded-epoch"],
      [16_250_000, "budget-exceeded"],
    ] as const) {
      points.push({
        t,
        kind: "rejection",
        row: Math.floor(rnd() * chunks.n),
        reason,
      });
    }
    points.push({
      t: 13_100_000,
      kind: "retry",
      row: Math.floor(rnd() * chunks.n),
      reason: "transport-closed",
    });
  }

  // --- Per-tick aggregates --------------------------------------------------
  const tickCount = Math.floor(spec.durationMs / 16);
  const ticks = makeTickTable(tickCount);
  let resident = spec.warmth === "warm" ? 180 : 0;
  for (let i = 0; i < tickCount; i++) {
    const t = i * 16_000;
    ticks.t[i] = t;
    ticks.frameMs[i] = 8 + rnd() * 6 + (t < planStart + 200_000 ? 40 : 0);
    // Queue depth: everything planned, minus everything admitted so far.
    const admitted = Math.min(
      spec.fetched,
      Math.max(0, ((t - planStart) / 1e6) * spec.fetchRatePerSec),
    );
    ticks.queueDepth[i] =
      t < planStart ? 0 : Math.max(0, Math.round(spec.chunks - admitted));
    ticks.inFlight[i] = t < planStart ? 0 : 12; // pinned at the cap all run
    ticks.requestsPerSubmit[i] =
      i % 12 === 0 ? spec.requestsPerSubmit : 0; // ~5 rebuilds/s
    ticks.minimapProbes[i] = i % 12 === 0 ? 21_370 : 0;
    resident = Math.min(512, resident + rnd() * 1.4);
    ticks.residentMiB[i] = Math.round(resident);
    ticks.decodedKiB[i] = Math.round(rnd() * 320);
    ticks.n++;
  }

  const gaps: string[] = [
    "worker-side timing not recorded: `decode` is a main-thread round trip and includes worker queue wait",
    "client-side TTFB does not exist: the transport delivers one whole frame per chunk",
    "cache admission and worker dispatch are counted, not timed (below the 100 us clock floor)",
  ];
  if (key === "warm") {
    gaps.push(
      "rejections and the retry in this run are INJECTED: #899 observed zero across 3,781 reads",
    );
  }

  return {
    header: {
      schemaVersion: 1,
      datasetUrl:
        "gs://<bucket>/processed/20260626.v1319.processed.zarr (21,371 images / 21,587 entities)",
      build: "lucida 0.2.0+prototype",
      gpu: "Apple M5 Max",
      devicePixelRatio: 2,
      viewport: [1600, 1000],
      cacheWarmth: spec.warmth,
      cause: spec.cause,
      runLabel: spec.label,
      durationUs: durUs,
      truncated: false,
      gaps,
    },
    chunks,
    server,
    meta,
    points,
    ticks,
  };
}
