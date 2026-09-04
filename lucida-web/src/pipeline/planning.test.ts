import { describe, it, expect } from "vitest";

import {
  assignModes,
  buildPrevModeByGroup,
  chunkKey,
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  groupMembers,
  FAR_THRESHOLD_PX,
  DETAIL_THRESHOLD_PX,
  HYSTERESIS_PX,
  MINIMAP_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  MINIMAP_SEED_BULK_LANE_OFFSET,
  COARSE_LANE_OFFSET,
  PROXY_LANE_OFFSET,
  DETAIL_LANE_OFFSET,
  OVERVIEW_LANE_OFFSET,
  PREFETCH_LANE_OFFSET,
  chooseEntityMode,
  chunkOutsideFrustum,
  emptyPlanStats,
  iterateChunks,
  plan,
  PREFETCH_DEPTH,
  IMPORTANCE_WEIGHT,
  DISTANCE_WEIGHT,
  DEPTH_BIAS_VIEW,
  GROUP_PROXY_PRIORITY_BUMP,
  RENDER_RADIUS_DISABLED_VIEW,
  DEFAULT_PLANNING_CONFIG,
  mergeConfig,
} from "./planning/index.ts";
import type { PlanningConfig } from "./planning/index.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningState,
  SelectionState,
  PlanningSnapshot,
  ResolvedMode,
  AssetCatalogSnapshot,
  ProxyKind,
} from "./planning/index.ts";
import type { VisibleRegion } from "./viewport.ts";
import type { LevelGeometry } from "../manifestTypes.ts";

const LEGACY_PROXY_CONFIG = mergeConfig({ coarseDetailEnabled: false });

// ---------------------------------------------------------------------------
// Catalog helper
// ---------------------------------------------------------------------------

/** Build an AssetCatalogSnapshot from `(entityId, kinds[])` pairs. */
function makeCatalog(
  entries: [string, ProxyKind[]][],
): AssetCatalogSnapshot {
  const byEntity: AssetCatalogSnapshot["byEntity"] = new Map();
  for (const [entityId, kinds] of entries) {
    byEntity.set(entityId, { kinds: new Set(kinds), footprints: new Map() });
  }
  return { byEntity };
}

// ---------------------------------------------------------------------------
// Default-active-set helper for legacy two-tier tests
// ---------------------------------------------------------------------------

/**
 * Build a singleton tile-mode active-set entry for an Image-kind
 * entity. Used by the migrated legacy tests so synthetic snapshots
 * still produce one entry per entity. Returns the discriminated
 * `TileEntry` variant explicitly.
 */
function makeTileDetailEntry(
  entityId: string,
  imageId: string,
  targetLod: number,
  coarsestDetailLod: number,
): ActiveSetEntry {
  return {
    kind: "tile",
    entityId,
    imageId,
    mode: "tiles-with-detail",
    targetLod,
    coarsestDetailLod,
    detailOwnedLodRange: [targetLod, coarsestDetailLod],
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
  };
}

// ActiveSetEntry is a discriminated union; tests that read
// tile-mode-only tiles (`mode`, `targetLod`, etc.) need to narrow
// first. These helpers fail the test with a descriptive message if
// the entry is a different variant.
function asTile(entry: ActiveSetEntry) {
  if (entry.kind !== "tile") {
    throw new Error(
      `expected TileEntry but got kind="${entry.kind}" (entityId=${entry.entityId})`,
    );
  }
  return entry;
}

function asGroupAsProxy(entry: ActiveSetEntry) {
  if (entry.kind !== "group-as-proxy") {
    throw new Error(
      `expected GroupAsProxyEntry but got kind="${entry.kind}" (entityId=${entry.entityId})`,
    );
  }
  return entry;
}

