import { describe, expect, it } from "vitest";

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { AssetCatalogSnapshot, ProxyFootprint } from "../assetCatalog.ts";
import type { SceneEpochs } from "../epochs.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  TileSnapshot,
  PlanningSnapshot,
  ProxyKind,
  ProxyRequest,
  GroupSnapshot,
} from "./types.ts";
import { DEFAULT_PLANNING_CONFIG, mergeConfig } from "./config.ts";
import { planProxyResidency, proxyRequestKey } from "./proxyResidency.ts";

const LEVEL: LevelGeometry = {
  level_index: 0,
  shape: [1, 1, 1, 128, 128],
  chunk_shape: [1, 1, 1, 64, 64],
  grid_shape: [1, 1, 1, 2, 2],
  scale: [1, 1, 1, 1, 1],
};

const EPOCHS: SceneEpochs = {
  content: 0,
  view: 0,
  layout: 0,
  asset: 0,
  selection: 0,
  request: 0,
};

function group(id: string, x: number, importance = 0.5): GroupSnapshot {
  return {
    kind: "Group",
    entityId: id,
    imageId: "",
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 1000,
    centroidWorld: [0, 0, 0],
    targetLevel: 0,
    coarseLevel: 0,
    importance,
    layoutPositionVox: [x, 0],
    levels: [LEVEL],
  };
}

function tile(id: string, parentId: string, x: number, importance = 0.5): TileSnapshot {
  return {
    kind: "Tile",
    entityId: id,
    imageId: `img-${id}`,
    parentId,
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 1000,
    centroidWorld: [0, 0, 0],
    targetLevel: 0,
    coarseLevel: 0,
    importance,
    layoutPositionVox: [x, 0],
    levels: [LEVEL],
  };
}

