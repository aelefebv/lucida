'use strict';
// Shared clock-probe source for issue #897's two runners (`tr_driver.cjs`,
// `tr_probe.cjs`). Kept in one place because the first version of this
// harness copied it into both files and the copies drifted — one of them
// lost its trailing `()` and silently returned `undefined` for a whole run.
//
// These are SOURCE STRINGS evaluated inside the page, not functions here.
// Every one must be a complete call expression: a string that evaluates to
// a function is never invoked, and Playwright cannot serialise a function,
// so the result silently disappears.

// Spin on performance.now() and collect every DISTINCT non-zero delta. On a
// clamped clock there is exactly one: the clamp. Then quantify what that
// floor does to a fine per-chunk operation — timed individually, timed as a
// batch, and (for the aggregation argument) the sum of the individually
// timed spans against an outer wall-clock measurement of the very same loop.
const CLOCK_PROBE = `(() => {
  const t_end = Date.now() + 1200;
  const deltas = new Map();
  let samples = 0, last = performance.now();
  while (Date.now() < t_end) {
    for (let i = 0; i < 2000; i++) {
      const n = performance.now();
      samples++;
      if (n !== last) { const d = +(n - last).toFixed(6); deltas.set(d, (deltas.get(d) || 0) + 1); last = n; }
    }
  }
  const distinct = [...deltas.entries()].sort((a, b) => a[0] - b[0]);

  // A stand-in for a fine pipeline stage: one lookup in a 20k-entry Map.
  const map = new Map();
  for (let i = 0; i < 20000; i++) map.set('level/0/0/' + i, i);
  const keys = [];
  for (let i = 0; i < 20000; i++) keys.push('level/0/0/' + ((i * 7919) % 20000));

  // Individually timed, with an OUTER wall measurement of the same loop.
  const outer0 = performance.now();
  let zero = 0, nonzero = 0, sumIndividual = 0;
  for (let i = 0; i < keys.length; i++) {
    const a = performance.now();
    map.get(keys[i]);
    const b = performance.now();
    if (b === a) zero++; else { nonzero++; sumIndividual += (b - a); }
  }
  const outerMs = performance.now() - outer0;

  // The same work, timed once.
  const a0 = performance.now();
  for (let i = 0; i < keys.length; i++) map.get(keys[i]);
  const batchTotalMs = performance.now() - a0;

  return {
    crossOriginIsolated: (typeof crossOriginIsolated !== 'undefined') ? crossOriginIsolated : null,
    samples,
    distinct_deltas_ms: distinct.slice(0, 12),
    distinct_delta_count: distinct.length,
    min_nonzero_delta_ms: distinct.length ? distinct[0][0] : null,
    fine_stage: {
      n: keys.length,
      timed_individually_zero: zero,
      timed_individually_nonzero: nonzero,
      // Sum of the quantised per-span readings.
      individual_sum_ms: +sumIndividual.toFixed(4),
      // Wall time of the SAME instrumented loop. individual_sum vs this is
      // the honest test of whether quantised sums converge: they can only
      // converge to the cost of the instrumented region, not to the cost of
      // the bare work.
      individual_outer_ms: +outerMs.toFixed(4),
      // The bare work, timed once.
      batch_total_ms: +batchTotalMs.toFixed(4),
      batch_per_op_us: +((batchTotalMs * 1000) / keys.length).toFixed(4),
    },
  };
})()`;

// Same probe, inside a worker: decode and render run in workers, so the
// floor that binds is the one there.
const WORKER_SRC = 'self.onmessage = () => { postMessage(' + CLOCK_PROBE + '); };';
const WORKER_PROBE = `(() => new Promise((resolve) => {
  const src = ${JSON.stringify(WORKER_SRC)};
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const to = setTimeout(() => resolve({ error: 'worker_timeout' }), 30000);
  w.onmessage = (e) => { clearTimeout(to); w.terminate(); resolve(e.data); };
  w.onerror = (e) => { clearTimeout(to); resolve({ error: 'worker_error: ' + (e && e.message) }); };
  w.postMessage(0);
}))()`;

module.exports = { CLOCK_PROBE, WORKER_PROBE };