function asInvisible(entry: ActiveSetEntry) {
  if (entry.kind !== "invisible") {
    throw new Error(
      `expected InvisibleEntry but got kind="${entry.kind}" (entityId=${entry.entityId})`,
    );
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Promotion / demotion (legacy two-tier semantics, mapped to current modes)
// ---------------------------------------------------------------------------
//
// Without an asset catalog the only reachable mode is `tiles-with-detail`,
// since both proxy modes degrade away when proxies aren't advertised.
// The legacy boundary at FAR_THRESHOLD_PX still distinguishes the
// group-as-proxy desired-mode region from tiles-with-detail; `<` flips
// to tiles-with-detail post-degrade. We test the mode after degrade.

describe("assignModes — three-tier (no catalog)", () => {
  it("entity above MEDIUM threshold uses tiles-with-detail", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
    });
    expect(entity.projectedDiagonalPx).toBeGreaterThan(DETAIL_THRESHOLD_PX);

    const [result] = assignModes([entity], []);
    expect(asTile(result).mode).toBe("tiles-with-detail");
  });

  it("entity below FAR threshold degrades to tiles-with-detail when no catalog", () => {
    // Below FAR_THRESHOLD_PX, chooseEntityMode picks group-as-proxy, but
    // catalog-aware degrade pushes it all the way down to tiles-with-detail.
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 30,
    });
    expect(entity.projectedDiagonalPx).toBeLessThan(FAR_THRESHOLD_PX);

    const [result] = assignModes([entity], []);
    expect(asTile(result).mode).toBe("tiles-with-detail");
  });

  it("entity in mid range degrades to tiles-with-detail when no catalog", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 100,
    });
    const [result] = assignModes([entity], []);
    expect(asTile(result).mode).toBe("tiles-with-detail");
  });

  it("invisible entity emits an InvisibleEntry at coarsest LOD", () => {
    // Invisibles are their own variant (not conflated with
    // `tiles-with-detail`). They carry only `coarsestLod`, no
    // LOD range / mode / proxy tiles.
    const entity = createSyntheticEntity({
      visible: false,
      projectedDiagonalPx: 200,
      levels: makeStubLevels(5),
    });

    const [result] = assignModes([entity], []);
    const inv = asInvisible(result);
    expect(inv.coarsestLod).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// LOD range
// ---------------------------------------------------------------------------

describe("LOD range", () => {
  it("sets coarsestDetailLod = targetLod for a tile-mode entity (no +2 buffer)", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: makeStubLevels(5),
    });

    const [result] = assignModes([entity], []);
    const f = asTile(result);
    expect(f.mode).toBe("tiles-with-detail");
    expect(f.targetLod).toBe(0);
    expect(f.coarsestDetailLod).toBe(0);
    expect(f.detailOwnedLodRange).toEqual([0, 0]);
  });

  it("coarsestDetailLod tracks targetLod even at the top of the pyramid", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 3,
      levels: makeStubLevels(4),
    });

    const [result] = assignModes([entity], []);
    const f = asTile(result);
    expect(f.mode).toBe("tiles-with-detail");
    expect(f.targetLod).toBe(3);
    expect(f.coarsestDetailLod).toBe(3);
    expect(f.detailOwnedLodRange).toEqual([3, 3]);
  });

  it("handles single-level images", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: makeStubLevels(1),
    });

    const [result] = assignModes([entity], []);
    const f = asTile(result);
    expect(f.mode).toBe("tiles-with-detail");
    expect(f.targetLod).toBe(0);
    expect(f.coarsestDetailLod).toBe(0);
    expect(f.detailOwnedLodRange).toEqual([0, 0]);
  });

  it("invisible entity coarsestLod is the coarsest level", () => {
    // InvisibleEntry only carries `coarsestLod`; no
    // `targetLod`/`coarsestDetailLod`/`detailOwnedLodRange` tiles.
    const entity = createSyntheticEntity({
      kind: "Image",
      visible: false,
      projectedDiagonalPx: 30,
      levels: makeStubLevels(5),
    });

    const [result] = assignModes([entity], []);
    expect(asInvisible(result).coarsestLod).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// chooseEntityMode — pure hysteresis tests
// ---------------------------------------------------------------------------

describe("chooseEntityMode", () => {
  it("clearly far → group-as-proxy", () => {
    expect(chooseEntityMode(null, 50)).toBe("group-as-proxy");
  });
  it("clearly mid → tiles-with-proxy-fallback", () => {
    expect(chooseEntityMode(null, 100)).toBe("tiles-with-proxy-fallback");
  });
  it("clearly near → tiles-with-detail", () => {
    expect(chooseEntityMode(null, 200)).toBe("tiles-with-detail");
  });

  it("hysteresis at FAR threshold: keeps group-as-proxy across 75–84", () => {
    let prev: ResolvedMode | null = "group-as-proxy";
    for (const px of [80, 78, 82, 84, 75, 79]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("group-as-proxy");
      prev = next;
    }
    // Past upper bound (>= 85) → flip
    expect(chooseEntityMode("group-as-proxy", 85)).toBe(
      "tiles-with-proxy-fallback",
    );
  });

  it("hysteresis at FAR threshold: keeps proxy-fallback across 76–85", () => {
    let prev: ResolvedMode | null = "tiles-with-proxy-fallback";
    for (const px of [80, 81, 82, 84, 85]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("tiles-with-proxy-fallback");
      prev = next;
    }
    // Below lower bound → flip down to group-as-proxy
    expect(chooseEntityMode("tiles-with-proxy-fallback", 74)).toBe(
      "group-as-proxy",
    );
  });

  it("hysteresis at MEDIUM threshold: keeps tiles-with-detail across 146-155", () => {
    let prev: ResolvedMode | null = "tiles-with-detail";
    for (const px of [150, 148, 152, 155, 146]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("tiles-with-detail");
      prev = next;
    }
    // Below lower bound (<= 145) → flip
    expect(chooseEntityMode("tiles-with-detail", 145)).toBe(
      "tiles-with-proxy-fallback",
    );
  });

  it("hysteresis at MEDIUM threshold: keeps proxy-fallback across 145-154", () => {
    let prev: ResolvedMode | null = "tiles-with-proxy-fallback";
    for (const px of [150, 151, 154, 145, 148]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("tiles-with-proxy-fallback");
      prev = next;
    }
    expect(chooseEntityMode("tiles-with-proxy-fallback", 156)).toBe(
      "tiles-with-detail",
    );
  });
});

// ---------------------------------------------------------------------------
// assignModes() with a populated catalog (three-tier behaviour)
// ---------------------------------------------------------------------------

/** Build a 1-group-3-tiles collection group at the given diagonal. */
function makeCollectionEntities(
  groupId: string,
  tiles: { id: string; image: string; px: number }[],
): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  out.push(
    createSyntheticEntity({
      entityId: groupId,
      imageId: "",
      kind: "Group",
      projectedDiagonalPx: Math.max(...tiles.map((f) => f.px), 0),
      levels: [],
    }),
  );
  for (const f of tiles) {
    out.push(
      createSyntheticEntity({
        entityId: f.id,
        imageId: f.image,
        kind: "Tile",
        projectedDiagonalPx: f.px,
        levels: makeStubLevels(5),
        targetLevel: 0,
        parentId: groupId,
      }),
    );
  }
  return out;
}

describe("assignModes — three-tier with catalog", () => {
  it("far group (50px) with full catalog → single group-as-proxy entry", () => {
    const entities = makeCollectionEntities("groupA", [
      { id: "fA1", image: "imgA1", px: 40 },
      { id: "fA2", image: "imgA2", px: 50 },
    ]);
    const catalog = makeCatalog([
      ["groupA", ["GroupProxy3D"]],
      ["fA1", ["TileProxy3D"]],
      ["fA2", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);

    expect(result).toHaveLength(1);
    const wp = asGroupAsProxy(result[0]);
    expect(wp.entityId).toBe("groupA");
    // GroupAsProxyEntry has no imageId / proxyKind / proxyAvailable
    // tiles — those invariants are compile-time enforced rather
    // than asserted at runtime.
  });

  it("mid group (100px) with catalog → one tiles-with-proxy-fallback per tile", () => {
    const entities = makeCollectionEntities("groupB", [
      { id: "fB1", image: "imgB1", px: 100 },
      { id: "fB2", image: "imgB2", px: 100 },
    ]);
    const catalog = makeCatalog([
      ["groupB", ["GroupProxy3D"]],
      ["fB1", ["TileProxy3D"]],
      ["fB2", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(2);
    for (const entry of result) {
      const f = asTile(entry);
      expect(f.mode).toBe("tiles-with-proxy-fallback");
      expect(f.proxyKind).toBe("TileProxy3D");
      expect(f.proxyAvailable).toBe(true);
      expect(f.groupProxyAvailable).toBe(true);
    }
  });

  it("near group (200px) → tiles-with-detail per tile; group proxy still flagged available", () => {
    const entities = makeCollectionEntities("groupC", [
      { id: "fC1", image: "imgC1", px: 200 },
      { id: "fC2", image: "imgC2", px: 220 },
    ]);
    const catalog = makeCatalog([
      ["groupC", ["GroupProxy3D"]],
      ["fC1", ["TileProxy3D"]],
      ["fC2", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(2);
    for (const entry of result) {
      const f = asTile(entry);
      expect(f.mode).toBe("tiles-with-detail");
      expect(f.proxyKind).toBe("TileProxy3D");
      expect(f.proxyAvailable).toBe(true);
      expect(f.groupProxyAvailable).toBe(true);
    }
  });

  it("mixed scene: two groups at different zooms get different modes", () => {
    const entities = [
      ...makeCollectionEntities("groupA", [{ id: "fA1", image: "imgA1", px: 40 }]),
      ...makeCollectionEntities("groupB", [{ id: "fB1", image: "imgB1", px: 200 }]),
    ];
    const catalog = makeCatalog([
      ["groupA", ["GroupProxy3D"]],
      ["groupB", ["GroupProxy3D"]],
      ["fA1", ["TileProxy3D"]],
      ["fB1", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    const groupAEntries = result.filter(
      (e) => e.entityId === "groupA" || e.entityId === "fA1",
    );
    const groupBEntries = result.filter(
      (e) => e.entityId === "groupB" || e.entityId === "fB1",
    );
    expect(groupAEntries).toHaveLength(1);
    expect(groupAEntries[0].kind).toBe("group-as-proxy");
    expect(groupBEntries).toHaveLength(1);
    expect(asTile(groupBEntries[0]).mode).toBe("tiles-with-detail");
  });

  it("catalog miss for GroupProxy3D → far group degrades to tiles-with-proxy-fallback", () => {
    const entities = makeCollectionEntities("groupD", [
      { id: "fD1", image: "imgD1", px: 50 },
    ]);
    // Tile proxy advertised but group proxy is NOT.
    const catalog = makeCatalog([
      ["fD1", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    const f = asTile(result[0]);
    expect(f.mode).toBe("tiles-with-proxy-fallback");
    expect(f.proxyAvailable).toBe(true);
    expect(f.groupProxyAvailable).toBe(false);
  });

  it("catalog miss for both proxies → far group degrades all the way to tiles-with-detail", () => {
    const entities = makeCollectionEntities("groupE", [
      { id: "fE1", image: "imgE1", px: 50 },
    ]);
    const catalog = makeCatalog([]); // empty catalog

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    const f = asTile(result[0]);
    expect(f.mode).toBe("tiles-with-detail");
    expect(f.proxyAvailable).toBe(false);
    expect(f.groupProxyAvailable).toBe(false);
  });

  it("catalog miss in mid range: no TileProxy3D for any tile but group has GroupProxy3D → keeps proxy-fallback", () => {
    const entities = makeCollectionEntities("groupF", [
      { id: "fF1", image: "imgF1", px: 100 },
    ]);
    const catalog = makeCatalog([["groupF", ["GroupProxy3D"]]]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    const f = asTile(result[0]);
    // Stays in proxy-fallback because group-proxy can stand in.
    expect(f.mode).toBe("tiles-with-proxy-fallback");
    expect(f.proxyAvailable).toBe(false); // tile proxy missing
    expect(f.groupProxyAvailable).toBe(true);
  });

  it("hysteresis: previous group-as-proxy holds at 84px when catalog still supports it", () => {
    const entities = makeCollectionEntities("groupG", [
      { id: "fG1", image: "imgG1", px: 84 },
    ]);
    const catalog = makeCatalog([
      ["groupG", ["GroupProxy3D"]],
      ["fG1", ["TileProxy3D"]],
    ]);
    // GroupAsProxyEntry carries only `kind` and `entityId`;
    // LOD/proxy bookkeeping is implicit.
    const prev: ActiveSetEntry[] = [
      { kind: "group-as-proxy", entityId: "groupG" },
    ];

    const result = assignModes(entities, prev, catalog);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("group-as-proxy");
  });

  it("hysteresis flip: 50→100→50 returns to group-as-proxy", () => {
    const tiles = [{ id: "fH1", image: "imgH1", px: 50 }];
    const catalog = makeCatalog([
      ["groupH", ["GroupProxy3D"]],
      ["fH1", ["TileProxy3D"]],
    ]);

    const r1 = assignModes(makeCollectionEntities("groupH", tiles), [], catalog);
    expect(r1[0].kind).toBe("group-as-proxy");

    tiles[0].px = 100;
    const r2 = assignModes(makeCollectionEntities("groupH", tiles), r1, catalog);
    expect(asTile(r2[0]).mode).toBe("tiles-with-proxy-fallback");

    tiles[0].px = 50;
    const r3 = assignModes(makeCollectionEntities("groupH", tiles), r2, catalog);
    expect(r3[0].kind).toBe("group-as-proxy");
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

/**
 * Build a stub `levels` array of length `n` for tests that only care
 * about the entity's level count (e.g. invisible-entry coarsest-LOD
 * tests) rather than per-level geometry.
 */
function makeStubLevels(n: number): LevelGeometry[] {
  const levels: LevelGeometry[] = [];
  for (let i = 0; i < n; i++) {
    levels.push(makeLevelGeo(i, [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]));
  }
  return levels;
}

/** Default visible region covering [0,0]-[1024,1024], z=[0,1). */
function makeVisibleRegion(overrides?: Partial<VisibleRegion>): VisibleRegion {
  return {
    xyBoundsVox: [0, 0, 1024, 1024],
    zRangeVox: [0, 1],
    effectiveZoom: 1,
    sortCenterVox: null,
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
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);

    // Visible region covers only top-left quarter: [0,0]-[512,512]
    const region = makeVisibleRegion({ xyBoundsVox: [0, 0, 512, 512] });
    const selection = makeSelection();

    const result = iterateChunks(entity, entry, region, selection);

    // Expect 2x2 = 4 chunks (cols 0-1, rows 0-1)
    expect(result).toHaveLength(4);
    const coords = result.map((r) => [r.y, r.x]);
    expect(coords).toContainEqual([0, 0]);
    expect(coords).toContainEqual([0, 1]);
    expect(coords).toContainEqual([1, 0]);
    expect(coords).toContainEqual([1, 1]);
  });

  it("group-as-proxy entry produces no chunk requests", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "groupX",
      imageId: "",
      kind: "Group",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    // GroupAsProxyEntry carries only `kind` + `entityId`; the
    // chunk-iteration short-circuit reads `kind`, not `mode`.
    const entry: ActiveSetEntry = { kind: "group-as-proxy", entityId: "groupX" };

    const result = iterateChunks(entity, entry, makeVisibleRegion(), makeSelection());
    expect(result).toHaveLength(0);
  });

  it("invisible entry produces no chunk requests", () => {
    // InvisibleEntry is a distinct variant — iterateChunks
    // short-circuits on `kind !== "tile"`.
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "invX",
      imageId: "imgInv",
      kind: "Image",
      visible: false,
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry: ActiveSetEntry = {
      kind: "invisible",
      entityId: "invX",
      imageId: "imgInv",
      coarsestLod: 0,
    };

    const result = iterateChunks(entity, entry, makeVisibleRegion(), makeSelection());
    expect(result).toHaveLength(0);
  });

  it("3D frustum planes cull chunks", () => {
    // 4x4x4 chunk grid
    const level0 = makeLevelGeo(0, [1, 1, 4, 1024, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);

    // Visible region covers all, but with a frustum plane that rejects
    // chunks whose local cmin.x >= 512 (i.e., only keeps cols 0 and 1).
    // Plane [-1, 0, 0, 256]: test = (-1)*cmin_x + 256 < 0 → cmin_x > 256
    // col 0 (cmin_x=0): kept, col 1 (cmin_x=256): kept, col 2+: culled.
    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 4],
      frustumPlanes: [[-1, 0, 0, 256]],
    });
    const selection = makeSelection();

    const all = iterateChunks(
      entity,
      entry,
      makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024], zRangeVox: [0, 4] }),
      selection,
    );
    const culled = iterateChunks(entity, entry, region, selection);

    // Without frustum: 4*4*4 = 64 chunks
    expect(all).toHaveLength(64);
    // With frustum: only x-columns 0,1 survive (x*256 < 512), so 2*4*4 = 32
    expect(culled).toHaveLength(32);
    for (const req of culled) {
      expect(req.x).toBeLessThan(2);
    }
  });

  it("emits all visible chunks regardless of cache state", () => {
    // Planning no longer filters cached chunks — CpuCache.submit()
    // refreshes cached entries' priority/lastSeenTick from the request,
    // so eviction can spare them. iterateChunks must therefore emit
    // every visible chunk, cached or not.
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBoundsVox: [0, 0, 512, 512] });
    const selection = makeSelection();

    const result = iterateChunks(entity, entry, region, selection);

    // 2x2 grid → 4 chunks, regardless of what's cached.
    expect(result).toHaveLength(4);
  });

  it("multi-channel produces one request per channel per spatial cell", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBoundsVox: [0, 0, 256, 256] });
    const selection = makeSelection({ visibleChannels: [0, 2, 3] });

    const result = iterateChunks(entity, entry, region, selection);

    // 1 spatial cell * 3 channels = 3 requests
    expect(result).toHaveLength(3);
    const channels = result.map((r) => r.c).sort();
    expect(channels).toEqual([0, 2, 3]);
  });

  it("multi-channel request order interleaves channels per spatial cell", () => {
    const level0 = makeLevelGeo(0, [1, 2, 1, 256, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBoundsVox: [0, 0, 512, 256] });
    const selection = makeSelection({ visibleChannels: [0, 1] });

    const result = iterateChunks(entity, entry, region, selection);

    expect(result.map((r) => [r.x, r.c])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });

  it("returns all visible chunks regardless of sort order", () => {
    // 4x1x1 grid so chunks are spread along X.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);

    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 1024, 256],
      sortCenterVox: [960, 128, 0],
    });
    const selection = makeSelection();

    const result = iterateChunks(entity, entry, region, selection);

    // All 4 columns should be present.
    expect(result).toHaveLength(4);
    const xs = result.map((r) => r.x).sort();
    expect(xs).toEqual([0, 1, 2, 3]);
  });

  it("entity position offsets the visible region correctly", () => {
    // Entity at position [500, 500], visible region [400,400]-[600,600].
    // In local coords: [-100,-100]-[100,100].
    // Only the [0,0]-[100,100] portion overlaps the entity (shape 1024x1024).
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [500, 500],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBoundsVox: [400, 400, 600, 600] });
    const selection = makeSelection();

    const result = iterateChunks(entity, entry, region, selection);

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
      levels: [level0, level1, level2],
      layoutPositionVox: [0, 0],
    });
    // Detail entry owning levels 0..2 inclusive.
    const entry = makeTileDetailEntry("e0", "img0", 0, 2);
    const region = makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024] });
    const selection = makeSelection();

    const result = iterateChunks(entity, entry, region, selection);

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
    const level0 = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
      layoutPositionVox: [0, 0],
    });
    return createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });
  }

  it("detail requests have lower priority than prefetch", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot, createSyntheticState(), LEGACY_PROXY_CONFIG);

    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    const prefetchReqs = result.requests.filter((r) => r.lane === "prefetch");

    expect(detailReqs.length).toBeGreaterThan(0);
    expect(prefetchReqs.length).toBeGreaterThan(0);

    const maxDetailPriority = Math.max(...detailReqs.map((r) => r.priority));
    const minPrefetchPriority = Math.min(...prefetchReqs.map((r) => r.priority));
    expect(maxDetailPriority).toBeLessThan(minPrefetchPriority);
  });

  it("prefetch requests have lower priority than overview", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot, createSyntheticState(), LEGACY_PROXY_CONFIG);

    const prefetchReqs = result.requests.filter((r) => r.lane === "prefetch");
    const overviewReqs = result.requests.filter((r) => r.lane === "overview");

    expect(prefetchReqs.length).toBeGreaterThan(0);
    expect(overviewReqs.length).toBeGreaterThan(0);

    const maxPrefetchPriority = Math.max(...prefetchReqs.map((r) => r.priority));
    const minOverviewPriority = Math.min(
      ...overviewReqs.map((r) => r.priority),
    );
    expect(maxPrefetchPriority).toBeLessThan(minOverviewPriority);
  });

  it("higher importance yields lower priority within a lane", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const highImportance = createSyntheticEntity({
      entityId: "high",
      imageId: "img-high",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
      layoutPositionVox: [0, 0],
    });
    const lowImportance = createSyntheticEntity({
      entityId: "low",
      imageId: "img-low",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 0.2,
      layoutPositionVox: [0, 0],
    });
    const snapshot = createSyntheticSnapshot({
      entities: [highImportance, lowImportance],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const result = plan(snapshot, createSyntheticState(), LEGACY_PROXY_CONFIG);

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

  it("temporal prefetch generates T+1 and T+2", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot, createSyntheticState(), LEGACY_PROXY_CONFIG);

    const prefetchReqs = result.requests.filter((r) => r.lane === "prefetch");
    expect(prefetchReqs.length).toBeGreaterThan(0);

    const tValues = new Set(prefetchReqs.map((r) => r.t));
    expect(tValues.has(11)).toBe(true);
    expect(tValues.has(12)).toBe(true);
  });

  it("prefetch T+1 before T+2", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot, createSyntheticState());

    const prefetchReqs = result.requests.filter((r) => r.lane === "prefetch");
    const t11Reqs = prefetchReqs.filter((r) => r.t === 11);
    const t12Reqs = prefetchReqs.filter((r) => r.t === 12);

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
  it("center-out priority: chunks nearest view center have lowest priority", () => {
    // 4x1x1 grid so chunks are spread along X (cols 0-3).
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
      layoutPositionVox: [0, 0],
    });

    // sortCenterVox at x=960 (near chunk col 3).
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 1024, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: [960, 128, 0],
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
    });

    const result = plan(snapshot, createSyntheticState());
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs.length).toBe(4);

    // Detail requests should be sorted by priority (ascending).
    // The chunk closest to sortCenterVox (col 3) should be first.
    expect(detailReqs[0].x).toBe(3);
    // The chunk farthest from sortCenterVox (col 0) should be last.
    expect(detailReqs[3].x).toBe(0);
  });

  it("center-out priority respects entity position offset", () => {
    // Entity at position [500, 0], 2x1 grid.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
      layoutPositionVox: [500, 0],
    });

    // View center at x=900 → local x=400 → closer to col 1 (chunk center 384).
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [400, 0, 1100, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null, // midpoint = [750, 128] → local x = 250
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
    });

    const result = plan(snapshot, createSyntheticState());
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs.length).toBe(2);

    // View midpoint local x = (400+1100)/2 - 500 = 250.
    // Col 0 center = 128, col 1 center = 384.
    // Col 1 (dist 134) is farther than col 0 (dist 122), so col 0 first.
    expect(detailReqs[0].x).toBe(0);
    expect(detailReqs[1].x).toBe(1);
  });

  it("propagates request epoch", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      kind: "Image",
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

    const result = plan(snapshot, createSyntheticState());

    expect(result.epochs.request).toBe(8);
    expect(result.epochs.content).toBe(3);
    expect(result.epochs.layout).toBe(2);
    expect(result.epochs.view).toBe(1);
    expect(result.epochs.selection).toBe(4);
    expect(result.epochs.asset).toBe(0);
  });

  it("full integration: two entities, three lanes, sorted output", () => {
    // Entity 1: large projected diagonal -> tiles-with-detail
    const level0A = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityDetail = createSyntheticEntity({
      entityId: "detail-entity",
      imageId: "img-detail",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0A],
      importance: 0.8,
      layoutPositionVox: [0, 0],
    });

    // Entity 2: small projected diagonal — without a catalog this still
    // ends up in tiles-with-detail mode. Overview lane requests come
    // from the per-entity pass at the coarsest level for ALL entities,
    // so the test still gets overview chunks for both.
    const level0B = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityOverview = createSyntheticEntity({
      entityId: "overview-entity",
      imageId: "img-overview",
      kind: "Image",
      projectedDiagonalPx: 20,
      targetLevel: 0,
      levels: [level0B],
      importance: 0.5,
      layoutPositionVox: [0, 0],
    });

    const snapshot = createSyntheticSnapshot({
      entities: [entityDetail, entityOverview],
      visibleRegion: {
        xyBoundsVox: [0, 0, 512, 512],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const result = plan(snapshot, createSyntheticState(), LEGACY_PROXY_CONFIG);

    // Active set: 2 entries, both in tiles-with-detail (no catalog → degrade).
    expect(result.activeSet).toHaveLength(2);
    for (const entry of result.activeSet) {
      expect(asTile(entry).mode).toBe("tiles-with-detail");
    }

    // Detail lane: both entities at L0 with 2x2 grid each = 8 chunks.
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs).toHaveLength(8);

    // Prefetch lane: both entities each contribute 4 chunks * 2 timepoints.
    const prefetchReqs = result.requests.filter((r) => r.lane === "prefetch");
    expect(prefetchReqs).toHaveLength(2 * 4 * PREFETCH_DEPTH);
    const prefetchTs = new Set(prefetchReqs.map((r) => r.t));
    expect(prefetchTs.has(6)).toBe(true);
    expect(prefetchTs.has(7)).toBe(true);

    // Overview lane: both entities contribute coarsest-level chunks.
    // Each entity has a 2x2 grid at level 0 (only level), so 4+4 = 8.
    const overviewReqs = result.requests.filter((r) => r.lane === "overview");
    expect(overviewReqs).toHaveLength(8);
    const overviewEntities = new Set(overviewReqs.map((r) => r.entityId));
    expect(overviewEntities.has("detail-entity")).toBe(true);
    expect(overviewEntities.has("overview-entity")).toBe(true);

    // Total: 8 detail + 16 prefetch + 8 overview = 32
    expect(result.requests).toHaveLength(32);

    // Requests are sorted by ascending priority.
    for (let i = 1; i < result.requests.length; i++) {
      expect(result.requests[i].priority).toBeGreaterThanOrEqual(
        result.requests[i - 1].priority,
      );
    }
  });
});

