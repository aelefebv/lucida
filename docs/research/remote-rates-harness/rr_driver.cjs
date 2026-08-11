'use strict';
// Remote-rate driver (issue #899). Adapted from tv_driver.cjs (#888). Drives the
// real lucida SPA at DPR2 against an already-opened REMOTE dataset and dumps
// window.__tv event counters + latency distributions per phase. Each phase also
// records its wall-clock window so server-side RRGET/RRBAK lines in server.log
// can be bucketed to the same phase. Phases:
//   cold   — first load of the viewer URL in a fresh context, until first render + settle
//   warm   — full page reload in the same context (HTTP cache + server caches warm)
//   pan    — camera drag
//   zoom   — wheel zoom in/out
//   idle   — post-interaction quiescence (how many ticks a still viewer costs)
// Also samples JS heap around a monitor-relevant window and records the existing
// telemetry's own footprint via cpuCache/upload telemetry read paths where reachable.
const fs = require('fs');
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let chromium = null;
try { ({ chromium } = require('playwright')); }
catch (e1) { try { ({ chromium } = require('@playwright/test')); }
  catch (e2) { out({ ok: false, reason: 'playwright_not_resolvable: ' + String(e2).split('\n')[0] }); process.exit(0); } }

const req = JSON.parse(process.argv[2]);
const { url, out_dir: outDir } = req;
const exe = req.executable_path || undefined;
const width = req.width || 1600, height = req.height || 1000, dpr = req.device_scale_factor || 2;
const readyWaitMs = req.ready_wait_ms || 180000;
const settleMs = req.settle_ms || 8000;
const panMs = req.pan_ms || 10000;
const zoomMs = req.zoom_ms || 8000;
const idleMs = req.idle_ms || 5000;

function readyProbe() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { ready: false, reason: 'missing_canvas' };
  const cw = canvas.width || Math.floor(canvas.clientWidth);
  const ch = canvas.height || Math.floor(canvas.clientHeight);
  if (!cw || !ch) return { ready: false, reason: 'zero_size_canvas' };
  const s = window.__lucidaCaptureReady;
  if (!s) return { ready: false, reason: 'missing_lucida_capture_ready', canvas_width: cw, canvas_height: ch };
  const fc = Number(s.frameCount || 0), dc = Number(s.datasetCount || 0);
  const ready = Boolean(s.ready) && fc > 0 && dc > 0;
  return { ready, reason: ready ? 'rendered' : String(s.reason || 'not_ready'), frame_count: fc, dataset_count: dc, canvas_width: cw, canvas_height: ch };
}
const dump = () => (window.__tvDump ? window.__tvDump() : { error: 'no___tvDump' });
const reset = () => { if (window.__tvReset) window.__tvReset(); };
const heap = () => {
  const m = performance.memory;
  return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize } : null;
};

async function canvasBox(page) {
  const b = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  return b || { x: 0, y: 0, w: width, h: height };
}
// Pick a drag centre + radius whose whole circle lands on the canvas and is not
// covered by any floating panel (elementFromPoint must return the canvas).
async function dragTarget(page) {
  const t = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const hit = (x, y) => document.elementFromPoint(x, y) === c;
    let best = null;
    for (const R of [Math.min(r.width, r.height) * 0.28, 120, 80, 50, 30, 15]) {
      for (let fy = 0.15; fy <= 0.86; fy += 0.05) {
        for (let fx = 0.15; fx <= 0.86; fx += 0.05) {
          const cx = r.x + r.width * fx, cy = r.y + r.height * fy;
          let ok = hit(cx, cy);
          for (let k = 0; ok && k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            ok = hit(cx + R * Math.cos(a), cy + R * Math.sin(a));
          }
          if (ok) { best = { cx, cy, R }; break; }
        }
        if (best) break;
      }
      if (best) break;
    }
    return best || { cx: r.x + r.width / 2, cy: r.y + r.height / 2, R: Math.min(r.width, r.height) * 0.28, fallback: true };
  });
  return t;
}
async function pan(page, ms, rec, label) {
  const tgt = await dragTarget(page);
  if (rec) rec[label] = tgt;
  const cx = tgt.cx, cy = tgt.cy, R = tgt.R;
  await page.mouse.move(cx, cy); await page.mouse.down();
  const t0 = Date.now(); let t = 0;
  while (Date.now() - t0 < ms) { t += 0.15; await page.mouse.move(cx + R * Math.cos(t), cy + R * Math.sin(t)); await page.waitForTimeout(16); }
  await page.mouse.up();
}
async function zoom(page, ms) {
  const tgt = await dragTarget(page);
  const cx = tgt.cx, cy = tgt.cy;
  await page.mouse.move(cx, cy);
  const t0 = Date.now(); let dir = -1, n = 0;
  while (Date.now() - t0 < ms) {
    await page.mouse.wheel(0, dir * 120); n++;
    if (n % 12 === 0) dir = -dir;
    await page.waitForTimeout(40);
  }
}

