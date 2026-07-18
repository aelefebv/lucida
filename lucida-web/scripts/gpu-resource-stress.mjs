/**
 * Real-browser WebGPU churn and idle-frame proofs.
 *
 * This intentionally stays outside the default unit suite: headless Chromium's
 * software build does not expose WebGPU on macOS, while installed Chrome does.
 * Run with `pnpm test:browser-contracts` on a WebGPU-capable workstation.
 * CI supplies `LUCIDA_BROWSER`; local runs default to installed Chrome and may
 * override `LUCIDA_CHROME_CHANNEL` for another Playwright channel.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  plugins: [{
    name: "gpu-resource-stress-page",
    configureServer(server) {
      server.middlewares.use("/gpu-resource-stress.html", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><meta charset=utf-8><title>GPU resource stress</title>");
      });
    },
  }],
  server: { host: "127.0.0.1" },
});

let browser;
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  assert(address && typeof address !== "string", "Vite did not expose a local port");

  const browserTarget = process.env.LUCIDA_BROWSER
    ? { executablePath: process.env.LUCIDA_BROWSER }
    : { channel: process.env.LUCIDA_CHROME_CHANNEL || "chrome" };
  const browserArgs = ["--enable-unsafe-webgpu"];
  if (process.platform === "linux") {
    browserArgs.push(
      "--enable-features=Vulkan,WebGPU",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
    );
  }
  browser = await chromium.launch({
    ...browserTarget,
    headless: true,
    args: browserArgs,
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/gpu-resource-stress.html`);

  const receipt = await page.evaluate(async () => {
    const { GpuBudgetExceededError, GpuResourceBudget } = await import(
      "/src/renderer/gpuResourceBudget.ts"
    );
    const { DemandDrivenAnimationFrame } = await import(
      "/src/demandDrivenAnimationFrame.ts"
    );
    const require = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
    const deadline = (promise, label) => Promise.race([
      promise,
      delay(2_000).then(() => { throw new Error(`${label} timed out`); }),
    ]);

    // Trace the production scheduler against the browser's actual RAF queue.
    // The page is otherwise empty, so every observed callback belongs to this
    // owner. An idle window must schedule/fire zero callbacks; a 10k-event
    // burst must coalesce to one; continuous work must stop on the exact frame
    // where the step returns false and later resume from one new event.
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    let scheduledFrames = 0;
    let firedFrames = 0;
    let cancelledFrames = 0;
    window.requestAnimationFrame = callback => {
      scheduledFrames++;
      return nativeRequest(timestamp => {
        firedFrames++;
        callback(timestamp);
      });
    };
    window.cancelAnimationFrame = id => {
      cancelledFrames++;
      nativeCancel(id);
    };

    const idleOwner = new DemandDrivenAnimationFrame(() => false);
    await delay(120);
    require(scheduledFrames === 0 && firedFrames === 0, "idle owner scheduled browser frames");

    let finishBurst;
    const burstDone = new Promise(resolve => { finishBurst = resolve; });
    const burstOwner = new DemandDrivenAnimationFrame(() => {
      finishBurst();
      return false;
    });
    for (let index = 0; index < 10_000; index++) burstOwner.wake();
    require(scheduledFrames === 1, "event burst did not coalesce to one browser frame");
    await deadline(burstDone, "event burst frame");
    require(firedFrames === 1 && !burstOwner.pending, "event burst did not settle exactly");
    await delay(80);
    require(scheduledFrames === 1 && firedFrames === 1, "settled burst kept browser RAF alive");

    let continuousSteps = 0;
    let finishContinuous;
    const continuousDone = new Promise(resolve => { finishContinuous = resolve; });
    const continuousOwner = new DemandDrivenAnimationFrame(() => {
      continuousSteps++;
      if (continuousSteps === 3) {
        finishContinuous();
        return false;
      }
      return true;
    });
    continuousOwner.wake();
    await deadline(continuousDone, "continuous frame sequence");
    require(!continuousOwner.pending, "continuous owner did not settle");
    require(scheduledFrames === 4 && firedFrames === 4, "continuous callback count drifted");
    await delay(80);
    require(scheduledFrames === 4 && firedFrames === 4, "settled continuous owner kept RAF alive");

    let finishResume;
    const resumeDone = new Promise(resolve => { finishResume = resolve; });
    const resumeOwner = new DemandDrivenAnimationFrame(() => {
      finishResume();
      return false;
    });
    resumeOwner.wake();
    await deadline(resumeDone, "resumed frame");
    require(scheduledFrames === 5 && firedFrames === 5, "event did not resume in one browser frame");
    idleOwner.dispose();
    burstOwner.dispose();
    continuousOwner.dispose();
    resumeOwner.dispose();
    window.requestAnimationFrame = nativeRequest;
    window.cancelAnimationFrame = nativeCancel;

    if (!navigator.gpu) throw new Error("This browser does not expose WebGPU");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    const resources = new GpuResourceBudget(32 * 1024 * 1024);

    device.pushErrorScope("validation");
    resources.createTexture(
      device,
      { key: "session:offscreen:0", kind: "offscreen" },
      {
        size: [64, 64],
        format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      },
    );
    const baseline = resources.snapshot();
    const layerCounts = [1, 10, 50, 256];
    let datasetCycles = 0;

    for (const layerCount of layerCounts) {
      for (let cycle = 0; cycle < 8; cycle++) {
        const datasetId = `browser-${layerCount}-${cycle}`;
        for (let channel = 0; channel < 4; channel++) {
          for (const tier of ["detail", "coarse"]) {
            resources.createTexture(
              device,
              {
                key: `${datasetId}:${channel}:${tier}:atlas`,
                kind: tier === "detail" ? "volume-atlas" : "slice-atlas",
                datasetId,
              },
              {
                size: [8, 8, 2],
                dimension: "3d",
                format: "r16uint",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              },
            );
            resources.createBuffer(
              device,
              {
                key: `${datasetId}:${channel}:${tier}:indirection`,
                kind: "buffer",
                datasetId,
              },
              { size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
            );
          }
        }
        resources.createBuffer(
          device,
          { key: `${datasetId}:descriptor`, kind: "descriptor", datasetId },
          {
            size: layerCount * 128,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          },
        );

        resources.destroyDataset(datasetId);
        resources.destroyDataset(datasetId);
        const settled = resources.snapshot();
        if (
          settled.usedBytes !== baseline.usedBytes ||
          settled.allocationCount !== baseline.allocationCount ||
          Object.keys(settled.byDataset).length !== 0
        ) {
          throw new Error(`dataset teardown did not return to baseline: ${datasetId}`);
        }
        datasetCycles++;
      }
    }

    const beforeFailure = resources.snapshot();
    let rejected = false;
    try {
      resources.createTexture(
        device,
        { key: "too-large", kind: "offscreen" },
        {
          size: [2048, 2048, 4],
          dimension: "3d",
          format: "rgba16float",
          usage: GPUTextureUsage.TEXTURE_BINDING,
        },
      );
    } catch (error) {
      rejected = error instanceof GpuBudgetExceededError;
    }
    const afterFailure = resources.snapshot();
    if (
      !rejected ||
      afterFailure.usedBytes !== beforeFailure.usedBytes ||
      afterFailure.allocationCount !== beforeFailure.allocationCount
    ) {
      throw new Error("failed allocation did not preserve the exact baseline");
    }

    resources.destroyAll();
    await device.queue.onSubmittedWorkDone();
    const validationError = await device.popErrorScope();
    const final = resources.snapshot();
    device.destroy();
    if (validationError) throw new Error(validationError.message);
    if (
      final.usedBytes !== 0 ||
      final.allocationCount !== 0 ||
      final.createdCount !== final.destroyedCount ||
      final.createdBytes !== final.destroyedBytes
    ) {
      throw new Error("final destruction accounting is not exact");
    }

    return {
      adapter: true,
      idleTrace: {
        idleWindowMs: 120,
        burstWakeCount: 10_000,
        continuousSteps,
        scheduledFrames,
        firedFrames,
        cancelledFrames,
      },
      datasetCycles,
      channels: 4,
      tiers: 2,
      layerCounts,
      peakBytes: final.peakBytes,
      createdCount: final.createdCount,
      destroyedCount: final.destroyedCount,
      createdBytes: final.createdBytes,
      destroyedBytes: final.destroyedBytes,
    };
  });

  assert.equal(receipt.datasetCycles, 32);
  assert.deepEqual(receipt.idleTrace, {
    idleWindowMs: 120,
    burstWakeCount: 10_000,
    continuousSteps: 3,
    scheduledFrames: 5,
    firedFrames: 5,
    cancelledFrames: 0,
  });
  assert.deepEqual(receipt.layerCounts, [1, 10, 50, 256]);
  assert.equal(receipt.createdCount, receipt.destroyedCount);
  assert.equal(receipt.createdBytes, receipt.destroyedBytes);
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await vite.close();
}
