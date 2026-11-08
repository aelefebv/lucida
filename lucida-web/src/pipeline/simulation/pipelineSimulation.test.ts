// @vitest-environment happy-dom
/**
 * The pipeline loop, run to a fixed point at device pixel ratio 1 and 2.
 * A known stall runs as `it.fails`: its case passes while the view never
 * settles, and fails once it does, which is the cue to move it out of the
 * known stalls.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  describeScenario,
  expectSettled,
  initSimulationWasm,
  runScenario,
  type PhaseOutcome,
  type Scenario,
  type ScenarioSpec,
  type ScenarioStep,
  type SimulationRun,
} from "./harness.ts";
import { collection, singleImage, type PyramidSpec } from "./fixtures.ts";
import { rampSamples, type SourceChunk } from "./source.ts";
import type { ChannelFit } from "../autoContrast.ts";

beforeAll(initSimulationWasm);

const DEVICE_PIXEL_RATIOS = [1, 2];

/** One 64 × 64 plane of uint16 samples, the unit the budgets below are sized in. */
const CHUNK_64_BYTES = 64 * 64 * 2;

/**
 * A 1024-sample image fitted to the 640 × 400 canvas targets level 1 at
 * device pixel ratio 1 and level 0 at ratio 2, so the two ratios plan
 * different chunks.
 */
const IMAGE_1024: PyramidSpec = { shape: [1, 1, 1, 1024, 1024], chunk: [1, 64, 64], levels: 4 };

/** One case per device pixel ratio; a ratio in `stallsAt` runs as a known stall. */
function settles(scenario: Scenario, known?: { stallsAt: number[]; because: string }): void {
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    if (!known?.stallsAt.includes(dpr)) {
      it(`settles at device pixel ratio ${dpr}`, async () => {
        expectSettled(await runScenario(scenario, { dpr }));
      });
      continue;
    }
    // `it.fails` passes on any throw, and a broken harness must not pass as
    // the stall: its error is logged and the case returns, which fails it.
    it.fails(`settles at device pixel ratio ${dpr}; known stall: ${known.because}`, async () => {
      let run: SimulationRun;
      try {
        run = await runScenario(scenario, { dpr });
      } catch (err) {
        console.error(err);
        return;
      }
      expectSettled(run);
    });
  }
}

describe("a static single image", () => {
  settles(describeScenario({
    name: "static single image",
    dataset: singleImage({ id: "still", pyramid: IMAGE_1024 }),
  }));
});

describe("a static volume", () => {
  settles(describeScenario({
    name: "static volume",
    mode: "volume",
    dataset: singleImage({
      id: "block",
      pyramid: { shape: [1, 1, 64, 256, 256], chunk: [32, 32, 32], levels: 3 },
    }),
  }));
});

/** 36 tiles of one 128-sample pyramid, a coarse chunk per tile. */
const WIDE = collection({
  id: "wide",
  rows: 6,
  columns: 6,
  pyramid: { shape: [1, 1, 1, 128, 128], chunk: [1, 64, 64], levels: 2 },
});

describe("a wide collection with more tiles than the coarse budget holds", () => {
  // A coarse budget of 20 chunks, with the detail budget's spare room beside
  // it: the coarse floor grows with the layout, so the view covers it all.
  const scenario = describeScenario({
    name: "wide collection",
    dataset: WIDE,
    cache: { overviewBudgetBytes: 20 * CHUNK_64_BYTES },
    gpuComplete: false,
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles covering every tile at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      const [open] = run.phases;
      expect(open.quiescence).toBe("quiescent");
      expect(open.coarse).toEqual({ resident: 36, desired: 36 });
    });
  }
});

