'use strict';
// Timer-resolution driver (issue #897). Adapted from rr_driver.cjs (#899).
//
// Drives the real lucida SPA at DPR2 against an already-opened dataset and
// answers two questions in one run:
//
//   1. What is the actual `performance.now()` granularity on this page —
//      on the main thread AND inside a worker (decode runs in workers)?
//   2. Does the app still work when the page is cross-origin isolated?
//      Any subresource COEP blocks shows up as a failed request; any
//      broken open shows up as a not-ready probe.
//
// The arm (isolated or not) is chosen by the SERVER, which either does or
// does not send COOP/COEP. The driver just reports what it observes.
const fs = require('fs');
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let chromium = null;
try { ({ chromium } = require('playwright')); }
catch (e1) {
  try { ({ chromium } = require('@playwright/test')); }
  catch (e2) { out({ ok: false, reason: 'playwright_not_resolvable: ' + String(e2).split('\n')[0] }); process.exit(0); }
}

const req = JSON.parse(process.argv[2]);
const { url, out_dir: outDir } = req;
const exe = req.executable_path || undefined;
const width = req.width || 1600, height = req.height || 1000, dpr = req.device_scale_factor || 2;
const readyWaitMs = req.ready_wait_ms || 600000;
const settleMs = req.settle_ms || 15000;
const panMs = req.pan_ms || 6000;
const arm = req.arm || 'unknown';

function readyProbe() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { ready: false, reason: 'missing_canvas' };
  const s = window.__lucidaCaptureReady;
  if (!s) return { ready: false, reason: 'missing_lucida_capture_ready' };
  const fc = Number(s.frameCount || 0), dc = Number(s.datasetCount || 0);
  const ready = Boolean(s.ready) && fc > 0 && dc > 0;
  return { ready, reason: ready ? 'rendered' : String(s.reason || 'not_ready'), frame_count: fc, dataset_count: dc };
}

// ---- the clock probe, run identically on the main thread and in a worker ----
//
// Spin on performance.now() and collect every DISTINCT non-zero delta. On a
// clamped clock there is exactly one: the clamp. Also measure how many of a
// batch of realistic short operations register as a zero-duration span, and
// what the same batch costs when timed in aggregate — that is the whole
// aggregation-vs-isolation argument, measured rather than asserted.
const CLOCK_PROBE = `(() => {
  const t_end = Date.now() + 1200;
  const deltas = new Map();
  let samples = 0, last = performance.now();
  while (Date.now() < t_end) {
    for (let i = 0; i < 2000; i++) {
      const n = performance.now();
      samples++;
      if (n !== last) {
        const d = +(n - last).toFixed(6);
        deltas.set(d, (deltas.get(d) || 0) + 1);
        last = n;
      }
    }
  }
  const distinct = [...deltas.entries()].sort((a, b) => a[0] - b[0]);

  // A stand-in for a fine pipeline stage: one lookup in a 20k-entry Map,
  // the shape of the per-chunk cache lookup the trace wants to time.
  const map = new Map();
  for (let i = 0; i < 20000; i++) map.set('level/0/0/' + i, i);
  const keys = [];
  for (let i = 0; i < 20000; i++) keys.push('level/0/0/' + ((i * 7919) % 20000));

  let zero = 0, nonzero = 0, sumIndividual = 0;
  for (let i = 0; i < keys.length; i++) {
    const a = performance.now();
    map.get(keys[i]);
    const b = performance.now();
    if (b === a) zero++; else { nonzero++; sumIndividual += (b - a); }
  }

  const a0 = performance.now();
  for (let i = 0; i < keys.length; i++) map.get(keys[i]);
  const a1 = performance.now();
  const batchTotalMs = a1 - a0;

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
      individual_sum_ms: +sumIndividual.toFixed(4),
      batch_total_ms: +batchTotalMs.toFixed(4),
      batch_per_op_us: +((batchTotalMs * 1000) / keys.length).toFixed(4),
    },
  };
})()`;

// The worker body is the same probe source, inlined into a blob worker.
const WORKER_SRC = 'self.onmessage = () => { postMessage(' + CLOCK_PROBE + '); };';
const WORKER_PROBE = `(() => new Promise((resolve) => {
  const src = ${JSON.stringify(WORKER_SRC)};
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const to = setTimeout(() => resolve({ error: 'worker_timeout' }), 30000);
  w.onmessage = (e) => { clearTimeout(to); w.terminate(); resolve(e.data); };
  w.onerror = (e) => { clearTimeout(to); resolve({ error: 'worker_error: ' + (e && e.message) }); };
  w.postMessage(0);
}))`;