describe("plan() — depth-bias focal plane (#532)", () => {
  // A single entity whose detail grid is 1x1x4 along Z (X/Y are one
  // chunk each), so the only thing that varies between detail chunks is
  // depth. chunkWorldZ = 128; Z-chunk world centers are 64, 192, 320,
  // 448 for z = 0..3. The visible Z range covers all four.
  function makeDepthSnapshot(
    sortCenterVox: [number, number, number] | null,
  ): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 512, 256, 256], [1, 1, 128, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
      layoutPositionVox: [0, 0],
    });
    return createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 512],
        effectiveZoom: 1,
        sortCenterVox,
        frustumPlanes: null,
      },
      selection: {
        t: 0,
        c: 0,
        z: 0,
        visibleChannels: [0],
        renderMode: "volume",
        interactionState: "idle",
      },
    });
  }

  /** Map of detail-chunk z-index → priority, for ordering assertions. */
  function detailPriorityByZ(config: PlanningConfig): Map<number, number> {
    // centerZ = 256 sits exactly between the z=1 (192) and z=2 (320)
    // chunk centers, so the unbiased ordering is symmetric.
    const snapshot = makeDepthSnapshot([128, 128, 256]);
    const result = plan(snapshot, createSyntheticState(), config);
    const byZ = new Map<number, number>();
    for (const req of result.requests.filter((r) => r.lane === "detail")) {
      byZ.set(req.z, req.priority);
    }
    return byZ;
  }

  it("emits one detail chunk per Z cell along the depth axis", () => {
    const result = plan(
      makeDepthSnapshot([128, 128, 256]),
      createSyntheticState(),
    );
    const detail = result.requests.filter((r) => r.lane === "detail");
    expect(detail.map((r) => r.z).sort()).toEqual([0, 1, 2, 3]);
  });

  it("SAFETY: depth bias 0 reproduces the unbiased center-out ordering byte-for-byte", () => {
    // Golden = the priorities the planner produces with the default
    // config, whose depthBiasView is 0. The bias is implemented as an
    // additive term that is exactly 0 at the default and short-circuits
    // before any arithmetic, so an explicit `depthBiasView: 0` must
    // reproduce the same numbers, and they must match the hand-computed
    // unbiased priority: detailLaneOffset + dist * distanceWeight
    // (importance 1 ⇒ the importance term is 0).
    const golden = detailPriorityByZ(DEFAULT_PLANNING_CONFIG);
    const explicitZero = detailPriorityByZ(mergeConfig({ depthBiasView: 0 }));
    expect(explicitZero).toEqual(golden);

    // Hand-computed unbiased priorities. centerZ = 256; chunk centers
    // 64/192/320/448 ⇒ |Δ| = 192/64/64/192.
    const lane = DEFAULT_PLANNING_CONFIG.detailLaneOffset;
    const w = DEFAULT_PLANNING_CONFIG.distanceWeight;
    expect(golden.get(0)).toBeCloseTo(lane + 192 * w, 6);
    expect(golden.get(1)).toBeCloseTo(lane + 64 * w, 6);
    expect(golden.get(2)).toBeCloseTo(lane + 64 * w, 6);
    expect(golden.get(3)).toBeCloseTo(lane + 192 * w, 6);
  });

  it("biasing toward NEAR makes near-plane chunks more urgent than far-plane chunks", () => {
    // Unbiased, z=0 and z=3 tie (both 192 from center). Bias toward the
    // near plane (negative) shifts the focal Z down, so z=0/z=1 get
    // closer (lower priority) and z=2/z=3 farther.
    const biased = detailPriorityByZ(mergeConfig({ depthBiasView: -1 }));
    expect(biased.get(0)!).toBeLessThan(biased.get(3)!);
    expect(biased.get(1)!).toBeLessThan(biased.get(2)!);

    // And it actually changed the order vs. the unbiased tie.
    const unbiased = detailPriorityByZ(DEFAULT_PLANNING_CONFIG);
    expect(biased.get(0)!).toBeLessThan(unbiased.get(0)!);
  });

  it("biasing toward FAR makes far-plane chunks more urgent than near-plane chunks", () => {
    const biased = detailPriorityByZ(mergeConfig({ depthBiasView: 1 }));
    expect(biased.get(3)!).toBeLessThan(biased.get(0)!);
    expect(biased.get(2)!).toBeLessThan(biased.get(1)!);
  });

  it("clamps the biased focal Z to the visible Z range (|bias| beyond 1 saturates)", () => {
    // bias = -1 already lands the focal Z on the near plane (z=0);
    // an out-of-range bias must not push it past the near plane.
    const atNear = detailPriorityByZ(mergeConfig({ depthBiasView: -1 }));
    const beyondNear = detailPriorityByZ(mergeConfig({ depthBiasView: -5 }));
    expect(beyondNear).toEqual(atNear);
  });
});

