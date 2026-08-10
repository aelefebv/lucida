// PROTOTYPE — throwaway. Five synthesized runs, built from the measured
// distributions in docs/research/remote-rates.md (#899) and
// docs/research/trace-volumes.md (#888).
//
// PROVENANCE RULES followed here, so the samples can be trusted as far as they
// deserve and no further:
//   [M] percentile points quoted verbatim from a research table.
//   [I] percentile points interpolated between quoted points (p90/p99 where the
//       note only quotes p50/p95/max). Marked in each distribution below.
//   [S] synthesized: a count or a shape the research explicitly marks [U].
// Every [S] value is listed in the run header's `synthesized` field so it shows
// up in the rendered output rather than hiding in this file.

import { rng, fromPercentiles } from './rng.mjs';
import { emptyTrace } from './trace.mjs';

const ms = (v) => Math.max(0, Math.round(v * 1000)); // ms -> integer microseconds

// ---------------------------------------------------------------------------
// Distributions (milliseconds)
// ---------------------------------------------------------------------------

// #899 §1, run1 (the slower network sample).
const R1_PERMIT = { min: 0, p50: 467.1, p90: 610.8, p95: 694.7, p99: 887.9, max: 916.1 };
const R1_TTFB = { min: 168.6, p50: 198.6, p90: 238.8, p95: 258.0, p99: 297.0, max: 354.0 };
const R1_BODY = { min: 135.2, p50: 265.3, p90: 292.9, p95: 374.5, p99: 876.4, max: 1484.9 };

// #899 §1, run2 (the faster network sample).
const R2_PERMIT = { min: 0, p50: 165.6, p90: 204.0, p95: 223.6, p99: 306.5, max: 426.2 };
const R2_TTFB = { min: 40.2, p50: 97.5, p90: 150.4, p95: 169.2, p99: 212.6, max: 321.0 };
const R2_BODY = { min: 0, p50: 51.6, p90: 94.8, p95: 106.7, p99: 293.0, max: 928.4 };

// #899 §3: scheduler queue wait, warm re-open (p50 8.8 s, max 19.8 s quoted [M];
// p90/p95/p99 [I]).
const SCHED_WAIT_WARM = { min: 0.1, p50: 8800, p90: 14000, p95: 16000, p99: 18500, max: 19800 };
// #899 §3: cold open queue wait (p50 0.1 ms, max 558 ms quoted [M]).
const SCHED_WAIT_COLD = { min: 0.02, p50: 0.1, p90: 40, p95: 120, p99: 400, max: 558 };

// #899 §7: client decode round trip, 6 KiB payloads (65 % under 100 us [M]; shape [I]).
const DECODE_RT = { min: 0.02, p50: 0.09, p90: 0.4, p95: 0.6, p99: 1.2, max: 3.0 };
// #899 §7: upload dispatch (91.6 % under 100 us [M]; shape [I]).
const UPLOAD = { min: 0.01, p50: 0.05, p90: 0.09, p95: 0.15, p99: 0.4, max: 1.1 };
// #899 §7: plan rebuild p50 38 ms [M]; shape [I].
const PLAN = { min: 5, p50: 38, p90: 70, p95: 85, p99: 120, max: 160 };
// #899 §7: server-side chunk slice/decode p50 0.6 ms [M]; shape [I].
const SERVE = { min: 0.05, p50: 0.6, p90: 1.6, p95: 2.2, p99: 4.0, max: 9.0 };
// Local-disk wire latency — [S]. #888 served from NVMe and never measured
// per-request latency; only the 37 fetch/s rate is [M].
const LOCAL_WIRE = { min: 0.8, p50: 4.5, p90: 12, p95: 18, p99: 34, max: 61 };

const chunkKey = (i) => `0/0/${i % 3}/${(i >> 2) % 8}/${(i >> 5) % 16}/${i % 16}`;

// ---------------------------------------------------------------------------
// A — cold open of a remote collection. The bottleneck is not in the chunk
//     pipeline at all: it is dataset-open metadata reads (#899 §4).
// ---------------------------------------------------------------------------

