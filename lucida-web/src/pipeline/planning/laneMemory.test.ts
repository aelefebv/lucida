/**
 * A view that plans its dataset alone carries its requests from one plan to
 * the next: a request whose chunk and lane inputs held is the previous
 * plan's object, and the plan names what it added and removed.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  compareChunkRequests,
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticView,
  initialPlanningState,
  plan,
  type ChunkRequest,
  type DatasetLevelSelection,
  type EntityLevelSelection,
  type PlanningSnapshot,
  type SelectedCell,
  type ViewSnapshot,
} from "./index.ts";
import type { LevelGeometry } from "../../manifestTypes.ts";
import { requestIdentity } from "./plan.ts";
import { loadWasm } from "../../viewProperties.ts";

beforeAll(loadWasm);

function level(index: number, side: number, depth: number): LevelGeometry {
  return {
    level_index: index,
    shape: [1, 2, depth, side, side],
    chunk_shape: [1, 1, 32, 64, 64],
    grid_shape: [1, 2, Math.ceil(depth / 32), Math.ceil(side / 64), Math.ceil(side / 64)],
    scale: [1, 1, 1, 1, 1],
  };
}

/** A two-channel volume of three levels, its coarsest the coarse tier's. */
const LEVELS = [level(0, 512, 128), level(1, 256, 64), level(2, 128, 32)];

const ENTITY = createSyntheticEntity({ entityId: "vol", imageId: "img", levels: LEVELS, coarseLevel: 2 });

function cells(list: [number, number, number, number][]): SelectedCell[] {
  return list.map(([lvl, x, y, z], rank) => ({ level: lvl, x, y, z, rank }));
}

function selection(detail: SelectedCell[], ancestors: SelectedCell[] = []): DatasetLevelSelection {
  const entity: EntityLevelSelection = {
    detail,
    ancestors,
    lookahead: [],
    detailLevels: [...new Set(detail.map((cell) => cell.level))].sort((a, b) => a - b),
    coarseCells: 1,
  };
  return { entities: new Map([["vol", entity]]), budgetLimited: false };
}