describe("plan() — coarse/detail bridge", () => {
  it("is the default planner path and emits no proxy requests or proxy modes", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const level1 = makeLevelGeo(1, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "tile-default",
      imageId: "img-default",
      kind: "Image",
      projectedDiagonalPx: 40,
      levels: [level0, level1],
      detailLevel: 0,
      coarseLevel: 1,
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      assetCatalog: makeCatalog([["tile-default", ["TileProxy3D"]]]),
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 512, 512] }),
      selection: makeSelection(),
    });

    const result = plan(snapshot, createSyntheticState());

    expect(DEFAULT_PLANNING_CONFIG.coarseDetailEnabled).toBe(true);
    expect(DEFAULT_PLANNING_CONFIG.detailRenderRadiusView).toBe(RENDER_RADIUS_DISABLED_VIEW);
    expect(DEFAULT_PLANNING_CONFIG.coarseRenderRadiusView).toBe(RENDER_RADIUS_DISABLED_VIEW);
    expect(result.proxyRequests).toHaveLength(0);
    expect(result.activeSet.map((entry) => entry.kind)).toEqual(["tile"]);
    expect(asTile(result.activeSet[0]).proxyAvailable).toBe(false);
    expect(result.requests.some((request) => request.lane === "coarse")).toBe(true);
    expect(result.requests.some((request) => request.lane === "overview")).toBe(false);
  });

  it("emits selected detail plus explicit coarse chunks and no proxy/overview work", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const level1 = makeLevelGeo(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const level2 = makeLevelGeo(2, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "tile-a",
      imageId: "img-a",
      kind: "Image",
      projectedDiagonalPx: 40,
      levels: [level0, level1, level2],
      detailLevel: 0,
      coarseLevel: 2,
      layoutPositionVox: [0, 0],
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024] }),
      selection: makeSelection({ t: 0 }),
    });

    const result = plan(
      snapshot,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: true, prefetchDepth: 0 }),
    );

    const entry = asTile(result.activeSet[0]);
    expect(entry.targetLod).toBe(0);
    expect(entry.coarseLevel).toBe(2);
    expect(entry.detailOwnedLodRange).toEqual([0, 2]);
    expect(entry.wantedLodLevels).toEqual([0, 2]);
    expect(result.proxyRequests).toHaveLength(0);
    expect(result.requests.some((r) => r.lane === "overview")).toBe(false);

    const detail = result.requests.filter((r) => r.lane === "detail");
    const coarse = result.requests.filter((r) => r.lane === "coarse");
    expect(detail).toHaveLength(16);
    expect(new Set(detail.map((r) => r.level))).toEqual(new Set([0]));
    expect(detail.every((r) => r.tier === "detail")).toBe(true);
    expect(coarse).toHaveLength(1);
    expect(coarse[0]).toMatchObject({ level: 2, tier: "coarse" });
  });

  it("uses an explicit lower source detail level while keeping the coarse tier separate", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const level1 = makeLevelGeo(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const level2 = makeLevelGeo(2, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "tile-a",
      imageId: "img-a",
      kind: "Image",
      levels: [level0, level1, level2],
      detailLevel: 1,
      coarseLevel: 2,
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024] }),
      selection: makeSelection(),
    });

    const result = plan(
      snapshot,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: true, prefetchDepth: 0 }),
    );

    const detail = result.requests.filter((r) => r.lane === "detail");
    const coarse = result.requests.filter((r) => r.lane === "coarse");
    expect(new Set(detail.map((r) => r.level))).toEqual(new Set([1]));
    expect(new Set(coarse.map((r) => r.level))).toEqual(new Set([2]));
  });

  it("keeps the coarse lane when the selected detail level is also the coarse level", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const level1 = makeLevelGeo(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "tile-a",
      imageId: "img-a",
      kind: "Image",
      levels: [level0, level1],
      detailLevel: 1,
      coarseLevel: 1,
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024] }),
      selection: makeSelection(),
    });

    const result = plan(
      snapshot,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: true, prefetchDepth: 0 }),
    );

    const detail = result.requests.filter((r) => r.lane === "detail");
    const coarse = result.requests.filter((r) => r.lane === "coarse");
    expect(detail.map((r) => [r.level, r.tier])).toEqual([
      [1, "detail"],
      [1, "detail"],
      [1, "detail"],
      [1, "detail"],
    ]);
    expect(coarse.map((r) => [r.level, r.tier])).toEqual([
      [1, "coarse"],
      [1, "coarse"],
      [1, "coarse"],
      [1, "coarse"],
    ]);
  });

  it("filters detail and coarse lanes with independent render radius knobs", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 1024, 1024], [1, 1, 1, 256, 256]);
    const level1 = makeLevelGeo(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const level2 = makeLevelGeo(2, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "tile-a",
      imageId: "img-a",
      kind: "Image",
      levels: [level0, level1, level2],
      detailLevel: 0,
      coarseLevel: 1,
      layoutPositionVox: [0, 0],
    });
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024] }),
      selection: makeSelection(),
    });

    const result = plan(
      snapshot,
      createSyntheticState(),
      mergeConfig({
        prefetchDepth: 0,
        detailRenderRadiusView: 0.26,
        coarseRenderRadiusView: 0,
      }),
    );

    expect(result.requests.filter((r) => r.lane === "detail")).toHaveLength(4);
    expect(result.requests.filter((r) => r.lane === "coarse")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Three-tier proxy request emission
// ---------------------------------------------------------------------------

describe("plan() — proxy request emission", () => {
  /**
   * Build a minimal collection snapshot with one group + N tiles. All tiles
   * share the same image-level geometry (single LOD, 256x256, 1 chunk).
   *
   * Prev-active-set carry-over lives on {@link PlanningState}, not on
   * the snapshot. Tests that need to seed prev state should construct
   * a `PlanningState` (or thread `result.nextState` from the previous
   * tick) and pass it as the second argument to `plan()`.
   */
  function makeCollectionSnapshot(opts: {
    groupId: string;
    tiles: { id: string; image: string; px: number }[];
    catalog: AssetCatalogSnapshot | null;
    visibleChannels?: number[];
    t?: number;
  }): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entities: EntitySnapshot[] = [
      createSyntheticEntity({
        entityId: opts.groupId,
        imageId: "",
        kind: "Group",
        projectedDiagonalPx: Math.max(...opts.tiles.map((f) => f.px), 0),
        levels: [],
      }),
      ...opts.tiles.map((f) =>
        createSyntheticEntity({
          entityId: f.id,
          imageId: f.image,
          kind: "Tile",
          projectedDiagonalPx: f.px,
          levels: [level0],
          targetLevel: 0,
          parentId: opts.groupId,
        }),
      ),
    ];
    return createSyntheticSnapshot({
      entities,
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      selection: {
        t: opts.t ?? 0,
        c: 0,
        z: 0,
        visibleChannels: opts.visibleChannels ?? [0],
        renderMode: "slice",
        interactionState: "idle",
      },
      assetCatalog: opts.catalog,
    });
  }

  it("group-as-proxy emits one ProxyRequest and no detail chunk requests for that group", () => {
    const catalog = makeCatalog([["groupA", ["GroupProxy3D"]]]);
    const snap = makeCollectionSnapshot({
      groupId: "groupA",
      tiles: [
        { id: "fA1", image: "imgA1", px: 50 },
        { id: "fA2", image: "imgA2", px: 50 },
      ],
      catalog,
    });

    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);

    // Active set = 1 group-as-proxy entry, plus invisible-entry pass for the group/tiles would be 0
    // since they're all visible.
    expect(result.activeSet).toHaveLength(1);
    expect(result.activeSet[0].kind).toBe("group-as-proxy");

    // Proxy requests: exactly 1 group proxy.
    expect(result.proxyRequests).toHaveLength(1);
    expect(result.proxyRequests[0]).toMatchObject({
      entityId: "groupA",
      kind: "GroupProxy3D",
      t: 0,
      c: 0,
      priority: PROXY_LANE_OFFSET + 0,
    });

    // No detail chunks for the group's tiles (group-as-proxy short-circuits).
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs).toHaveLength(0);
  });

  it("tiles-with-proxy-fallback emits chunks + per-tile TileProxy3D + one shared GroupProxy3D", () => {
    const catalog = makeCatalog([
      ["groupB", ["GroupProxy3D"]],
      ["fB1", ["TileProxy3D"]],
      ["fB2", ["TileProxy3D"]],
    ]);
    const snap = makeCollectionSnapshot({
      groupId: "groupB",
      tiles: [
        { id: "fB1", image: "imgB1", px: 100 },
        { id: "fB2", image: "imgB2", px: 100 },
      ],
      catalog,
    });

    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);

    expect(result.activeSet).toHaveLength(2);
    for (const entry of result.activeSet) {
      expect(asTile(entry).mode).toBe("tiles-with-proxy-fallback");
    }

    // Tile detail chunks emitted (2 tiles × 1 chunk).
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs).toHaveLength(2);

    // 2 tile proxies + 1 group proxy.
    expect(result.proxyRequests).toHaveLength(3);

    const tileProxies = result.proxyRequests.filter(
      (p) => p.kind === "TileProxy3D",
    );
    const groupProxies = result.proxyRequests.filter(
      (p) => p.kind === "GroupProxy3D",
    );

    expect(tileProxies).toHaveLength(2);
    expect(groupProxies).toHaveLength(1);
    expect(groupProxies[0].entityId).toBe("groupB");
    // Group proxy is lower priority (higher number) than tile proxies.
    expect(groupProxies[0].priority).toBeGreaterThan(tileProxies[0].priority);
  });

  it("tiles-with-detail emits chunks + per-tile TileProxy3D fallback (no group proxy)", () => {
    const catalog = makeCatalog([
      ["groupC", ["GroupProxy3D"]],
      ["fC1", ["TileProxy3D"]],
    ]);
    const snap = makeCollectionSnapshot({
      groupId: "groupC",
      tiles: [{ id: "fC1", image: "imgC1", px: 200 }],
      catalog,
    });

    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(result.activeSet).toHaveLength(1);
    expect(asTile(result.activeSet[0]).mode).toBe("tiles-with-detail");

    // Detail chunks emitted.
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs.length).toBeGreaterThan(0);

    // Only tile proxy, NO group proxy.
    expect(result.proxyRequests).toHaveLength(1);
    expect(result.proxyRequests[0].kind).toBe("TileProxy3D");
    expect(result.proxyRequests[0].entityId).toBe("fC1");
  });

  it("multi-channel emits one proxy request per visible channel", () => {
    const catalog = makeCatalog([["groupM", ["GroupProxy3D"]]]);
    const snap = makeCollectionSnapshot({
      groupId: "groupM",
      tiles: [{ id: "fM1", image: "imgM1", px: 50 }],
      catalog,
      visibleChannels: [0, 1, 3],
    });

    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(result.proxyRequests).toHaveLength(3);
    const cs = result.proxyRequests.map((p) => p.c).sort();
    expect(cs).toEqual([0, 1, 3]);
  });

  it("lane priority order: minimap (0) < detail (500) < proxy (1000) < prefetch (1500) < overview (2500)", () => {
    // Lane offsets are part of the public contract — downstream
    // priority comparisons depend on this ordering.
    expect(MINIMAP_LANE_OFFSET).toBe(0);
    expect(DETAIL_LANE_OFFSET).toBe(500);
    expect(PROXY_LANE_OFFSET).toBe(1000);
    expect(PREFETCH_LANE_OFFSET).toBe(1500);
    expect(OVERVIEW_LANE_OFFSET).toBe(2500);
    expect(MINIMAP_LANE_OFFSET).toBeLessThan(DETAIL_LANE_OFFSET);
    expect(DETAIL_LANE_OFFSET).toBeLessThan(PROXY_LANE_OFFSET);
    expect(PROXY_LANE_OFFSET).toBeLessThan(PREFETCH_LANE_OFFSET);
    expect(PREFETCH_LANE_OFFSET).toBeLessThan(OVERVIEW_LANE_OFFSET);

    // And in plan() output: smallest detail < smallest proxy < smallest overview.
    const catalog = makeCatalog([
      ["groupL", ["GroupProxy3D"]],
      ["fL1", ["TileProxy3D"]],
    ]);
    const snap = makeCollectionSnapshot({
      groupId: "groupL",
      tiles: [{ id: "fL1", image: "imgL1", px: 100 }],
      catalog,
    });
    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);

    const detail = result.requests.filter((r) => r.lane === "detail");
    const overview = result.requests.filter((r) => r.lane === "overview");
    expect(detail.length).toBeGreaterThan(0);
    expect(overview.length).toBeGreaterThan(0);

    const minDetail = Math.min(...detail.map((r) => r.priority));
    const minProxy = Math.min(...result.proxyRequests.map((p) => p.priority));
    const minOverview = Math.min(...overview.map((r) => r.priority));
    expect(minDetail).toBeLessThan(minProxy);
    expect(minProxy).toBeLessThan(minOverview);
  });

  it("hysteresis: bouncing 75-85px doesn't flip mode after settling on group-as-proxy", () => {
    const catalog = makeCatalog([
      ["groupH", ["GroupProxy3D"]],
      ["fH1", ["TileProxy3D"]],
    ]);

    // Settle on group-as-proxy at 50px.
    let snap = makeCollectionSnapshot({
      groupId: "groupH",
      tiles: [{ id: "fH1", image: "imgH1", px: 50 }],
      catalog,
    });
    let result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(result.activeSet[0].kind).toBe("group-as-proxy");

    // Now bounce 75/82/78/84 — should stay group-as-proxy. Each tick
    // threads the previous tick's `nextState` back as this tick's
    // state, exercising the PlanningState round-trip.
    for (const px of [75, 82, 78, 84, 80]) {
      snap = makeCollectionSnapshot({
        groupId: "groupH",
        tiles: [{ id: "fH1", image: "imgH1", px }],
        catalog,
      });
      result = plan(snap, result.nextState, LEGACY_PROXY_CONFIG);
      expect(result.activeSet[0].kind).toBe("group-as-proxy");
    }

    // Cross 85 → flip to proxy-fallback.
    snap = makeCollectionSnapshot({
      groupId: "groupH",
      tiles: [{ id: "fH1", image: "imgH1", px: 86 }],
      catalog,
    });
    result = plan(snap, result.nextState, LEGACY_PROXY_CONFIG);
    expect(asTile(result.activeSet[0]).mode).toBe("tiles-with-proxy-fallback");
  });

  it("hysteresis: bouncing 145-155px doesn't flip mode after settling on tiles-with-detail", () => {
    const catalog = makeCatalog([
      ["groupJ", ["GroupProxy3D"]],
      ["fJ1", ["TileProxy3D"]],
    ]);

    // Settle on tiles-with-detail at 200px.
    let snap = makeCollectionSnapshot({
      groupId: "groupJ",
      tiles: [{ id: "fJ1", image: "imgJ1", px: 200 }],
      catalog,
    });
    let result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(asTile(result.activeSet[0]).mode).toBe("tiles-with-detail");

    for (const px of [148, 152, 146, 154, 150]) {
      snap = makeCollectionSnapshot({
        groupId: "groupJ",
        tiles: [{ id: "fJ1", image: "imgJ1", px }],
        catalog,
      });
      result = plan(snap, result.nextState, LEGACY_PROXY_CONFIG);
      expect(asTile(result.activeSet[0]).mode).toBe("tiles-with-detail");
    }

    // Cross 145 → flip down.
    snap = makeCollectionSnapshot({
      groupId: "groupJ",
      tiles: [{ id: "fJ1", image: "imgJ1", px: 144 }],
      catalog,
    });
    result = plan(snap, result.nextState, LEGACY_PROXY_CONFIG);
    expect(asTile(result.activeSet[0]).mode).toBe("tiles-with-proxy-fallback");
  });

  it("PlanningState round-trip: feeding result.nextState back is equivalent to threading previousActiveSet manually", () => {
    // The planner returns an opaque `nextState` pointer; the caller
    // is supposed to hand it back unchanged on the next tick. This
    // test pins that "hand back" path to the same outcome a
    // hand-derived `{ previousActiveSet: result.activeSet }` state
    // produces — proving the round-trip is lossless.
    const catalog = makeCatalog([
      ["groupR", ["GroupProxy3D"]],
      ["fR1", ["TileProxy3D"]],
    ]);

    // Tick 1: settle on group-as-proxy at 50px.
    const tick1Snap = makeCollectionSnapshot({
      groupId: "groupR",
      tiles: [{ id: "fR1", image: "imgR1", px: 50 }],
      catalog,
    });
    const tick1 = plan(tick1Snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(tick1.activeSet[0].kind).toBe("group-as-proxy");

    // Tick 2: same snapshot at 82px (inside the FAR hysteresis band).
    // Two state constructions that should produce identical plans:
    //   (a) feeding the planner-returned `nextState` back unchanged,
    //   (b) hand-constructing `{ previousActiveSet: tick1.activeSet }`.
    const tick2Snap = makeCollectionSnapshot({
      groupId: "groupR",
      tiles: [{ id: "fR1", image: "imgR1", px: 82 }],
      catalog,
    });

    const viaNextState = plan(tick2Snap, tick1.nextState, LEGACY_PROXY_CONFIG);
    const viaHandConstructed = plan(
      tick2Snap,
      {
        previousActiveSet: tick1.activeSet,
      } satisfies PlanningState,
      LEGACY_PROXY_CONFIG,
    );

    // Active set, request lanes, proxy requests, and stats agree.
    expect(viaNextState.activeSet).toEqual(viaHandConstructed.activeSet);
    expect(viaNextState.requests).toEqual(viaHandConstructed.requests);
    expect(viaNextState.proxyRequests).toEqual(viaHandConstructed.proxyRequests);
    expect(viaNextState.stats).toEqual(viaHandConstructed.stats);
    // And the next-state pointer the caller would store is also the
    // same shape (the planner derives it from `activeSet` — a
    // round-trip of a round-trip).
    expect(viaNextState.nextState).toEqual(viaHandConstructed.nextState);
    // Hysteresis preserved: 82px stays group-as-proxy because prev
    // already was.
    expect(viaNextState.activeSet[0].kind).toBe("group-as-proxy");
  });

  it("constants check: thresholds 80/150 with hysteresis 5", () => {
    expect(FAR_THRESHOLD_PX).toBe(80);
    expect(DETAIL_THRESHOLD_PX).toBe(150);
    expect(HYSTERESIS_PX).toBe(5);
  });

  it("named magic numbers have their documented values", () => {
    expect(IMPORTANCE_WEIGHT).toBe(500);
    expect(DISTANCE_WEIGHT).toBe(10);
    expect(GROUP_PROXY_PRIORITY_BUMP).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// iterateGridCells stats accumulation (characterization)
// ---------------------------------------------------------------------------

describe("iterateGridCells stats accumulation", () => {
  /**
   * Single-LOD, single-channel entity with a 4x4x4 grid and 256-voxel
   * chunks. Reused across the stats tests so each one only needs to
   * tweak the visible region / frustum.
   */
  function makeStatsFixture(): { entity: EntitySnapshot; entry: ActiveSetEntry } {
    const level0 = makeLevelGeo(0, [1, 1, 4, 1024, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      layoutPositionVox: [0, 0],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);
    return { entity, entry };
  }

  it("considered increments by maxCol * maxRow * maxZ per call", () => {
    const { entity, entry } = makeStatsFixture();
    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 4],
    });
    const stats = emptyPlanStats();

    iterateChunks(entity, entry, region, makeSelection(), stats);

    // 4 * 4 * 4 = 64 grid cells considered.
    expect(stats.culling.considered).toBe(64);
  });

  it("after XY clipping, afterXyBounds reflects the clipped count", () => {
    const { entity, entry } = makeStatsFixture();
    // Clip to top-left quadrant: 2x2 columns kept, all 4 z slices.
    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 512, 512],
      zRangeVox: [0, 4],
    });
    const stats = emptyPlanStats();

    iterateChunks(entity, entry, region, makeSelection(), stats);

    expect(stats.culling.considered).toBe(64);
    // 2 cols * 2 rows * 4 z = 16
    expect(stats.culling.afterXyBounds).toBe(16);
  });

  it("after Z clipping, afterZRange reflects the further clip", () => {
    const { entity, entry } = makeStatsFixture();
    // Full XY but only z=0..1 (one z slice kept).
    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
    });
    const stats = emptyPlanStats();

    iterateChunks(entity, entry, region, makeSelection(), stats);

    // afterXyBounds = full 4*4*4 cube of cols/rows times all z = 64
    expect(stats.culling.afterXyBounds).toBe(64);
    // afterZRange clips z to a single slice: 4 * 4 * 1 = 16
    expect(stats.culling.afterZRange).toBe(16);
  });

  it("afterFrustum increments per surviving cell", () => {
    const { entity, entry } = makeStatsFixture();
    // Tight frustum: keep only x-cols where cmin_x < 256, i.e. col 0.
    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 4],
      // Plane (-1, 0, 0, 0): outside iff -1*cmin_x + 0 < 0 → cmin_x > 0.
      // p-vertex picks cmax_x for negative-x normal (here normal[0] = -1 < 0,
      // so px = cmin_x). Plane = [-1, 0, 0, 256] keeps cmin_x <= 256.
      frustumPlanes: [[-1, 0, 0, 256]],
    });
    const stats = emptyPlanStats();

    iterateChunks(entity, entry, region, makeSelection(), stats);

    // Only x-cols 0,1 (cmin_x = 0, 256) survive: 2 cols * 4 rows * 4 z = 32.
    expect(stats.culling.afterFrustum).toBe(32);
  });

  it("hierarchy invariant holds across multiple calls: considered ≥ afterXyBounds ≥ afterZRange ≥ afterFrustum", () => {
    const { entity, entry } = makeStatsFixture();
    const stats = emptyPlanStats();

    // Mix of regions: full, XY clipped, Z clipped, frustum culled.
    iterateChunks(
      entity,
      entry,
      makeVisibleRegion({ xyBoundsVox: [0, 0, 1024, 1024], zRangeVox: [0, 4] }),
      makeSelection(),
      stats,
    );
    iterateChunks(
      entity,
      entry,
      makeVisibleRegion({ xyBoundsVox: [0, 0, 512, 512], zRangeVox: [0, 4] }),
      makeSelection(),
      stats,
    );
    iterateChunks(
      entity,
      entry,
      makeVisibleRegion({
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [0, 1],
        frustumPlanes: [[-1, 0, 0, 256]],
      }),
      makeSelection(),
      stats,
    );

    expect(stats.culling.considered).toBeGreaterThanOrEqual(
      stats.culling.afterXyBounds,
    );
    expect(stats.culling.afterXyBounds).toBeGreaterThanOrEqual(
      stats.culling.afterZRange,
    );
    expect(stats.culling.afterZRange).toBeGreaterThanOrEqual(
      stats.culling.afterFrustum,
    );
  });

  it("early-out (no overlap) only increments considered; others stay at zero", () => {
    const { entity, entry } = makeStatsFixture();
    // Visible region wholly to the right of the entity (which sits at
    // origin with a 1024-wide level-0 shape). Local maxX <= 0 triggers
    // the early-out before any axis indices are computed.
    const region = makeVisibleRegion({
      xyBoundsVox: [-2000, -2000, -1000, -1000],
      zRangeVox: [0, 4],
    });
    const stats = emptyPlanStats();

    const result = iterateChunks(entity, entry, region, makeSelection(), stats);

    expect(result).toHaveLength(0);
    expect(stats.culling.considered).toBe(64);
    expect(stats.culling.afterXyBounds).toBe(0);
    expect(stats.culling.afterZRange).toBe(0);
    expect(stats.culling.afterFrustum).toBe(0);
  });

  it("all-frustum-culled scenario: empty result, afterFrustum=0, afterZRange records the clipped count", () => {
    const { entity, entry } = makeStatsFixture();
    // XY-bounds and Z keep everything, but the frustum plane rejects
    // every chunk (plane forces cmin_x > entity extent).
    const region = makeVisibleRegion({
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      frustumPlanes: [[-1, 0, 0, -2000]],
    });
    const stats = emptyPlanStats();

    const result = iterateChunks(entity, entry, region, makeSelection(), stats);

    expect(result).toHaveLength(0);
    expect(stats.culling.afterFrustum).toBe(0);
    // After Z clipping (z=[0,1] keeps a single z slice): 4 * 4 * 1 = 16.
    expect(stats.culling.afterZRange).toBe(16);
    expect(stats.culling.afterXyBounds).toBe(64);
    expect(stats.culling.considered).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("plan() edge cases", () => {
  it("empty entities → empty plan, no errors", () => {
    const snap = createSyntheticSnapshot({ entities: [] });
    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);

    expect(result.activeSet).toHaveLength(0);
    expect(result.requests).toHaveLength(0);
    expect(result.proxyRequests).toHaveLength(0);
    expect(result.epochs.request).toBe(snap.epochs.request + 1);
  });

  it("all entities invisible → invisible-only active set, empty requests", () => {
    // Entity A: positioned wholly outside the visible region so spatial
    // culling clips every chunk away. Entity B: no levels, so the
    // iterator early-outs.
    //
    // Together this tests the planner's invariant: invisible entities
    // make it into the active set as `tiles-with-detail` pass-throughs,
    // but contribute no chunk requests when there's nothing to fetch.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entityA = createSyntheticEntity({
      entityId: "a",
      imageId: "img-a",
      visible: false,
      levels: [level0],
      layoutPositionVox: [10000, 10000],
    });
    const entityB = createSyntheticEntity({
      entityId: "b",
      imageId: "img-b",
      visible: false,
      levels: [],
    });
    const snap = createSyntheticSnapshot({ entities: [entityA, entityB] });
    const result = plan(snap, createSyntheticState());

    expect(result.activeSet).toHaveLength(2);
    // Invisibles ride their own variant.
    for (const entry of result.activeSet) {
      expect(entry.kind).toBe("invisible");
    }
    const detail = result.requests.filter((r) => r.lane === "detail");
    const prefetch = result.requests.filter((r) => r.lane === "prefetch");
    expect(detail).toHaveLength(0);
    expect(prefetch).toHaveLength(0);
  });

  it("prefetch terminates correctly when selection.t + dt >= maxT", () => {
    // Single timepoint (maxT === 1): no prefetch should be emitted.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      levels: [level0],
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const result = plan(snap, createSyntheticState());
    const prefetch = result.requests.filter((r) => r.lane === "prefetch");
    expect(prefetch).toHaveLength(0);
  });

  it("prefetch only emits valid future timepoints (selection.t near maxT)", () => {
    // maxT = 3, selection.t = 2 → only T+1 (=3) would be requested but
    // 3 >= maxT, so the loop breaks before emitting; expect no prefetch.
    const level0 = makeLevelGeo(0, [3, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      levels: [level0],
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      selection: {
        t: 2,
        c: 0,
        z: 0,
        visibleChannels: [0],
        renderMode: "slice",
        interactionState: "idle",
      },
    });

    const result = plan(snap, createSyntheticState());
    const prefetch = result.requests.filter((r) => r.lane === "prefetch");
    expect(prefetch).toHaveLength(0);
  });
});