describe("a wide collection whose demand exceeds both budgets", () => {
  // 40 detail chunks and 20 coarse chunks of room. At ratio 1 the view wants
  // 36 detail and 36 coarse chunks, at ratio 2 it wants 144 and 36.
  const scenario = describeScenario({
    name: "wide collection over budget",
    dataset: WIDE,
    cache: { mainBudgetBytes: 40 * CHUNK_64_BYTES, overviewBudgetBytes: 20 * CHUNK_64_BYTES },
    gpuComplete: false,
    tickBound: 120,
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles covering less within the tick bound, without refetching, at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      const [open] = run.phases;
      expect(open.quiescence).toBe("coverage_limited");
      expect(open.coverage).toBeLessThan(1);
      // Whatever was admitted is resident, it fits the 60 chunks of room,
      // and each resident chunk took one request: nothing was evicted and
      // fetched again.
      expect(open.missingCpu).toEqual([]);
      const resident = open.detail.resident + open.coarse.resident;
      expect(resident).toBeLessThanOrEqual(60);
      expect(open.sourceRequests).toBe(resident);
    });
  }
});

describe("pending generated chunks that become available later", () => {
  settles(
    describeScenario({
      name: "pending generated chunks",
      dataset: singleImage({
        id: "generated",
        pyramid: { shape: [1, 1, 1, 1024, 1024], chunk: [1, 64, 64], levels: 2 },
        generatedCoarse: { readyAtMs: 1_000 },
      }),
    }),
  );
});

describe("a generated level published after the open", () => {
  // The level's geometry reaches the page half a second in, as a replaced
  // manifest with no scene epoch behind it. The view settles without a coarse
  // tier before then, so settling alone would not show the level was used.
  const scenario = describeScenario({
    name: "generated level published later",
    dataset: singleImage({
      id: "late",
      pyramid: { shape: [1, 1, 1, 1024, 1024], chunk: [1, 64, 64], levels: 2 },
      generatedCoarse: { publishedAtMs: 500, readyAtMs: 0 },
    }),
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`requests the new level and settles at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      expect(run.phases[0].coarse).toEqual({ resident: 16, desired: 16 });
    });
  }
});

describe("a Z and T scrub", () => {
  settles(describeScenario({
    name: "Z and T scrub",
    dataset: singleImage({
      id: "stack",
      pyramid: { shape: [2, 1, 32, 1024, 1024], chunk: [8, 128, 128], levels: 3 },
    }),
    // z 20 → 22 stays inside one chunk along Z; z 3 leaves it.
    steps: [{ scrub: { z: 20 } }, { scrub: { z: 22 } }, { scrub: { t: 1 } }, { scrub: { z: 3 } }],
  }));
});

describe("a full atlas with more wanted chunks than worker slots", () => {
  // On a 320 × 200 canvas the 512-sample image targets level 1 at ratio 1
  // and level 0 at ratio 2. 25 slots hold level 1's 16 chunks but not level
  // 0's 64. The chunks lie in a grid around the camera, so many share a
  // distance from it.
  settles(
    describeScenario({
      name: "full atlas",
      dataset: singleImage({
        id: "grid",
        pyramid: { shape: [1, 1, 1, 512, 512], chunk: [1, 64, 64], levels: 3 },
      }),
      viewport: [320, 200],
      gpuTotalBytes: 25 * CHUNK_64_BYTES,
      gpuComplete: false,
    }),
  );
});

describe("two mirror-image chunks and one worker slot", () => {
  // Two chunks side by side, centered in the view, so both sit at exactly one
  // distance from the camera. Each tier's pool has one slot, and neither chunk
  // may displace the other: each would come back evicted, be re-sent, and
  // displace it back.
  const scenario = describeScenario({
    name: "mirror-image chunks in a full atlas",
    dataset: singleImage({
      id: "pair",
      pyramid: { shape: [1, 1, 1, 64, 128], chunk: [1, 64, 64], levels: 1 },
    }),
    gpuTotalBytes: CHUNK_64_BYTES,
    gpuComplete: false,
  });
  // Two chunks in each of two tiers, each sent once: the one that does not fit
  // is refused, and not asked for again until the next plan.
  const MAX_SENDS = 2 * 2;
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles at device pixel ratio ${dpr} without the two trading the slot`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      expect(run.phases[0].chunksSent).toBeLessThanOrEqual(MAX_SENDS);
    });
  }
});