function remoteColdOpen() {
  const next = rng(0xa11ce);
  const t = emptyTrace({
    runId: 'r-3f2a9c',
    cause: 'open',
    warmth: 'cold',
    dataset: 'gs://bucket/collection-21371.zarr',
    members: 21371,
    devicePixelRatio: 2,
    viewport: '1600x1000',
    build: '0.31.2+7f3d34b',
    gpu: 'Apple M5 Max',
    transport: 'remote (object store, US-WEST1)',
    endReason: 'quiescent',
    serverTimings: 'complete',
    synthesized: [
      'metadata read count (200) — #899 marks the dataset-open read count [U]; ' +
        'chosen so 12-way concurrency over the measured per-read latency lands on the measured 7.7 s wall',
    ],
  });

  // 200 metadata object reads behind the 12-permit source-read semaphore.
  let openEnd = 0;
  const permits = new Array(12).fill(0);
  for (let i = 0; i < 200; i++) {
    const slot = permits.indexOf(Math.min(...permits));
    const start = permits[slot];
    const permitWait = i < 12 ? 0 : ms(fromPercentiles(next, R1_PERMIT) * 0.15);
    const ttfb = ms(fromPercentiles(next, R1_TTFB));
    const body = ms(fromPercentiles(next, R1_BODY) * 0.55);
    const parse = ms(fromPercentiles(next, SERVE));
    const dur = permitWait + ttfb + body + parse;
    permits[slot] = start + dur;
    openEnd = Math.max(openEnd, permits[slot]);
    t.opens.push({
      object: i === 0 ? 'zarr.json' : `member-${i}/zarr.json`,
      startUs: start,
      durations: { openPermit: permitWait, openTtfb: ttfb, openBody: body, openParse: parse },
      bytes: 1400 + Math.floor(next() * 900),
    });
  }
  t.limiters.push({
    id: 'server.source_read',
    cap: 12,
    unit: 'permits',
    samples: sampleLimiter(next, openEnd, 12, 12, 0, 200),
  });

  // Then 36 chunks (#899 §4: cold open of this fixture is 36 chunks [M]).
  const planAt = openEnd + ms(fromPercentiles(next, PLAN));
  let firstVisible = 0;
  for (let i = 0; i < 36; i++) {
    const corrId = `c${i}`;
    const queued = ms(fromPercentiles(next, SCHED_WAIT_COLD));
    const permit = ms(fromPercentiles(next, R1_PERMIT) * 0.2);
    const ttfb = ms(fromPercentiles(next, R1_TTFB));
    const body = ms(fromPercentiles(next, R1_BODY) * 0.3);
    const serve = ms(fromPercentiles(next, SERVE));
    const wire = permit + ttfb + body + serve + 1000;
    const decode = ms(fromPercentiles(next, DECODE_RT));
    const upload = ms(fromPercentiles(next, UPLOAD));
    const visible = i < 18 ? ms(2 + next() * 6) : 0;
    const endedAt = planAt + queued + wire + decode + upload + visible;
    if (visible) firstVisible = Math.max(firstVisible, endedAt);
    t.chunks.push({
      key: chunkKey(i),
      lane: 'main',
      tier: 'detail',
      corrId,
      startUs: planAt,
      bytesOut: 6144,
      durations: { queued, wire, decode, upload, visible },
    });
    t.serves.push({
      corrId,
      durations: { permit, ttfb, body, serve },
      bytesRead: 326 * 1024,
      bytesOut: 6144,
      outcome: 'ok',
    });
  }
  t.header.wallUs = firstVisible + ms(30);
  t.header.targetEvent = 'first render complete';
  t.header.targetUs = firstVisible;
  addTickAggregates(t, next, { probesPerScan: 21370, planPerRebuild: 36 });
  return t;
}

