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
  type Scenario,
  type SimulationRun,
} from "./harness.ts";
import { collection, singleImage, type PyramidSpec } from "./fixtures.ts";

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

describe("a wide collection with more tiles than the coarse budget holds", () => {
  // 36 tiles, one coarse chunk each, against a coarse budget of 20 chunks.
  settles(
    describeScenario({
      name: "wide collection",
      dataset: collection({
        id: "wide",
        rows: 6,
        columns: 6,
        pyramid: { shape: [1, 1, 1, 128, 128], chunk: [1, 64, 64], levels: 2 },
      }),
      cache: { overviewBudgetBytes: 20 * CHUNK_64_BYTES },
      // The view wants more than the budget holds, so covering less is the settled state.
      gpuComplete: false,
    }),
    {
      stallsAt: [1, 2],
      because: "the wanted set ignores the coarse budget, and settle has no covering-less state",
    },
  );
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
      atlas: { sliceAtlasBytes: 25 * CHUNK_64_BYTES },
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
    atlas: { sliceAtlasBytes: CHUNK_64_BYTES },
    gpuComplete: false,
  });
  // Two chunks in each of two tiers. Each goes at most twice: once, and again
  // after a cold state clears the refusal of the one that did not fit.
  const MAX_SENDS = 2 * 4;
  for (const dpr of DEVICE_PIXEL_RATIOS) {
    it(`settles at device pixel ratio ${dpr} without the two trading the slot`, async () => {
      const run = await runScenario(scenario, { dpr });
      expectSettled(run);
      expect(run.phases[0].chunksSent).toBeLessThanOrEqual(MAX_SENDS);
    });
  }
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
