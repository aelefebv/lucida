/**
 * The slice view asks for the plane it draws from each chunk and fetches a
 * band around it, and after a step along Z it prefetches the whole chunks
 * the plane lies in. The volume view, the coarse tier and a generated level
 * keep asking for whole chunks.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  isCutStep,
  mergeConfig,
  plan,
  SLICE_BAND_PLANES,
} from "./index.ts";
import type { ChunkRequest, PlanningSnapshot, SelectionState } from "./index.ts";
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

/** A 100-plane volume in 32-plane chunks, with a coarse level of one chunk. */
const LEVELS = [level(0, 100, 128, [32, 64]), level(1, 25, 32, [25, 32])];

function snapshot(selection: Partial<SelectionState>, sourceLevels?: number[]): PlanningSnapshot {
  return createSyntheticSnapshot({
    entities: [
      createSyntheticEntity({
        entityId: "vol",
        imageId: "img",
        levels: LEVELS,
        targetLevel: 0,
        coarseLevel: 1,
        ...(sourceLevels ? { sourceLevels } : {}),
      }),
    ],
    visibleRegion: {
      xyBoundsVox: [0, 0, 128, 128],
      zRangeVox: [selection.z ?? 0, (selection.z ?? 0) + 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    selection: {
      t: 0,
      z: 0,
      cut: { axis: "z", index: selection.z ?? 0 },
      visibleChannels: [0],
      renderMode: "slice",
      interactionState: "idle",
      ...selection,
    },
  });
}

const noPrefetch = mergeConfig({ prefetchDepth: 0 });

function lane(requests: ChunkRequest[], name: ChunkRequest["lane"]): ChunkRequest[] {
  return requests.filter((req) => req.lane === name);
}

describe("the slice view's requests", () => {
  it("ask for the plane drawn and fetch a band around it", () => {
    const { requests } = plan(snapshot({ z: 40 }), createSyntheticState(), noPrefetch);
    const detail = lane(requests, "detail");
    expect(detail).toHaveLength(4);
    for (const req of detail) {
      // Plane 40 is plane 8 of chunk 1.
      expect(req).toMatchObject({ z: 1, plane: 8, planes: [8 - SLICE_BAND_PLANES, 9 + SLICE_BAND_PLANES] });
    }
  });

  it("keep the band inside the chunk and off an edge chunk's padding", () => {
    const first = lane(plan(snapshot({ z: 1 }), createSyntheticState(), noPrefetch).requests, "detail");
    expect(first[0]).toMatchObject({ z: 0, plane: 1, planes: [0, 4] });
    // Chunk 3 holds planes 96 to 99 of the level and padding after them.
    const edge = lane(plan(snapshot({ z: 99 }), createSyntheticState(), noPrefetch).requests, "detail");
    expect(edge[0]).toMatchObject({ z: 3, plane: 3, planes: [1, 4] });
  });

  it("cut a side view's plane along its axis, through every chunk along Z", () => {
    // An XZ cut at Y 70 of 128, in 64-row chunks: row 6 of chunk row 1.
    const xz = createSyntheticSnapshot({
      ...snapshot({ z: 0 }),
      visibleRegion: {
        xyBoundsVox: [0, 70, 128, 71],
        zRangeVox: [0, 100],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
        cutAxis: "y",
      },
    });
    xz.selection = { ...xz.selection, cut: { axis: "y", index: 70 } };
    const detail = lane(plan(xz, createSyntheticState(), noPrefetch).requests, "detail");
    // Two chunks across, four deep.
    expect(detail).toHaveLength(8);
    expect(new Set(detail.map((req) => req.z))).toEqual(new Set([0, 1, 2, 3]));
    for (const req of detail) {
      expect(req).toMatchObject({
        y: 1,
        plane: 6,
        planes: [6 - SLICE_BAND_PLANES, 7 + SLICE_BAND_PLANES],
        planeAxis: "y",
      });
    }
  });

  it("leave the coarse tier, the volume view and a generated level whole", () => {
    const slice = plan(snapshot({ z: 40 }), createSyntheticState(), noPrefetch).requests;
    // The coarse chunk is 25 planes deep, but the coarse tier is read whole.
    expect(lane(slice, "coarse").every((req) => req.plane === undefined && req.planes === undefined)).toBe(true);

    const volume = plan(snapshot({ z: 40, renderMode: "volume" }), createSyntheticState(), noPrefetch).requests;
    expect(volume.every((req) => req.planes === undefined)).toBe(true);

    const generated = plan(snapshot({ z: 40 }, [1]), createSyntheticState(), noPrefetch).requests;
    expect(lane(generated, "detail").every((req) => req.planes === undefined)).toBe(true);
  });
});

describe("a step along Z", () => {
  it("is a move of a few planes in the slice view, and not a jump or the first plan", () => {
    const at = (z: number, renderMode: SelectionState["renderMode"] = "slice") =>
      ({ t: 0, z, cut: { axis: "z", index: z }, visibleChannels: [0], renderMode, interactionState: "idle" }) as SelectionState;
    const was = { axis: "z", index: 10 } as const;
    expect(isCutStep(was, at(11), SLICE_BAND_PLANES)).toBe(true);
    expect(isCutStep(was, at(10 - SLICE_BAND_PLANES), SLICE_BAND_PLANES)).toBe(true);
    expect(isCutStep(was, at(10 + SLICE_BAND_PLANES + 1), SLICE_BAND_PLANES)).toBe(false);
    expect(isCutStep(was, at(10), SLICE_BAND_PLANES)).toBe(false);
    expect(isCutStep(null, at(11), SLICE_BAND_PLANES)).toBe(false);
    expect(isCutStep(was, at(11, "volume"), SLICE_BAND_PLANES)).toBe(false);
    // A move along another axis is a new cut, not a step.
    expect(isCutStep({ axis: "y", index: 10 }, at(11), SLICE_BAND_PLANES)).toBe(false);
  });

  it("prefetches the whole chunks the plane lies in, ahead of every other prefetch", () => {
    const opened = plan(snapshot({ z: 40 }), createSyntheticState(), noPrefetch);
    expect(lane(opened.requests, "prefetch")).toHaveLength(0);
    expect(opened.nextState.previousCut).toEqual({ axis: "z", index: 40 });

    const stepped = plan(snapshot({ z: 41 }), opened.nextState, noPrefetch);
    const prefetch = lane(stepped.requests, "prefetch");
    expect(prefetch).toHaveLength(4);
    for (const req of prefetch) {
      expect(req).toMatchObject({ z: 1, tier: "detail" });
      expect(req.plane).toBeUndefined();
      expect(req.planes).toBeUndefined();
    }
    const view = lane(stepped.requests, "detail");
    expect(Math.max(...view.map((req) => req.priority))).toBeLessThan(
      Math.min(...prefetch.map((req) => req.priority)),
    );

    const jumped = plan(snapshot({ z: 90 }), stepped.nextState, noPrefetch);
    expect(lane(jumped.requests, "prefetch")).toHaveLength(0);
  });
  it("follows the band's width in the planning config, which is also how far a step goes", () => {
    const wide = mergeConfig({ prefetchDepth: 0, sliceBandPlanes: 5 });
    const opened = plan(snapshot({ z: 40 }), createSyntheticState(), wide);
    expect(lane(opened.requests, "detail")[0]).toMatchObject({ plane: 8, planes: [3, 14] });
    const stepped = plan(snapshot({ z: 45 }), opened.nextState, wide);
    expect(lane(stepped.requests, "prefetch")).toHaveLength(4);

    // With no band, the view fetches only its plane, and every move is a jump.
    const none = mergeConfig({ prefetchDepth: 0, sliceBandPlanes: 0 });
    const alone = plan(snapshot({ z: 40 }), createSyntheticState(), none);
    expect(lane(alone.requests, "detail")[0]).toMatchObject({ plane: 8, planes: [8, 9] });
    expect(lane(plan(snapshot({ z: 41 }), alone.nextState, none).requests, "prefetch")).toHaveLength(0);
  });
});
