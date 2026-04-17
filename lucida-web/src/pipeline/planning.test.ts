import { describe, it, expect } from "vitest";

import {
  promote,
  createSyntheticEntity,
  createSyntheticSnapshot,
  PROMOTE_THRESHOLD_PX,
  DEMOTE_THRESHOLD_PX,
  FAR_THRESHOLD_PX,
  MEDIUM_THRESHOLD_PX,
  HYSTERESIS_PX,
  PROXY_LANE_OFFSET,
  DETAIL_LANE_OFFSET,
  OVERVIEW_LANE_OFFSET,
  chooseWellMode,
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
  WellMode,
  AssetCatalogSnapshot,
  ProxyKind,
} from "./planning.ts";
import type { LevelGeometry } from "../contentTypes.ts";

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
  seedDetailLod: number,
): ActiveSetEntry {
  return {
    entityId,
    imageId,
    mode: "fields-with-detail",
    targetLod,
    seedDetailLod,
    detailOwnedLodRange: [targetLod, seedDetailLod],
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

describe("promote — three-tier (no catalog)", () => {
  it("entity above MEDIUM threshold uses fields-with-detail", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
    });
    expect(entity.projectedDiagonalPx).toBeGreaterThan(MEDIUM_THRESHOLD_PX);

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
  });

  it("entity below FAR threshold degrades to fields-with-detail when no catalog", () => {
    // Below FAR_THRESHOLD_PX, chooseWellMode picks well-as-proxy, but
    // catalog-aware degrade pushes it all the way down to fields-with-detail.
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 30,
    });
    expect(entity.projectedDiagonalPx).toBeLessThan(FAR_THRESHOLD_PX);

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
  });

  it("entity in mid range degrades to fields-with-detail when no catalog", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 100,
    });
    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
  });

  it("invisible entity emits a fields-with-detail entry at coarsest LOD", () => {
    const entity = createSyntheticEntity({
      visible: false,
      projectedDiagonalPx: 200,
      numLevels: 5,
    });

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(4);
    expect(result.detailOwnedLodRange).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------------------
// LOD range
// ---------------------------------------------------------------------------

describe("LOD range", () => {
  it("sets seedDetailLod = targetLod + 2 for a field-mode entity", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 5,
    });

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(0);
    expect(result.seedDetailLod).toBe(2);
    expect(result.detailOwnedLodRange).toEqual([0, 2]);
  });

  it("clamps seedDetailLod to numLevels - 1", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 3,
      numLevels: 4,
    });

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(3);
    expect(result.seedDetailLod).toBe(3); // clamped: min(3+2, 3) = 3
    expect(result.detailOwnedLodRange).toEqual([3, 3]);
  });

  it("handles single-level images", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
    });

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(0);
    expect(result.seedDetailLod).toBe(0);
    expect(result.detailOwnedLodRange).toEqual([0, 0]);
  });

  it("invisible entity LODs are coarsest level", () => {
    const entity = createSyntheticEntity({
      kind: "Image",
      visible: false,
      projectedDiagonalPx: 30,
      numLevels: 5,
    });

    const [result] = promote([entity], []);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.targetLod).toBe(4);
    expect(result.seedDetailLod).toBe(4);
    expect(result.detailOwnedLodRange).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------------------
// chooseWellMode — pure hysteresis tests
// ---------------------------------------------------------------------------

describe("chooseWellMode", () => {
  it("clearly far → well-as-proxy", () => {
    expect(chooseWellMode(null, 50)).toBe("well-as-proxy");
  });
  it("clearly mid → fields-with-proxy-fallback", () => {
    expect(chooseWellMode(null, 100)).toBe("fields-with-proxy-fallback");
  });
  it("clearly near → fields-with-detail", () => {
    expect(chooseWellMode(null, 200)).toBe("fields-with-detail");
  });

  it("hysteresis at FAR threshold: keeps well-as-proxy across 75–84", () => {
    let prev: WellMode | null = "well-as-proxy";
    for (const px of [80, 78, 82, 84, 75, 79]) {
      const next = chooseWellMode(prev, px);
      expect(next).toBe("well-as-proxy");
      prev = next;
    }
    // Past upper bound (>= 85) → flip
    expect(chooseWellMode("well-as-proxy", 85)).toBe(
      "fields-with-proxy-fallback",
    );
  });

  it("hysteresis at FAR threshold: keeps proxy-fallback across 76–85", () => {
    let prev: WellMode | null = "fields-with-proxy-fallback";
    for (const px of [80, 81, 82, 84, 85]) {
      const next = chooseWellMode(prev, px);
      expect(next).toBe("fields-with-proxy-fallback");
      prev = next;
    }
    // Below lower bound → flip down to well-as-proxy
    expect(chooseWellMode("fields-with-proxy-fallback", 74)).toBe(
      "well-as-proxy",
    );
  });

  it("hysteresis at MEDIUM threshold: keeps fields-with-detail across 146-155", () => {
    let prev: WellMode | null = "fields-with-detail";
    for (const px of [150, 148, 152, 155, 146]) {
      const next = chooseWellMode(prev, px);
      expect(next).toBe("fields-with-detail");
      prev = next;
    }
    // Below lower bound (<= 145) → flip
    expect(chooseWellMode("fields-with-detail", 145)).toBe(
      "fields-with-proxy-fallback",
    );
  });

  it("hysteresis at MEDIUM threshold: keeps proxy-fallback across 145-154", () => {
    let prev: WellMode | null = "fields-with-proxy-fallback";
    for (const px of [150, 151, 154, 145, 148]) {
      const next = chooseWellMode(prev, px);
      expect(next).toBe("fields-with-proxy-fallback");
      prev = next;
    }
    expect(chooseWellMode("fields-with-proxy-fallback", 156)).toBe(
      "fields-with-detail",
    );
  });
});

// ---------------------------------------------------------------------------
// promote() with a populated catalog (three-tier behaviour)
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
      numLevels: 1,
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
        numLevels: 5,
        idealTargetLod: 0,
        parentId: wellId,
      }),
    );
  }
  return out;
}