async function dragTarget(page) {
  const t = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const hit = (x, y) => document.elementFromPoint(x, y) === c;
    for (const R of [Math.min(r.width, r.height) * 0.28, 120, 80, 50, 30, 15]) {
      for (let fy = 0.15; fy <= 0.86; fy += 0.05) {
        for (let fx = 0.15; fx <= 0.86; fx += 0.05) {
          const cx = r.x + r.width * fx, cy = r.y + r.height * fy;
          let ok = hit(cx, cy);
          for (let k = 0; ok && k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            ok = hit(cx + R * Math.cos(a), cy + R * Math.sin(a));
          }
          if (ok) return { cx, cy, R };
        }
      }
    }
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, R: Math.min(r.width, r.height) * 0.28, fallback: true };
  });
  return t;
}

async function pan(page, ms) {
  const tgt = await dragTarget(page);
  if (!tgt) return null;
  await page.mouse.move(tgt.cx, tgt.cy); await page.mouse.down();
  const t0 = Date.now(); let t = 0;
  while (Date.now() - t0 < ms) {
    t += 0.15;
    await page.mouse.move(tgt.cx + tgt.R * Math.cos(t), tgt.cy + tgt.R * Math.sin(t));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  return tgt;
}

(async () => {
  const messages = [];
  const failedRequests = [];
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true, executablePath: exe,
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check'],
    });
  } catch (e) { out({ ok: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0] }); process.exit(0); }

  const result = { ok: false, arm, url, dpr, clock: {}, ready: {}, doc_headers: null, failed_requests: failedRequests };
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.on('console', (m) => { try { messages.push('[' + m.type() + '] ' + m.text()); } catch (_) {} });
    page.on('pageerror', (e) => messages.push('[pageerror] ' + String(e && e.message ? e.message : e)));
    page.on('requestfailed', (r) => {
      try {
        failedRequests.push({ url: r.url().slice(0, 300), method: r.method(), type: r.resourceType(), failure: (r.failure() || {}).errorText || null });
      } catch (_) {}
    });

    const resp = await page.goto(url, { waitUntil: 'load', timeout: readyWaitMs });
    if (resp) {
      const h = resp.headers();
      result.doc_headers = {
        'cross-origin-opener-policy': h['cross-origin-opener-policy'] || null,
        'cross-origin-embedder-policy': h['cross-origin-embedder-policy'] || null,
      };
    }

    // Clock granularity does not need a rendered dataset — measure it early
    // so we still get an answer even if the open fails (which is itself the
    // result we are looking for in the isolated arm).
    result.clock.main = await page.evaluate(CLOCK_PROBE);
    result.clock.worker = await page.evaluate(WORKER_PROBE);

    let probe = null; const deadline = Date.now() + readyWaitMs;
    while (Date.now() < deadline) {
      probe = await page.evaluate(readyProbe);
      if (probe && probe.ready) break;
      await page.waitForTimeout(250);
    }
    result.ready.cold = probe;
    if (probe && probe.ready) {
      await page.waitForTimeout(settleMs);
      await page.screenshot({ path: outDir + '/' + arm + '-cold.png' });
      await pan(page, panMs);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: outDir + '/' + arm + '-pan.png' });
      result.ready.after_pan = await page.evaluate(readyProbe);
      // Re-measure the clock after real pipeline work, in case anything
      // about a busy page changes the granularity.
      result.clock.main_after_work = await page.evaluate(CLOCK_PROBE);
      result.ok = true;
    } else {
      result.reason = 'not_ready: ' + (probe ? probe.reason : 'unknown');
      await page.screenshot({ path: outDir + '/' + arm + '-notready.png' });
    }
    result.console_error_count = messages.filter((m) => m.startsWith('[error]') || m.startsWith('[pageerror]')).length;
    fs.writeFileSync(outDir + '/' + arm + '-console.log', messages.join('\n'));
    fs.writeFileSync(outDir + '/' + arm + '-summary.json', JSON.stringify(result, null, 2));
    out({ ok: result.ok, arm, out_dir: outDir, ready: result.ready, doc_headers: result.doc_headers, reason: result.reason || null });
  } catch (e) {
    try { fs.writeFileSync(outDir + '/' + arm + '-console.log', messages.join('\n')); } catch (_) {}
    try { fs.writeFileSync(outDir + '/' + arm + '-summary.json', JSON.stringify(result, null, 2)); } catch (_) {}
    out({ ok: false, arm, reason: 'driver_failed: ' + String(e && e.message ? e.message : e).split('\n')[0], out_dir: outDir });
  } finally { try { await browser.close(); } catch (_) {} }
  process.exit(0);
})();
