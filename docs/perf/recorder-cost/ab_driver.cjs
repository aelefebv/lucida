'use strict';
// Recorder A/B frame-throughput driver (issue #928, ADR 0049).
//
// Loads an already-opened viewer URL twice in one browser context and counts
// rendered frames over a fixed ten-second window on the SECOND load — the warm
// re-open, which is the shape #888 measured (1,148 frames in ten seconds,
// debug panel open against debug panel closed). One arm per bundle: the tree's
// real sink, and the same tree with `noop-sink.patch` applied.
//
// Frames come from `window.__lucidaCaptureReady.frameCount`, the counter the
// product already keeps for capture readiness — nothing is added to the page
// to measure it, so the arms differ only by the sink.
//
// devicePixelRatio 2 is not optional. DPR-1-only verification has hidden whole
// defect classes in this project, and at DPR 1 the render path is a quarter of
// the pixels and a different bottleneck entirely.
const fs = require('fs');
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let chromium = null;
try { ({ chromium } = require('playwright')); }
catch (e1) {
  try { ({ chromium } = require('@playwright/test')); }
  catch (e2) {
    out({ ok: false, reason: 'playwright_not_resolvable: ' + String(e2).split('\n')[0] });
    process.exit(0);
  }
}

const req = JSON.parse(process.argv[2]);
const { url, out_dir: outDir, arm } = req;
const exe = req.executable_path || undefined;
const width = req.width || 1600, height = req.height || 1000, dpr = req.device_scale_factor || 2;
const readyWaitMs = req.ready_wait_ms || 240000;
const settleMs = req.settle_ms || 8000;
const windowMs = req.window_ms || 10000;

function readyProbe() {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { ready: false, reason: 'missing_canvas' };
  const s = window.__lucidaCaptureReady;
  if (!s) return { ready: false, reason: 'missing_lucida_capture_ready' };
  const fc = Number(s.frameCount || 0), dc = Number(s.datasetCount || 0);
  const ready = Boolean(s.ready) && fc > 0 && dc > 0;
  return { ready, reason: ready ? 'rendered' : String(s.reason || 'not_ready'), frame_count: fc };
}
const frames = () => Number((window.__lucidaCaptureReady || {}).frameCount || 0);
// Present in both arms: the seam is unconditional (ADR 0051). Its absence in
// the no-op arm would mean the patch removed more than the sink.
const seam = () => (window.lucidaTrace ? window.lucidaTrace.schemaVersion : null);

// Keep the pipeline working for the whole window rather than measuring an
// idle viewer: the render loop is dirty-driven, so a still page draws nothing
// and both arms would tie at zero. A slow orbit round the canvas centre is the
// same drive the #888 harness used.
async function drive(page, ms) {
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
  if (!t) return null;
  await page.mouse.move(t.cx, t.cy);
  await page.mouse.down();
  const t0 = Date.now();
  let a = 0;
  while (Date.now() - t0 < ms) {
    a += 0.15;
    await page.mouse.move(t.cx + t.R * Math.cos(a), t.cy + t.R * Math.sin(a));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  return t;
}

(async () => {
  const messages = [];
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: exe,
      args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check'],
    });
  } catch (e) {
    out({ ok: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0] });
    process.exit(0);
  }

  const result = { ok: false, arm, url, dpr, window_ms: windowMs };
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    page.on('console', (m) => { try { messages.push('[' + m.type() + '] ' + m.text()); } catch (_) {} });
    page.on('pageerror', (e) => messages.push('[pageerror] ' + String(e && e.message ? e.message : e)));

    // Cold load: warms the HTTP cache, the server's caches and the source cache.
    await page.goto(url, { waitUntil: 'load', timeout: readyWaitMs });
    let probe = null; let deadline = Date.now() + readyWaitMs;
    while (Date.now() < deadline) { probe = await page.evaluate(readyProbe); if (probe && probe.ready) break; await page.waitForTimeout(200); }
    result.ready_cold = probe;
    if (!probe || !probe.ready) {
      result.reason = 'cold_not_ready: ' + (probe ? probe.reason : 'unknown');
      await page.screenshot({ path: outDir + '/' + arm + '-cold-notready.png' });
      fs.writeFileSync(outDir + '/' + arm + '-console.log', messages.join('\n'));
      out(result); process.exit(0);
    }
    await page.waitForTimeout(settleMs);

    // Warm re-open: the measured arm.
    const tReopen = Date.now();
    await page.reload({ waitUntil: 'load', timeout: readyWaitMs });
    probe = null; deadline = Date.now() + readyWaitMs;
    while (Date.now() < deadline) { probe = await page.evaluate(readyProbe); if (probe && probe.ready) break; await page.waitForTimeout(100); }
    result.ready_warm = probe;
    result.warm_first_render_ms = Date.now() - tReopen;
    if (!probe || !probe.ready) {
      result.reason = 'warm_not_ready: ' + (probe ? probe.reason : 'unknown');
      fs.writeFileSync(outDir + '/' + arm + '-console.log', messages.join('\n'));
      out(result); process.exit(0);
    }
    result.trace_seam_schema = await page.evaluate(seam);

    const before = await page.evaluate(frames);
    const t0 = Date.now();
    result.drag_target = await drive(page, windowMs);
    const elapsed = Date.now() - t0;
    const after = await page.evaluate(frames);

    result.frames = after - before;
    result.elapsed_ms = elapsed;
    result.fps = (after - before) / (elapsed / 1000);
    await page.screenshot({ path: outDir + '/' + arm + '.png' });
    fs.writeFileSync(outDir + '/' + arm + '-console.log', messages.join('\n'));
    result.ok = true;
    fs.writeFileSync(outDir + '/' + arm + '-result.json', JSON.stringify(result, null, 2));
    out(result);
  } catch (e) {
    try { fs.writeFileSync(outDir + '/' + arm + '-console.log', messages.join('\n')); } catch (_) {}
    out({ ok: false, arm, reason: 'driver_failed: ' + String(e && e.message ? e.message : e).split('\n')[0] });
  } finally { try { await browser.close(); } catch (_) {} }
  process.exit(0);
})();