describe("iterateChunks edge cases", () => {
  it("tile-mode entry with empty levels → empty result", () => {
    const entity = createSyntheticEntity({
      entityId: "e0",
      levels: [],
    });
    const entry = makeTileDetailEntry("e0", "img0", 0, 0);
    const result = iterateChunks(entity, entry, makeVisibleRegion(), makeSelection());
    expect(result).toHaveLength(0);
  });
});

// {@link TileSnapshot} requires a non-null `parentId` at the type
// level — an orphan tile is a producer invariant violation, not a
// code path. The snapshot builder throws on a missing manifest
// parent edge for a Tile, and the per-variant defaults in
// {@link createSyntheticEntity} supply a synthetic parent id so
// test fixtures don't have to thread one through every call.

describe("assignModes edge cases", () => {
  it("stale previousActiveSet entries (entities no longer present) are silently ignored", () => {
    // No entities in the new snapshot — but previousActiveSet has
    // entries pointing to ids that don't exist anymore. assignModes
    // should not throw and the empty entities list should produce an
    // empty result.
    const stalePrev: ActiveSetEntry[] = [
      { kind: "group-as-proxy", entityId: "ghost-group" },
      {
        kind: "tile",
        entityId: "ghost-tile",
        imageId: "ghost-img",
        mode: "tiles-with-detail",
        targetLod: 0,
        coarsestDetailLod: 2,
        detailOwnedLodRange: [0, 2],
        proxyKind: "TileProxy3D",
        proxyAvailable: false,
        groupProxyAvailable: false,
      },
    ];

    expect(() => assignModes([], stalePrev)).not.toThrow();
    expect(assignModes([], stalePrev)).toEqual([]);
  });
});

describe("chooseEntityMode edge cases", () => {
  it("null prev with px inside the FAR hysteresis band falls back to tiles-with-proxy-fallback", () => {
    // px=80 is in the [farLower, farUpper) band; with no prev mode and
    // none of the prevMode branches matching, the function returns
    // `prevMode ?? "tiles-with-proxy-fallback"`.
    expect(chooseEntityMode(null, 80)).toBe("tiles-with-proxy-fallback");
  });

  it("null prev with px inside the MEDIUM hysteresis band falls back to tiles-with-proxy-fallback", () => {
    // px=150 is in the (medLower, medUpper] band.
    expect(chooseEntityMode(null, 150)).toBe("tiles-with-proxy-fallback");
  });
});

describe("chunkOutsideFrustum multi-plane scenarios", () => {
  it("3+ planes simulating a real camera frustum: chunk inside all planes is kept", () => {
    // Approximate a camera frustum with 6 planes (left/right/top/bottom/near/far)
    // around the box x in [0, 100], y in [0, 100], z in [0, 100].
    // Each plane is `n . p + d >= 0`, where n is the inward-pointing normal.
    const planes: [number, number, number, number][] = [
      [1, 0, 0, 0],     // left:   x >= 0
      [-1, 0, 0, 100],  // right:  x <= 100
      [0, 1, 0, 0],     // bottom: y >= 0
      [0, -1, 0, 100],  // top:    y <= 100
      [0, 0, 1, 0],     // near:   z >= 0
      [0, 0, -1, 100],  // far:    z <= 100
    ];
    // Chunk wholly inside the frustum.
    expect(chunkOutsideFrustum([10, 10, 10], [40, 40, 40], planes)).toBe(false);
  });

  it("3+ planes: chunk straddling just one plane is still kept (p-vertex test)", () => {
    const planes: [number, number, number, number][] = [
      [1, 0, 0, 0],
      [-1, 0, 0, 100],
      [0, 1, 0, 0],
      [0, -1, 0, 100],
      [0, 0, 1, 0],
      [0, 0, -1, 100],
    ];
    // Chunk straddles the right plane (x crosses 100). p-vertex picks
    // cmin_x for the right plane (normal[0] = -1 < 0, so px = cmin_x =
    // 90), and (-1)*90 + 100 = 10 >= 0 → not outside.
    expect(chunkOutsideFrustum([90, 10, 10], [120, 40, 40], planes)).toBe(false);
  });

  it("3+ planes: chunk fully behind one plane is culled even when inside all others", () => {
    const planes: [number, number, number, number][] = [
      [1, 0, 0, 0],
      [-1, 0, 0, 100],
      [0, 1, 0, 0],
      [0, -1, 0, 100],
      [0, 0, 1, 0],
      [0, 0, -1, 100],
    ];
    // Chunk wholly past the far plane (z > 100).
    expect(chunkOutsideFrustum([10, 10, 200], [40, 40, 250], planes)).toBe(true);
  });
});

describe("chunkKey direct format", () => {
  it("returns canonical 'level/t/c/z/y/x' string", () => {
    expect(chunkKey(2, 0, 1, 5, 4, 3)).toBe("2/0/1/5/4/3");
  });

  it("round-trips via simple parse", () => {
    const key = chunkKey(0, 7, 1, 9, 2, 6);
    const parts = key.split("/").map(Number);
    expect(parts).toEqual([0, 7, 1, 9, 2, 6]);
  });
});

// ---------------------------------------------------------------------------
// PlanningConfig
// ---------------------------------------------------------------------------

