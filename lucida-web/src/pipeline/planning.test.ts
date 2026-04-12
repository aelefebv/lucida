import { describe, it, expect } from "vitest";

import {
  promote,
  createSyntheticEntity,
  createSyntheticSnapshot,
  PROMOTE_THRESHOLD_PX,
  DEMOTE_THRESHOLD_PX,
  chunkKey,
  chunkOutsideFrustum,
  iterateChunks,
  plan,
  RUNWAY_DEPTH,
} from "./planning.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  VisibleRegion,
  SelectionState,
  CacheStateSnapshot,
  PlanningSnapshot,
  ChunkRequest,
} from "./planning.ts";
import type { LevelGeometry } from "../contentTypes.ts";

// ---------------------------------------------------------------------------
// Promotion / demotion
// ---------------------------------------------------------------------------

describe("promote", () => {
  it("promotes entity above PROMOTE_THRESHOLD_PX to detail", () => {
    const entity = createSyntheticEntity({ projectedDiagonalPx: 100 });
    expect(entity.projectedDiagonalPx).toBeGreaterThanOrEqual(PROMOTE_THRESHOLD_PX);

    const [result] = promote([entity], []);
    expect(result.representation).toBe("detail");
  });

  it("keeps entity below DEMOTE_THRESHOLD_PX as overview", () => {
    const entity = createSyntheticEntity({ projectedDiagonalPx: 30 });
    expect(entity.projectedDiagonalPx).toBeLessThan(DEMOTE_THRESHOLD_PX);

    const [result] = promote([entity], []);
    expect(result.representation).toBe("overview");
  });

  it("keeps entity in hysteresis band as detail when previously detail", () => {
    const entity = createSyntheticEntity({
      entityId: "e1",
      projectedDiagonalPx: 60,
    });
    const prev: ActiveSetEntry = {
      entityId: "e1",
      imageId: "image-0",
      representation: "detail",
      targetLod: 0,
      seedDetailLod: 2,
      detailOwnedLodRange: [0, 2],
    };

    const [result] = promote([entity], [prev]);
    expect(result.representation).toBe("detail");
  });

  it("keeps entity in hysteresis band as overview when previously overview", () => {
    const entity = createSyntheticEntity({
      entityId: "e1",
      projectedDiagonalPx: 60,
    });
    const prev: ActiveSetEntry = {
      entityId: "e1",
      imageId: "image-0",
      representation: "overview",
      targetLod: 4,
      seedDetailLod: 4,
      detailOwnedLodRange: [4, 4],
    };

    const [result] = promote([entity], [prev]);
    expect(result.representation).toBe("overview");
  });

  it("defaults to overview when entity is in hysteresis band with no previous entry", () => {
    const entity = createSyntheticEntity({ projectedDiagonalPx: 60 });

    const [result] = promote([entity], []);
    expect(result.representation).toBe("overview");
  });

  it("forces invisible entity to overview even when projectedDiagonalPx is large", () => {
    const entity = createSyntheticEntity({
      visible: false,
      projectedDiagonalPx: 200,
    });

    const [result] = promote([entity], []);
    expect(result.representation).toBe("overview");
  });
});

// ---------------------------------------------------------------------------
// LOD range
// ---------------------------------------------------------------------------