(async () => {
  const messages = [];
  let browser = null;
  try { browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--js-flags=--expose-gc'] }); }
  catch (e) { out({ ok: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0] }); process.exit(0); }

  const result = { ok: false, url, dpr, phases: {}, ready: {}, heap: {}, net: {}, windows: {} };
  const mark = (name, k) => { (result.windows[name] = result.windows[name] || {})[k] = Date.now(); };
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.on('console', (m) => { try { messages.push('[' + m.type() + '] ' + m.text()); } catch (_) {} });
    page.on('pageerror', (e) => messages.push('[pageerror] ' + String(e && e.message ? e.message : e)));

    // ---- COLD: fresh context, first navigation --------------------------------
    const netCold = { requests: 0, bytes: 0 };
    const onReq = (r) => { netCold.requests++; };
    page.on('request', onReq);
    const tCold = Date.now();
    mark('cold', 'start');
    await page.goto(url, { waitUntil: 'load', timeout: readyWaitMs });
    let probe = null; const deadline = Date.now() + readyWaitMs;
    while (Date.now() < deadline) { probe = await page.evaluate(readyProbe); if (probe && probe.ready) break; await page.waitForTimeout(200); }
    result.ready.cold = probe;
    const tFirstRender = Date.now() - tCold;
    if (!probe || !probe.ready) {
      result.reason = 'not_ready: ' + (probe ? probe.reason : 'unknown');
      await page.screenshot({ path: outDir + '/cold-notready.png' });
      fs.writeFileSync(outDir + '/console.log', messages.join('\n'));
      out(result); process.exit(0);
    }
    await page.waitForTimeout(settleMs); // let residency fill settle
    mark('cold', 'end');
    result.phases.cold = await page.evaluate(dump);
    result.phases.cold.first_render_ms = tFirstRender;
    result.phases.cold.settle_ms = settleMs;
    result.net.cold = netCold;
    result.canvas_box = await canvasBox(page);
    result.drag_target = await dragTarget(page);
    result.heap.after_cold = await page.evaluate(heap);
    await page.screenshot({ path: outDir + '/cold.png' });
    page.off('request', onReq);

    // ---- IDLE: quiescent viewer -----------------------------------------------
    await page.evaluate(reset);
    mark('idle', 'start');
    await page.waitForTimeout(idleMs);
    mark('idle', 'end');
    result.phases.idle = await page.evaluate(dump);

    // ---- PAN -------------------------------------------------------------------
    await page.evaluate(reset);
    mark('pan', 'start');
    await pan(page, panMs, result.targets = result.targets || {}, 'pan');
    mark('pan', 'end');
    result.phases.pan = await page.evaluate(dump);
    await page.screenshot({ path: outDir + '/pan.png' });

    // ---- ZOOM ------------------------------------------------------------------
    await page.evaluate(reset);
    mark('zoom', 'start');
    await zoom(page, zoomMs);
    mark('zoom', 'end');
    result.phases.zoom = await page.evaluate(dump);
    await page.screenshot({ path: outDir + '/zoom.png' });
    result.heap.after_interaction = await page.evaluate(heap);

    // ---- WARM RE-OPEN: reload the same viewer URL in the same context ----------
    const netWarm = { requests: 0 };
    const onReq2 = () => { netWarm.requests++; };
    page.on('request', onReq2);
    // #700's last-view capture is debounced by 3 s. Reloading sooner than
    // that loses the interacted camera, so the reload lands back on the
    // opening view and understates the warm case. Hold well past the debounce.
    await page.waitForTimeout(8000);
    const tWarm = Date.now();
    mark('warm', 'start');
    await page.reload({ waitUntil: 'load', timeout: readyWaitMs });
    let probe2 = null; const dl2 = Date.now() + readyWaitMs;
    while (Date.now() < dl2) { probe2 = await page.evaluate(readyProbe); if (probe2 && probe2.ready) break; await page.waitForTimeout(200); }
    result.ready.warm = probe2;
    const tWarmRender = Date.now() - tWarm;
    if (probe2 && probe2.ready) {
      await page.waitForTimeout(settleMs);
      mark('warm', 'end');
      result.phases.warm = await page.evaluate(dump);
      result.phases.warm.first_render_ms = tWarmRender;
      result.phases.warm.settle_ms = settleMs;
    }
    result.net.warm = netWarm;
    result.heap.after_warm = await page.evaluate(heap);
    await page.screenshot({ path: outDir + '/warm.png' });

    fs.writeFileSync(outDir + '/console.log', messages.join('\n'));
    fs.writeFileSync(outDir + '/rr-summary.json', JSON.stringify(result, null, 2));
    result.ok = true;
    out({ ok: true, out_dir: outDir, wrote: 'rr-summary.json', ready: result.ready });
  } catch (e) {
    try { fs.writeFileSync(outDir + '/console.log', messages.join('\n')); } catch (_) {}
    try { fs.writeFileSync(outDir + '/rr-summary.json', JSON.stringify(result, null, 2)); } catch (_) {}
    out({ ok: false, reason: 'driver_failed: ' + String(e && e.message ? e.message : e).split('\n')[0], out_dir: outDir });
  } finally { try { await browser.close(); } catch (_) {} }
  process.exit(0);
})();