// ---------------------------------------------------------------------------
// B — warm re-open into a restored camera. The saturation case (#899 §5):
//     20,620 queued, 24 in flight, and the run never finishes.
// ---------------------------------------------------------------------------

function remoteWarmReopen() {
  const next = rng(0xb0b);
  const WALL = ms(20100);
  const t = emptyTrace({
    runId: 'r-77d104',
    cause: 'open',
    warmth: 'warm (camera restored)',
    dataset: 'gs://bucket/collection-21371.zarr',
    members: 21371,
    devicePixelRatio: 2,
    viewport: '1600x1000',
    build: '0.31.2+7f3d34b',
    gpu: 'Apple M5 Max',
    transport: 'remote (object store, US-WEST1)',
    endReason: 'cutoff',
    serverTimings: 'partial',
    serverTimingsNote: '1,483 of 1,500 wire requests joined; 17 have no server row',
    wallUs: WALL,
    targetEvent: 'residency settled',
    targetUs: null, // never reached
    synthesized: [
      'a 1,200-row recording budget, so this run demonstrates ADR 0047 truncation — #899 recorded all 1,500 fetches it issued',
    ],
  });

  // 1,500 fetches issued in 20 s, 1,470 completed [M] — but the per-chunk table
  // fills at row 1,200 and the run stops recording rather than dropping the
  // oldest rows, because the beginning of a run is the diagnostic payload
  // (ADR 0047). Everything after that row is invisible, and the report says so.
  const ROW_BUDGET = 1200;
  for (let i = 0; i < ROW_BUDGET; i++) {
    const corrId = `c${i}`;
    const queued = ms(fromPercentiles(next, SCHED_WAIT_WARM));
    const permit = ms(fromPercentiles(next, R2_PERMIT));
    const ttfb = ms(fromPercentiles(next, R2_TTFB));
    const body = ms(fromPercentiles(next, R2_BODY));
    const serve = ms(fromPercentiles(next, SERVE));
    const wire = permit + ttfb + body + serve + 800;
    const done = i < 1470;
    t.chunks.push({
      key: chunkKey(i),
      lane: 'main',
      tier: i % 7 === 0 ? 'coarse' : 'detail',
      corrId,
      startUs: Math.floor((i / 1500) * WALL * 0.6),
      bytesOut: 6144,
      durations: done
        ? {
            queued,
            wire,
            decode: ms(fromPercentiles(next, DECODE_RT)),
            upload: i < 18 ? ms(fromPercentiles(next, UPLOAD)) : 0,
            visible: i < 18 ? ms(2 + next() * 6) : 0,
          }
        : { queued, wire: null }, // still in flight at cutoff
    });
    if (done && i < 1483) {
      t.serves.push({
        corrId,
        durations: { permit, ttfb, body, serve },
        bytesRead: 326 * 1024,
        bytesOut: 6144,
        outcome: i === 900 || i === 1201 ? 'not_found' : 'ok',
      });
    }
  }

  t.limiters.push(
    {
      id: 'client.scheduler',
      cap: 24,
      unit: 'in-flight requests',
      samples: sampleLimiter(next, WALL, 24, 24, 20620, 1500),
    },
    {
      id: 'server.source_read',
      cap: 12,
      unit: 'permits',
      samples: sampleLimiter(next, WALL, 12, 12, 0, 1483),
    },
  );
  t.truncated = {
    atRow: ROW_BUDGET,
    reason: 'per-chunk table budget reached at 13.4 s; 300 further requests were issued and not recorded',
  };
  t.events.push(
    ...Array.from({ length: 55 }, (_, i) => ({
      tUs: Math.floor((i / 55) * WALL),
      kind: 'abort',
      reason: 'replan-superseded',
      key: chunkKey(i * 13),
    })),
  );
  t.rings = [{ name: 'events', dropped: 312, policy: 'drop-oldest' }];
  addTickAggregates(t, next, { probesPerScan: 21370, planPerRebuild: 21400 });
  return t;
}

