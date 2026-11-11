/**
 * A dataset several views show is planned once for all of them: each view
 * asks for what it draws, a chunk two views ask for alike is asked for once,
 * and each view keeps its own memory between plans.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  createSyntheticView,
  emitPlanRequests,
  emptyPlanStats,
  mergeConfig,
  plan,
  scrubbedPlanningState,
} from "./index.ts";
import type { ChunkRequest, SelectionState, ViewSnapshot } from "./index.ts";
import type { LevelGeometry } from "../../manifestTypes.ts";
import { loadWasm } from "../../viewProperties.ts";

beforeAll(loadWasm);

function level(index: number, depth: number, side: number, chunk: [number, number]): LevelGeometry {
  const [cz, cxy] = chunk;
  return {
    level_index: index,
    shape: [1, 1, depth, side, side],
    chunk_shape: [1, 1, cz, cxy, cxy],
    grid_shape: [1, 1, Math.ceil(depth / cz), Math.ceil(side / cxy), Math.ceil(side / cxy)],
    scale: [1, 1, 1, 1, 1],
  };
}

/** A 100-plane volume in 32-plane chunks, its two levels each a source level. */
const LEVELS = [level(0, 100, 128, [32, 64]), level(1, 50, 64, [32, 64])];

/** View `id` of the volume at plane `z`, targeting `targetLevel`, at `effectiveZoom`. */
function viewAt(id: number, z: number, targetLevel = 0, effectiveZoom = 1): ViewSnapshot {
  const selection: SelectionState = {
    t: 0,
    z,
    cut: { axis: "z", index: z },
    visibleChannels: [0],
    renderMode: "slice",
    interactionState: "idle",
  };
  return createSyntheticView({
    view: id,
    entities: [
      createSyntheticEntity({
        entityId: "vol",
        imageId: "img",
        levels: LEVELS,
        sourceLevels: [0, 1],
        targetLevel,
        coarseLevel: null,
      }),
    ],
    visibleRegion: {
      xyBoundsVox: [0, 0, 128, 128],
      zRangeVox: [z, z + 1],
      effectiveZoom,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    selection,
  });
}

const noPrefetch = mergeConfig({ prefetchDepth: 0 });

function keys(requests: ChunkRequest[]): string[] {
  return requests.map((req) => `${req.chunkKey} ${req.plane ?? "whole"}`).sort();
}

describe("a plan for several views", () => {
  it("asks once for what two views at one place both want", () => {
    const one = plan(createSyntheticSnapshot({ views: [viewAt(0, 40)] }), createSyntheticState(), noPrefetch);
    const two = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 40), viewAt(1, 40)] }),
      createSyntheticState(),
      noPrefetch,
    );
    expect(keys(two.requests)).toEqual(keys(one.requests));
  });

  it("asks for a chunk once for each mode that draws it, stamped with the mode whose pools it goes to", () => {
    const sliceView = viewAt(0, 40);
    const volumeView = { ...viewAt(1, 40), selection: { ...viewAt(1, 40).selection, renderMode: "volume" as const } };
    const both = plan(
      createSyntheticSnapshot({ views: [sliceView, volumeView] }),
      createSyntheticState(),
      noPrefetch,
    );
    const detail = both.requests.filter((req) => req.lane === "detail");
    const slice = detail.filter((req) => req.mode === "slice");
    const volume = detail.filter((req) => req.mode === "volume");
    expect(slice.length).toBeGreaterThan(0);
    expect(slice.every((req) => req.plane !== undefined)).toBe(true);
    expect(volume.every((req) => req.plane === undefined)).toBe(true);
    // The slice view's plane lies in a chunk the volume view also wants whole.
    expect(volume.map((req) => req.chunkKey)).toEqual(expect.arrayContaining(slice.map((req) => req.chunkKey)));
  });

  it("asks for what each view draws", () => {
    const near = plan(createSyntheticSnapshot({ views: [viewAt(0, 10)] }), createSyntheticState(), noPrefetch);
    const far = plan(createSyntheticSnapshot({ views: [viewAt(1, 80)] }), createSyntheticState(), noPrefetch);
    const both = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 10), viewAt(1, 80)] }),
      createSyntheticState(),
      noPrefetch,
    );
    expect(keys(both.requests)).toEqual([...keys(near.requests), ...keys(far.requests)].sort());
  });

  it("keeps what each view asks for of its own, for its coverage", () => {
    const near = plan(createSyntheticSnapshot({ views: [viewAt(0, 10)] }), createSyntheticState(), noPrefetch);
    const both = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 10), viewAt(1, 80)] }),
      createSyntheticState(),
      noPrefetch,
    );
    const own = (requests: readonly ChunkRequest[]) => keys(requests.filter((req) => req.lane !== "minimap"));
    expect(own(both.byView!.get(0)!)).toEqual(own(near.requests));
    expect(both.byView!.get(1)!.length).toBeGreaterThan(0);
    // One view's plan is the view's own.
    expect(near.byView).toBeUndefined();
  });

  it("holds every view's detail levels in one active set, finest first", () => {
    const { activeSet, nextState } = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 40, 1), viewAt(1, 40, 0)] }),
      createSyntheticState(),
      noPrefetch,
    );
    expect(activeSet).toEqual([
      { kind: "tile", entityId: "vol", imageId: "img", detailLevels: [0, 1], coarseLevel: null },
    ]);
    expect(nextState.previousActiveSet).toBe(activeSet);
    // Each view keeps the set its own entities made.
    expect(nextState.views.get(0)?.activeSet[0]).toMatchObject({ detailLevels: [1] });
    expect(nextState.views.get(1)?.activeSet[0]).toMatchObject({ detailLevels: [0] });
  });

  it("remembers each view's own zoom and cut", () => {
    const first = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 40, 0, 1), viewAt(1, 60, 0, 1)] }),
      createSyntheticState(),
    );
    // View 0 zooms in; view 1 holds still.
    const second = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 40, 0, 2), viewAt(1, 60, 0, 1)] }),
      first.nextState,
    );
    expect(second.nextState.views.get(0)).toMatchObject({ zoomDirection: "in", previousCut: { index: 40 } });
    expect(second.nextState.views.get(1)).toMatchObject({ zoomDirection: null, previousCut: { index: 60 } });
  });

  it("fetches whole a chunk two crossing slice views ask for planes of, each drawing its own plane", () => {
    const xy = viewAt(0, 40);
    const xz = { ...viewAt(1, 40), selection: { ...viewAt(1, 40).selection, cut: { axis: "y" as const, index: 30 } } };
    const both = plan(createSyntheticSnapshot({ views: [xy, xz] }), createSyntheticState(), noPrefetch);
    // The requests that draw a plane, each view's along its own axis.
    const drawing = both.requests.filter((req) => req.lane === "detail" && req.plane !== undefined);
    const ofView = (axis: "y" | "z") => drawing.filter((req) => (req.planeAxis ?? "z") === axis);
    const shared = ofView("z").map((req) => req.chunkKey).filter((key) => ofView("y").some((req) => req.chunkKey === key));
    expect(shared.length).toBeGreaterThan(0);
    expect(ofView("z").length).toBeGreaterThan(shared.length);
    for (const req of drawing) {
      // Planes of a chunk one view cuts, and the whole of one both cut.
      expect(req.planes === undefined).toBe(shared.includes(req.chunkKey));
    }
  });

  it("widens two views' bands of one chunk along one axis to one band holding both", () => {
    const both = plan(createSyntheticSnapshot({ views: [viewAt(0, 36), viewAt(1, 44)] }), createSyntheticState(), noPrefetch);
    const banded = both.requests.filter((req) => req.lane === "detail" && req.planes);
    const bands = new Map<string, string>();
    for (const req of banded) {
      const band = req.planes!.join(":");
      expect(bands.get(req.chunkKey) ?? band).toBe(band);
      bands.set(req.chunkKey, band);
      expect(req.planes![0]).toBeLessThanOrEqual(req.plane!);
      expect(req.plane!).toBeLessThan(req.planes![1]);
    }
    expect(new Set(banded.map((req) => req.plane))).toEqual(new Set([4, 12]));
  });

  it("puts the view under a gesture first in each lane", () => {
    const views = [viewAt(0, 10), viewAt(1, 80)];
    const plain = plan(createSyntheticSnapshot({ views }), createSyntheticState(), noPrefetch);
    const led = plan(createSyntheticSnapshot({ views, leadingView: 0 }), createSyntheticState(), noPrefetch);
    const detail = (requests: readonly ChunkRequest[]) => requests.filter((req) => req.lane === "detail");
    // View 0 cuts the first chunk along Z, view 1 the third.
    const viewOf = (req: ChunkRequest) => (req.z === 0 ? 0 : 1);
    // Without a gesture view 1's chunks happen to rank first; with view 0
    // under one, every chunk of view 0 comes before any of view 1.
    expect(detail(plain.requests).map(viewOf)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(detail(led.requests).map(viewOf)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(keys(led.requests)).toEqual(keys(plain.requests));
  });

  it("regenerates each view's requests from its own active set on a scrub", () => {
    const planned = plan(
      createSyntheticSnapshot({ views: [viewAt(0, 10), viewAt(1, 80)] }),
      createSyntheticState(),
      noPrefetch,
    );
    // View 1 scrubs to plane 20.
    const scrubbed = createSyntheticSnapshot({ views: [viewAt(0, 10), viewAt(1, 20)] });
    const requests = emitPlanRequests(scrubbed, planned.nextState, emptyPlanStats(), noPrefetch);
    const fresh = plan(scrubbed, planned.nextState, noPrefetch);
    expect(keys(requests)).toEqual(keys(fresh.requests));

    const state = scrubbedPlanningState(scrubbed, planned.nextState);
    expect(state.previousActiveSet).toBe(planned.nextState.previousActiveSet);
    expect(state.views.get(1)?.previousCut).toEqual({ axis: "z", index: 20 });
    expect(state.views.get(0)?.previousCut).toEqual({ axis: "z", index: 10 });
  });
});