function view(detail: SelectedCell[], overrides: Partial<ViewSnapshot> = {}, ancestors: SelectedCell[] = []): ViewSnapshot {
  return createSyntheticView({
    entities: [ENTITY],
    visibleRegion: {
      xyBoundsVox: [0, 0, 512, 512],
      zRangeVox: [0, 128],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    selection: {
      t: 0,
      z: 0,
      cut: { axis: "z", index: 0 },
      visibleChannels: [0, 1],
      renderMode: "volume",
      interactionState: "idle",
    },
    levelSelection: selection(detail, ancestors),
    ...overrides,
  });
}

function snapshot(views: ViewSnapshot[]): PlanningSnapshot {
  return createSyntheticSnapshot({ views });
}

const FIRST = cells([[1, 0, 0, 0], [1, 1, 0, 0], [1, 0, 1, 0], [1, 1, 1, 0]]);
/** FIRST with one cell refined to its level-0 children's first two and another dropped. */
const SECOND = cells([[1, 1, 0, 0], [1, 0, 1, 0], [0, 0, 0, 0], [0, 1, 0, 0], [1, 1, 1, 1]]);

const identities = (requests: readonly ChunkRequest[]): string[] =>
  requests.map((req) => `${req.lane}|${requestIdentity(req)}`).sort();

describe("carrying a view's requests between plans", () => {
  it("returns the same requests, and an empty delta, when the selection held", () => {
    const first = plan(snapshot([view(FIRST)]), initialPlanningState());
    const second = plan(snapshot([view(FIRST)]), first.nextState);

    expect(first.delta).toBeUndefined();
    expect(second.requests).toBe(first.requests);
    expect(second.delta).toEqual({ base: first.requests, added: [], removed: [] });
  });

  it("keeps the requests of the cells still selected, and names what it added and removed", () => {
    const first = plan(snapshot([view(FIRST)]), initialPlanningState());
    const second = plan(snapshot([view(SECOND)]), first.nextState);
    const fresh = plan(snapshot([view(SECOND)]), initialPlanningState());

    // The same requests a plan from nothing makes, by what each asks for.
    expect(identities(second.requests)).toEqual(identities(fresh.requests));
    const delta = second.delta!;
    expect(delta.base).toBe(first.requests);
    const detailKeys = (requests: readonly ChunkRequest[]) =>
      requests.filter((req) => req.lane === "detail").map((req) => req.chunkKey).sort();
    // Two channels per cell.
    expect(detailKeys(delta.removed)).toEqual(["1/0/0/0/0/0", "1/0/0/0/1/1", "1/0/1/0/0/0", "1/0/1/0/1/1"]);
    expect(detailKeys(delta.added)).toEqual([
      "0/0/0/0/0/0", "0/0/0/0/0/1", "0/0/1/0/0/0", "0/0/1/0/0/1", "1/0/0/1/1/1", "1/0/1/1/1/1",
    ]);

    // Every request kept is the previous plan's object.
    const before = new Set(first.requests);
    for (const req of second.requests) {
      expect(before.has(req) !== delta.added.includes(req)).toBe(true);
    }
    // The list is the previous one less what was removed, plus what was added.
    expect(second.requests.length).toBe(first.requests.length - delta.removed.length + delta.added.length);
  });

  it("stays in planner order", () => {
    const first = plan(snapshot([view(FIRST)]), initialPlanningState());
    const second = plan(snapshot([view(SECOND)]), first.nextState);
    const sorted = [...second.requests].sort(compareChunkRequests);
    expect(second.requests).toEqual(sorted);
  });

  it("emits every request again when what they depend on changed", () => {
    const first = plan(snapshot([view(FIRST)]), initialPlanningState());
    const oneChannel = view(FIRST, {
      selection: { ...view(FIRST).selection, visibleChannels: [0] },
    });
    const second = plan(snapshot([oneChannel]), first.nextState);

    expect(second.delta).toBeUndefined();
    const before = new Set(first.requests);
    expect(second.requests.some((req) => before.has(req))).toBe(false);
  });

  it("marks only the ancestors, and asks anew for a cell that turns from ancestor to drawn", () => {
    // Level 1's first cell kept above two of its level 0 cells, then drawn
    // once the selection coarsens back to it.
    const above = { level: 1, x: 0, y: 0, z: 0, rank: 0 };
    const fine = [{ level: 0, x: 0, y: 0, z: 0, rank: 1 }, { level: 0, x: 1, y: 0, z: 0, rank: 2 }];
    const first = plan(snapshot([view(fine, {}, [above])]), initialPlanningState());
    const second = plan(snapshot([view([above])]), first.nextState);
    const fresh = plan(snapshot([view([above])]), initialPlanningState());

    const marked = (requests: readonly ChunkRequest[]) =>
      requests.filter((req) => req.ancestor).map((req) => req.chunkKey).sort();
    const atLevel1 = ["1/0/0/0/0/0", "1/0/1/0/0/0"];
    expect(marked(first.requests)).toEqual(atLevel1);
    expect(marked(second.requests)).toEqual([]);
    expect(identities(second.requests)).toEqual(identities(fresh.requests));
    expect(marked(second.delta!.removed)).toEqual(atLevel1);
    expect(second.delta!.added.map((req) => req.chunkKey).sort()).toEqual(atLevel1);
  });

  it("carries nothing for a dataset several views plan", () => {
    const two = [view(FIRST), { ...view(FIRST), view: 1 }];
    const first = plan(snapshot(two), initialPlanningState());
    const second = plan(snapshot(two), first.nextState);

    expect(second.delta).toBeUndefined();
    expect(second.nextState.views.get(0)?.lanes).toBeNull();
  });
});
