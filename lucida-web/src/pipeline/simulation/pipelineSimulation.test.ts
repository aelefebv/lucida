// @vitest-environment happy-dom
/**
 * The pipeline loop, run to a fixed point at device pixel ratio 1 and 2.
 * A known stall runs as `it.fails`: its case passes while the view never
 * settles, and fails once it does, which is the cue to move it out of the
 * known stalls.
 */

import { beforeAll, describe, it } from "vitest";
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
    {
      stallsAt: [1, 2],
      because: "a chunk answered pending is not asked for again on a static view",
    },
  );
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
    {
      stallsAt: [2],
      because: "an incoming chunk displaces a resident one at the same distance, which is resent and displaces it back",
    },
  );
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
    {
      stallsAt: [1, 2],
      because: "a failed chunk's backoff is checked only when the view plans again, and a static view does not",
    },
  );
});

describe("a Z scrub on a level downsampled along Z", () => {
  // 100 planes at level 0 and 50 at level 1, in chunks 8 planes deep. The
  // planner puts plane 16 in level 1's chunk 1 and the worker in chunk 0;
  // plane 15 is in chunk 0 for both.
  settles(
    describeScenario({
      name: "Z scrub on a Z-downsampled level",
      dataset: singleImage({
        id: "deep",
        pyramid: { shape: [1, 1, 100, 256, 256], chunk: [8, 64, 64], levels: 2, downsampleZ: true },
      }),
      steps: [{ scrub: { z: 15 } }, { scrub: { z: 16 } }],
    }),
    {
      stallsAt: [1, 2],
      because: "the planner and the worker map the plane to different chunks, so each delivery comes back wrong-slice",
    },
  );
});
