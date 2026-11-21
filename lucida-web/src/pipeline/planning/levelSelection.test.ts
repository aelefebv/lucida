import { beforeAll, describe, expect, it } from "vitest";

import type { DatasetManifest, LevelGeometry } from "../../manifestTypes.ts";
import { loadWasm } from "../../viewProperties.ts";
import { INTERACTION_RENDER_SCALE } from "../../components/volumeRenderScale.ts";
import { MIN_ADAPTIVE_SCALE } from "../../renderResolution.ts";
import { ANCESTOR_SCALE, DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import {
  fairShares,
  initialLevelSelectionMemory,
  selectLevels,
  type SelectionBytes,
  type SelectionView,
} from "./levelSelection.ts";
import { createSyntheticEntity } from "./synthetic.ts";
import type { EntitySnapshot, SelectionState, ViewSnapshotBase } from "./types.ts";
import type { VisibleRegion } from "../viewport.ts";

beforeAll(loadWasm);

function level(index: number, zyx: [number, number, number], chunk: [number, number, number]): LevelGeometry {
  const shape: [number, number, number, number, number] = [1, 1, ...zyx];
  const chunkShape: [number, number, number, number, number] = [1, 1, ...chunk];
  return {
    level_index: index,
    shape,
    chunk_shape: chunkShape,
    grid_shape: shape.map((n, i) => Math.ceil(n / chunkShape[i])) as LevelGeometry["grid_shape"],
    scale: [1, 1, 1, 1, 1],
  };
}

/** A volume `depth` deep and 2048 across, 64-sample chunks, five levels halving every axis. */
function pyramid(depth = 512): LevelGeometry[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const z = Math.max(1, depth >> i);
    const xy = 2048 >> i;
    return level(i, [z, xy, xy], [Math.min(64, z), Math.min(64, xy), Math.min(64, xy)]);
  });
}

function image(id: string, levels: LevelGeometry[], overrides: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return createSyntheticEntity({
    entityId: id,
    imageId: `${id}-image`,
    levels,
    coarseLevel: levels.length - 1,
    sourceLevels: levels.map((_, i) => i),
    ...overrides,
  });
}

function manifest(imageIds: string[]): DatasetManifest {
  return {
    images: imageIds.map((image_id) => ({ image_id, multiscale: { data_type: "uint16", levels: [] } })),
  } as unknown as DatasetManifest;
}

/** A slice view across the image's middle plane at `pixelsPerSample`. */
function sliceView(view: number, entities: EntitySnapshot[], pixelsPerSample: number, z = 256): ViewSnapshotBase {
  const region: VisibleRegion = {
    xyBoundsVox: [0, 0, 2048, 2048],
    zRangeVox: [z, z + 1],
    effectiveZoom: pixelsPerSample,
    sortCenterVox: null,
    frustumPlanes: null,
  };
  const selection: SelectionState = {
    t: 0,
    z,
    cut: { axis: "z", index: z },
    visibleChannels: [0],
    renderMode: "slice",
    interactionState: "idle",
  };
  return { view, entities, visibleRegion: region, selection };
}

function viewOf(view: ViewSnapshotBase, area = 1): SelectionView {
  const ids = view.entities.map((entity) => entity.imageId);
  return { view: view.view, datasets: [{ datasetId: "ds", view, manifest: manifest(ids) }], area };
}

const ROOMY: SelectionBytes = { cpu: 1e12, gpu: 1e12 };

function select(views: SelectionView[], budget = ROOMY, config: PlanningConfig = DEFAULT_PLANNING_CONFIG) {
  return selectLevels(views, budget, initialLevelSelectionMemory(), config);
}