describe("LOD range", () => {
  it("sets seedDetailLod = targetLod + 2 for a detail entity", () => {
    const entity = createSyntheticEntity({
      projectedDiagonalPx: 100,
      idealTargetLod: 0,
      numLevels: 5,
    });

    const [result] = promote([entity], []);
    expect(result.representation).toBe("detail");
    expect(result.targetLod).toBe(0);
    expect(result.seedDetailLod).toBe(2);
    expect(result.detailOwnedLodRange).toEqual([0, 2]);
  });

  it("clamps seedDetailLod to numLevels - 1", () => {
    const entity = createSyntheticEntity({
      projectedDiagonalPx: 100,
      idealTargetLod: 3,
      numLevels: 4,
    });

    const [result] = promote([entity], []);
    expect(result.representation).toBe("detail");
    expect(result.targetLod).toBe(3);
    expect(result.seedDetailLod).toBe(3); // clamped: min(3+2, 3) = 3
    expect(result.detailOwnedLodRange).toEqual([3, 3]);
  });

  it("handles single-level images", () => {
    const entity = createSyntheticEntity({
      projectedDiagonalPx: 100,
      idealTargetLod: 0,
      numLevels: 1,
    });

    const [result] = promote([entity], []);
    expect(result.representation).toBe("detail");
    expect(result.targetLod).toBe(0);
    expect(result.seedDetailLod).toBe(0);
    expect(result.detailOwnedLodRange).toEqual([0, 0]);
  });

  it("sets overview entity LODs to coarsest level", () => {
    const entity = createSyntheticEntity({
      projectedDiagonalPx: 30,
      numLevels: 5,
    });

    const [result] = promote([entity], []);
    expect(result.representation).toBe("overview");
    expect(result.targetLod).toBe(4);
    expect(result.seedDetailLod).toBe(4);
    expect(result.detailOwnedLodRange).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------------------
// Test helpers for iterateChunks
// ---------------------------------------------------------------------------

/** Build a LevelGeometry from 5D shape and chunk_shape arrays. */
function makeLevelGeo(
  level: number,
  shape: [number, number, number, number, number],
  chunkShape: [number, number, number, number, number],
): LevelGeometry {
  const gridShape: [number, number, number, number, number] = [
    Math.ceil(shape[0] / chunkShape[0]),
    Math.ceil(shape[1] / chunkShape[1]),
    Math.ceil(shape[2] / chunkShape[2]),
    Math.ceil(shape[3] / chunkShape[3]),
    Math.ceil(shape[4] / chunkShape[4]),
  ];
  return {
    level_index: level,
    shape,
    chunk_shape: chunkShape,
    grid_shape: gridShape,
    scale: [1, 1, 1, 1, 1],
  };
}

/** Default visible region covering [0,0]-[1024,1024], z=[0,1). */
function makeVisibleRegion(overrides?: Partial<VisibleRegion>): VisibleRegion {
  return {
    xyBounds: [0, 0, 1024, 1024],
    zRange: [0, 1],
    effectiveZoom: 1,
    sortCenter: null,
    frustumPlanes: null,
    ...overrides,
  };
}

/** Default selection state. */
function makeSelection(overrides?: Partial<SelectionState>): SelectionState {
  return {
    t: 0,
    c: 0,
    z: 0,
    visibleChannels: [0],
    renderMode: "slice",
    interactionState: "idle",
    ...overrides,
  };
}

/** Default empty cache state. */
function makeCacheState(
  entries?: [string, Set<string>][],
): CacheStateSnapshot {
  return { cached: new Map(entries ?? []) };
}

/** Default detail active-set entry for an entity. */
function makeDetailEntry(
  entityId: string,
  imageId: string,
  targetLod: number,
  seedDetailLod: number,
): ActiveSetEntry {
  return {
    entityId,
    imageId,
    representation: "detail",
    targetLod,
    seedDetailLod,
    detailOwnedLodRange: [targetLod, seedDetailLod],
  };
}

// ---------------------------------------------------------------------------
// chunkOutsideFrustum
// ---------------------------------------------------------------------------

describe("chunkOutsideFrustum", () => {
  it("returns false when chunk is inside all planes", () => {
    // A single plane: x >= 0  (normal = [1,0,0], d = 0)
    const planes: [number, number, number, number][] = [[1, 0, 0, 0]];
    const result = chunkOutsideFrustum([1, 1, 1], [2, 2, 2], planes);
    expect(result).toBe(false);
  });

  it("returns true when chunk is outside a plane", () => {
    // Plane: x >= 5  (normal = [1,0,0], d = -5)
    const planes: [number, number, number, number][] = [[1, 0, 0, -5]];
    const result = chunkOutsideFrustum([0, 0, 0], [3, 3, 3], planes);
    expect(result).toBe(true);
  });

  it("returns false when chunk straddles the plane boundary", () => {
    // Plane: x >= 2  (normal = [1,0,0], d = -2)
    const planes: [number, number, number, number][] = [[1, 0, 0, -2]];
    const result = chunkOutsideFrustum([0, 0, 0], [3, 3, 3], planes);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// iterateChunks
// ---------------------------------------------------------------------------

describe("iterateChunks", () => {
  it("2D viewport clips to expected grid cells", () => {
    // 4x4 chunk grid: shape [1,1,1,1024,1024], chunk [1,1,1,256,256]
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeDetailEntry("e0", "img0", 0, 0);

    // Visible region covers only top-left quarter: [0,0]-[512,512]
    const region = makeVisibleRegion({ xyBounds: [0, 0, 512, 512] });
    const selection = makeSelection();
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);

    // Expect 2x2 = 4 chunks (cols 0-1, rows 0-1)
    expect(result).toHaveLength(4);
    const coords = result.map((r) => [r.y, r.x]);
    expect(coords).toContainEqual([0, 0]);
    expect(coords).toContainEqual([0, 1]);
    expect(coords).toContainEqual([1, 0]);
    expect(coords).toContainEqual([1, 1]);
  });

  it("3D frustum planes cull chunks", () => {
    // 4x4x4 chunk grid
    const level0 = makeLevelGeo(0, [1, 1, 4, 1024, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeDetailEntry("e0", "img0", 0, 0);

    // Visible region covers all, but with a frustum plane that rejects
    // chunks whose local cmin.x >= 512 (i.e., only keeps cols 0 and 1).
    // Plane [-1, 0, 0, 256]: test = (-1)*cmin_x + 256 < 0 → cmin_x > 256
    // col 0 (cmin_x=0): kept, col 1 (cmin_x=256): kept, col 2+: culled.
    const region = makeVisibleRegion({
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 4],
      frustumPlanes: [[-1, 0, 0, 256]],
    });
    const selection = makeSelection();
    const cache = makeCacheState();

    const all = iterateChunks(
      entity,
      entry,
      makeVisibleRegion({ xyBounds: [0, 0, 1024, 1024], zRange: [0, 4] }),
      selection,
      cache,
    );
    const culled = iterateChunks(entity, entry, region, selection, cache);

    // Without frustum: 4*4*4 = 64 chunks
    expect(all).toHaveLength(64);
    // With frustum: only x-columns 0,1 survive (x*256 < 512), so 2*4*4 = 32
    expect(culled).toHaveLength(32);
    for (const req of culled) {
      expect(req.x).toBeLessThan(2);
    }
  });

  it("cached chunks are excluded", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 512, 512] });
    const selection = makeSelection();

    // Cache two of the four chunks.
    const cachedKeys = new Set([chunkKey(0, 0, 0, 0, 0, 0), chunkKey(0, 0, 0, 0, 1, 1)]);
    const cache = makeCacheState([["e0", cachedKeys]]);

    const result = iterateChunks(entity, entry, region, selection, cache);

    expect(result).toHaveLength(2);
    for (const req of result) {
      expect(cachedKeys.has(req.chunkKey)).toBe(false);
    }
  });

  it("multi-channel produces one request per channel per spatial cell", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 256, 256] });
    const selection = makeSelection({ visibleChannels: [0, 2, 3] });
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);

    // 1 spatial cell * 3 channels = 3 requests
    expect(result).toHaveLength(3);
    const channels = result.map((r) => r.c).sort();
    expect(channels).toEqual([0, 2, 3]);
  });

  it("center-out sort places nearest chunk first", () => {
    // 4x1x1 grid so chunks are spread along X.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeDetailEntry("e0", "img0", 0, 0);

    // sortCenter at x=960 (near the right edge, chunk col 3).
    const region = makeVisibleRegion({
      xyBounds: [0, 0, 1024, 256],
      sortCenter: [960, 128, 0],
    });
    const selection = makeSelection();
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);
    expect(result.length).toBeGreaterThan(1);

    // First chunk should be the one closest to sortCenter (col 3).
    expect(result[0].x).toBe(3);
  });

  it("entity position offsets the visible region correctly", () => {
    // Entity at position [500, 500], visible region [400,400]-[600,600].
    // In local coords: [-100,-100]-[100,100].
    // Only the [0,0]-[100,100] portion overlaps the entity (shape 1024x1024).
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 1,
      levels: [level0],
      position: [500, 500],
    });
    const entry = makeDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [400, 400, 600, 600] });
    const selection = makeSelection();
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);

    // Local range: x=[-100,100], y=[-100,100].
    // Clamped to [0,100] x [0,100] → col 0, row 0 only.
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(0);
  });

  it("multi-LOD iterates all levels in detailOwnedLodRange", () => {
    // 3 levels: 0, 1, 2.
    // Level 0: 1024x1024, chunk 256x256, grid 4x4
    // Level 1: 512x512, chunk 256x256, grid 2x2
    // Level 2: 256x256, chunk 256x256, grid 1x1
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const level1 = makeLevelGeo(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const level2 = makeLevelGeo(2, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);

    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      numLevels: 3,
      levels: [level0, level1, level2],
      position: [0, 0],
    });
    // Detail entry owning levels 0..2 inclusive.
    const entry = makeDetailEntry("e0", "img0", 0, 2);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 1024, 1024] });
    const selection = makeSelection();
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);

    // Level 0: 4x4 = 16, Level 1: 2x2 = 4, Level 2: 1x1 = 1 → total 21
    expect(result).toHaveLength(21);

    const levelCounts = new Map<number, number>();
    for (const req of result) {
      levelCounts.set(req.level, (levelCounts.get(req.level) ?? 0) + 1);
    }
    expect(levelCounts.get(0)).toBe(16);
    expect(levelCounts.get(1)).toBe(4);
    expect(levelCounts.get(2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Request scheduling
// ---------------------------------------------------------------------------

describe("request scheduling", () => {
  /** Reusable single-entity snapshot for scheduling tests. */
  function makeSchedulingSnapshot(): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
      levels: [level0],
      importance: 1.0,
      position: [0, 0],
    });
    return createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBounds: [0, 0, 512, 512],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: null,
        frustumPlanes: null,
      },
      selection: {
        t: 10,
        c: 0,
        z: 0,
        visibleChannels: [0],
        renderMode: "slice",
        interactionState: "idle",
      },
      cacheState: { cached: new Map() },
    });
  }

  it("detail requests have lower priority than runway", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    const runwayReqs = result.requests.filter((r) => r.lane === "runway");

    expect(detailReqs.length).toBeGreaterThan(0);
    expect(runwayReqs.length).toBeGreaterThan(0);

    const maxDetailPriority = Math.max(...detailReqs.map((r) => r.priority));
    const minRunwayPriority = Math.min(...runwayReqs.map((r) => r.priority));
    expect(maxDetailPriority).toBeLessThan(minRunwayPriority);
  });

  it("runway requests have lower priority than overview", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

    const runwayReqs = result.requests.filter((r) => r.lane === "runway");
    const overviewReqs = result.requests.filter((r) => r.lane === "overview");

    expect(runwayReqs.length).toBeGreaterThan(0);
    expect(overviewReqs.length).toBeGreaterThan(0);

    const maxRunwayPriority = Math.max(...runwayReqs.map((r) => r.priority));
    const minOverviewPriority = Math.min(
      ...overviewReqs.map((r) => r.priority),
    );
    expect(maxRunwayPriority).toBeLessThan(minOverviewPriority);
  });

  it("higher importance yields lower priority within a lane", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const highImportance = createSyntheticEntity({
      entityId: "high",
      imageId: "img-high",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
      levels: [level0],
      importance: 1.0,
      position: [0, 0],
    });
    const lowImportance = createSyntheticEntity({
      entityId: "low",
      imageId: "img-low",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
      levels: [level0],
      importance: 0.2,
      position: [0, 0],
    });
    const snapshot = createSyntheticSnapshot({
      entities: [highImportance, lowImportance],
      visibleRegion: {
        xyBounds: [0, 0, 256, 256],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: null,
        frustumPlanes: null,
      },
      selection: {
        t: 0,
        c: 0,
        z: 0,
        visibleChannels: [0],
        renderMode: "slice",
        interactionState: "idle",
      },
      cacheState: { cached: new Map() },
    });

    const result = plan(snapshot);

    const highDetailReqs = result.requests.filter(
      (r) => r.lane === "detail" && r.entityId === "high",
    );
    const lowDetailReqs = result.requests.filter(
      (r) => r.lane === "detail" && r.entityId === "low",
    );

    expect(highDetailReqs.length).toBeGreaterThan(0);
    expect(lowDetailReqs.length).toBeGreaterThan(0);

    // All high-importance detail requests should have lower (more urgent)
    // priority than all low-importance detail requests, given same distance.
    const maxHighPriority = Math.max(...highDetailReqs.map((r) => r.priority));
    const minLowPriority = Math.min(...lowDetailReqs.map((r) => r.priority));
    expect(maxHighPriority).toBeLessThan(minLowPriority);
  });

  it("temporal runway generates T+1 and T+2", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

    const runwayReqs = result.requests.filter((r) => r.lane === "runway");
    expect(runwayReqs.length).toBeGreaterThan(0);

    const tValues = new Set(runwayReqs.map((r) => r.t));
    expect(tValues.has(11)).toBe(true);
    expect(tValues.has(12)).toBe(true);
  });

  it("runway T+1 before T+2", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

    const runwayReqs = result.requests.filter((r) => r.lane === "runway");
    const t11Reqs = runwayReqs.filter((r) => r.t === 11);
    const t12Reqs = runwayReqs.filter((r) => r.t === 12);

    expect(t11Reqs.length).toBeGreaterThan(0);
    expect(t12Reqs.length).toBeGreaterThan(0);

    const maxT11Priority = Math.max(...t11Reqs.map((r) => r.priority));
    const minT12Priority = Math.min(...t12Reqs.map((r) => r.priority));
    expect(maxT11Priority).toBeLessThan(minT12Priority);
  });
});

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