describe("a pan and zoom across a full atlas", () => {
  // The full-atlas image and slots, with a view that moves. Each step plans a
  // new wanted set, and the slots the planner no longer wants make room first.
  settles(
    describeScenario({
      name: "pan and zoom on a full atlas",
      dataset: singleImage({
        id: "grid",
        pyramid: { shape: [1, 1, 1, 512, 512], chunk: [1, 64, 64], levels: 3 },
      }),
      viewport: [320, 200],
      gpuTotalBytes: 25 * CHUNK_64_BYTES,
      gpuComplete: false,
      steps: [{ pan: [150, 40] }, { pan: [-300, -80] }, { zoom: 2 }, { zoom: 0.5 }],
    }),
  );
});

describe("a view that moves away and back", () => {
  // Room for everything, so every chunk the worker acknowledged stays held.
  const scenario = describeScenario({
    name: "pan away and back",
    dataset: singleImage({ id: "still", pyramid: IMAGE_1024 }),
    steps: [{ zoom: 2 }, { pan: [200, 100] }, { pan: [-200, -100] }],
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles at device pixel ratio ${dpr}, never resending a chunk the worker holds`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      for (const phase of run.phases) expect(phase.chunksSent, phase.label).toBe(phase.distinctChunksSent);
      expect(run.phases[run.phases.length - 1].chunksSent).toBe(0);
    });
  }
});

describe("a zoom, pan and orbit inside a volume with a full atlas", () => {
  // 24 slots for a level of 128 chunks: every move changes which of them the
  // view wants nearest, and the pool keeps trading slots.
  settles(describeScenario({
    name: "volume moves on a full atlas",
    mode: "volume",
    dataset: singleImage({
      id: "block",
      pyramid: { shape: [1, 2, 64, 256, 256], chunk: [32, 32, 32], levels: 3 },
    }),
    gpuTotalBytes: 24 * 32 * 32 * 32 * 2,
    gpuComplete: false,
    steps: [{ zoom: 4 }, { orbit: [0.6, 0.3] }, { pan: [120, 60] }, { orbit: [-1.2, -0.4] }],
  }));
});

describe("a two-timepoint volume whose detail budget holds the view but not its prefetch", () => {
  // The view wants level 0 of the first timepoint, 128 chunks, and prefetch
  // asks for the same 128 of the second. Only what the view leaves is
  // prefetch's, even at the center, and an evicted prefetch chunk is no
  // reason to wait.
  const block = singleImage({
    id: "block",
    pyramid: { shape: [2, 1, 64, 256, 256], chunk: [32, 32, 32], levels: 3 },
  });
  const CHUNK_32_CUBE_BYTES = 32 * 32 * 32 * 2;
  const steps: ScenarioStep[] = [{ zoom: 2 }, { orbit: [0.5, 0.2] }, { zoom: 0.5 }];
  const fits = describeScenario({
    name: "volume prefetch beyond the detail budget",
    mode: "volume",
    dataset: block,
    cache: { mainBudgetBytes: 140 * CHUNK_32_CUBE_BYTES },
    steps,
  });
  const short = describeScenario({
    name: "volume view beyond the detail budget",
    mode: "volume",
    dataset: block,
    cache: { mainBudgetBytes: 100 * CHUNK_32_CUBE_BYTES },
    gpuComplete: false,
    steps,
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles covering the whole view in every phase at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(fits, { dpr });
      expectSettled(run);
      for (const phase of run.phases) {
        expect(phase.quiescence, phase.label).toBe("quiescent");
        expect(phase.detail.resident, phase.label).toBe(phase.detail.desired);
      }
    });
    it(`settles covering less in every phase when the view itself does not fit at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(short, { dpr });
      expectSettled(run);
      for (const phase of run.phases) {
        expect(phase.quiescence, phase.label).toBe("coverage_limited");
        expect(phase.detail.resident, phase.label).toBe(100);
      }
    });
  }
});