describe("PlanningConfig", () => {
  it("DEFAULT_PLANNING_CONFIG matches the exported constants for every tunable", () => {
    expect(DEFAULT_PLANNING_CONFIG.farThresholdPx).toBe(FAR_THRESHOLD_PX);
    expect(DEFAULT_PLANNING_CONFIG.detailThresholdPx).toBe(DETAIL_THRESHOLD_PX);
    expect(DEFAULT_PLANNING_CONFIG.hysteresisPx).toBe(HYSTERESIS_PX);
    expect(DEFAULT_PLANNING_CONFIG.prefetchDepth).toBe(PREFETCH_DEPTH);
    expect(DEFAULT_PLANNING_CONFIG.importanceWeight).toBe(IMPORTANCE_WEIGHT);
    expect(DEFAULT_PLANNING_CONFIG.distanceWeight).toBe(DISTANCE_WEIGHT);
    expect(DEFAULT_PLANNING_CONFIG.depthBiasView).toBe(DEPTH_BIAS_VIEW);
    // The default focal-depth bias must be exactly 0 (centered) — this
    // is the #532 safety property at the constant level.
    expect(DEPTH_BIAS_VIEW).toBe(0);
    expect(DEFAULT_PLANNING_CONFIG.groupProxyPriorityBump).toBe(
      GROUP_PROXY_PRIORITY_BUMP,
    );
    expect(DEFAULT_PLANNING_CONFIG.minimapLaneOffset).toBe(MINIMAP_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.minimapSeedFastMaxChunks).toBe(
      MINIMAP_SEED_FAST_MAX_CHUNKS,
    );
    expect(DEFAULT_PLANNING_CONFIG.minimapSeedBulkLaneOffset).toBe(
      MINIMAP_SEED_BULK_LANE_OFFSET,
    );
    expect(DEFAULT_PLANNING_CONFIG.detailLaneOffset).toBe(DETAIL_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.proxyLaneOffset).toBe(PROXY_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.prefetchLaneOffset).toBe(
      PREFETCH_LANE_OFFSET,
    );
    expect(DEFAULT_PLANNING_CONFIG.coarseLaneOffset).toBe(COARSE_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.overviewLaneOffset).toBe(
      OVERVIEW_LANE_OFFSET,
    );
    expect(DEFAULT_PLANNING_CONFIG.coarseDetailEnabled).toBe(true);
  });

  it("lane offsets: 0 / 500 / 1000 / 1500 / 2400 / 2500 / 2600", () => {
    // Hard-pinned values so a future re-number is loud.
    expect(MINIMAP_LANE_OFFSET).toBe(0);
    expect(DETAIL_LANE_OFFSET).toBe(500);
    expect(PROXY_LANE_OFFSET).toBe(1000);
    expect(PREFETCH_LANE_OFFSET).toBe(1500);
    expect(COARSE_LANE_OFFSET).toBe(2400);
    expect(OVERVIEW_LANE_OFFSET).toBe(2500);
    expect(MINIMAP_SEED_BULK_LANE_OFFSET).toBe(2600);
  });

  it("mergeConfig({}) returns a config equal to DEFAULT_PLANNING_CONFIG", () => {
    const merged = mergeConfig({});
    expect(merged).toEqual(DEFAULT_PLANNING_CONFIG);
    // Returns a fresh object — not the same reference as the default.
    expect(merged).not.toBe(DEFAULT_PLANNING_CONFIG);
  });

  it("mergeConfig({farThresholdPx: 50}) overrides one tile, defaults the rest", () => {
    const merged = mergeConfig({ farThresholdPx: 50 });
    expect(merged.farThresholdPx).toBe(50);
    expect(merged.detailThresholdPx).toBe(DEFAULT_PLANNING_CONFIG.detailThresholdPx);
    expect(merged.hysteresisPx).toBe(DEFAULT_PLANNING_CONFIG.hysteresisPx);
    expect(merged.prefetchDepth).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);
    expect(merged.importanceWeight).toBe(DEFAULT_PLANNING_CONFIG.importanceWeight);
    expect(merged.distanceWeight).toBe(DEFAULT_PLANNING_CONFIG.distanceWeight);
    expect(merged.groupProxyPriorityBump).toBe(
      DEFAULT_PLANNING_CONFIG.groupProxyPriorityBump,
    );
    expect(merged.minimapLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.minimapLaneOffset);
    expect(merged.detailLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.detailLaneOffset);
    expect(merged.proxyLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.proxyLaneOffset);
    expect(merged.prefetchLaneOffset).toBe(
      DEFAULT_PLANNING_CONFIG.prefetchLaneOffset,
    );
    expect(merged.coarseLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.coarseLaneOffset);
    expect(merged.overviewLaneOffset).toBe(
      DEFAULT_PLANNING_CONFIG.overviewLaneOffset,
    );
    expect(merged.coarseDetailEnabled).toBe(DEFAULT_PLANNING_CONFIG.coarseDetailEnabled);
    expect(merged.detailRenderRadiusView).toBe(DEFAULT_PLANNING_CONFIG.detailRenderRadiusView);
    expect(merged.coarseRenderRadiusView).toBe(DEFAULT_PLANNING_CONFIG.coarseRenderRadiusView);
  });

  it("mergeConfig doesn't mutate the input partial", () => {
    const partial: Partial<PlanningConfig> = { farThresholdPx: 50 };
    const before = { ...partial };
    mergeConfig(partial);
    expect(partial).toEqual(before);
    // And only the specified tile is present on the input object.
    expect(Object.keys(partial)).toEqual(["farThresholdPx"]);
  });
});

// ---------------------------------------------------------------------------
// plan() honors config tunables
// ---------------------------------------------------------------------------
//
// Each test changes one tunable on a tailored synthetic snapshot and
// asserts that the corresponding behaviour shifts. Defaults are
// confirmed in PlanningConfig above; here we verify the parameter
// actually flows through to every code path.

describe("plan() honors config tunables", () => {
  /**
   * Single-channel single-LOD collection snapshot at a configurable
   * projected diagonal. Tile has its own catalog entries so it can
   * promote to any of the three modes.
   */
  function makeTunableCollection(opts: {
    px: number;
    catalog?: AssetCatalogSnapshot | null;
    importance?: number;
    visibleChannels?: number[];
  }): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const groupId = "groupT";
    const tileId = "fT1";
    const catalog =
      opts.catalog ??
      makeCatalog([
        [groupId, ["GroupProxy3D"]],
        [tileId, ["TileProxy3D"]],
      ]);
    return createSyntheticSnapshot({
      entities: [
        createSyntheticEntity({
          entityId: groupId,
          imageId: "",
          kind: "Group",
          projectedDiagonalPx: opts.px,
          levels: [],
        }),
        createSyntheticEntity({
          entityId: tileId,
          imageId: "imgT1",
          kind: "Tile",
          projectedDiagonalPx: opts.px,
          targetLevel: 0,
          levels: [level0],
          importance: opts.importance ?? 1.0,
          parentId: groupId,
        }),
      ],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      selection: {
        t: 0,
        c: 0,
        z: 0,
        visibleChannels: opts.visibleChannels ?? [0],
        renderMode: "slice",
        interactionState: "idle",
      },
      assetCatalog: catalog,
    });
  }

  it("farThresholdPx: raising to 200 promotes a 100px entity to group-as-proxy", () => {
    const snap = makeTunableCollection({ px: 100 });

    // Default thresholds: 100px → tiles-with-proxy-fallback.
    const defaultResult = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(asTile(defaultResult.activeSet[0]).mode).toBe("tiles-with-proxy-fallback");

    // Raise the far threshold past 100 → promotes to group-as-proxy.
    const result = plan(
      snap,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: false, farThresholdPx: 200, detailThresholdPx: 250 }),
    );
    expect(result.activeSet).toHaveLength(1);
    expect(result.activeSet[0].kind).toBe("group-as-proxy");
  });

  it("detailThresholdPx: lowering to 50 demotes a 100px entity to tiles-with-detail", () => {
    const snap = makeTunableCollection({ px: 100 });

    const defaultResult = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    expect(asTile(defaultResult.activeSet[0]).mode).toBe("tiles-with-proxy-fallback");

    // Lower the detail threshold past 100 → tiles-with-detail.
    const result = plan(
      snap,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: false, farThresholdPx: 30, detailThresholdPx: 50 }),
    );
    expect(asTile(result.activeSet[0]).mode).toBe("tiles-with-detail");
  });

  it("hysteresisPx: a wider band lets the previous mode win in a wider range", () => {
    // Settle at 50px in group-as-proxy, then read 100px.
    const settle = plan(
      makeTunableCollection({ px: 50 }),
      createSyntheticState(),
      LEGACY_PROXY_CONFIG,
    );
    expect(settle.activeSet[0].kind).toBe("group-as-proxy");

    const followup = makeTunableCollection({ px: 100 });
    // Prev active set carries via PlanningState.
    const followupState = settle.nextState;

    // Default hysteresis (5px): 100 is way past farUpper (85), so it
    // flips out of group-as-proxy.
    const defaultResult = plan(followup, followupState, LEGACY_PROXY_CONFIG);
    expect(defaultResult.activeSet[0].kind).not.toBe("group-as-proxy");

    // Wider hysteresis (50px): 100 falls inside the [80-50, 80+50] = [30, 130]
    // band, so the prev group-as-proxy mode is preserved.
    const result = plan(
      followup,
      followupState,
      mergeConfig({ coarseDetailEnabled: false, hysteresisPx: 50 }),
    );
    expect(result.activeSet[0].kind).toBe("group-as-proxy");
  });

  it("prefetchDepth: 0 emits no prefetch chunks; 4 emits T+1..T+4", () => {
    const level0 = makeLevelGeo(0, [10, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const zero = plan(snap, createSyntheticState(), mergeConfig({ prefetchDepth: 0 }));
    expect(zero.requests.filter((r) => r.lane === "prefetch")).toHaveLength(0);

    const four = plan(snap, createSyntheticState(), mergeConfig({ prefetchDepth: 4 }));
    const ts = new Set(
      four.requests.filter((r) => r.lane === "prefetch").map((r) => r.t),
    );
    expect(ts).toEqual(new Set([1, 2, 3, 4]));
  });

  it("importanceWeight: 0 makes priority no longer depend on importance", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const high = createSyntheticEntity({
      entityId: "high",
      imageId: "img-h",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
    });
    const low = createSyntheticEntity({
      entityId: "low",
      imageId: "img-l",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 0.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [high, low],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    // Default: importance weight is non-zero → priorities differ.
    const defaultResult = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const defaultDetail = defaultResult.requests.filter(
      (r) => r.lane === "detail",
    );
    const defaultHigh = defaultDetail.find((r) => r.entityId === "high")!;
    const defaultLow = defaultDetail.find((r) => r.entityId === "low")!;
    expect(defaultHigh.priority).not.toBe(defaultLow.priority);

    // With importanceWeight = 0, same-distance chunks have equal priority.
    const result = plan(snap, createSyntheticState(), mergeConfig({ importanceWeight: 0 }));
    const detail = result.requests.filter((r) => r.lane === "detail");
    const hi = detail.find((r) => r.entityId === "high")!;
    const lo = detail.find((r) => r.entityId === "low")!;
    expect(hi.priority).toBe(lo.priority);
  });

  it("distanceWeight: 0 removes distance from priority within a lane", () => {
    // Two chunks at different distances from sortCenterVox, same importance.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 1024, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: [960, 128, 0],
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
    });

    // Default: distance-based priority differs across columns.
    const defaultResult = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const defaultDetail = defaultResult.requests.filter(
      (r) => r.lane === "detail",
    );
    const defaultPriorities = new Set(defaultDetail.map((r) => r.priority));
    expect(defaultPriorities.size).toBeGreaterThan(1);

    // distanceWeight = 0 → all detail chunks for one entity share the
    // same priority because importance is identical and distance no
    // longer contributes.
    const result = plan(snap, createSyntheticState(), mergeConfig({ distanceWeight: 0 }));
    const detail = result.requests.filter((r) => r.lane === "detail");
    expect(detail.length).toBe(4);
    const priorities = new Set(detail.map((r) => r.priority));
    expect(priorities.size).toBe(1);
  });

  it("groupProxyPriorityBump: changing it shifts the parent-group proxy priority", () => {
    const snap = makeTunableCollection({ px: 100 });

    const defaultResult = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const defaultGroupProxy = defaultResult.proxyRequests.find(
      (p) => p.kind === "GroupProxy3D",
    )!;
    expect(defaultGroupProxy.priority).toBe(
      DEFAULT_PLANNING_CONFIG.proxyLaneOffset +
        DEFAULT_PLANNING_CONFIG.groupProxyPriorityBump,
    );

    const result = plan(
      snap,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: false, groupProxyPriorityBump: 50 }),
    );
    const groupProxy = result.proxyRequests.find(
      (p) => p.kind === "GroupProxy3D",
    )!;
    expect(groupProxy.priority).toBe(
      DEFAULT_PLANNING_CONFIG.proxyLaneOffset + 50,
    );
  });

  it("detailLaneOffset: changing it shifts every detail-chunk priority", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const before = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const beforeDetail = before.requests.filter((r) => r.lane === "detail");
    expect(beforeDetail.length).toBe(1);
    const beforePri = beforeDetail[0].priority;

    // Override offset is `default + 250` so the delta is +250
    // regardless of the default. The override is computed off the
    // live default rather than hard-coded so a future re-number
    // doesn't silently break this assertion.
    const newOffset = DEFAULT_PLANNING_CONFIG.detailLaneOffset + 250;
    const after = plan(snap, createSyntheticState(), mergeConfig({ detailLaneOffset: newOffset }));
    const afterDetail = after.requests.filter((r) => r.lane === "detail");
    expect(afterDetail.length).toBe(1);
    // Only the lane offset changed → priority shifts by exactly +250.
    expect(afterDetail[0].priority).toBeCloseTo(beforePri + 250);
  });

  it("proxyLaneOffset: changing it shifts every proxy-request priority", () => {
    const snap = makeTunableCollection({ px: 50 }); // → group-as-proxy

    const before = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const beforeGroupProxy = before.proxyRequests.find(
      (p) => p.kind === "GroupProxy3D",
    )!;
    expect(beforeGroupProxy.priority).toBe(
      DEFAULT_PLANNING_CONFIG.proxyLaneOffset,
    );

    const after = plan(
      snap,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: false, proxyLaneOffset: 750 }),
    );
    const afterGroupProxy = after.proxyRequests.find(
      (p) => p.kind === "GroupProxy3D",
    )!;
    expect(afterGroupProxy.priority).toBe(750);
  });

  it("prefetchLaneOffset: changing it shifts every prefetch-chunk priority", () => {
    const level0 = makeLevelGeo(0, [10, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const before = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const beforePrefetch = before.requests.filter(
      (r) => r.lane === "prefetch" && r.t === 1,
    );
    expect(beforePrefetch.length).toBe(1);
    const beforePri = beforePrefetch[0].priority;

    // Override is `default + 500` so the delta is +500 regardless
    // of the default — computed off the live default rather than
    // hard-coded.
    const newOffset = DEFAULT_PLANNING_CONFIG.prefetchLaneOffset + 500;
    const after = plan(snap, createSyntheticState(), mergeConfig({ prefetchLaneOffset: newOffset }));
    const afterPrefetch = after.requests.filter(
      (r) => r.lane === "prefetch" && r.t === 1,
    );
    expect(afterPrefetch.length).toBe(1);
    // Lane offset shift is +500.
    expect(afterPrefetch[0].priority).toBeCloseTo(beforePri + 500);
  });

  it("overviewLaneOffset: changing it shifts every overview-chunk priority", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
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
    });

    const before = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const beforeOverview = before.requests.filter((r) => r.lane === "overview");
    expect(beforeOverview.length).toBe(1);
    const beforePri = beforeOverview[0].priority;

    // Override is `default + 1000` so the delta is +1000 regardless
    // of the default — computed off the live default rather than
    // hard-coded.
    const newOffset = DEFAULT_PLANNING_CONFIG.overviewLaneOffset + 1000;
    const after = plan(
      snap,
      createSyntheticState(),
      mergeConfig({ coarseDetailEnabled: false, overviewLaneOffset: newOffset }),
    );
    const afterOverview = after.requests.filter((r) => r.lane === "overview");
    expect(afterOverview.length).toBe(1);
    // Lane offset shift is +1000.
    expect(afterOverview[0].priority).toBeCloseTo(beforePri + 1000);
  });
});