describe("promote — three-tier with catalog", () => {
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

    const result = promote(entities, [], catalog);

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

    const result = promote(entities, [], catalog);
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

    const result = promote(entities, [], catalog);
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

    const result = promote(entities, [], catalog);
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

    const result = promote(entities, [], catalog);
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

    const result = promote(entities, [], catalog);
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

    const result = promote(entities, [], catalog);
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
        seedDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyKind: "WellProxy3D",
        proxyAvailable: true,
        wellProxyAvailable: true,
      },
    ];

    const result = promote(entities, prev, catalog);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("well-as-proxy");
  });

  it("hysteresis flip: 50→100→50 returns to well-as-proxy", () => {
    const fields = [{ id: "fH1", image: "imgH1", px: 50 }];
    const catalog = makeCatalog([
      ["wellH", ["WellProxy3D"]],
      ["fH1", ["FieldProxy3D"]],
    ]);

    const r1 = promote(makePlateEntities("wellH", fields), [], catalog);
    expect(r1[0].mode).toBe("well-as-proxy");

    fields[0].px = 100;
    const r2 = promote(makePlateEntities("wellH", fields), r1, catalog);
    expect(r2[0].mode).toBe("fields-with-proxy-fallback");

    fields[0].px = 50;
    const r3 = promote(makePlateEntities("wellH", fields), r2, catalog);
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
  return { cached: new Map(entries ?? []), inFlight: new Map() };
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
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);

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

  it("well-as-proxy entry produces no chunk requests", () => {
    const level0 = makeLevelGeo(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "wellX",
      imageId: "",
      kind: "Well",
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry: ActiveSetEntry = {
      entityId: "wellX",
      imageId: "",
      mode: "well-as-proxy",
      targetLod: 0,
      seedDetailLod: 0,
      detailOwnedLodRange: [0, 0],
      proxyKind: "WellProxy3D",
      proxyAvailable: true,
      wellProxyAvailable: true,
    };

    const result = iterateChunks(entity, entry, makeVisibleRegion(), makeSelection(), makeCacheState());
    expect(result).toHaveLength(0);
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
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
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
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
    const region = makeVisibleRegion({ xyBounds: [0, 0, 256, 256] });
    const selection = makeSelection({ visibleChannels: [0, 2, 3] });
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);

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
      numLevels: 1,
      levels: [level0],
      position: [0, 0],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);

    const region = makeVisibleRegion({
      xyBounds: [0, 0, 1024, 256],
      sortCenter: [960, 128, 0],
    });
    const selection = makeSelection();
    const cache = makeCacheState();

    const result = iterateChunks(entity, entry, region, selection, cache);

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
      numLevels: 1,
      levels: [level0],
      position: [500, 500],
    });
    const entry = makeFieldDetailEntry("e0", "img0", 0, 0);
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
    const entry = makeFieldDetailEntry("e0", "img0", 0, 2);
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
    const level0 = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      kind: "Image",
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
      cacheState: { cached: new Map(), inFlight: new Map() },
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
      kind: "Image",
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
      kind: "Image",
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
      cacheState: { cached: new Map(), inFlight: new Map() },
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
  it("center-out priority: chunks nearest view center have lowest priority", () => {
    // 4x1x1 grid so chunks are spread along X (cols 0-3).
    const level0 = makeLevelGeo(0, [1, 1, 1, 256, 1024], [1, 1, 1, 256, 256]);
    const entity = createSyntheticEntity({
      entityId: "e0",
      imageId: "img0",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
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
      numLevels: 1,
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
    // Entity 1: large projected diagonal -> fields-with-detail
    const level0A = makeLevelGeo(0, [20, 1, 1, 512, 512], [1, 1, 1, 256, 256]);
    const entityDetail = createSyntheticEntity({
      entityId: "detail-entity",
      imageId: "img-detail",
      kind: "Image",
      projectedDiagonalPx: 200,
      idealTargetLod: 0,
      numLevels: 1,
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
      cacheState: { cached: new Map(), inFlight: new Map() },
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

    // Runway lane: both entities each contribute 4 chunks * 2 timepoints.
    const runwayReqs = result.requests.filter((r) => r.lane === "runway");
    expect(runwayReqs).toHaveLength(2 * 4 * RUNWAY_DEPTH);
    const runwayTs = new Set(runwayReqs.map((r) => r.t));
    expect(runwayTs.has(6)).toBe(true);
    expect(runwayTs.has(7)).toBe(true);

    // Overview lane: both entities contribute coarsest-level chunks.
    // Each entity has a 2x2 grid at level 0 (only level), so 4+4 = 8.
    const overviewReqs = result.requests.filter((r) => r.lane === "overview");
    expect(overviewReqs).toHaveLength(8);
    const overviewEntities = new Set(overviewReqs.map((r) => r.entityId));
    expect(overviewEntities.has("detail-entity")).toBe(true);
    expect(overviewEntities.has("overview-entity")).toBe(true);

    // Total: 8 detail + 16 runway + 8 overview = 32
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
        numLevels: 0,
        levels: [],
        parentId: null,
      }),
      ...opts.fields.map((f) =>
        createSyntheticEntity({
          entityId: f.id,
          imageId: f.image,
          kind: "Field",
          projectedDiagonalPx: f.px,
          numLevels: 1,
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

  it("lane priority order: detail (0) < proxy (500) < overview (2000)", () => {
    expect(DETAIL_LANE_OFFSET).toBe(0);
    expect(PROXY_LANE_OFFSET).toBe(500);
    expect(OVERVIEW_LANE_OFFSET).toBe(2000);
    expect(DETAIL_LANE_OFFSET).toBeLessThan(PROXY_LANE_OFFSET);
    expect(PROXY_LANE_OFFSET).toBeLessThan(OVERVIEW_LANE_OFFSET);

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
    expect(MEDIUM_THRESHOLD_PX).toBe(150);
    expect(HYSTERESIS_PX).toBe(5);
    // Backwards-compat: PROMOTE_THRESHOLD_PX maps onto FAR_THRESHOLD_PX.
    expect(PROMOTE_THRESHOLD_PX).toBe(FAR_THRESHOLD_PX);
    expect(DEMOTE_THRESHOLD_PX).toBe(40);
  });
});