describe("a zoom and pan across a collection", () => {
  settles(describeScenario({
    name: "collection moves",
    dataset: collection({
      id: "tiles",
      rows: 3,
      columns: 4,
      pyramid: { shape: [1, 2, 1, 256, 256], chunk: [1, 64, 64], levels: 3 },
    }),
    steps: [{ zoom: 3 }, { pan: [300, 0] }, { pan: [0, 200] }, { zoom: 0.33 }],
  }));
});

describe("a transient source failure", () => {
  // The coarse chunk is wanted at both ratios. It fails its first request
  // and the in-fetch retry, then would succeed.
  settles(
    describeScenario({
      name: "transient source failure",
      dataset: singleImage({ id: "flaky", pyramid: IMAGE_1024 }),
      source: {
        answer: (req) => (req.chunkKey === "3/0/0/0/0/0" && req.attempt <= 2 ? "transient" : "ready"),
      },
    }),
  );
});

describe("a permanent source failure", () => {
  // The coarse chunk is wanted at both ratios, and the source answers it with
  // bytes that will not decode. Nothing asks for it again, so the view
  // settles without it and says why, instead of waiting for it forever.
  const scenario = describeScenario({
    name: "permanent source failure",
    dataset: singleImage({ id: "broken", pyramid: IMAGE_1024 }),
    source: {
      answer: (req) =>
        req.chunkKey === "3/0/0/0/0/0"
          ? { status: "failed_permanent", failure: "corrupt_chunk" }
          : "ready",
    },
    // The worker still wants the chunk that failed.
    gpuComplete: false,
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles at device pixel ratio ${dpr} with the failure named`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      const [open] = run.phases;
      expect(open.failed).toEqual(["broken/broken-image/3/0/0/0/0/0: corrupt_chunk"]);
      // The failed chunk is the only one the view goes without, and it was
      // asked for once: a permanent failure is not retried.
      expect(open.missingGpu).toHaveLength(1);
      expect(open.missingGpu[0]).toContain("3/0/0/0/0/0");
      expect(open.missingGpu[0]).toContain("source answered corrupt_chunk (1 request)");
      // The renderer is told, so the chunk draws as failed rather than as nothing.
      expect(open.drawnFailed).toEqual(["broken-image:ch0 coarse level 3 cell 0,0"]);
    });
  }
});

describe("a permanent source failure at the target level", () => {
  // The target is level 1 at ratio 1 and level 0 at ratio 2. Its corner
  // chunk fails, and the coarse tier holds data there. The cell draws as
  // failed instead of falling through to the coarse stand-in, which would
  // pass for the target forever.
  const scenario = describeScenario({
    name: "permanent source failure at the target level",
    dataset: singleImage({ id: "broken", pyramid: IMAGE_1024 }),
    source: {
      answer: (req) =>
        /^[01]\/0\/0\/0\/0\/0$/.test(req.chunkKey)
          ? { status: "failed_permanent", failure: "wrong_size" }
          : "ready",
    },
    gpuComplete: false,
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`draws the failed chunk as failed at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      const target = dpr === 1 ? 1 : 0;
      const [open] = run.phases;
      expect(open.failed).toEqual([`broken/broken-image/${target}/0/0/0/0/0: wrong_size`]);
      expect(open.drawnFailed).toEqual([`broken-image:ch0 detail level ${target} cell 0,0`]);
    });
  }
});