// ---------------------------------------------------------------------------
// C — a healthy run. What the default output must look like when nothing fired.
//     Local NVMe, 5.44 GB volume fixture, 37 chunks, first render 378 ms (#888).
// ---------------------------------------------------------------------------

function localColdOpen() {
  const next = rng(0xc0ffee);
  const t = emptyTrace({
    runId: 'r-01b6e2',
    cause: 'open',
    warmth: 'cold',
    dataset: 'file:///fixtures/volume-timeseries.zarr',
    members: 1,
    devicePixelRatio: 2,
    viewport: '1600x1000',
    build: '0.31.2+7f3d34b',
    gpu: 'Apple M5 Max',
    transport: 'local (NVMe)',
    endReason: 'quiescent',
    serverTimings: 'complete',
    synthesized: [
      'local wire latency distribution — #888 measured rates but not per-request latency',
      'app boot (298 ms before the first recorded row) — #888 measured first render at 378 ms from navigation but nothing instruments the stretch before the first metadata read',
    ],
  });

  // Nothing records shell boot and wasm init, so the run opens with a stretch
  // no instrument covers. This is the interesting part of this scenario.
  const BOOT = ms(298);
  let openEnd = 0;
  for (let i = 0; i < 6; i++) {
    const dur = ms(0.4 + next() * 1.8);
    t.opens.push({
      object: i === 0 ? 'zarr.json' : `level-${i - 1}/zarr.json`,
      startUs: BOOT + i * 300,
      durations: { openPermit: 0, openTtfb: Math.floor(dur * 0.4), openBody: Math.floor(dur * 0.4), openParse: Math.floor(dur * 0.2) },
      bytes: 1800,
    });
    openEnd = Math.max(openEnd, BOOT + i * 300 + dur);
  }

  const planAt = openEnd + ms(fromPercentiles(next, PLAN) * 0.4);
  let firstVisible = 0;
  for (let i = 0; i < 37; i++) {
    const corrId = `c${i}`;
    const queued = ms(fromPercentiles(next, SCHED_WAIT_COLD) * 0.3);
    const wire = ms(fromPercentiles(next, LOCAL_WIRE));
    const decode = ms(fromPercentiles(next, DECODE_RT) * 4);
    const upload = ms(fromPercentiles(next, UPLOAD));
    const visible = i < 13 ? ms(2 + next() * 5) : 0;
    const endedAt = planAt + queued + wire + decode + upload + visible;
    if (visible) firstVisible = Math.max(firstVisible, endedAt);
    t.chunks.push({
      key: chunkKey(i),
      lane: 'main',
      tier: 'detail',
      corrId,
      startUs: planAt,
      bytesOut: 262144,
      durations: { queued, wire, decode, upload, visible },
    });
    t.serves.push({
      corrId,
      durations: { permit: 0, ttfb: Math.floor(wire * 0.2), body: Math.floor(wire * 0.6), serve: ms(fromPercentiles(next, SERVE)) },
      bytesRead: 262144,
      bytesOut: 262144,
      outcome: 'ok',
    });
  }
  t.limiters.push({
    id: 'server.source_read',
    cap: 12,
    unit: 'permits',
    samples: sampleLimiter(next, firstVisible, 4, 9, 0, 37),
  });
  t.header.wallUs = firstVisible + ms(24);
  t.header.targetEvent = 'first render complete';
  t.header.targetUs = firstVisible;
  addTickAggregates(t, next, { probesPerScan: 3, planPerRebuild: 37 });
  return t;
}

// ---------------------------------------------------------------------------
// D — an interaction run with the server rows missing. Two degradations at
//     once: an interaction has no completion event to walk a critical path back
//     from, and without server rows the wire bracket cannot be split into
//     "our permit queue" and "the network". The report has to say so.
// ---------------------------------------------------------------------------