describe("selectLevels", () => {
  it("draws a slice view at its target level when it fits, with nothing at the coarse tier", () => {
    // Half a pixel per sample calls for level 1.
    const entity = image("a", pyramid());
    const result = select([viewOf(sliceView(0, [entity], 0.5))]);
    const chosen = result.byView.get(0)!.get("ds")!;
    expect(chosen.budgetLimited).toBe(false);
    const a = chosen.entities.get("a")!;
    expect(a.detailLevels).toEqual([1]);
    expect(a.coarseCells).toBe(0);
    // 1024 samples across at level 1 is 16 by 16 chunks on the one plane.
    expect(a.detail).toHaveLength(256);
    expect(new Set(a.detail.map((cell) => cell.z))).toEqual(new Set([2]));
  });

  it("ranks a slice view's chunks center out", () => {
    const entity = image("a", pyramid());
    const a = select([viewOf(sliceView(0, [entity], 0.5))]).byView.get(0)!.get("ds")!.entities.get("a")!;
    const first = a.detail.reduce((best, cell) => (cell.rank < best.rank ? cell : best));
    expect([first.x, first.y].every((v) => v === 7 || v === 8)).toBe(true);
  });

  it("charges a slice view the band of planes it holds, not the whole chunk", () => {
    // At Z 300, level 1's plane 150 lies 22 planes into its chunk. Its 256
    // chunks on the plane are 512 KiB each whole, and the five-plane band
    // of each is 40 KiB: the bands fit a 16 MiB budget, the whole chunks
    // would not.
    const entity = image("a", pyramid());
    const budget = { cpu: 16 * 2 ** 20, gpu: 1e12 };
    const result = select([viewOf(sliceView(0, [entity], 0.5, 300))], budget);
    const chosen = result.byView.get(0)!.get("ds")!;
    expect(chosen.entities.get("a")!.detailLevels).toEqual([1]);
    expect(chosen.budgetLimited).toBe(false);
    expect(result.summaries.get(0)!.used.cpu).toBe(256 * 64 * 64 * 2 * 5);
  });

  it("draws coarser than the target when the budget cannot hold it, and says the budget stopped it", () => {
    const entity = image("a", pyramid());
    const budget = { cpu: 2 ** 20, gpu: 1e12 };
    const result = select([viewOf(sliceView(0, [entity], 0.5))], budget);
    const chosen = result.byView.get(0)!.get("ds")!;
    expect(chosen.budgetLimited).toBe(true);
    expect(Math.min(...chosen.entities.get("a")!.detailLevels)).toBeGreaterThan(1);
    const summary = result.summaries.get(0)!;
    expect(summary.used.cpu).toBeLessThanOrEqual(summary.share.cpu);
    expect(summary.share.cpu).toBe(budget.cpu * DEFAULT_PLANNING_CONFIG.selectionShare);
    expect(summary.limit).toBeGreaterThan(1);
  });

  it("keeps the levels it chose while the zoom moves inside the band", () => {
    const entity = image("a", pyramid());
    const first = selectLevels([viewOf(sliceView(0, [entity], 0.48))], ROOMY, initialLevelSelectionMemory(), DEFAULT_PLANNING_CONFIG);
    expect(first.byView.get(0)!.get("ds")!.entities.get("a")!.detailLevels).toEqual([1]);
    const fresh = select([viewOf(sliceView(0, [entity], 0.52))]);
    expect(fresh.byView.get(0)!.get("ds")!.entities.get("a")!.detailLevels).toEqual([0]);
    const held = selectLevels([viewOf(sliceView(0, [entity], 0.52))], ROOMY, first.memory, DEFAULT_PLANNING_CONFIG);
    expect(held.byView.get(0)!.get("ds")!.entities.get("a")!.detailLevels).toEqual([1]);
  });

  it("looks ahead to the refinements it would make next after a zoom in, within the room the share leaves", () => {
    // 4 MiB holds level 1 on part of the plane and level 2 on the rest.
    const entity = image("a", pyramid());
    const budget = { cpu: 4 * 2 ** 20, gpu: 1e12 };
    const before = selectLevels([viewOf(sliceView(0, [entity], 0.2))], budget, initialLevelSelectionMemory(), DEFAULT_PLANNING_CONFIG);
    const after = selectLevels([viewOf(sliceView(0, [entity], 0.5))], budget, before.memory, DEFAULT_PLANNING_CONFIG);
    const a = after.byView.get(0)!.get("ds")!.entities.get("a")!;
    expect(a.detailLevels).toEqual([1, 2]);
    expect(a.lookahead.length).toBeGreaterThan(0);
    expect(a.lookahead.every((cell) => cell.level === 1)).toBe(true);
    const summary = after.summaries.get(0)!;
    const band = 64 * 64 * 2 * 3;
    expect(summary.used.cpu + a.lookahead.length * band).toBeLessThanOrEqual(budget.cpu);
  });

  it("keeps looking ahead while the view holds still, and stops once it moves without zooming", () => {
    const entity = image("a", pyramid());
    const budget = { cpu: 4 * 2 ** 20, gpu: 1e12 };
    const run = (view: ViewSnapshotBase, memory = initialLevelSelectionMemory()) =>
      selectLevels([viewOf(view)], budget, memory, DEFAULT_PLANNING_CONFIG);
    const ahead = (result: ReturnType<typeof run>) => result.byView.get(0)!.get("ds")!.entities.get("a")!.lookahead;
    const zoomed = run(sliceView(0, [entity], 0.5), run(sliceView(0, [entity], 0.2)).memory);
    expect(ahead(zoomed).length).toBeGreaterThan(0);
    const still = run(sliceView(0, [entity], 0.5), zoomed.memory);
    expect(ahead(still).length).toBeGreaterThan(0);
    const panned = sliceView(0, [entity], 0.5);
    panned.visibleRegion = { ...panned.visibleRegion, xyBoundsVox: [100, 0, 2148, 2048] };
    expect(ahead(run(panned, still.memory))).toEqual([]);
  });

  it.each([
    ["volume", "zooms in", [2]],
    ["volume", "turns", [1]],
    ["slice", "zooms in", [1]],
  ] as const)("draws a %s view that %s while the views move at levels %j, and refines it once they stop", (mode, move, levelsWhileMoving) => {
    // A turn moves the measure and not the focal zoom, as an orbit's near
    // side does; a zoom moves both.
    const entity = image("a", pyramid());
    const at = (pixelsPerSample: number): SelectionView => {
      const view = sliceView(0, [entity], pixelsPerSample);
      view.selection = { ...view.selection, renderMode: mode };
      view.visibleRegion = { ...view.visibleRegion, focalZoom: move === "turns" ? 0.2 : pixelsPerSample };
      return viewOf(view);
    };
    const before = select([at(0.2)]);
    const moved = selectLevels([at(0.5)], ROOMY, before.memory, DEFAULT_PLANNING_CONFIG, true);
    const whileMoving = moved.byView.get(0)!.get("ds")!.entities.get("a")!;
    expect(whileMoving.detailLevels).toEqual(levelsWhileMoving);
    expect(moved.held).toBe(levelsWhileMoving[0] === 2);
    // What a held zoom draws once it stops, it fetches ahead.
    if (moved.held) expect(whileMoving.lookahead.map((cell) => cell.level)).toEqual(expect.arrayContaining([1]));
    const stopped = selectLevels([at(0.5)], ROOMY, moved.memory, DEFAULT_PLANNING_CONFIG);
    expect(stopped.byView.get(0)!.get("ds")!.entities.get("a")!.detailLevels).toEqual([1]);
    expect(stopped.held).toBe(false);
  });

  it("looks no level ahead with the prefetch lane off", () => {
    const entity = image("a", pyramid());
    const off = { ...DEFAULT_PLANNING_CONFIG, prefetchDepth: 0 };
    const before = selectLevels([viewOf(sliceView(0, [entity], 0.2))], ROOMY, initialLevelSelectionMemory(), off);
    const after = selectLevels([viewOf(sliceView(0, [entity], 0.5))], ROOMY, before.memory, off);
    expect(after.byView.get(0)!.get("ds")!.entities.get("a")!.lookahead).toEqual([]);
  });

  it("refines a pinned entity to its pin", () => {
    const entity = image("a", pyramid(), { targetLevel: 0, levelPinned: true });
    const a = select([viewOf(sliceView(0, [entity], 0.05))]).byView.get(0)!.get("ds")!.entities.get("a")!;
    expect(a.detailLevels).toEqual([0]);
  });

  it("shares the budget between views by their area", () => {
    // Each view alone would take the whole budget; the larger takes three
    // quarters of it.
    const budget = { cpu: 4 * 2 ** 20, gpu: 1e12 };
    const big = viewOf(sliceView(0, [image("a", pyramid())], 0.5), 3);
    const small = viewOf(sliceView(1, [image("a", pyramid())], 0.5), 1);
    const result = select([big, small], budget);
    const share = budget.cpu * DEFAULT_PLANNING_CONFIG.selectionShare;
    expect(result.summaries.get(0)!.share.cpu).toBeCloseTo(share * 0.75);
    expect(result.summaries.get(1)!.share.cpu).toBeCloseTo(share * 0.25);
    expect(result.summaries.get(0)!.used.cpu + result.summaries.get(1)!.used.cpu).toBeLessThanOrEqual(share);
  });

  /** The slice view across the middle plane at `pixelsPerSample`, drawn as a volume. */
  function volumeView(pixelsPerSample: number): ViewSnapshotBase {
    const slice = sliceView(0, [image("a", pyramid())], pixelsPerSample);
    return { ...slice, selection: { ...slice.selection, renderMode: "volume" } };
  }

  it("keeps a volume view's ancestors that a quarter-resolution frame samples, ranked after its chunks, and a slice view's none", () => {
    // Half a pixel per sample calls for level 1, and a quarter-resolution
    // frame samples levels 2 and 3 above it. Level 4 is the coarse tier's.
    const slice = sliceView(0, [image("a", pyramid())], 0.5);
    expect(select([viewOf(slice)]).byView.get(0)!.get("ds")!.entities.get("a")!.ancestors).toEqual([]);

    const result = select([viewOf(volumeView(0.5))]);
    const a = result.byView.get(0)!.get("ds")!.entities.get("a")!;
    expect(a.detailLevels).toEqual([1]);
    expect(new Set(a.ancestors.map((cell) => cell.level))).toEqual(new Set([2, 3]));
    const fetched = [...a.detail, ...a.ancestors].sort((p, q) => p.rank - q.rank);
    expect(fetched.map((cell) => cell.rank)).toEqual(fetched.map((_, i) => i));
    expect(Math.min(...a.ancestors.map((cell) => cell.rank))).toBe(a.detail.length);
    const levels = a.ancestors.sort((p, q) => p.rank - q.rank).map((cell) => cell.level);
    expect(levels).toEqual([...levels].sort((p, q) => q - p));
    // The share bounds the view's own chunks; the ancestors come beside it.
    expect(result.summaries.get(0)!.used.cpu).toBe(a.detail.length * 64 * 64 * 64 * 2);
  });

  it("keeps fewer ancestors as the view zooms past a pixel a sample, and none past two", () => {
    const ancestorsAt = (pixelsPerSample: number) =>
      select([viewOf(volumeView(pixelsPerSample))]).byView.get(0)!.get("ds")!.entities.get("a")!;
    const near = ancestorsAt(1.8);
    expect(near.detailLevels).toEqual([0]);
    expect(near.ancestors.length).toBeGreaterThan(0);
    expect(near.ancestors.every((cell) => cell.level === 1)).toBe(true);
    expect(ancestorsAt(3).ancestors).toEqual([]);
  });

  it("keeps an ancestor the last selection kept until its span passes the band", () => {
    // Level 0 at 1.9 pixels a sample keeps level 1; at 2.1 a fresh selection
    // would not, but one that kept it does.
    const first = selectLevels([viewOf(volumeView(1.9))], ROOMY, initialLevelSelectionMemory(), DEFAULT_PLANNING_CONFIG);
    const ancestorsOf = (result: ReturnType<typeof select>) => result.byView.get(0)!.get("ds")!.entities.get("a")!.ancestors;
    expect(ancestorsOf(first).length).toBeGreaterThan(0);
    expect(ancestorsOf(select([viewOf(volumeView(2.1))]))).toEqual([]);
    const held = selectLevels([viewOf(volumeView(2.1))], ROOMY, first.memory, DEFAULT_PLANNING_CONFIG);
    expect(ancestorsOf(held).length).toBeGreaterThan(0);
  });

  it("keeps ancestors for the frames a warm gesture draws at its lowest", () => {
    expect(ANCESTOR_SCALE).toBe(INTERACTION_RENDER_SCALE * MIN_ADAPTIVE_SCALE);
  });

  it("lists nothing for a view with nothing to draw", () => {
    const result = select([viewOf(sliceView(0, [], 0.5))]);
    expect(result.byView.get(0)!.get("ds")!.entities.size).toBe(0);
    expect(result.summaries.get(0)!.limit).toBeNull();
  });
});

describe("fairShares", () => {
  it("gives a claim that wants less than its share what it wants, and the rest to the others by weight", () => {
    const shares = fairShares(new Map([[1, 100], [2, 10], [3, 100]]), new Map([[1, 1], [2, 1], [3, 2]]), 70);
    expect(shares.get(2)).toBe(10);
    expect(shares.get(1)).toBeCloseTo(20);
    expect(shares.get(3)).toBeCloseTo(40);
  });

  it("gives every claim what it wants when the room holds them all", () => {
    expect([...fairShares(new Map([[1, 5], [2, 7]]), new Map([[1, 1], [2, 1]]), 100)]).toEqual([[1, 5], [2, 7]]);
  });
});