describe("a permanent source failure in a volume", () => {
  const scenario = describeScenario({
    name: "permanent source failure in a volume",
    mode: "volume",
    dataset: singleImage({
      id: "block",
      pyramid: { shape: [1, 1, 64, 256, 256], chunk: [32, 32, 32], levels: 3 },
    }),
    source: {
      answer: (req) =>
        req.chunkKey === "2/0/0/1/0/0"
          ? { status: "failed_permanent", failure: "corrupt_chunk" }
          : "ready",
    },
    gpuComplete: false,
  });
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`draws the failed chunk as failed at device pixel ratio ${dpr}`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      const [open] = run.phases;
      expect(open.failed).toEqual(["block/block-image/2/0/0/1/0/0: corrupt_chunk"]);
      expect(open.drawnFailed).toEqual(["block-image:ch0 coarse level 2 cell 0,0,1"]);
    });
  }
});

describe("a source failure that outlasts its first backoff", () => {
  // The detail chunk in the view's corner fails its first four requests:
  // two fetches, each with its in-fetch retry. The view waits out one
  // backoff, fails again, and waits out a longer one before it lands.
  settles(
    describeScenario({
      name: "repeated source failure",
      dataset: singleImage({ id: "stubborn", pyramid: IMAGE_1024 }),
      source: {
        answer: (req) => (/^[0-2]\/0\/0\/0\/0\/0$/.test(req.chunkKey) && req.attempt <= 4 ? "transient" : "ready"),
      },
    }),
  );
});

describe("a Z scrub on a level downsampled along Z", () => {
  // 100 planes at level 0 and 50 at level 1, in chunks 8 planes deep. Plane
  // 16 is the first plane of level 1's chunk 1, where a proportional mapping
  // lands one plane short, in chunk 0; plane 15 is in chunk 0 either way.
  settles(
    describeScenario({
      name: "Z scrub on a Z-downsampled level",
      dataset: singleImage({
        id: "deep",
        pyramid: { shape: [1, 1, 100, 256, 256], chunk: [8, 64, 64], levels: 2, downsampleZ: true },
      }),
      steps: [{ scrub: { z: 15 } }, { scrub: { z: 16 } }],
    }),
  );
});

/** The last auto-contrast fit each channel got in a phase. */
function lastFits(phase: PhaseOutcome): Map<string, ChannelFit> {
  const out = new Map<string, ChannelFit>();
  for (const { datasetId, channel, fit } of phase.fits) out.set(`${datasetId}:${channel}`, fit);
  return out;
}

/** How many times each channel's limits moved in a phase. */
function fitCounts(phase: PhaseOutcome): number[] {
  const counts = new Map<string, number>();
  for (const { datasetId, channel } of phase.fits) {
    const key = `${datasetId}:${channel}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()];
}

/**
 * A latency per chunk from a hash of its key, so chunks arrive out of plan
 * order. `reversed` turns that order around.
 */
function scatteredLatency(reversed: boolean): (chunk: SourceChunk) => number {
  return (chunk) => {
    let h = 0;
    for (const ch of `${chunk.imageId}/${chunk.chunkKey}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    const spread = h % 60;
    return 10 + (reversed ? 59 - spread : spread);
  };
}