function interactionOrbit() {
  const next = rng(0xd00d);
  const WALL = ms(10000);
  const t = emptyTrace({
    runId: 'r-9ae413',
    cause: 'view',
    warmth: 'warm',
    dataset: 'gs://bucket/collection-21371.zarr',
    members: 21371,
    devicePixelRatio: 2,
    viewport: '1600x1000',
    build: '0.31.2+7f3d34b',
    gpu: 'Apple M5 Max',
    transport: 'remote (object store, US-WEST1)',
    endReason: 'quiescent',
    serverTimings: 'absent',
    serverTimingsNote: 'server build predates correlation-id support; no server rows joined',
    wallUs: WALL,
    // An interaction has no completion event. Nothing "finishes" a pan.
    targetEvent: null,
    targetUs: null,
    synthesized: [
      'wire latency inflated 2.5x over #899 run1 to stand in for a slow link — the measured runs never produced a wire stall',
    ],
  });

  for (let i = 0; i < 688; i++) {
    const corrId = `c${i}`;
    const queued = ms(fromPercentiles(next, SCHED_WAIT_COLD));
    const wire = ms(2.5 * (fromPercentiles(next, R1_PERMIT) + fromPercentiles(next, R1_TTFB) + fromPercentiles(next, R1_BODY)));
    t.chunks.push({
      key: chunkKey(i),
      lane: i % 5 === 0 ? 'minimap' : 'main',
      tier: 'detail',
      corrId,
      startUs: Math.floor((i / 688) * WALL * 0.8),
      bytesOut: 6144,
      durations: {
        queued,
        wire,
        decode: ms(fromPercentiles(next, DECODE_RT)),
        upload: ms(fromPercentiles(next, UPLOAD)),
        visible: ms(2 + next() * 6),
      },
    });
  }
  t.limiters.push({
    id: 'client.scheduler',
    cap: 24,
    unit: 'in-flight requests',
    samples: sampleLimiter(next, WALL, 17, 21, 40, 688),
  });
  addTickAggregates(t, next, { probesPerScan: 21370, planPerRebuild: 21400, orbit: true });
  return t;
}

// ---------------------------------------------------------------------------

function sampleLimiter(next, wallUs, p50, max, pending, completions) {
  const n = Math.max(2, Math.round(wallUs / 1e6));
  return Array.from({ length: n }, (_, i) => ({
    tSec: i,
    inFlight: i === 0 ? Math.min(p50, Math.round(max * 0.6)) : p50 + (next() < 0.15 ? -1 : 0),
    pending: i === 0 ? 0 : pending,
    completions: Math.round(completions / n),
  }));
}

/**
 * Tier-two records: per-second aggregates for stages that cannot afford a row
 * per item (ADR 0047), which is exactly where the minimap seed-scan lives.
 */
function addTickAggregates(t, next, { probesPerScan, planPerRebuild, orbit = false, probeCostUs = 0.2 }) {
  // Buckets are one second, and the last one is partial: a 380 ms run must not
  // be charged a full second of main-thread work.
  const total = (t.header.wallUs ?? 1e6) / 1e6;
  for (let s = 0; s < Math.ceil(total); s++) {
    const frac = Math.min(1, total - s);
    const scans = Math.max(1, Math.round(10 * frac));
    // #888 §4.1: the scan costs a map lookup + a template literal per probe.
    // The per-probe cost is [S] — see the header's `synthesized` list.
    const probes = probesPerScan * scans;
    t.aggregates.push({
      tSec: s,
      stage: 'minimap.seedscan',
      values: {
        scans,
        probes,
        hits: Math.round(probes * 0.0002),
        mainThreadUs: Math.round(probes * probeCostUs),
      },
    });
    const rebuilds = Math.max(1, Math.round(5 * frac));
    t.aggregates.push({
      tSec: s,
      stage: 'plan.emit',
      values: {
        rebuilds,
        emitted: planPerRebuild * rebuilds,
        mainThreadUs: Math.round(rebuilds * fromPercentiles(next, PLAN) * 1000),
      },
    });
    t.aggregates.push({
      tSec: s,
      stage: 'render',
      values: {
        ticks: Math.round((orbit ? 58 : 120) * frac),
        frames: Math.round((orbit ? 24 : 101) * frac),
        passes: orbit ? 204 : 2,
      },
    });
    t.aggregates.push({
      tSec: s,
      stage: 'cache',
      values: { requests: planPerRebuild * rebuilds, hits: 14, evictions: 0 },
    });
  }
}

