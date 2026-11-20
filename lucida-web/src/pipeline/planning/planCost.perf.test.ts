/**
 * What one planning pass costs on the main thread, from the snapshot to the
 * sorted plan, the level selection included, for the shapes the viewer
 * meets: a small collection, a multichannel timeseries volume, and a
 * collection wide enough that the plan's crossings into the core carry
 * thousands of entities. Read the logged p50s.
 */
import { beforeAll, describe, it } from "vitest";
import { WasmScene } from "lucida-core";

import { describeTiming, expectWithinBudget, timeStep } from "../../test/perfBudget.ts";
import { parseResolvedLayers } from "../../resolvedLayers.ts";
import { loadWasm } from "../../viewProperties.ts";
import { collection, singleImage, type DatasetFixture } from "../simulation/fixtures.ts";
import { DESKTOP_BUDGETS } from "../../deviceBudget.ts";
import { DEFAULT_PLANNING_CONFIG } from "./config.ts";
import { initialLevelSelectionMemory, selectLevels, type LevelSelectionMemory } from "./levelSelection.ts";
import { plan } from "./plan.ts";
import { buildViewSnapshot } from "./snapshot.ts";
import { initialPlanningState, type PlanningSnapshot, type ViewSnapshotBase } from "./types.ts";

/** The page's budgets on a capable desktop. */
const BUDGET = { cpu: DESKTOP_BUDGETS.cpuMainBytes, gpu: DESKTOP_BUDGETS.gpuTotalBytes };

beforeAll(loadWasm);

/** A 1280 × 800 CSS canvas. */
const CANVAS: readonly [number, number] = [1280, 800];

interface Case {
  name: string;
  dataset: DatasetFixture;
  mode: "slice" | "volume";
  /** Applied after the open fits the camera. */
  commands: object[];
  /** In nominal microseconds, about twice the typical figure. */
  budgetUs: number;
}

const CASES: Case[] = [
  {
    name: "12-tile two-channel collection",
    dataset: collection({
      id: "tiles",
      rows: 3,
      columns: 4,
      pyramid: { shape: [1, 2, 1, 512, 512], chunk: [1, 128, 128], levels: 3 },
    }),
    mode: "slice",
    commands: [],
    budgetUs: 450,
  },
  {
    name: "three-channel two-timepoint volume",
    dataset: singleImage({
      id: "volume",
      pyramid: { shape: [2, 3, 128, 512, 512], chunk: [64, 64, 64], levels: 3, downsampleZ: true },
    }),
    mode: "volume",
    commands: [{ type: "arcball_zoom", delta: -0.5 }],
    budgetUs: 550,
  },
  {
    name: "1,600-tile collection",
    dataset: collection({
      id: "wide",
      rows: 40,
      columns: 40,
      pyramid: { shape: [1, 1, 1, 256, 256], chunk: [1, 128, 128], levels: 2 },
    }),
    mode: "slice",
    commands: [],
    budgetUs: 11_000,
  },
];

function snapshotFor(c: Case, dpr: number): { base: ViewSnapshotBase; scene: WasmScene } {
  const scene = new WasmScene(CANVAS[0] * dpr, CANVAS[1] * dpr);
  scene.apply_command(c.dataset.openCommand);
  scene.set_viewport(CANVAS[0] * dpr, CANVAS[1] * dpr, dpr);
  if (c.mode === "volume") scene.apply_command(JSON.stringify({ type: "set_mode_arcball" }));
  for (const command of c.commands) scene.apply_command(JSON.stringify(command));
  const view = scene.active_view();
  const layer = parseResolvedLayers(scene.resolved_layers(view)).get(c.dataset.datasetId);
  const built = buildViewSnapshot({
    scene,
    view,
    datasetId: c.dataset.datasetId,
    dataset: { manifest: c.dataset.manifest },
    layer,
    mode: c.mode,
  });
  if (!built) throw new Error(`${c.name}: no snapshot`);
  return { base: built, scene };
}

/** One pass: the level selection, then the plan from it. */
function planPass(c: Case, base: ViewSnapshotBase, memory: LevelSelectionMemory) {
  const views = [{ view: base.view, datasets: [{ datasetId: c.dataset.datasetId, view: base, manifest: c.dataset.manifest }], area: 1 }];
  const selected = selectLevels(views, BUDGET, memory, DEFAULT_PLANNING_CONFIG);
  const snapshot: PlanningSnapshot = {
    datasetId: c.dataset.datasetId,
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    views: [{ ...base, levelSelection: selected.byView.get(base.view)!.get(c.dataset.datasetId)! }],
    minimapPending: new Map(),
  };
  return { plan: plan(snapshot, initialPlanningState()), memory: selected.memory };
}

describe("planning cost per pass", () => {
  for (const c of CASES) {
    for (const dpr of [1, 2]) {
      it(`${c.name} at device pixel ratio ${dpr}`, () => {
        const { base, scene } = snapshotFor(c, dpr);
        try {
          // A view that zoomed in since its last selection, so the selection
          // looks ahead to the next finer chunks.
          const zoomedOut = { ...base, visibleRegion: { ...base.visibleRegion, effectiveZoom: base.visibleRegion.effectiveZoom / 2 } };
          const memory = planPass(c, zoomedOut, initialLevelSelectionMemory()).memory;
          const requests = planPass(c, base, memory).plan.requests.length;
          const timing = timeStep(() => planPass(c, base, memory), { samples: 60, warmup: 10 });
          console.log(`[plan] ${c.name} @${dpr}x, ${requests} requests: ${describeTiming(timing, c.budgetUs)}`);
          expectWithinBudget(`${c.name} @${dpr}x`, timing, c.budgetUs);
        } finally {
          scene.free();
        }
      });
    }
  }
});