describe("auto-contrast limits", () => {
  const views: Array<Omit<ScenarioSpec, "source">> = [
    {
      name: "single image over a generated coarse level",
      dataset: singleImage({
        id: "flat",
        pyramid: { shape: [1, 1, 1, 1024, 1024], chunk: [1, 64, 64], levels: 2 },
        generatedCoarse: { readyAtMs: 0 },
      }),
    },
    { name: "single image over a source coarse level", dataset: singleImage({ id: "pyramid", pyramid: IMAGE_1024 }) },
    {
      name: "volume",
      mode: "volume",
      dataset: singleImage({ id: "cube", pyramid: { shape: [1, 1, 64, 256, 256], chunk: [32, 32, 32], levels: 3 } }),
    },
    {
      name: "two-channel collection",
      dataset: collection({
        id: "plate",
        rows: 3,
        columns: 4,
        pyramid: { shape: [1, 2, 1, 256, 256], chunk: [1, 64, 64], levels: 2 },
      }),
    },
  ];

  for (const view of views) {
    for (const dpr of DEVICE_PIXEL_RATIOS) {
      it(`gives a ${view.name} one set of limits in any arrival order at device pixel ratio ${dpr}`, async () => {
        const forward = await runScenario(
          describeScenario({ ...view, source: { latencyMs: scatteredLatency(false) } }),
          { dpr },
        );
        const reversed = await runScenario(
          describeScenario({ ...view, source: { latencyMs: scatteredLatency(true) } }),
          { dpr },
        );
        expectSettled(forward);
        expectSettled(reversed);
        // The same chunks, in another order.
        expect([...reversed.served].sort()).toEqual([...forward.served].sort());
        expect(reversed.served).not.toEqual(forward.served);

        const limits = lastFits(forward.phases[0]);
        expect(limits.size).toBeGreaterThan(0);
        expect(lastFits(reversed.phases[0])).toEqual(limits);
        for (const run of [forward, reversed]) {
          // At most a stand-in and then the settled fit.
          for (const count of fitCounts(run.phases[0])) expect(count).toBeLessThanOrEqual(2);
          for (const fit of lastFits(run.phases[0]).values()) expect(fit.provisional).toBe(false);
        }
      });
    }
  }

  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`keeps a generated coarse level's limits through pans and zooms at device pixel ratio ${dpr}`, async () => {
      // The zoom and the pans at it bring in chunks the view did not read
      // before; the generated level arrives after the first of them.
      const run = await runScenario(
        describeScenario({
          name: "pans and zooms over a generated coarse level",
          dataset: singleImage({
            id: "roam",
            pyramid: { shape: [1, 1, 1, 2048, 2048], chunk: [1, 64, 64], levels: 3 },
            generatedCoarse: { readyAtMs: 300 },
          }),
          source: { latencyMs: scatteredLatency(false) },
          steps: [{ zoom: 3 }, { pan: [400, 200] }, { pan: [-700, -350] }, { zoom: 0.25 }],
        }),
        { dpr },
      );
      expectSettled(run);
      const fitted = lastFits(run.phases[0]);
      expect(fitted.size).toBe(1);
      for (const fit of fitted.values()) expect(fit.provisional).toBe(false);
      for (const phase of run.phases.slice(1, 4)) {
        expect(phase.distinctChunksSent, `${phase.label} brings in chunks`).toBeGreaterThan(0);
      }
      for (const phase of run.phases.slice(1)) {
        expect(phase.fits, `${phase.label} keeps the limits`).toEqual([]);
      }
    });
  }

  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`leaves a generated level out of the settled limits at device pixel ratio ${dpr}`, async () => {
      const dataset = singleImage({
        id: "lifted",
        pyramid: { shape: [1, 1, 1, 1024, 1024], chunk: [1, 64, 64], levels: 2 },
        generatedCoarse: { readyAtMs: 0 },
      });
      const generatedLevel = dataset.generated!.levelIndex;
      // Max-pooling lifts a generated level's values; these sit far above the source's.
      const lifted = (chunk: SourceChunk, count: number): Uint16Array<ArrayBuffer> =>
        Number(chunk.chunkKey.split("/")[0]) === generatedLevel
          ? new Uint16Array(count).fill(60_000)
          : rampSamples(chunk, count);
      const plain = await runScenario(describeScenario({ name: "plain generated level", dataset }), { dpr });
      const bright = await runScenario(
        describeScenario({ name: "lifted generated level", dataset, source: { samples: lifted } }),
        { dpr },
      );
      expectSettled(plain);
      expectSettled(bright);
      expect(lastFits(bright.phases[0])).toEqual(lastFits(plain.phases[0]));
      for (const fit of lastFits(bright.phases[0]).values()) expect(fit.limits.max).toBeLessThan(60_000);
    });
  }
});
