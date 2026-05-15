import { describe, it, expect } from "vitest";

import {
  assignModes,
  chunkKey,
  createSyntheticEntity,
  createSyntheticSnapshot,
  PROMOTE_THRESHOLD_PX,
  FAR_THRESHOLD_PX,
  DETAIL_THRESHOLD_PX,
  HYSTERESIS_PX,
  MINIMAP_LANE_OFFSET,
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
  WELL_PROXY_PRIORITY_BUMP,
  DEFAULT_PLANNING_CONFIG,
  mergeConfig,
} from "./planning/index.ts";
import type { PlanningConfig } from "./planning/index.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  MinimapChunkCoord,
  SelectionState,
  PlanningSnapshot,
  EntityMode,
  AssetCatalogSnapshot,
  ProxyKind,
} from "./planning/index.ts";
import type { VisibleRegion } from "./viewport.ts";
import type { LevelGeometry } from "../manifestTypes.ts";

// ---------------------------------------------------------------------------
// Catalog helper
// ---------------------------------------------------------------------------

/** Build an AssetCatalogSnapshot from `(entityId, kinds[])` pairs. */
function makeCatalog(
  entries: [string, ProxyKind[]][],
): AssetCatalogSnapshot {
  const byEntity = new Map<string, { kinds: Set<ProxyKind> }>();
  for (const [entityId, kinds] of entries) {
    byEntity.set(entityId, { kinds: new Set(kinds) });
  }
  return { byEntity };
}

// ---------------------------------------------------------------------------
// Default-active-set helper for legacy two-tier tests
// ---------------------------------------------------------------------------

/**
 * Build a singleton active-set entry for an Image-kind entity in the
 * given mode. Used by the migrated legacy tests so synthetic snapshots
 * still produce one entry per entity.
 */
function makeFieldDetailEntry(
  entityId: string,
  imageId: string,
  targetLod: number,
  coarsestDetailLod: number,
): ActiveSetEntry {
  return {
    entityId,
    imageId,
    mode: "fields-with-detail",
    targetLod,
    coarsestDetailLod,
    detailOwnedLodRange: [targetLod, coarsestDetailLod],
    proxyKind: undefined,
    proxyAvailable: false,
    wellProxyAvailable: false,
  };
}

// ---------------------------------------------------------------------------
// Promotion / demotion (legacy two-tier semantics, mapped to S6 modes)
// ---------------------------------------------------------------------------
//
// Without an asset catalog the only reachable mode is `fields-with-detail`,
// since both proxy modes degrade away when proxies aren't advertised.
// The legacy boundary at PROMOTE_THRESHOLD_PX still distinguishes the
// well-as-proxy desired-mode region from fields-with-detail; `<` flips
// to fields-with-detail post-degrade. We test the mode after degrade.