describe("plan()", () => {
  it("propagates request epoch", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      numLevels: 1,
      levels: [level0],
      projectedDiagonalPx: 200,
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      epochs: {
        content: 3,
        layout: 2,
        view: 1,
        selection: 4,
        asset: 0,
        request: 7,
      },
    });

    const result = plan(snapshot);

    expect(result.epochs.request).toBe(8);
    expect(result.epochs.content).toBe(3);
    expect(result.epochs.layout).toBe(2);
    expect(result.epochs.view).toBe(1);
    expect(result.epochs.selection).toBe(4);
    expect(result.epochs.asset).toBe(0);
  });

  it("full integration: two entities, three lanes, sorted output", () => {
    // Entity 1: large projected diagonal -> detail
    const level0A = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityDetail = createSyntheticEntity({
      entityId: "detail-entity",
      imageId: "img-detail",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
      levels: [level0A],
      importance: 0.8,
      position: [0, 0],
    });

    // Entity 2: small projected diagonal -> overview
    const level0B = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityOverview = createSyntheticEntity({
      entityId: "overview-entity",
      imageId: "img-overview",
      projectedDiagonalPx: 20,
      idealTargetLod: 0,
      numLevels: 1,
      levels: [level0B],
      importance: 0.5,
      position: [0, 0],
    });

    const snapshot = createSyntheticSnapshot({
      entities: [entityDetail, entityOverview],
      visibleRegion: {
        xyBounds: [0, 0, 512, 512],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: null,
        frustumPlanes: null,
      },
      selection: {
        t: 5,
        c: 0,
        z: 0,
        visibleChannels: [0],
        renderMode: "slice",
        interactionState: "idle",
      },
      cacheState: { cached: new Map() },
    });

    const result = plan(snapshot);

    // Active set: 2 entries
    expect(result.activeSet).toHaveLength(2);
    const detailEntry = result.activeSet.find(
      (e) => e.entityId === "detail-entity",
    );
    const overviewEntry = result.activeSet.find(
      (e) => e.entityId === "overview-entity",
    );
    expect(detailEntry?.representation).toBe("detail");
    expect(overviewEntry?.representation).toBe("overview");

    // Detail lane: entity 1's 2x2 grid = 4 chunks
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs).toHaveLength(4);
    for (const r of detailReqs) {
      expect(r.entityId).toBe("detail-entity");
    }

    // Runway lane: entity 1 at T+1 and T+2, each 4 chunks = 8 total
    const runwayReqs = result.requests.filter((r) => r.lane === "runway");
    expect(runwayReqs).toHaveLength(4 * RUNWAY_DEPTH);
    const runwayTs = new Set(runwayReqs.map((r) => r.t));
    expect(runwayTs.has(6)).toBe(true);
    expect(runwayTs.has(7)).toBe(true);
    for (const r of runwayReqs) {
      expect(r.entityId).toBe("detail-entity");
    }

    // Overview lane: both entities contribute coarsest-level chunks.
    // Each entity has a 2x2 grid at level 0 (only level), so 4+4 = 8.
    const overviewReqs = result.requests.filter((r) => r.lane === "overview");
    expect(overviewReqs).toHaveLength(8);
    const overviewEntities = new Set(overviewReqs.map((r) => r.entityId));
    expect(overviewEntities.has("detail-entity")).toBe(true);
    expect(overviewEntities.has("overview-entity")).toBe(true);

    // Total: 4 detail + 8 runway + 8 overview = 20
    expect(result.requests).toHaveLength(20);

    // Requests are sorted by ascending priority.
    for (let i = 1; i < result.requests.length; i++) {
      expect(result.requests[i].priority).toBeGreaterThanOrEqual(
        result.requests[i - 1].priority,
      );
    }
  });
});
