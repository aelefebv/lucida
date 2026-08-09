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

const { CLOCK_PROBE, WORKER_PROBE } = require('./tr_clock.js');

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
    if (!result.clock.worker) result.clock.worker = { error: 'evaluate_returned_undefined' };

    let probe = null; const deadline = Date.now() + readyWaitMs;
    while (Date.now() < deadline) {
      probe = await page.evaluate(readyProbe);
      if (probe && probe.ready) break;
      await page.waitForTimeout(250);
    }
    result.ready.cold = probe;
    if (probe && probe.ready) {
      await page.waitForTimeout(settleMs);
      // Real lucida stages, instrumented by the throwaway patch. This is the
      // measurement the decision rests on — the synthetic fine_stage in the
      // clock probe is only a bound; these are the actual spans.
      result.stages_after_cold = await page.evaluate(() => (window.__trDump ? window.__trDump() : { error: 'no___trDump' }));
      await page.screenshot({ path: outDir + '/' + arm + '-cold.png' });
      await page.evaluate(() => { if (window.__trReset) window.__trReset(); });
      await pan(page, panMs);
      await page.waitForTimeout(2000);
      result.stages_pan = await page.evaluate(() => (window.__trDump ? window.__trDump() : { error: 'no___trDump' }));
      const shotPath = outDir + '/' + arm + '-pan.png';
      await page.screenshot({ path: shotPath });
      // Record real pixel dimensions so DPR2 is evidenced by the run itself.
      try {
        const buf = fs.readFileSync(shotPath);
        result.screenshot_px = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      } catch (_) {}
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