describe("assignModes — three-tier (no catalog)", () => {
  it("entity above MEDIUM threshold uses fields-with-detail", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
    });
    expect(entity.projectedDiagonalPx).toBeGreaterThan(DETAIL_THRESHOLD_PX);

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
  });

  it("entity below FAR threshold degrades to fields-with-detail when no catalog", () => {
    // Below FAR_THRESHOLD_PX, chooseEntityMode picks well-as-proxy, but
    // catalog-aware degrade pushes it all the way down to fields-with-detail.
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 30,
    });
    expect(entity.projectedDiagonalPx).toBeLessThan(FAR_THRESHOLD_PX);

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
  });

  it("entity in mid range degrades to fields-with-detail when no catalog", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 100,
    });
    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
  });

  it("invisible entity emits a fields-with-detail entry at coarsest LOD", () => {
    const entity = createSyntheticEntity({
      visible: false,
      projectedDiagonalPx: 200,
      levels: makeStubLevels(5),
    });

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(4);
    expect(result.detailOwnedLodRange).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------------------
// LOD range
// ---------------------------------------------------------------------------

describe("LOD range", () => {
  it("sets coarsestDetailLod = targetLod for a field-mode entity (no +2 buffer post-PRD-545)", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: makeStubLevels(5),
    });

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(0);
    expect(result.coarsestDetailLod).toBe(0);
    expect(result.detailOwnedLodRange).toEqual([0, 0]);
  });

  it("coarsestDetailLod tracks targetLod even at the top of the pyramid", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 3,
      levels: makeStubLevels(4),
    });

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(3);
    expect(result.coarsestDetailLod).toBe(3);
    expect(result.detailOwnedLodRange).toEqual([3, 3]);
  });

  it("handles single-level images", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: makeStubLevels(1),
    });

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(0);
    expect(result.coarsestDetailLod).toBe(0);
    expect(result.detailOwnedLodRange).toEqual([0, 0]);
  });

  it("invisible entity LODs are coarsest level", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      visible: false,
      projectedDiagonalPx: 30,
      levels: makeStubLevels(5),
    });

    const [result] = assignModes([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(4);
    expect(result.coarsestDetailLod).toBe(4);
    expect(result.detailOwnedLodRange).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------------------
// chooseEntityMode — pure hysteresis tests
// ---------------------------------------------------------------------------

describe("chooseEntityMode", () => {
  it("clearly far → well-as-proxy", () => {
    expect(chooseEntityMode(null, 50)).toBe("well-as-proxy");
  });
  it("clearly mid → fields-with-proxy-fallback", () => {
    expect(chooseEntityMode(null, 100)).toBe("fields-with-proxy-fallback");
  });
  it("clearly near → fields-with-detail", () => {
    expect(chooseEntityMode(null, 200)).toBe("fields-with-detail");
  });

  it("hysteresis at FAR threshold: keeps well-as-proxy across 75–84", () => {
    let prev: EntityMode | null = "well-as-proxy";
    for (const px of [80, 78, 82, 84, 75, 79]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("well-as-proxy");
      prev = next;
    }
    // Past upper bound (>= 85) → flip
    expect(chooseEntityMode("well-as-proxy", 85)).toBe(
      "fields-with-proxy-fallback",
    );
  });

  it("hysteresis at FAR threshold: keeps proxy-fallback across 76–85", () => {
    let prev: EntityMode | null = "fields-with-proxy-fallback";
    for (const px of [80, 81, 82, 84, 85]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("fields-with-proxy-fallback");
      prev = next;
    }
    // Below lower bound → flip down to well-as-proxy
    expect(chooseEntityMode("fields-with-proxy-fallback", 74)).toBe(
      "well-as-proxy",
    );
  });

  it("hysteresis at MEDIUM threshold: keeps fields-with-detail across 146-155", () => {
    let prev: EntityMode | null = "fields-with-detail";
    for (const px of [150, 148, 152, 155, 146]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("fields-with-detail");
      prev = next;
    }
    // Below lower bound (<= 145) → flip
    expect(chooseEntityMode("fields-with-detail", 145)).toBe(
      "fields-with-proxy-fallback",
    );
  });

  it("hysteresis at MEDIUM threshold: keeps proxy-fallback across 145-154", () => {
    let prev: EntityMode | null = "fields-with-proxy-fallback";
    for (const px of [150, 151, 154, 145, 148]) {
      const next = chooseEntityMode(prev, px);
      expect(next).toBe("fields-with-proxy-fallback");
      prev = next;
    }
    expect(chooseEntityMode("fields-with-proxy-fallback", 156)).toBe(
      "fields-with-detail",
    );
  });
});

// ---------------------------------------------------------------------------
// assignModes() with a populated catalog (three-tier behaviour)
// ---------------------------------------------------------------------------

/** Build a 1-well-3-fields plate group at the given diagonal. */
function makePlateEntities(
  wellId: string,
  fields: { id: string; image: string; px: number }[],
): EntitySnapshot[] {
  const out: EntitySnapshot[] = [];
  out.push(
    createSyntheticEntity({
      entityId: wellId,
      imageId: "",
      kind: "Well",
      projectedDiagonalPx: Math.max(...fields.map((f) => f.px), 0),
      levels: [],
      parentId: null,
    }),
  );
  for (const f of fields) {
    out.push(
      createSyntheticEntity({
        entityId: f.id,
        imageId: f.image,
        kind: "Field",
        projectedDiagonalPx: f.px,
        levels: makeStubLevels(5),
        idealTargetLod: 0,
        parentId: wellId,
      }),
    );
  }
  return out;
}

describe("assignModes — three-tier with catalog", () => {
  it("far well (50px) with full catalog → single well-as-proxy entry", () => {
    const entities = makePlateEntities("wellA", [
      { id: "fA1", image: "imgA1", px: 40 },
      { id: "fA2", image: "imgA2", px: 50 },
    ]);
    const catalog = makeCatalog([
      ["wellA", ["WellProxy3D"]],
      ["fA1", ["FieldProxy3D"]],
      ["fA2", ["FieldProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);

    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("well-as-proxy");
    expect(result[0].entityId).toBe("wellA");
    expect(result[0].imageId).toBe("");
    expect(result[0].proxyKind).toBe("WellProxy3D");
    expect(result[0].proxyAvailable).toBe(true);
  });

  it("mid well (100px) with catalog → one fields-with-proxy-fallback per field", () => {
    const entities = makePlateEntities("wellB", [
      { id: "fB1", image: "imgB1", px: 100 },
      { id: "fB2", image: "imgB2", px: 100 },
    ]);
    const catalog = makeCatalog([
      ["wellB", ["WellProxy3D"]],
      ["fB1", ["FieldProxy3D"]],
      ["fB2", ["FieldProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(2);
    for (const entry of result) {
      expect(entry.mode).toBe("fields-with-proxy-fallback");
      expect(entry.proxyKind).toBe("FieldProxy3D");
      expect(entry.proxyAvailable).toBe(true);
      expect(entry.wellProxyAvailable).toBe(true);
    }
  });

  it("near well (200px) → fields-with-detail per field; well proxy still flagged available", () => {
    const entities = makePlateEntities("wellC", [
      { id: "fC1", image: "imgC1", px: 200 },
      { id: "fC2", image: "imgC2", px: 220 },
    ]);
    const catalog = makeCatalog([
      ["wellC", ["WellProxy3D"]],
      ["fC1", ["FieldProxy3D"]],
      ["fC2", ["FieldProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(2);
    for (const entry of result) {
      expect(entry.mode).toBe("fields-with-detail");
      expect(entry.proxyKind).toBe("FieldProxy3D");
      expect(entry.proxyAvailable).toBe(true);
      expect(entry.wellProxyAvailable).toBe(true);
    }
  });

  it("mixed scene: two wells at different zooms get different modes", () => {
    const entities = [
      ...makePlateEntities("wellA", [{ id: "fA1", image: "imgA1", px: 40 }]),
      ...makePlateEntities("wellB", [{ id: "fB1", image: "imgB1", px: 200 }]),
    ];
    const catalog = makeCatalog([
      ["wellA", ["WellProxy3D"]],
      ["wellB", ["WellProxy3D"]],
      ["fA1", ["FieldProxy3D"]],
      ["fB1", ["FieldProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    const wellAEntries = result.filter(
      (e) => e.entityId === "wellA" || e.entityId === "fA1",
    );
    const wellBEntries = result.filter(
      (e) => e.entityId === "wellB" || e.entityId === "fB1",
    );
    expect(wellAEntries).toHaveLength(1);
    expect(wellAEntries[0].mode).toBe("well-as-proxy");
    expect(wellBEntries).toHaveLength(1);
    expect(wellBEntries[0].mode).toBe("fields-with-detail");
  });

  it("catalog miss for WellProxy3D → far well degrades to fields-with-proxy-fallback", () => {
    const entities = makePlateEntities("wellD", [
      { id: "fD1", image: "imgD1", px: 50 },
    ]);
    // Field proxy advertised but well proxy is NOT.
    const catalog = makeCatalog([
      ["fD1", ["FieldProxy3D"]],
    ]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("fields-with-proxy-fallback");
    expect(result[0].proxyAvailable).toBe(true);
    expect(result[0].wellProxyAvailable).toBe(false);
  });

  it("catalog miss for both proxies → far well degrades all the way to fields-with-detail", () => {
    const entities = makePlateEntities("wellE", [
      { id: "fE1", image: "imgE1", px: 50 },
    ]);
    const catalog = makeCatalog([]); // empty catalog

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("fields-with-detail");
    expect(result[0].proxyAvailable).toBe(false);
    expect(result[0].wellProxyAvailable).toBe(false);
  });

  it("catalog miss in mid range: no FieldProxy3D for any field but well has WellProxy3D → keeps proxy-fallback", () => {
    const entities = makePlateEntities("wellF", [
      { id: "fF1", image: "imgF1", px: 100 },
    ]);
    const catalog = makeCatalog([["wellF", ["WellProxy3D"]]]);

    const result = assignModes(entities, [], catalog);
    expect(result).toHaveLength(1);
    // Stays in proxy-fallback because well-proxy can stand in.
    expect(result[0].mode).toBe("fields-with-proxy-fallback");
    expect(result[0].proxyAvailable).toBe(false); // field proxy missing
    expect(result[0].wellProxyAvailable).toBe(true);
  });

  it("hysteresis: previous well-as-proxy holds at 84px when catalog still supports it", () => {
    const entities = makePlateEntities("wellG", [
      { id: "fG1", image: "imgG1", px: 84 },
    ]);
    const catalog = makeCatalog([
      ["wellG", ["WellProxy3D"]],
      ["fG1", ["FieldProxy3D"]],
    ]);
    const prev: ActiveSetEntry[] = [
      {
        entityId: "wellG",
        imageId: "",
        mode: "well-as-proxy",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyKind: "WellProxy3D",
        proxyAvailable: true,
        wellProxyAvailable: true,
      },
    ];

    const result = assignModes(entities, prev, catalog);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("well-as-proxy");
  });

  it("hysteresis flip: 50→100→50 returns to well-as-proxy", () => {
    const fields = [{ id: "fH1", image: "imgH1", px: 50 }];
    const catalog = makeCatalog([
      ["wellH", ["WellProxy3D"]],
      ["fH1", ["FieldProxy3D"]],
    ]);

    const r1 = assignModes(makePlateEntities("wellH", fields), [], catalog);
    expect(r1[0].mode).toBe("well-as-proxy");

    fields[0].px = 100;
    const r2 = assignModes(makePlateEntities("wellH", fields), r1, catalog);
    expect(r2[0].mode).toBe("fields-with-proxy-fallback");

    fields[0].px = 50;
    const r3 = assignModes(makePlateEntities("wellH", fields), r2, catalog);
    expect(r3[0].mode).toBe("well-as-proxy");
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
 * tests) rather than per-level geometry. PRD #563 / Slice 1 dropped
 * `EntitySnapshot.numLevels`, so callers that previously wrote
 * `numLevels: 5` now provide `levels: makeStubLevels(5)` instead.
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
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);

    // Visible region covers only top-left quarter: [0,0]-[512,512]
    const region = makeVisibleRegion({ xyBounds: [0, 0, 512, 512] });
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

  it("well-as-proxy entry produces no chunk requests", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "wellX",
      imageId: "",
      kind: "Well",
      levels: [level0],
      position: [0, 0],
    });
    const entry: ActiveSetEntry = {
      entityId: "wellX",
      imageId: "",
      mode: "well-as-proxy",
      targetLod: 0,
      coarsestDetailLod: 0,
      detailOwnedLodRange: [0, 0],
      proxyKind: "WellProxy3D",
      proxyAvailable: true,
      wellProxyAvailable: true,
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
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);

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

    const all = iterateChunks(
      entity,
      entry,
      makeVisibleRegion({ xyBounds: [0, 0, 1024, 1024], zRange: [0, 4] }),
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
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 512, 512] });
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
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 256, 256] });
    const selection = makeSelection({ visibleChannels: [0, 2, 3] });

    const result = iterateChunks(entity, entry, region, selection);

    // 1 spatial cell * 3 channels = 3 requests
    expect(result).toHaveLength(3);
    const channels = result.map((r) => r.c).sort();
    expect(channels).toEqual([0, 2, 3]);
  });

  it("returns all visible chunks regardless of sort order", () => {
    // 4x1x1 grid so chunks are spread along X.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);

    const region = makeVisibleRegion({
      xyBounds: [0, 0, 1024, 256],
      sortCenter: [960, 128, 0],
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
      position: [500, 500],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [400, 400, 600, 600] });
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
      position: [0, 0],
    });
    // Detail entry owning levels 0..2 inclusive.
    const entry = makeFieldDetailEntry("e0", "img0", 0, 2);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 1024, 1024] });
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
      idealTargetLod: 0,
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
    });
  }

  it("detail requests have lower priority than prefetch", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

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
    const result = plan(snapshot);

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
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
      position: [0, 0],
    });
    const lowImportance = createSyntheticEntity({
      entityId: "low",
      imageId: "img-low",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
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

  it("temporal prefetch generates T+1 and T+2", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

    const prefetchReqs = result.requests.filter((r) => r.lane === "prefetch");
    expect(prefetchReqs.length).toBeGreaterThan(0);

    const tValues = new Set(prefetchReqs.map((r) => r.t));
    expect(tValues.has(11)).toBe(true);
    expect(tValues.has(12)).toBe(true);
  });

  it("prefetch T+1 before T+2", () => {
    const snapshot = makeSchedulingSnapshot();
    const result = plan(snapshot);

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
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
      position: [0, 0],
    });

    // sortCenter at x=960 (near chunk col 3).
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBounds: [0, 0, 1024, 256],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: [960, 128, 0],
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

    const result = plan(snapshot);
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs.length).toBe(4);

    // Detail requests should be sorted by priority (ascending).
    // The chunk closest to sortCenter (col 3) should be first.
    expect(detailReqs[0].x).toBe(3);
    // The chunk farthest from sortCenter (col 0) should be last.
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
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
      position: [500, 0],
    });

    // View center at x=900 → local x=400 → closer to col 1 (chunk center 384).
    const snapshot = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBounds: [400, 0, 1100, 256],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: null, // midpoint = [750, 128] → local x = 250
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

    const result = plan(snapshot);
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

    const result = plan(snapshot);

    expect(result.epochs.request).toBe(8);
    expect(result.epochs.content).toBe(3);
    expect(result.epochs.layout).toBe(2);
    expect(result.epochs.view).toBe(1);
    expect(result.epochs.selection).toBe(4);
    expect(result.epochs.asset).toBe(0);
  });

  it("full integration: two entities, three lanes, sorted output", () => {
    // Entity 1: large projected diagonal -> fields-with-detail
    const level0A = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityDetail = createSyntheticEntity({
      entityId: "detail-entity",
      imageId: "img-detail",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: [level0A],
      importance: 0.8,
      position: [0, 0],
    });

    // Entity 2: small projected diagonal — without a catalog this still
    // ends up in fields-with-detail mode. Overview lane requests come
    // from the per-entity pass at the coarsest level for ALL entities,
    // so the test still gets overview chunks for both.
    const level0B = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityOverview = createSyntheticEntity({
      entityId: "overview-entity",
      imageId: "img-overview",
      kind: "Image",
      projectedDiagonalPx: 20,
      idealTargetLod: 0,
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
    });

    const result = plan(snapshot);

    // Active set: 2 entries, both in fields-with-detail (no catalog → degrade).
    expect(result.activeSet).toHaveLength(2);
    for (const entry of result.activeSet) {
      expect(entry.mode).toBe("fields-with-detail");
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

// ---------------------------------------------------------------------------
// Three-tier proxy request emission (S6)
// ---------------------------------------------------------------------------

describe("plan() — proxy request emission", () => {
  /**
   * Build a minimal plate snapshot with one well + N fields. All fields
   * share the same image-level geometry (single LOD, 256x256, 1 chunk).
   */
  function makePlateSnapshot(opts: {
    wellId: string;
    fields: { id: string; image: string; px: number }[];
    catalog: AssetCatalogSnapshot | null;
    visibleChannels?: number[];
    t?: number;
    previousActiveSet?: ActiveSetEntry[];
  }): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entities: EntitySnapshot[] = [
      createSyntheticEntity({
        entityId: opts.wellId,
        imageId: "",
        kind: "Well",
        projectedDiagonalPx: Math.max(...opts.fields.map((f) => f.px), 0),
        levels: [],
        parentId: null,
      }),
      ...opts.fields.map((f) =>
        createSyntheticEntity({
          entityId: f.id,
          imageId: f.image,
          kind: "Field",
          projectedDiagonalPx: f.px,
          levels: [level0],
          idealTargetLod: 0,
          parentId: opts.wellId,
        }),
      ),
    ];
    return createSyntheticSnapshot({
      entities,
      visibleRegion: {
        xyBounds: [0, 0, 256, 256],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: null,
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
      previousActiveSet: opts.previousActiveSet ?? [],
    });
  }

  it("well-as-proxy emits one ProxyRequest and no detail chunk requests for that well", () => {
    const catalog = makeCatalog([["wellA", ["WellProxy3D"]]]);
    const snap = makePlateSnapshot({
      wellId: "wellA",
      fields: [
        { id: "fA1", image: "imgA1", px: 50 },
        { id: "fA2", image: "imgA2", px: 50 },
      ],
      catalog,
    });

    const result = plan(snap);

    // Active set = 1 well-as-proxy entry, plus invisible-entry pass for the well/fields would be 0
    // since they're all visible.
    expect(result.activeSet).toHaveLength(1);
    expect(result.activeSet[0].mode).toBe("well-as-proxy");

    // Proxy requests: exactly 1 well proxy.
    expect(result.proxyRequests).toHaveLength(1);
    expect(result.proxyRequests[0]).toMatchObject({
      entityId: "wellA",
      kind: "WellProxy3D",
      t: 0,
      c: 0,
      priority: PROXY_LANE_OFFSET + 0,
    });

    // No detail chunks for the well's fields (well-as-proxy short-circuits).
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs).toHaveLength(0);
  });

  it("fields-with-proxy-fallback emits chunks + per-field FieldProxy3D + one shared WellProxy3D", () => {
    const catalog = makeCatalog([
      ["wellB", ["WellProxy3D"]],
      ["fB1", ["FieldProxy3D"]],
      ["fB2", ["FieldProxy3D"]],
    ]);
    const snap = makePlateSnapshot({
      wellId: "wellB",
      fields: [
        { id: "fB1", image: "imgB1", px: 100 },
        { id: "fB2", image: "imgB2", px: 100 },
      ],
      catalog,
    });

    const result = plan(snap);

    expect(result.activeSet).toHaveLength(2);
    for (const entry of result.activeSet) {
      expect(entry.mode).toBe("fields-with-proxy-fallback");
    }

    // Field detail chunks emitted (2 fields × 1 chunk).
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs).toHaveLength(2);

    // 2 field proxies + 1 well proxy.
    expect(result.proxyRequests).toHaveLength(3);

    const fieldProxies = result.proxyRequests.filter(
      (p) => p.kind === "FieldProxy3D",
    );
    const wellProxies = result.proxyRequests.filter(
      (p) => p.kind === "WellProxy3D",
    );

    expect(fieldProxies).toHaveLength(2);
    expect(wellProxies).toHaveLength(1);
    expect(wellProxies[0].entityId).toBe("wellB");
    // Well proxy is lower priority (higher number) than field proxies.
    expect(wellProxies[0].priority).toBeGreaterThan(fieldProxies[0].priority);
  });

  it("fields-with-detail emits chunks + per-field FieldProxy3D fallback (no well proxy)", () => {
    const catalog = makeCatalog([
      ["wellC", ["WellProxy3D"]],
      ["fC1", ["FieldProxy3D"]],
    ]);
    const snap = makePlateSnapshot({
      wellId: "wellC",
      fields: [{ id: "fC1", image: "imgC1", px: 200 }],
      catalog,
    });

    const result = plan(snap);
    expect(result.activeSet).toHaveLength(1);
    expect(result.activeSet[0].mode).toBe("fields-with-detail");

    // Detail chunks emitted.
    const detailReqs = result.requests.filter((r) => r.lane === "detail");
    expect(detailReqs.length).toBeGreaterThan(0);

    // Only field proxy, NO well proxy.
    expect(result.proxyRequests).toHaveLength(1);
    expect(result.proxyRequests[0].kind).toBe("FieldProxy3D");
    expect(result.proxyRequests[0].entityId).toBe("fC1");
  });

  it("multi-channel emits one proxy request per visible channel", () => {
    const catalog = makeCatalog([["wellM", ["WellProxy3D"]]]);
    const snap = makePlateSnapshot({
      wellId: "wellM",
      fields: [{ id: "fM1", image: "imgM1", px: 50 }],
      catalog,
      visibleChannels: [0, 1, 3],
    });

    const result = plan(snap);
    expect(result.proxyRequests).toHaveLength(3);
    const cs = result.proxyRequests.map((p) => p.c).sort();
    expect(cs).toEqual([0, 1, 3]);
  });

  it("lane priority order: minimap (0) < detail (500) < proxy (1000) < prefetch (1500) < overview (2500)", () => {
    // Slice 5 of PRD #545 promoted minimap to its own lane and renumbered
    // every other lane offset upward. The renumbering is part of the
    // public contract — downstream priority comparisons depend on it.
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
      ["wellL", ["WellProxy3D"]],
      ["fL1", ["FieldProxy3D"]],
    ]);
    const snap = makePlateSnapshot({
      wellId: "wellL",
      fields: [{ id: "fL1", image: "imgL1", px: 100 }],
      catalog,
    });
    const result = plan(snap);

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

  it("hysteresis: bouncing 75-85px doesn't flip mode after settling on well-as-proxy", () => {
    const catalog = makeCatalog([
      ["wellH", ["WellProxy3D"]],
      ["fH1", ["FieldProxy3D"]],
    ]);

    // Settle on well-as-proxy at 50px.
    let snap = makePlateSnapshot({
      wellId: "wellH",
      fields: [{ id: "fH1", image: "imgH1", px: 50 }],
      catalog,
    });
    let result = plan(snap);
    expect(result.activeSet[0].mode).toBe("well-as-proxy");

    // Now bounce 75/82/78/84 — should stay well-as-proxy.
    for (const px of [75, 82, 78, 84, 80]) {
      snap = makePlateSnapshot({
        wellId: "wellH",
        fields: [{ id: "fH1", image: "imgH1", px }],
        catalog,
        previousActiveSet: result.activeSet,
      });
      result = plan(snap);
      expect(result.activeSet[0].mode).toBe("well-as-proxy");
    }

    // Cross 85 → flip to proxy-fallback.
    snap = makePlateSnapshot({
      wellId: "wellH",
      fields: [{ id: "fH1", image: "imgH1", px: 86 }],
      catalog,
      previousActiveSet: result.activeSet,
    });
    result = plan(snap);
    expect(result.activeSet[0].mode).toBe("fields-with-proxy-fallback");
  });

  it("hysteresis: bouncing 145-155px doesn't flip mode after settling on fields-with-detail", () => {
    const catalog = makeCatalog([
      ["wellJ", ["WellProxy3D"]],
      ["fJ1", ["FieldProxy3D"]],
    ]);

    // Settle on fields-with-detail at 200px.
    let snap = makePlateSnapshot({
      wellId: "wellJ",
      fields: [{ id: "fJ1", image: "imgJ1", px: 200 }],
      catalog,
    });
    let result = plan(snap);
    expect(result.activeSet[0].mode).toBe("fields-with-detail");

    for (const px of [148, 152, 146, 154, 150]) {
      snap = makePlateSnapshot({
        wellId: "wellJ",
        fields: [{ id: "fJ1", image: "imgJ1", px }],
        catalog,
        previousActiveSet: result.activeSet,
      });
      result = plan(snap);
      expect(result.activeSet[0].mode).toBe("fields-with-detail");
    }

    // Cross 145 → flip down.
    snap = makePlateSnapshot({
      wellId: "wellJ",
      fields: [{ id: "fJ1", image: "imgJ1", px: 144 }],
      catalog,
      previousActiveSet: result.activeSet,
    });
    result = plan(snap);
    expect(result.activeSet[0].mode).toBe("fields-with-proxy-fallback");
  });

  it("constants check: thresholds 80/150 with hysteresis 5", () => {
    expect(FAR_THRESHOLD_PX).toBe(80);
    expect(DETAIL_THRESHOLD_PX).toBe(150);
    expect(HYSTERESIS_PX).toBe(5);
    // Backwards-compat: PROMOTE_THRESHOLD_PX maps onto FAR_THRESHOLD_PX.
    expect(PROMOTE_THRESHOLD_PX).toBe(FAR_THRESHOLD_PX);
  });

  it("named magic numbers have their documented values", () => {
    expect(IMPORTANCE_WEIGHT).toBe(500);
    expect(DISTANCE_WEIGHT).toBe(10);
    expect(WELL_PROXY_PRIORITY_BUMP).toBe(100);
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
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
    return { entity, entry };
  }

  it("considered increments by maxCol * maxRow * maxZ per call", () => {
    const { entity, entry } = makeStatsFixture();
    const region = makeVisibleRegion({
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 4],
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
      xyBounds: [0, 0, 512, 512],
      zRange: [0, 4],
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
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 1],
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
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 4],
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
      makeVisibleRegion({ xyBounds: [0, 0, 1024, 1024], zRange: [0, 4] }),
      makeSelection(),
      stats,
    );
    iterateChunks(
      entity,
      entry,
      makeVisibleRegion({ xyBounds: [0, 0, 512, 512], zRange: [0, 4] }),
      makeSelection(),
      stats,
    );
    iterateChunks(
      entity,
      entry,
      makeVisibleRegion({
        xyBounds: [0, 0, 1024, 1024],
        zRange: [0, 1],
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
      xyBounds: [-2000, -2000, -1000, -1000],
      zRange: [0, 4],
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
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 1],
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
    const result = plan(snap);

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
    // make it into the active set as `fields-with-detail` pass-throughs,
    // but contribute no chunk requests when there's nothing to fetch.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entityA = createSyntheticEntity({
      entityId: "a",
      visible: false,
      levels: [level0],
      position: [10000, 10000],
    });
    const entityB = createSyntheticEntity({
      entityId: "b",
      visible: false,
      levels: [],
    });
    const snap = createSyntheticSnapshot({ entities: [entityA, entityB] });
    const result = plan(snap);

    expect(result.activeSet).toHaveLength(2);
    for (const entry of result.activeSet) {
      expect(entry.mode).toBe("fields-with-detail");
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
    });

    const result = plan(snap);
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
        xyBounds: [0, 0, 256, 256],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: null,
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

    const result = plan(snap);
    const prefetch = result.requests.filter((r) => r.lane === "prefetch");
    expect(prefetch).toHaveLength(0);
  });
});