// ---------------------------------------------------------------------------
// emitMinimapLane (ADR 0023)
// ---------------------------------------------------------------------------
//
// Minimap chunks ride their own dedicated highest-priority lane.
// The planner pulls them from `snapshot.minimapPending` and emits
// them with `priority = MINIMAP_LANE_OFFSET` directly (no importance
// / distance terms — minimap is per-dataset, not per-entity).

describe("plan() — minimap lane", () => {
  /** Build a minimal snapshot with one visible Image entity and a non-empty minimapPending. */
  function makeMinimapSnapshot(opts?: {
    minimapPending?: Map<string, MinimapChunkCoord[]>;
    importance?: number;
  }): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "imgM",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      levels: [level0],
      importance: opts?.importance ?? 1.0,
    });
    return createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 256, 256] }),
      selection: makeSelection(),
      minimapPending:
        opts?.minimapPending ??
        new Map([
          [
            "imgM",
            [
              { level: 3, x: 0, y: 0, z: 0, t: 0, c: 0, key: "3/0/0/0/0/0" },
              { level: 3, x: 1, y: 0, z: 0, t: 0, c: 0, key: "3/0/0/0/0/1" },
            ],
          ],
        ]),
    });
  }

  it("enumerates one ChunkRequest per coord per matching entity.imageId", () => {
    const snap = makeMinimapSnapshot();
    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    expect(minimap).toHaveLength(2);
    expect(new Set(minimap.map((r) => r.chunkKey))).toEqual(
      new Set(["3/0/0/0/0/0", "3/0/0/0/0/1"]),
    );
    for (const req of minimap) {
      expect(req.entityId).toBe("e0");
      expect(req.imageId).toBe("imgM");
      expect(req.level).toBe(3);
    }
  });

  it("emits at priority MINIMAP_LANE_OFFSET (= 0 by default)", () => {
    const snap = makeMinimapSnapshot();
    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    for (const req of minimap) {
      expect(req.priority).toBe(MINIMAP_LANE_OFFSET);
      expect(req.priority).toBe(0);
    }
  });

  it("ignores importance — priority is exactly the lane offset regardless", () => {
    // Two snapshots, identical minimapPending, different entity.importance.
    const snapHigh = makeMinimapSnapshot({ importance: 1.0 });
    const snapLow = makeMinimapSnapshot({ importance: 0.0 });
    const high = plan(snapHigh, createSyntheticState()).requests.filter((r) => r.lane === "minimap");
    const low = plan(snapLow, createSyntheticState()).requests.filter((r) => r.lane === "minimap");
    expect(high.length).toBeGreaterThan(0);
    expect(low.length).toBeGreaterThan(0);
    // Importance is not factored into minimap priority.
    expect(high[0].priority).toBe(MINIMAP_LANE_OFFSET);
    expect(low[0].priority).toBe(MINIMAP_LANE_OFFSET);
    expect(high[0].priority).toBe(low[0].priority);
  });

  it("ignores distance from view center — every coord is at MINIMAP_LANE_OFFSET", () => {
    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        [
          "imgM",
          [
            { level: 3, x: 0, y: 0, z: 0, t: 0, c: 0, key: "3/0/0/0/0/0" },
            { level: 3, x: 99, y: 99, z: 0, t: 0, c: 0, key: "3/0/0/0/99/99" },
            { level: 3, x: 5, y: 5, z: 0, t: 0, c: 0, key: "3/0/0/0/5/5" },
          ],
        ],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const priorities = new Set(
      result.requests.filter((r) => r.lane === "minimap").map((r) => r.priority),
    );
    expect(priorities.size).toBe(1);
    expect(priorities.has(MINIMAP_LANE_OFFSET)).toBe(true);
  });

  it("emits no minimap requests when minimapPending is empty", () => {
    const snap = makeMinimapSnapshot({ minimapPending: new Map() });
    const result = plan(snap, createSyntheticState());
    expect(result.requests.some((r) => r.lane === "minimap")).toBe(false);
  });

  // The "skips coords for an imageId that no visible entity matches"
  // case isn't covered here: per ADR 0031, `validatePlanningInputs`
  // (called at the top of `plan()` in dev mode) throws on an unknown
  // `minimapPending` key at the producer boundary instead of letting
  // the planner silently ignore it. That throw is covered by
  // `validate.test.ts > checkMinimapKeys`.

  it("sorts before every other lane after the priority sort (smallest priority first)", () => {
    const snap = makeMinimapSnapshot();
    const result = plan(snap, createSyntheticState());
    expect(result.requests.length).toBeGreaterThan(0);
    // Minimap chunks are at priority 0, every other lane is
    // >= DETAIL_LANE_OFFSET (= 500). plan()'s ascending priority
    // sort therefore guarantees the first non-minimap entry comes
    // after every minimap entry.
    let lastMinimapIdx = -1;
    let firstNonMinimapIdx = -1;
    for (let i = 0; i < result.requests.length; i++) {
      if (result.requests[i].lane === "minimap") lastMinimapIdx = i;
      else if (firstNonMinimapIdx === -1) firstNonMinimapIdx = i;
    }
    expect(lastMinimapIdx).toBeGreaterThanOrEqual(0);
    expect(firstNonMinimapIdx).toBeGreaterThanOrEqual(0);
    expect(lastMinimapIdx).toBeLessThan(firstNonMinimapIdx);
  });

  it("respects config.minimapLaneOffset — shifting it shifts every minimap priority", () => {
    const snap = makeMinimapSnapshot();
    const before = plan(snap, createSyntheticState(), DEFAULT_PLANNING_CONFIG);
    const beforeMinimap = before.requests.filter((r) => r.lane === "minimap");
    expect(beforeMinimap.length).toBeGreaterThan(0);
    expect(beforeMinimap[0].priority).toBe(MINIMAP_LANE_OFFSET);

    const after = plan(snap, createSyntheticState(), mergeConfig({ minimapLaneOffset: 250 }));
    const afterMinimap = after.requests.filter((r) => r.lane === "minimap");
    expect(afterMinimap.length).toBeGreaterThan(0);
    for (const req of afterMinimap) expect(req.priority).toBe(250);
  });

  // Bulk seeding. The top-priority lane is justified by the seed set
  // being SMALL (the "starvation risk is bounded" argument in ADR 0023).
  // A wide collection's whole-collection seed set is not small: at tens
  // of thousands of coarsest chunks, top-priority seeding would occupy
  // every fetch slot for minutes while the visible band waits. Above
  // the fast-seed cap the whole set emits behind every view-serving
  // lane instead.

  function makeManyCoords(n: number): MinimapChunkCoord[] {
    const coords: MinimapChunkCoord[] = [];
    for (let i = 0; i < n; i++) {
      coords.push({ level: 3, x: i, y: 0, z: 0, t: 0, c: 0, key: `3/0/0/0/0/${i}` });
    }
    return coords;
  }

  it("keeps the top-priority lane at exactly the fast-seed cap", () => {
    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        ["imgM", makeManyCoords(MINIMAP_SEED_FAST_MAX_CHUNKS)],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    expect(minimap).toHaveLength(MINIMAP_SEED_FAST_MAX_CHUNKS);
    for (const req of minimap) expect(req.priority).toBe(MINIMAP_LANE_OFFSET);
  });

  it("demotes seeding below every view-serving lane once pending exceeds the fast-seed cap", () => {
    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        ["imgM", makeManyCoords(MINIMAP_SEED_FAST_MAX_CHUNKS + 1)],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    expect(minimap).toHaveLength(MINIMAP_SEED_FAST_MAX_CHUNKS + 1);
    for (const req of minimap) {
      expect(req.priority).toBe(MINIMAP_SEED_BULK_LANE_OFFSET);
    }
    // Bulk seeding must rank behind the view's own coarse fill and the
    // overview backstop — the view cannot wait minutes, the minimap can.
    expect(MINIMAP_SEED_BULK_LANE_OFFSET).toBeGreaterThan(COARSE_LANE_OFFSET);
    expect(MINIMAP_SEED_BULK_LANE_OFFSET).toBeGreaterThan(OVERVIEW_LANE_OFFSET);
  });

  it("bulk-demoted seeding sorts after every other lane in the plan", () => {
    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        ["imgM", makeManyCoords(MINIMAP_SEED_FAST_MAX_CHUNKS + 1)],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const firstMinimapIdx = result.requests.findIndex((r) => r.lane === "minimap");
    const lastOtherIdx = result.requests.reduce(
      (acc, r, i) => (r.lane !== "minimap" ? i : acc),
      -1,
    );
    expect(firstMinimapIdx).toBeGreaterThanOrEqual(0);
    expect(lastOtherIdx).toBeGreaterThanOrEqual(0);
    expect(firstMinimapIdx).toBeGreaterThan(lastOtherIdx);
  });

  it("counts pending across all entities when deciding fast vs bulk", () => {
    // Two members, each under the cap alone but over it together: the
    // starvation cost is a property of the whole seed set, not of any
    // one member's share of it.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const perEntity = Math.ceil((MINIMAP_SEED_FAST_MAX_CHUNKS + 2) / 2);
    const entities = [
      createSyntheticEntity({
        entityId: "e0",
        imageId: "imgA",
        kind: "Image",
        projectedDiagonalPx: 200,
        targetLevel: 0,
        levels: [level0],
      }),
      createSyntheticEntity({
        entityId: "e1",
        imageId: "imgB",
        kind: "Image",
        projectedDiagonalPx: 200,
        targetLevel: 0,
        levels: [level0],
      }),
    ];
    const snap = createSyntheticSnapshot({
      entities,
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 256, 256] }),
      selection: makeSelection(),
      minimapPending: new Map([
        ["imgA", makeManyCoords(perEntity)],
        ["imgB", makeManyCoords(perEntity)],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    expect(minimap).toHaveLength(perEntity * 2);
    for (const req of minimap) {
      expect(req.priority).toBe(MINIMAP_SEED_BULK_LANE_OFFSET);
    }
  });

  it("bulk seeding sorts after view lanes even when distance terms exceed the bulk offset", () => {
    // Lane offsets are not bands: computePriority adds unbounded
    // importance/distance terms, so on a wide view a coarse request's
    // effective priority (2400 + distance × weight) runs far past any
    // constant bulk offset. Demoted seeding must rank behind the view's
    // requests by construction, not by hoping a constant outruns the
    // distance term.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const level3 = makeLevelGeo(3, [1, 1, 1, 32, 32], [1, 1, 1, 32, 32]);
    const entity = createSyntheticEntity({
      entityId: "eFar",
      imageId: "imgFar",
      kind: "Image",
      projectedDiagonalPx: 200,
      targetLevel: 0,
      detailLevel: 0,
      coarseLevel: 3,
      levels: [level0, level3, level3, level3],
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      // Wide region: the view center sits ~14k voxels from the entity's
      // chunks, so coarse priority ≈ 2400 + 14k×10 ≫ the bulk offset.
      visibleRegion: makeVisibleRegion({ xyBoundsVox: [0, 0, 20000, 20000] }),
      selection: makeSelection(),
      minimapPending: new Map([
        ["imgFar", makeManyCoords(MINIMAP_SEED_FAST_MAX_CHUNKS + 1)],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    const others = result.requests.filter((r) => r.lane !== "minimap");
    expect(minimap.length).toBe(MINIMAP_SEED_FAST_MAX_CHUNKS + 1);
    expect(others.length).toBeGreaterThan(0);
    const maxOther = Math.max(...others.map((r) => r.priority));
    expect(maxOther).toBeGreaterThan(MINIMAP_SEED_BULK_LANE_OFFSET);
    for (const req of minimap) {
      expect(req.priority).toBeGreaterThan(maxOther);
    }
    // And therefore they sort last.
    const firstMinimapIdx = result.requests.findIndex((r) => r.lane === "minimap");
    const lastOtherIdx = result.requests.reduce(
      (acc, r, i) => (r.lane !== "minimap" ? i : acc),
      -1,
    );
    expect(firstMinimapIdx).toBeGreaterThan(lastOtherIdx);
  });

  it("demotes bulk seeding even when the caller's config predates the seed knobs", () => {
    // plan() is pure and accepts any PlanningConfig-shaped object;
    // structural typing admits configs built before the seed knobs
    // existed (older persisted snapshots, external embedders of the
    // planner). Large demand must never ride the fast lane because a
    // knob is merely absent from the caller's object.
    const preKnobConfig = { ...DEFAULT_PLANNING_CONFIG } as Record<string, unknown>;
    delete preKnobConfig.minimapSeedFastMaxChunks;
    delete preKnobConfig.minimapSeedBulkLaneOffset;

    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        ["imgM", makeManyCoords(MINIMAP_SEED_FAST_MAX_CHUNKS + 1)],
      ]),
    });
    const result = plan(
      snap,
      createSyntheticState(),
      preKnobConfig as unknown as PlanningConfig,
    );
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    expect(minimap).toHaveLength(MINIMAP_SEED_FAST_MAX_CHUNKS + 1);
    for (const req of minimap) {
      expect(req.priority).toBe(MINIMAP_SEED_BULK_LANE_OFFSET);
    }
  });

  it("reads the fast/bulk decision from the whole pending map, not the entity-joined subset", () => {
    // Producers enumerate every dataset image when seeding, so the
    // pending map can cover members outside this call's entity set —
    // and the fetch queue the demand lands in is shared. The demotion
    // decision must follow the full demand, no matter which members
    // this particular plan() call emits for.
    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        ["imgM", makeManyCoords(10)],
        ["imgElsewhere", makeManyCoords(MINIMAP_SEED_FAST_MAX_CHUNKS)],
      ]),
    });
    const result = plan(snap, createSyntheticState());
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    // Emission stays entity-joined — only imgM has a matching entity.
    expect(minimap).toHaveLength(10);
    expect(new Set(minimap.map((r) => r.imageId))).toEqual(new Set(["imgM"]));
    // But the demand total (10 + cap) exceeds the cap, so what IS
    // emitted rides the bulk lane.
    for (const req of minimap) {
      expect(req.priority).toBe(MINIMAP_SEED_BULK_LANE_OFFSET);
    }
  });

  it("respects config.minimapSeedFastMaxChunks and config.minimapSeedBulkLaneOffset", () => {
    const snap = makeMinimapSnapshot(); // two pending coords
    const result = plan(
      snap,
      createSyntheticState(),
      mergeConfig({ minimapSeedFastMaxChunks: 1, minimapSeedBulkLaneOffset: 2700 }),
    );
    const minimap = result.requests.filter((r) => r.lane === "minimap");
    expect(minimap).toHaveLength(2);
    for (const req of minimap) expect(req.priority).toBe(2700);
  });
});