function snapshot(entities: EntitySnapshot[], catalog: AssetCatalogSnapshot): PlanningSnapshot {
  return {
    datasetId: "ds-a",
    epochs: EPOCHS,
    entities,
    visibleRegion: {
      xyBoundsVox: [-64, -64, 64, 64],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: [0, 0, 0],
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
    assetCatalog: catalog,
    minimapPending: new Map(),
  };
}

function catalog(entries: Array<[string, ProxyKind, number]>): AssetCatalogSnapshot {
  const byEntity: AssetCatalogSnapshot["byEntity"] = new Map();
  for (const [entityId, kind, bytes] of entries) {
    let entry = byEntity.get(entityId);
    if (!entry) {
      entry = { kinds: new Set(), footprints: new Map() };
      byEntity.set(entityId, entry);
    }
    entry.kinds.add(kind);
    const footprint: ProxyFootprint = { kind, dims: [1, 1, 1], bytes };
    entry.footprints.set(kind, footprint);
  }
  return { byEntity };
}

function tileEntry(entityId: string): ActiveSetEntry {
  return {
    kind: "tile",
    entityId,
    imageId: `img-${entityId}`,
    mode: "tiles-with-detail",
    detailLevels: [0],
    coarseLevel: null,
    proxyAvailable: true,
    proxyKind: "TileProxy3D",
    groupProxyAvailable: false,
  };
}

function groupEntry(entityId: string): ActiveSetEntry {
  return {
    kind: "group-as-proxy",
    entityId,
  };
}

function proxy(
  entityId: string,
  kind: ProxyKind,
  c = 0,
  datasetId = "ds-a",
): ProxyRequest {
  return {
    datasetId,
    entityId,
    imageId: kind === "TileProxy3D" ? `img-${entityId}` : "",
    kind,
    t: 0,
    c,
    priority: DEFAULT_PLANNING_CONFIG.proxyLaneOffset,
  };
}

describe("planProxyResidency", () => {
  it("admits or skips tile bundles atomically at whole-group granularity", () => {
    const f1 = tile("tile-1", "group-A", 0);
    const f2 = tile("tile-2", "group-A", 8);
    const reqs = [proxy("tile-1", "TileProxy3D"), proxy("tile-2", "TileProxy3D")];
    const result = planProxyResidency({
      snapshot: snapshot(
        [group("group-A", 0), f1, f2],
        catalog([
          ["tile-1", "TileProxy3D", 10],
          ["tile-2", "TileProxy3D", 10],
        ]),
      ),
      activeSet: [tileEntry("tile-1"), tileEntry("tile-2")],
      proxyRequests: reqs,
      config: mergeConfig({ proxyResidencyBudgetBytes: 15 }),
    });

    expect(result.desiredProxyKeys.size).toBe(0);
    expect(result.skippedProxyRequests).toHaveLength(2);
    expect(result.decisions[0]).toMatchObject({ groupId: "group-A", reason: "over-budget" });
  });

  it("falls back to a group bundle when the tile bundle does not fit", () => {
    const f1 = tile("tile-1", "group-A", 0);
    const f2 = tile("tile-2", "group-A", 8);
    const tileReqs = [proxy("tile-1", "TileProxy3D"), proxy("tile-2", "TileProxy3D")];
    const groupReq = proxy("group-A", "GroupProxy3D");
    const result = planProxyResidency({
      snapshot: snapshot(
        [group("group-A", 0), f1, f2],
        catalog([
          ["tile-1", "TileProxy3D", 20],
          ["tile-2", "TileProxy3D", 20],
          ["group-A", "GroupProxy3D", 10],
        ]),
      ),
      activeSet: [tileEntry("tile-1"), tileEntry("tile-2")],
      proxyRequests: [...tileReqs, groupReq],
      config: mergeConfig({ proxyResidencyBudgetBytes: 30 }),
    });

    expect(result.desiredProxyKeys).toEqual(new Set([proxyRequestKey(groupReq)]));
    expect(result.admittedProxyRequests).toEqual([groupReq]);
    expect(result.decisions.map((d) => d.reason)).toEqual(["over-budget", "admitted"]);
  });

  it("prioritizes nearby high-importance tile bundles before far group bundles", () => {
    const near = tile("near-tile", "near-group", 0, 1);
    const farGroup = group("far-group", 500, 0);
    const nearReq = proxy("near-tile", "TileProxy3D");
    const farReq = proxy("far-group", "GroupProxy3D");
    const result = planProxyResidency({
      snapshot: snapshot(
        [group("near-group", 0), near, farGroup],
        catalog([
          ["near-tile", "TileProxy3D", 20],
          ["far-group", "GroupProxy3D", 10],
        ]),
      ),
      activeSet: [tileEntry("near-tile"), groupEntry("far-group")],
      proxyRequests: [farReq, nearReq],
      config: mergeConfig({ proxyResidencyBudgetBytes: 20 }),
    });

    expect(result.desiredProxyKeys).toEqual(new Set([proxyRequestKey(nearReq)]));
    expect(result.skippedProxyRequests).toEqual([farReq]);
  });

  it("accounts for every channel in a bundle before admitting it", () => {
    const f1 = tile("tile-1", "group-A", 0);
    const c0 = proxy("tile-1", "TileProxy3D", 0);
    const c1 = proxy("tile-1", "TileProxy3D", 1);
    const result = planProxyResidency({
      snapshot: snapshot(
        [group("group-A", 0), f1],
        catalog([["tile-1", "TileProxy3D", 10]]),
      ),
      activeSet: [tileEntry("tile-1")],
      proxyRequests: [c0, c1],
      config: mergeConfig({ proxyResidencyBudgetBytes: 15 }),
    });

    expect(result.desiredProxyKeys.size).toBe(0);
    expect(result.skippedProxyRequests).toEqual([c0, c1]);
    expect(result.decisions[0].bytes).toBe(20);
  });

  it("uses deterministic tie-breaking under a worker-global budget", () => {
    const reqA = proxy("group-A", "GroupProxy3D", 0, "ds-a");
    const reqB = proxy("group-B", "GroupProxy3D", 0, "ds-b");
    const result = planProxyResidency({
      snapshot: {
        ...snapshot(
          [group("group-A", 0), group("group-B", 0)],
          catalog([
            ["group-A", "GroupProxy3D", 10],
            ["group-B", "GroupProxy3D", 10],
          ]),
        ),
        datasetId: "mixed",
      },
      activeSet: [groupEntry("group-A"), groupEntry("group-B")],
      proxyRequests: [reqB, reqA],
      config: mergeConfig({ proxyResidencyBudgetBytes: 10 }),
    });

    expect(result.desiredProxyKeys).toEqual(new Set([proxyRequestKey(reqA)]));
    expect(result.stats.admittedBytes).toBe(10);
    expect(result.stats.skippedProxyCount).toBe(1);
  });
});