describe("iterateChunks edge cases", () => {
  it("field-mode entry with empty levels → empty result", () => {
    const entity = createSyntheticEntity({
      entityId: "e0",
      levels: [],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
    const result = iterateChunks(entity, entry, makeVisibleRegion(), makeSelection());
    expect(result).toHaveLength(0);
  });
});

describe("groupByWell edge cases (via assignModes)", () => {
  it("field whose parentId === null gets a synthetic-key group", () => {
    // A field-kind entity with no parent should still be grouped (as a
    // singleton) and emit one active-set entry. Without a catalog the
    // mode collapses to fields-with-detail.
    const orphan = createSyntheticEntity({
      entityId: "orphan-field",
      imageId: "img-orphan",
      kind: "Field",
      projectedDiagonalPx: 200,
      levels: makeStubLevels(3),
      idealTargetLod: 0,
      parentId: null,
    });
    const result = assignModes([orphan], []);

    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe("orphan-field");
    expect(result[0].mode).toBe("fields-with-detail");
  });
});

describe("assignModes edge cases", () => {
  it("stale previousActiveSet entries (entities no longer present) are silently ignored", () => {
    // No entities in the new snapshot — but previousActiveSet has
    // entries pointing to ids that don't exist anymore. assignModes
    // should not throw and the empty entities list should produce an
    // empty result.
    const stalePrev: ActiveSetEntry[] = [
      {
        entityId: "ghost-well",
        imageId: "",
        mode: "well-as-proxy",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyKind: "WellProxy3D",
        proxyAvailable: true,
        wellProxyAvailable: true,
      },
      {
        entityId: "ghost-field",
        imageId: "ghost-img",
        mode: "fields-with-detail",
        targetLod: 0,
        coarsestDetailLod: 2,
        detailOwnedLodRange: [0, 2],
        proxyKind: "FieldProxy3D",
        proxyAvailable: false,
        wellProxyAvailable: false,
      },
    ];

    expect(() => assignModes([], stalePrev)).not.toThrow();
    expect(assignModes([], stalePrev)).toEqual([]);
  });
});

describe("chooseEntityMode edge cases", () => {
  it("null prev with px inside the FAR hysteresis band falls back to fields-with-proxy-fallback", () => {
    // px=80 is in the [farLower, farUpper) band; with no prev mode and
    // none of the prevMode branches matching, the function returns
    // `prevMode ?? "fields-with-proxy-fallback"`.
    expect(chooseEntityMode(null, 80)).toBe("fields-with-proxy-fallback");
  });

  it("null prev with px inside the MEDIUM hysteresis band falls back to fields-with-proxy-fallback", () => {
    // px=150 is in the (medLower, medUpper] band.
    expect(chooseEntityMode(null, 150)).toBe("fields-with-proxy-fallback");
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
// PlanningConfig — Slice 3
// ---------------------------------------------------------------------------

describe("PlanningConfig", () => {
  it("DEFAULT_PLANNING_CONFIG matches the exported constants for every tunable", () => {
    expect(DEFAULT_PLANNING_CONFIG.farThresholdPx).toBe(FAR_THRESHOLD_PX);
    expect(DEFAULT_PLANNING_CONFIG.detailThresholdPx).toBe(DETAIL_THRESHOLD_PX);
    expect(DEFAULT_PLANNING_CONFIG.hysteresisPx).toBe(HYSTERESIS_PX);
    expect(DEFAULT_PLANNING_CONFIG.prefetchDepth).toBe(PREFETCH_DEPTH);
    expect(DEFAULT_PLANNING_CONFIG.importanceWeight).toBe(IMPORTANCE_WEIGHT);
    expect(DEFAULT_PLANNING_CONFIG.distanceWeight).toBe(DISTANCE_WEIGHT);
    expect(DEFAULT_PLANNING_CONFIG.wellProxyPriorityBump).toBe(
      WELL_PROXY_PRIORITY_BUMP,
    );
    expect(DEFAULT_PLANNING_CONFIG.minimapLaneOffset).toBe(MINIMAP_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.detailLaneOffset).toBe(DETAIL_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.proxyLaneOffset).toBe(PROXY_LANE_OFFSET);
    expect(DEFAULT_PLANNING_CONFIG.prefetchLaneOffset).toBe(
      PREFETCH_LANE_OFFSET,
    );
    expect(DEFAULT_PLANNING_CONFIG.overviewLaneOffset).toBe(
      OVERVIEW_LANE_OFFSET,
    );
  });

  it("renumbered lane offsets — Slice 5: 0 / 500 / 1000 / 1500 / 2500", () => {
    // Hard-pinned values so a future re-number is loud.
    expect(MINIMAP_LANE_OFFSET).toBe(0);
    expect(DETAIL_LANE_OFFSET).toBe(500);
    expect(PROXY_LANE_OFFSET).toBe(1000);
    expect(PREFETCH_LANE_OFFSET).toBe(1500);
    expect(OVERVIEW_LANE_OFFSET).toBe(2500);
  });

  it("mergeConfig({}) returns a config equal to DEFAULT_PLANNING_CONFIG", () => {
    const merged = mergeConfig({});
    expect(merged).toEqual(DEFAULT_PLANNING_CONFIG);
    // Returns a fresh object — not the same reference as the default.
    expect(merged).not.toBe(DEFAULT_PLANNING_CONFIG);
  });

  it("mergeConfig({farThresholdPx: 50}) overrides one field, defaults the rest", () => {
    const merged = mergeConfig({ farThresholdPx: 50 });
    expect(merged.farThresholdPx).toBe(50);
    expect(merged.detailThresholdPx).toBe(DEFAULT_PLANNING_CONFIG.detailThresholdPx);
    expect(merged.hysteresisPx).toBe(DEFAULT_PLANNING_CONFIG.hysteresisPx);
    expect(merged.prefetchDepth).toBe(DEFAULT_PLANNING_CONFIG.prefetchDepth);
    expect(merged.importanceWeight).toBe(DEFAULT_PLANNING_CONFIG.importanceWeight);
    expect(merged.distanceWeight).toBe(DEFAULT_PLANNING_CONFIG.distanceWeight);
    expect(merged.wellProxyPriorityBump).toBe(
      DEFAULT_PLANNING_CONFIG.wellProxyPriorityBump,
    );
    expect(merged.minimapLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.minimapLaneOffset);
    expect(merged.detailLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.detailLaneOffset);
    expect(merged.proxyLaneOffset).toBe(DEFAULT_PLANNING_CONFIG.proxyLaneOffset);
    expect(merged.prefetchLaneOffset).toBe(
      DEFAULT_PLANNING_CONFIG.prefetchLaneOffset,
    );
    expect(merged.overviewLaneOffset).toBe(
      DEFAULT_PLANNING_CONFIG.overviewLaneOffset,
    );
  });

  it("mergeConfig doesn't mutate the input partial", () => {
    const partial: Partial<PlanningConfig> = { farThresholdPx: 50 };
    const before = { ...partial };
    mergeConfig(partial);
    expect(partial).toEqual(before);
    // And only the specified field is present on the input object.
    expect(Object.keys(partial)).toEqual(["farThresholdPx"]);
  });
});

// ---------------------------------------------------------------------------
// plan() honors config tunables — Slice 3
// ---------------------------------------------------------------------------
//
// Each test changes one tunable on a tailored synthetic snapshot and
// asserts that the corresponding behaviour shifts. Defaults are
// confirmed in PlanningConfig above; here we verify the parameter
// actually flows through to every code path.

describe("plan() honors config tunables", () => {
  /**
   * Single-channel single-LOD plate snapshot at a configurable
   * projected diagonal. Field has its own catalog entries so it can
   * promote to any of the three modes.
   */
  function makeTunablePlate(opts: {
    px: number;
    catalog?: AssetCatalogSnapshot | null;
    importance?: number;
    visibleChannels?: number[];
  }): PlanningSnapshot {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const wellId = "wellT";
    const fieldId = "fT1";
    const catalog =
      opts.catalog ??
      makeCatalog([
        [wellId, ["WellProxy3D"]],
        [fieldId, ["FieldProxy3D"]],
      ]);
    return createSyntheticSnapshot({
      entities: [
        createSyntheticEntity({
          entityId: wellId,
          imageId: "",
          kind: "Well",
          projectedDiagonalPx: opts.px,
          levels: [],
          parentId: null,
        }),
        createSyntheticEntity({
          entityId: fieldId,
          imageId: "imgT1",
          kind: "Field",
          projectedDiagonalPx: opts.px,
          idealTargetLod: 0,
          levels: [level0],
          importance: opts.importance ?? 1.0,
          parentId: wellId,
        }),
      ],
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
        visibleChannels: opts.visibleChannels ?? [0],
        renderMode: "slice",
        interactionState: "idle",
      },
      assetCatalog: catalog,
    });
  }

  it("farThresholdPx: raising to 200 promotes a 100px entity to well-as-proxy", () => {
    const snap = makeTunablePlate({ px: 100 });

    // Default thresholds: 100px → fields-with-proxy-fallback.
    const defaultResult = plan(snap, DEFAULT_PLANNING_CONFIG);
    expect(defaultResult.activeSet[0].mode).toBe("fields-with-proxy-fallback");

    // Raise the far threshold past 100 → promotes to well-as-proxy.
    const result = plan(
      snap,
      mergeConfig({ farThresholdPx: 200, detailThresholdPx: 250 }),
    );
    expect(result.activeSet).toHaveLength(1);
    expect(result.activeSet[0].mode).toBe("well-as-proxy");
  });

  it("detailThresholdPx: lowering to 50 demotes a 100px entity to fields-with-detail", () => {
    const snap = makeTunablePlate({ px: 100 });

    const defaultResult = plan(snap, DEFAULT_PLANNING_CONFIG);
    expect(defaultResult.activeSet[0].mode).toBe("fields-with-proxy-fallback");

    // Lower the detail threshold past 100 → fields-with-detail.
    const result = plan(
      snap,
      mergeConfig({ farThresholdPx: 30, detailThresholdPx: 50 }),
    );
    expect(result.activeSet[0].mode).toBe("fields-with-detail");
  });

  it("hysteresisPx: a wider band lets the previous mode win in a wider range", () => {
    // Settle at 50px in well-as-proxy, then read 100px.
    const settle = plan(makeTunablePlate({ px: 50 }), DEFAULT_PLANNING_CONFIG);
    expect(settle.activeSet[0].mode).toBe("well-as-proxy");

    const followup = makeTunablePlate({ px: 100 });
    followup.previousActiveSet = settle.activeSet;

    // Default hysteresis (5px): 100 is way past farUpper (85), so it
    // flips out of well-as-proxy.
    const defaultResult = plan(followup, DEFAULT_PLANNING_CONFIG);
    expect(defaultResult.activeSet[0].mode).not.toBe("well-as-proxy");

    // Wider hysteresis (50px): 100 falls inside the [80-50, 80+50] = [30, 130]
    // band, so the prev well-as-proxy mode is preserved.
    const result = plan(followup, mergeConfig({ hysteresisPx: 50 }));
    expect(result.activeSet[0].mode).toBe("well-as-proxy");
  });

  it("prefetchDepth: 0 emits no prefetch chunks; 4 emits T+1..T+4", () => {
    const level0 = makeLevelGeo(0, [10, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: [level0],
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
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
    });

    const zero = plan(snap, mergeConfig({ prefetchDepth: 0 }));
    expect(zero.requests.filter((r) => r.lane === "prefetch")).toHaveLength(0);

    const four = plan(snap, mergeConfig({ prefetchDepth: 4 }));
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
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
    });
    const low = createSyntheticEntity({
      entityId: "low",
      imageId: "img-l",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: [level0],
      importance: 0.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [high, low],
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
    });

    // Default: importance weight is non-zero → priorities differ.
    const defaultResult = plan(snap, DEFAULT_PLANNING_CONFIG);
    const defaultDetail = defaultResult.requests.filter(
      (r) => r.lane === "detail",
    );
    const defaultHigh = defaultDetail.find((r) => r.entityId === "high")!;
    const defaultLow = defaultDetail.find((r) => r.entityId === "low")!;
    expect(defaultHigh.priority).not.toBe(defaultLow.priority);

    // With importanceWeight = 0, same-distance chunks have equal priority.
    const result = plan(snap, mergeConfig({ importanceWeight: 0 }));
    const detail = result.requests.filter((r) => r.lane === "detail");
    const hi = detail.find((r) => r.entityId === "high")!;
    const lo = detail.find((r) => r.entityId === "low")!;
    expect(hi.priority).toBe(lo.priority);
  });

  it("distanceWeight: 0 removes distance from priority within a lane", () => {
    // Two chunks at different distances from sortCenter, same importance.
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: {
        xyBounds: [0, 0, 1024, 256],
        zRange: [0, 1],
        effectiveZoom: 1,
        sortCenter: [960, 128, 0],
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
    const defaultResult = plan(snap, DEFAULT_PLANNING_CONFIG);
    const defaultDetail = defaultResult.requests.filter(
      (r) => r.lane === "detail",
    );
    const defaultPriorities = new Set(defaultDetail.map((r) => r.priority));
    expect(defaultPriorities.size).toBeGreaterThan(1);

    // distanceWeight = 0 → all detail chunks for one entity share the
    // same priority because importance is identical and distance no
    // longer contributes.
    const result = plan(snap, mergeConfig({ distanceWeight: 0 }));
    const detail = result.requests.filter((r) => r.lane === "detail");
    expect(detail.length).toBe(4);
    const priorities = new Set(detail.map((r) => r.priority));
    expect(priorities.size).toBe(1);
  });

  it("wellProxyPriorityBump: changing it shifts the parent-well proxy priority", () => {
    const snap = makeTunablePlate({ px: 100 });

    const defaultResult = plan(snap, DEFAULT_PLANNING_CONFIG);
    const defaultWellProxy = defaultResult.proxyRequests.find(
      (p) => p.kind === "WellProxy3D",
    )!;
    expect(defaultWellProxy.priority).toBe(
      DEFAULT_PLANNING_CONFIG.proxyLaneOffset +
        DEFAULT_PLANNING_CONFIG.wellProxyPriorityBump,
    );

    const result = plan(snap, mergeConfig({ wellProxyPriorityBump: 50 }));
    const wellProxy = result.proxyRequests.find(
      (p) => p.kind === "WellProxy3D",
    )!;
    expect(wellProxy.priority).toBe(
      DEFAULT_PLANNING_CONFIG.proxyLaneOffset + 50,
    );
  });

  it("detailLaneOffset: changing it shifts every detail-chunk priority", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
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
    });

    const before = plan(snap, DEFAULT_PLANNING_CONFIG);
    const beforeDetail = before.requests.filter((r) => r.lane === "detail");
    expect(beforeDetail.length).toBe(1);
    const beforePri = beforeDetail[0].priority;

    // Override offset is `default + 250` so the delta is +250
    // regardless of the renumbered default. Slice 5 changed
    // DETAIL_LANE_OFFSET from 0 → 500; the override must be
    // computed off the live default rather than hard-coded.
    const newOffset = DEFAULT_PLANNING_CONFIG.detailLaneOffset + 250;
    const after = plan(snap, mergeConfig({ detailLaneOffset: newOffset }));
    const afterDetail = after.requests.filter((r) => r.lane === "detail");
    expect(afterDetail.length).toBe(1);
    // Only the lane offset changed → priority shifts by exactly +250.
    expect(afterDetail[0].priority).toBeCloseTo(beforePri + 250);
  });

  it("proxyLaneOffset: changing it shifts every proxy-request priority", () => {
    const snap = makeTunablePlate({ px: 50 }); // → well-as-proxy

    const before = plan(snap, DEFAULT_PLANNING_CONFIG);
    const beforeWellProxy = before.proxyRequests.find(
      (p) => p.kind === "WellProxy3D",
    )!;
    expect(beforeWellProxy.priority).toBe(
      DEFAULT_PLANNING_CONFIG.proxyLaneOffset,
    );

    const after = plan(snap, mergeConfig({ proxyLaneOffset: 750 }));
    const afterWellProxy = after.proxyRequests.find(
      (p) => p.kind === "WellProxy3D",
    )!;
    expect(afterWellProxy.priority).toBe(750);
  });

  it("prefetchLaneOffset: changing it shifts every prefetch-chunk priority", () => {
    const level0 = makeLevelGeo(0, [10, 1, 1, 256, 256], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
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
    });

    const before = plan(snap, DEFAULT_PLANNING_CONFIG);
    const beforePrefetch = before.requests.filter(
      (r) => r.lane === "prefetch" && r.t === 1,
    );
    expect(beforePrefetch.length).toBe(1);
    const beforePri = beforePrefetch[0].priority;

    // Override is `default + 500` so the delta is +500 regardless of
    // the renumbered default (Slice 5 shifted prefetch 1000 → 1500).
    const newOffset = DEFAULT_PLANNING_CONFIG.prefetchLaneOffset + 500;
    const after = plan(snap, mergeConfig({ prefetchLaneOffset: newOffset }));
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
      idealTargetLod: 0,
      levels: [level0],
      importance: 1.0,
    });
    const snap = createSyntheticSnapshot({
      entities: [entity],
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
    });

    const before = plan(snap, DEFAULT_PLANNING_CONFIG);
    const beforeOverview = before.requests.filter((r) => r.lane === "overview");
    expect(beforeOverview.length).toBe(1);
    const beforePri = beforeOverview[0].priority;

    // Override is `default + 1000` so the delta is +1000 regardless
    // of the renumbered default (Slice 5 shifted overview 2000 → 2500).
    const newOffset = DEFAULT_PLANNING_CONFIG.overviewLaneOffset + 1000;
    const after = plan(snap, mergeConfig({ overviewLaneOffset: newOffset }));
    const afterOverview = after.requests.filter((r) => r.lane === "overview");
    expect(afterOverview.length).toBe(1);
    // Lane offset shift is +1000.
    expect(afterOverview[0].priority).toBeCloseTo(beforePri + 1000);
  });
});

