import { describe, expect, it } from "vitest";

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { AssetCatalogSnapshot, ProxyFootprint } from "../assetCatalog.ts";
import type { SceneEpochs } from "../epochs.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  FieldSnapshot,
  PlanningSnapshot,
  ProxyKind,
  ProxyRequest,
  WellSnapshot,
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

function well(id: string, x: number, importance = 0.5): WellSnapshot {
  return {
    kind: "Well",
    entityId: id,
    imageId: "",
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 1000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    detailLevel: 0,
    coarseLevel: 0,
    importance,
    layoutPositionVox: [x, 0],
    levels: [LEVEL],
  };
}

function field(id: string, parentId: string, x: number, importance = 0.5): FieldSnapshot {
  return {
    kind: "Field",
    entityId: id,
    imageId: `img-${id}`,
    parentId,
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 1000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    detailLevel: 0,
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

function fieldEntry(entityId: string): ActiveSetEntry {
  return {
    kind: "field",
    entityId,
    imageId: `img-${entityId}`,
    mode: "fields-with-detail",
    targetLod: 0,
    coarsestDetailLod: 0,
    detailOwnedLodRange: [0, 0],
    proxyAvailable: true,
    proxyKind: "FieldProxy3D",
    wellProxyAvailable: false,
  };
}

function wellEntry(entityId: string): ActiveSetEntry {
  return {
    kind: "well-as-proxy",
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
    imageId: kind === "FieldProxy3D" ? `img-${entityId}` : "",
    kind,
    t: 0,
    c,
    priority: DEFAULT_PLANNING_CONFIG.proxyLaneOffset,
  };
}

describe("planProxyResidency", () => {
  it("admits or skips field bundles atomically at whole-well granularity", () => {
    const f1 = field("field-1", "well-A", 0);
    const f2 = field("field-2", "well-A", 8);
    const reqs = [proxy("field-1", "FieldProxy3D"), proxy("field-2", "FieldProxy3D")];
    const result = planProxyResidency({
      snapshot: snapshot(
        [well("well-A", 0), f1, f2],
        catalog([
          ["field-1", "FieldProxy3D", 10],
          ["field-2", "FieldProxy3D", 10],
        ]),
      ),
      activeSet: [fieldEntry("field-1"), fieldEntry("field-2")],
      proxyRequests: reqs,
      config: mergeConfig({ proxyResidencyBudgetBytes: 15 }),
    });

    expect(result.desiredProxyKeys.size).toBe(0);
    expect(result.skippedProxyRequests).toHaveLength(2);
    expect(result.decisions[0]).toMatchObject({ wellId: "well-A", reason: "over-budget" });
  });

  it("falls back to a well bundle when the field bundle does not fit", () => {
    const f1 = field("field-1", "well-A", 0);
    const f2 = field("field-2", "well-A", 8);
    const fieldReqs = [proxy("field-1", "FieldProxy3D"), proxy("field-2", "FieldProxy3D")];
    const wellReq = proxy("well-A", "WellProxy3D");
    const result = planProxyResidency({
      snapshot: snapshot(
        [well("well-A", 0), f1, f2],
        catalog([
          ["field-1", "FieldProxy3D", 20],
          ["field-2", "FieldProxy3D", 20],
          ["well-A", "WellProxy3D", 10],
        ]),
      ),
      activeSet: [fieldEntry("field-1"), fieldEntry("field-2")],
      proxyRequests: [...fieldReqs, wellReq],
      config: mergeConfig({ proxyResidencyBudgetBytes: 30 }),
    });

    expect(result.desiredProxyKeys).toEqual(new Set([proxyRequestKey(wellReq)]));
    expect(result.admittedProxyRequests).toEqual([wellReq]);
    expect(result.decisions.map((d) => d.reason)).toEqual(["over-budget", "admitted"]);
  });

  it("prioritizes nearby high-importance field bundles before far well bundles", () => {
    const near = field("near-field", "near-well", 0, 1);
    const farWell = well("far-well", 500, 0);
    const nearReq = proxy("near-field", "FieldProxy3D");
    const farReq = proxy("far-well", "WellProxy3D");
    const result = planProxyResidency({
      snapshot: snapshot(
        [well("near-well", 0), near, farWell],
        catalog([
          ["near-field", "FieldProxy3D", 20],
          ["far-well", "WellProxy3D", 10],
        ]),
      ),
      activeSet: [fieldEntry("near-field"), wellEntry("far-well")],
      proxyRequests: [farReq, nearReq],
      config: mergeConfig({ proxyResidencyBudgetBytes: 20 }),
    });

    expect(result.desiredProxyKeys).toEqual(new Set([proxyRequestKey(nearReq)]));
    expect(result.skippedProxyRequests).toEqual([farReq]);
  });

  it("accounts for every channel in a bundle before admitting it", () => {
    const f1 = field("field-1", "well-A", 0);
    const c0 = proxy("field-1", "FieldProxy3D", 0);
    const c1 = proxy("field-1", "FieldProxy3D", 1);
    const result = planProxyResidency({
      snapshot: snapshot(
        [well("well-A", 0), f1],
        catalog([["field-1", "FieldProxy3D", 10]]),
      ),
      activeSet: [fieldEntry("field-1")],
      proxyRequests: [c0, c1],
      config: mergeConfig({ proxyResidencyBudgetBytes: 15 }),
    });

    expect(result.desiredProxyKeys.size).toBe(0);
    expect(result.skippedProxyRequests).toEqual([c0, c1]);
    expect(result.decisions[0].bytes).toBe(20);
  });

  it("uses deterministic tie-breaking under a worker-global budget", () => {
    const reqA = proxy("well-A", "WellProxy3D", 0, "ds-a");
    const reqB = proxy("well-B", "WellProxy3D", 0, "ds-b");
    const result = planProxyResidency({
      snapshot: {
        ...snapshot(
          [well("well-A", 0), well("well-B", 0)],
          catalog([
            ["well-A", "WellProxy3D", 10],
            ["well-B", "WellProxy3D", 10],
          ]),
        ),
        datasetId: "mixed",
      },
      activeSet: [wellEntry("well-A"), wellEntry("well-B")],
      proxyRequests: [reqB, reqA],
      config: mergeConfig({ proxyResidencyBudgetBytes: 10 }),
    });

    expect(result.desiredProxyKeys).toEqual(new Set([proxyRequestKey(reqA)]));
    expect(result.stats.admittedBytes).toBe(10);
    expect(result.stats.skippedProxyCount).toBe(1);
  });
});