// ---------------------------------------------------------------------------
// Discriminated ActiveSetEntry
// ---------------------------------------------------------------------------
//
// These tests pin the variant shapes produced by `assignModes` (and
// hence by the `make*Entry` constructors it calls) so a future shape
// drift trips a test, not a debugging session.
//
// Type-narrowing assertions show up as `if (entry.kind === "...")
// { /* read variant-specific tiles */ }` blocks inside the test body
// — TypeScript's narrowing within those blocks is the actual
// compile-time invariant being tested.

describe("ActiveSetEntry variants", () => {
  it("group-as-proxy variant: only `kind` + `entityId`, no LOD/imageId/proxy tiles", () => {
    // 50px group + advertised GroupProxy3D → assignModes returns one
    // GroupAsProxyEntry. Keys() pin the surface.
    const entities = makeCollectionEntities("groupWP", [
      { id: "fWP", image: "imgWP", px: 50 },
    ]);
    const catalog = makeCatalog([
      ["groupWP", ["GroupProxy3D"]],
      ["fWP", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    const entry = result[0];

    // Kind discrimination first; only inside the narrowed block do
    // variant-specific reads typecheck.
    expect(entry.kind).toBe("group-as-proxy");
    if (entry.kind === "group-as-proxy") {
      expect(entry.entityId).toBe("groupWP");
      // Surface check: exactly two own keys (no imageId, mode,
      // targetLod, coarsestDetailLod, detailOwnedLodRange, proxyKind,
      // proxyAvailable, or groupProxyAvailable).
      expect(Object.keys(entry).sort()).toEqual(["entityId", "kind"]);
    }
  });

  it("tile variant: `kind: \"tile\"` + LOD bookkeeping + proxy availability flags", () => {
    const entities = makeCollectionEntities("groupF", [
      { id: "fF", image: "imgF", px: 200 },
    ]);
    const catalog = makeCatalog([
      ["groupF", ["GroupProxy3D"]],
      ["fF", ["TileProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    const entry = result[0];

    expect(entry.kind).toBe("tile");
    if (entry.kind === "tile") {
      expect(entry.entityId).toBe("fF");
      expect(entry.imageId).toBe("imgF");
      expect(entry.mode).toBe("tiles-with-detail");
      expect(entry.targetLod).toBe(0);
      expect(entry.coarsestDetailLod).toBe(0);
      expect(entry.detailOwnedLodRange).toEqual([0, 0]);
      expect(entry.proxyKind).toBe("TileProxy3D");
      expect(entry.proxyAvailable).toBe(true);
      expect(entry.groupProxyAvailable).toBe(true);
    }
  });

  it("invisible variant: `kind: \"invisible\"` + entityId/imageId/coarsestLod, no LOD range or proxy tiles", () => {
    const entity = createSyntheticEntity({
      entityId: "invE",
      imageId: "imgInv",
      kind: "Image",
      visible: false,
      levels: makeStubLevels(4),
    });

    const result = assignModes([entity], []);
    expect(result).toHaveLength(1);
    const entry = result[0];

    expect(entry.kind).toBe("invisible");
    if (entry.kind === "invisible") {
      expect(entry.entityId).toBe("invE");
      expect(entry.imageId).toBe("imgInv");
      expect(entry.coarsestLod).toBe(3);
      // Surface check: exactly four own keys (no mode, targetLod,
      // coarsestDetailLod, detailOwnedLodRange, proxyKind,
      // proxyAvailable, or groupProxyAvailable).
      expect(Object.keys(entry).sort()).toEqual([
        "coarsestLod", "entityId", "imageId", "kind",
      ]);
    }
  });

  it("end-to-end: a mixed snapshot produces all three variants and consumer narrowing works", () => {
    // One group in group-as-proxy mode, one group's tiles in
    // tiles-with-detail mode, plus an invisible image. The plan
    // must contain entries of all three kinds; iterating with kind
    // discrimination pulls per-variant tiles out cleanly.
    const groupWP = makeCollectionEntities("groupWP", [
      { id: "fWP", image: "imgWP", px: 50 },
    ]);
    const groupFD = makeCollectionEntities("groupFD", [
      { id: "fFD", image: "imgFD", px: 200 },
    ]);
    const invisible = createSyntheticEntity({
      entityId: "invE",
      imageId: "imgInv",
      kind: "Image",
      visible: false,
      levels: makeStubLevels(3),
    });
    const catalog = makeCatalog([
      ["groupWP", ["GroupProxy3D"]],
      ["fWP", ["TileProxy3D"]],
      ["groupFD", ["GroupProxy3D"]],
      ["fFD", ["TileProxy3D"]],
    ]);

    const snap = createSyntheticSnapshot({
      entities: [...groupWP, ...groupFD, invisible],
      assetCatalog: catalog,
      visibleRegion: {
        xyBoundsVox: [0, 0, 256, 256],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
    });
    const result = plan(snap, createSyntheticState(), LEGACY_PROXY_CONFIG);

    // One group-as-proxy + one tile + one invisible.
    const byKind = { groupAsProxy: 0, tile: 0, invisible: 0 };
    let observedTile: { mode: string; targetLod: number } | null = null;
    let observedInvisible: { coarsestLod: number } | null = null;
    let observedGroupAsProxy: { entityId: string } | null = null;
    for (const entry of result.activeSet) {
      if (entry.kind === "group-as-proxy") {
        byKind.groupAsProxy++;
        observedGroupAsProxy = { entityId: entry.entityId };
      } else if (entry.kind === "tile") {
        byKind.tile++;
        observedTile = { mode: entry.mode, targetLod: entry.targetLod };
      } else {
        byKind.invisible++;
        observedInvisible = { coarsestLod: entry.coarsestLod };
      }
    }
    expect(byKind).toEqual({ groupAsProxy: 1, tile: 1, invisible: 1 });
    expect(observedGroupAsProxy).toEqual({ entityId: "groupWP" });
    expect(observedTile).toEqual({ mode: "tiles-with-detail", targetLod: 0 });
    expect(observedInvisible).toEqual({ coarsestLod: 2 });
  });
});

// ---------------------------------------------------------------------------
// Discriminated EntitySnapshot
// ---------------------------------------------------------------------------
//
// These tests pin the variant shapes produced by `createSyntheticEntity`
// and the round-trip behaviour of `groupMembers` / `buildPrevModeByGroup`.
// `parentId: string` lives only on `TileSnapshot`; the other variants
// don't carry the tile at all.

describe("createSyntheticEntity — discriminated variants", () => {
  it("kind: \"Image\" returns an ImageSnapshot with no parentId tile", () => {
    const e = createSyntheticEntity({ kind: "Image" });
    expect(e.kind).toBe("Image");
    expect(Object.prototype.hasOwnProperty.call(e, "parentId")).toBe(false);
  });

  it("kind: \"Group\" returns a GroupSnapshot with no parentId tile", () => {
    const e = createSyntheticEntity({ kind: "Group" });
    expect(e.kind).toBe("Group");
    expect(Object.prototype.hasOwnProperty.call(e, "parentId")).toBe(false);
  });

  it("kind: \"Tile\" returns a TileSnapshot with a non-null parentId default", () => {
    const e = createSyntheticEntity({ kind: "Tile" });
    expect(e.kind).toBe("Tile");
    if (e.kind === "Tile") {
      // Default parentId — supplied so callers don't have to thread one
      // through every fixture. Non-empty / non-null.
      expect(typeof e.parentId).toBe("string");
      expect(e.parentId.length).toBeGreaterThan(0);
    }
  });

  it("kind: \"Tile\" preserves a caller-supplied parentId override", () => {
    const e = createSyntheticEntity({ kind: "Tile", parentId: "custom-group" });
    expect(e.kind).toBe("Tile");
    if (e.kind === "Tile") {
      expect(e.parentId).toBe("custom-group");
    }
  });

  it("default (no kind override) returns an ImageSnapshot", () => {
    const e = createSyntheticEntity();
    expect(e.kind).toBe("Image");
    expect(Object.prototype.hasOwnProperty.call(e, "parentId")).toBe(false);
  });
});

describe("groupMembers — round-trip with discriminated entities", () => {
  it("groups a mixed entity list", () => {
    // Build a snapshot of mixed entity kinds and assert the grouping
    // structure (group-as-proxy entries indexed by groupId; tiles
    // indexed by their parent group).
    const entities: EntitySnapshot[] = [
      createSyntheticEntity({
        entityId: "group-A",
        kind: "Group",
        projectedDiagonalPx: 200,
      }),
      createSyntheticEntity({
        entityId: "tile-A1",
        kind: "Tile",
        parentId: "group-A",
        projectedDiagonalPx: 150,
      }),
      createSyntheticEntity({
        entityId: "tile-A2",
        kind: "Tile",
        parentId: "group-A",
        projectedDiagonalPx: 250,
      }),
      createSyntheticEntity({
        entityId: "group-B",
        kind: "Group",
        projectedDiagonalPx: 100,
      }),
      createSyntheticEntity({
        entityId: "tile-B1",
        kind: "Tile",
        parentId: "group-B",
        projectedDiagonalPx: 80,
      }),
      createSyntheticEntity({
        entityId: "image-X",
        kind: "Image",
        projectedDiagonalPx: 300,
      }),
    ];

    const groups = groupMembers(entities);

    // Three groups: group-A (with two tiles), group-B (one tile), image-X.
    expect(groups).toHaveLength(3);

    const groupA = groups.find((g) => g.groupId === "group-A");
    expect(groupA).toBeDefined();
    expect(groupA?.groupEntity?.entityId).toBe("group-A");
    expect(groupA?.tiles.map((f) => f.entityId).sort()).toEqual([
      "tile-A1",
      "tile-A2",
    ]);
    // projectedDiagonalPx is the max of group + tiles.
    expect(groupA?.projectedDiagonalPx).toBe(250);

    const groupB = groups.find((g) => g.groupId === "group-B");
    expect(groupB).toBeDefined();
    expect(groupB?.groupEntity?.entityId).toBe("group-B");
    expect(groupB?.tiles.map((f) => f.entityId)).toEqual(["tile-B1"]);
    expect(groupB?.projectedDiagonalPx).toBe(100);

    // Image entries become singleton groups keyed `__image__${id}`.
    const imageX = groups.find((g) => g.groupId === "__image__image-X");
    expect(imageX).toBeDefined();
    expect(imageX?.groupEntity).toBeNull();
    expect(imageX?.tiles.map((f) => f.entityId)).toEqual(["image-X"]);
    expect(imageX?.projectedDiagonalPx).toBe(300);
  });

  it("skips invisible entities (round-trip behaviour preserved)", () => {
    const entities: EntitySnapshot[] = [
      createSyntheticEntity({
        entityId: "group-V",
        kind: "Group",
        visible: false,
        projectedDiagonalPx: 200,
      }),
      createSyntheticEntity({
        entityId: "tile-V",
        kind: "Tile",
        parentId: "group-V",
        visible: false,
        projectedDiagonalPx: 100,
      }),
    ];
    expect(groupMembers(entities)).toEqual([]);
  });
});

describe("buildPrevModeByGroup — round-trip with discriminated entities", () => {
  it("indexes prev tile-mode entries back to their parent group", () => {
    // Mixed kinds in the new entity list; previousActiveSet has both a
    // group-as-proxy entry (entityId === groupId) and a tile entry that
    // resolves back to its group via the entity list's parentId.
    const entities: EntitySnapshot[] = [
      createSyntheticEntity({ entityId: "group-A", kind: "Group" }),
      createSyntheticEntity({
        entityId: "tile-A1",
        kind: "Tile",
        parentId: "group-A",
      }),
      createSyntheticEntity({ entityId: "group-B", kind: "Group" }),
      createSyntheticEntity({
        entityId: "tile-B1",
        kind: "Tile",
        parentId: "group-B",
      }),
      createSyntheticEntity({ entityId: "image-X", kind: "Image" }),
    ];

    const prev: ActiveSetEntry[] = [
      // Group-as-proxy entry; entityId IS the groupId.
      { kind: "group-as-proxy", entityId: "group-A" },
      // Tile entry; resolves back to group-B via parentId on tile-B1.
      {
        kind: "tile",
        entityId: "tile-B1",
        imageId: "img-B1",
        mode: "tiles-with-proxy-fallback",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyKind: "TileProxy3D",
        proxyAvailable: true,
        groupProxyAvailable: true,
      },
      // Invisible — skipped (no promotion decision to remember).
      {
        kind: "invisible",
        entityId: "image-X",
        imageId: "img-X",
        coarsestLod: 0,
      },
    ];

    const map = buildPrevModeByGroup(prev, entities);

    expect(map.get("group-A")).toBe("group-as-proxy");
    expect(map.get("group-B")).toBe("tiles-with-proxy-fallback");
    // image-X is invisible in prev, so it has no entry; group-B already
    // covered above; nothing else in the map.
    expect(map.size).toBe(2);
  });

  it("empty prev or empty entities → empty map", () => {
    expect(buildPrevModeByGroup([], [])).toEqual(new Map());

    const entities = [
      createSyntheticEntity({
        entityId: "tile-1",
        kind: "Tile",
        parentId: "group-1",
      }),
    ];
    expect(buildPrevModeByGroup([], entities)).toEqual(new Map());

    const prev: ActiveSetEntry[] = [
      { kind: "group-as-proxy", entityId: "group-ghost" },
    ];
    // Stale entry — groupId still gets added (group-as-proxy maps directly
    // by entityId; entities list is only consulted for tile entries).
    const map = buildPrevModeByGroup(prev, []);
    expect(map.get("group-ghost")).toBe("group-as-proxy");
    expect(map.size).toBe(1);
  });
});