// ---------------------------------------------------------------------------
// emitMinimapLane — Slice 5 (PRD #545 / ADR 0023)
// ---------------------------------------------------------------------------
//
// The minimap lane is a Slice 5 promotion: minimap chunks now ride
// their own dedicated highest-priority lane instead of being shoved
// onto OVERVIEW at priority 2000 by the orchestrator. The planner
// pulls them from `snapshot.minimapPending` and emits them with
// `priority = MINIMAP_LANE_OFFSET` directly (no importance / distance
// terms — minimap is per-dataset, not per-entity).

describe("plan() — minimap lane (Slice 5)", () => {
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
      idealTargetLod: 0,
      levels: [level0],
      importance: opts?.importance ?? 1.0,
    });
    return createSyntheticSnapshot({
      entities: [entity],
      visibleRegion: makeVisibleRegion({ xyBounds: [0, 0, 256, 256] }),
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
    const result = plan(snap);
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
    const result = plan(snap);
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
    const high = plan(snapHigh).requests.filter((r) => r.lane === "minimap");
    const low = plan(snapLow).requests.filter((r) => r.lane === "minimap");
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
    const result = plan(snap);
    const priorities = new Set(
      result.requests.filter((r) => r.lane === "minimap").map((r) => r.priority),
    );
    expect(priorities.size).toBe(1);
    expect(priorities.has(MINIMAP_LANE_OFFSET)).toBe(true);
  });

  it("emits no minimap requests when minimapPending is empty", () => {
    const snap = makeMinimapSnapshot({ minimapPending: new Map() });
    const result = plan(snap);
    expect(result.requests.some((r) => r.lane === "minimap")).toBe(false);
  });

  it("skips coords for an imageId that no visible entity matches", () => {
    const snap = makeMinimapSnapshot({
      minimapPending: new Map([
        [
          "imgUnknown",
          [{ level: 3, x: 0, y: 0, z: 0, t: 0, c: 0, key: "3/0/0/0/0/0" }],
        ],
      ]),
    });
    const result = plan(snap);
    expect(result.requests.some((r) => r.lane === "minimap")).toBe(false);
  });

  it("sorts before every other lane after the priority sort (smallest priority first)", () => {
    const snap = makeMinimapSnapshot();
    const result = plan(snap);
    expect(result.requests.length).toBeGreaterThan(0);
    // Slice 5 invariant: minimap chunks are at priority 0, every
    // other lane is >= DETAIL_LANE_OFFSET (= 500). plan()'s ascending
    // priority sort therefore guarantees the first non-minimap entry
    // comes after every minimap entry.
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
    const before = plan(snap, DEFAULT_PLANNING_CONFIG);
    const beforeMinimap = before.requests.filter((r) => r.lane === "minimap");
    expect(beforeMinimap.length).toBeGreaterThan(0);
    expect(beforeMinimap[0].priority).toBe(MINIMAP_LANE_OFFSET);

    const after = plan(snap, mergeConfig({ minimapLaneOffset: 250 }));
    const afterMinimap = after.requests.filter((r) => r.lane === "minimap");
    expect(afterMinimap.length).toBeGreaterThan(0);
    for (const req of afterMinimap) expect(req.priority).toBe(250);
  });
});