// ---------------------------------------------------------------------------
// E — a 2D pan where the chunk pipeline is fine and the main thread is not.
//     The minimap seed-scan is O(members x coarse chunks) with no cap (#888
//     §4.1); at 21,371 members and a 2x2x2 coarse grid it is the busiest thing
//     in the system by three orders of magnitude, and it has no per-item rows
//     by design. The report has to name it without claiming it is on a path.
// ---------------------------------------------------------------------------

function interactionSeedScan() {
  const next = rng(0xe5ca);
  const WALL = ms(10000);
  const t = emptyTrace({
    runId: 'r-c2b805',
    cause: 'view',
    warmth: 'warm',
    dataset: 'gs://bucket/collection-21371.zarr',
    members: 21371,
    devicePixelRatio: 2,
    viewport: '1600x1000',
    build: '0.31.2+7f3d34b',
    gpu: 'Apple M5 Max',
    transport: 'remote (object store, US-WEST1)',
    endReason: 'quiescent',
    serverTimings: 'complete',
    wallUs: WALL,
    targetEvent: null,
    targetUs: null,
    synthesized: [
      'main-thread cost per seed-scan probe (200 ns) — #899 §2 measured the probe *count* (21,370/scan, 213,710/s), confirming the extrapolation from 384/scan in #888 §4.1, but neither measured the wall time of a scan',
      'coarse grid depth (2x2x2) — #888 §4.1 measured a 1-chunk coarse grid and notes the cost is "multiples of that with a larger one"',
    ],
  });

  for (let i = 0; i < 640; i++) {
    const corrId = `c${i}`;
    const permit = ms(fromPercentiles(next, R2_PERMIT));
    const ttfb = ms(fromPercentiles(next, R2_TTFB));
    const body = ms(fromPercentiles(next, R2_BODY));
    const serve = ms(fromPercentiles(next, SERVE));
    t.chunks.push({
      key: chunkKey(i),
      lane: i % 4 === 0 ? 'minimap' : 'main',
      tier: 'coarse',
      corrId,
      startUs: Math.floor((i / 640) * WALL * 0.9),
      bytesOut: 6144,
      durations: {
        queued: ms(fromPercentiles(next, SCHED_WAIT_COLD)),
        wire: permit + ttfb + body + serve + 800,
        decode: ms(fromPercentiles(next, DECODE_RT)),
        upload: ms(fromPercentiles(next, UPLOAD)),
        visible: ms(2 + next() * 6),
      },
    });
    t.serves.push({ corrId, durations: { permit, ttfb, body, serve }, bytesRead: 326 * 1024, bytesOut: 6144, outcome: 'ok' });
  }
  t.limiters.push({
    id: 'client.scheduler',
    cap: 24,
    unit: 'in-flight requests',
    samples: sampleLimiter(next, WALL, 15, 22, 60, 640),
  });
  addTickAggregates(t, next, { probesPerScan: 21370 * 8, planPerRebuild: 21400, probeCostUs: 0.2 });
  return t;
}

export const SCENARIOS = {
  'remote-cold-open': { label: 'Cold open, 21,371-member remote collection', build: remoteColdOpen },
  'remote-warm-reopen': { label: 'Warm re-open into a restored camera (saturated)', build: remoteWarmReopen },
  'local-cold-open': { label: 'Cold open, 5.44 GB local volume (healthy)', build: localColdOpen },
  'interaction-orbit': { label: 'Interaction with the server rows missing (cannot split the wire)', build: interactionOrbit },
  'interaction-seedscan': { label: 'Interaction where the main thread, not the pipeline, is the cost', build: interactionSeedScan },
};
