/**
 * Unit tests for `buildColdState` / `buildColdActiveEntry`.
 *
 * The end-to-end pure builder collapses three near-duplicate per-variant
 * literals (well-as-proxy / invisible / field) into one branching
 * function and a top-level `Array.map`. Tests cover each variant +
 * display-state fallback + empty active set + multi-dataset shape.
 */
import { describe, it, expect } from "vitest";
import { Axis } from "../../../axes.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  SelectionState,
} from "../../planning/index.ts";
import type { SceneEpochs } from "../../epochs.ts";
import type { VisibleRegion } from "../../viewport.ts";
import type { DatasetSettings } from "../../../tickCommon.ts";
import { buildColdState, buildColdActiveEntry } from "./build.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeField(
  entityId: string,
  imageId: string,
  parentId: string,
): EntitySnapshot {
  return {
    kind: "Field",
    entityId,
    imageId,
    parentId,
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    importance: 1,
    layoutPositionVox: [0, 0],
    levels: [
      // TCZYX shape: T=1 C=1 Z=2 Y=4 X=8; chunk_shape Z=1 Y=2 X=4.
      // Axis.Z=2 → 2; Axis.Y=3 → 4; Axis.X=4 → 8.
      {
        level_index: 0,
        shape: [1, 1, 2, 4, 8],
        chunk_shape: [1, 1, 1, 2, 4],
        grid_shape: [1, 1, 2, 2, 2],
        scale: [1, 1, 1, 1, 1],
      },
    ],
  } as unknown as EntitySnapshot;
}

function makeSelection(over: Partial<SelectionState> = {}): SelectionState {
  return {
    t: 0,
    c: 0,
    z: 0,
    visibleChannels: [0],
    renderMode: "slice",
    interactionState: "idle",
    ...over,
  };
}

function makeVisibleRegion(): VisibleRegion {
  return {
    xyBoundsVox: [0, 0, 100, 100],
    zRangeVox: [0, 10],
    effectiveZoom: 1,
    sortCenterVox: null,
    frustumPlanes: null,
  };
}

function makeEpochs(): SceneEpochs {
  return { content: 1, layout: 2, view: 3, selection: 4, asset: 5, request: 6 };
}

function makeDsSettings(over: Partial<DatasetSettings> = {}): DatasetSettings {
  return {
    visible: true,
    opacity: 1,
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    blend_mode: "alpha",
    channel_settings: [],
    channel_blend_mode: "additive",
    ...over,
  };
}

function makeMatrices(): Map<string, { model: Float32Array; inv: Float32Array }> {
  const m = new Map<string, { model: Float32Array; inv: Float32Array }>();
  return m;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("buildColdActiveEntry", () => {
  it("maps a `field` entry forwarding LOD + mode + proxy flags + parentWellId", () => {
    const entityById = new Map([["ent-a", makeField("ent-a", "img-a", "well-0")]]);
    const matricesByEntity = makeMatrices();
    const fieldEntry: ActiveSetEntry = {
      kind: "field",
      entityId: "ent-a",
      imageId: "img-a",
      mode: "fields-with-proxy-fallback",
      targetLod: 1,
      coarsestDetailLod: 3,
      detailOwnedLodRange: [1, 3],
      proxyKind: "FieldProxy3D",
      proxyAvailable: true,
      wellProxyAvailable: false,
    } as ActiveSetEntry;

    const result = buildColdActiveEntry(fieldEntry, entityById, matricesByEntity, {});

    expect(result.entityId).toBe("ent-a");
    expect(result.imageId).toBe("img-a");
    expect(result.targetLod).toBe(1);
    expect(result.detailOwnedLodRange).toEqual([1, 3]);
    expect(result.mode).toBe("fields-with-proxy-fallback");
    expect(result.proxyKind).toBe("FieldProxy3D");
    expect(result.proxyAvailable).toBe(true);
    expect(result.wellProxyAvailable).toBe(false);
    expect(result.parentWellId).toBe("well-0");
    // Levels are derived from the entity's `levels` array.
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]).toEqual({
      level: 0,
      chunkShape: [1, 2, 4],
      gridShape: [2, 2, 2],
      levelDims: [2, 4, 8],
    });
    // No matrices provided → identity fallback.
    expect(result.modelMatrix[0]).toBe(1);
    expect(result.invModelMatrix[5]).toBe(1);
  });

  it("maps a `well-as-proxy` entry to mode well-as-proxy, targetLod 0, WellProxy3D, etc.", () => {
    const matricesByEntity = new Map<string, { model: Float32Array; inv: Float32Array }>();
    const synthM = new Float32Array(16); synthM[0] = 30; synthM[5] = 30; synthM[10] = 30; synthM[15] = 1;
    const synthInv = new Float32Array(16); synthInv[0] = 1/30; synthInv[5] = 1/30; synthInv[10] = 1/30; synthInv[15] = 1;
    matricesByEntity.set("well-0", { model: synthM, inv: synthInv });

    const entry: ActiveSetEntry = { kind: "well-as-proxy", entityId: "well-0" } as ActiveSetEntry;
    const result = buildColdActiveEntry(entry, new Map(), matricesByEntity, {});

    expect(result.kind).toBe("well-as-proxy");
    expect(result.entityId).toBe("well-0");
    // The well-as-proxy variant has no `imageId` field (`?: never`).
    // Guard the assertion so the type narrows cleanly.
    if (result.kind !== "well-as-proxy") throw new Error("expected well-as-proxy");
    expect((result as unknown as Record<string, unknown>).imageId).toBeUndefined();
    expect(result.targetLod).toBe(0);
    expect(result.detailOwnedLodRange).toEqual([0, 0]);
    expect(result.mode).toBe("well-as-proxy");
    expect(result.proxyKind).toBe("WellProxy3D");
    expect(result.proxyAvailable).toBe(true);
    expect(result.wellProxyAvailable).toBe(true);
    expect(result.parentWellId).toBeNull();
    expect(result.modelMatrix[0]).toBe(30);
    expect(result.invModelMatrix[0]).toBeCloseTo(1 / 30);
  });

  it("maps an `invisible` entry to legacy fields-with-detail mode at coarsestLod", () => {
    const entityById = new Map([["ent-x", makeField("ent-x", "img-x", "well-0")]]);
    const entry: ActiveSetEntry = {
      kind: "invisible",
      entityId: "ent-x",
      imageId: "img-x",
      coarsestLod: 3,
    } as ActiveSetEntry;

    const result = buildColdActiveEntry(entry, entityById, makeMatrices(), {});

    expect(result.entityId).toBe("ent-x");
    expect(result.imageId).toBe("img-x");
    expect(result.targetLod).toBe(3);
    expect(result.detailOwnedLodRange).toEqual([3, 3]);
    expect(result.mode).toBe("fields-with-detail");
    expect(result.proxyKind).toBeUndefined();
    expect(result.proxyAvailable).toBe(false);
    expect(result.wellProxyAvailable).toBe(false);
    expect(result.parentWellId).toBe("well-0"); // Field's parent
  });
});

describe("buildColdState", () => {
  it("builds the message shape: type, epochs, datasetId, current{T,Z}, region, viewMode", () => {
    const entities = [makeField("ent-a", "img-a", "well-0")];
    const activeSet: ActiveSetEntry[] = [
      {
        kind: "field",
        entityId: "ent-a",
        imageId: "img-a",
        mode: "fields-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: false,
        wellProxyAvailable: false,
      } as ActiveSetEntry,
    ];

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection({ t: 7, z: 13, renderMode: "volume", visibleChannels: [0] }),
      multiChannel: false,
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      matricesByEntity: makeMatrices(),
      dsSettings: undefined,
    });

    expect(msg.type).toBe("coldState");
    expect(msg.datasetId).toBe("ds1");
    expect(msg.currentT).toBe(7);
    expect(msg.currentZ).toBe(13);
    expect(msg.multiChannel).toBe(false);
    expect(msg.visibleChannels).toEqual([0]);
    expect(msg.viewMode).toBe("volume");
    expect(msg.desiredProxyKeys).toEqual([]);
    expect(msg.epochs).toEqual({ content: 1, layout: 2, view: 3, selection: 4, asset: 5, request: 6 });
    expect(msg.activeSet).toHaveLength(1);
    expect(msg.activeSet[0].entityId).toBe("ent-a");
  });

  it("threads desired proxy keys into cold state in stable order", () => {
    const entities = [makeField("ent-a", "img-a", "well-0")];
    const activeSet: ActiveSetEntry[] = [
      {
        kind: "field",
        entityId: "ent-a",
        imageId: "img-a",
        mode: "fields-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: true,
        proxyKind: "FieldProxy3D",
        wellProxyAvailable: false,
      } as ActiveSetEntry,
    ];

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection(),
      multiChannel: false,
      visibleRegion: makeVisibleRegion(),
      desiredProxyKeys: new Set([
        "ds1|ent-b|FieldProxy3D|0|0",
        "ds1|ent-a|FieldProxy3D|0|0",
      ]),
      epochs: makeEpochs(),
      matricesByEntity: makeMatrices(),
      dsSettings: undefined,
    });

    expect(msg.desiredProxyKeys).toEqual([
      "ds1|ent-a|FieldProxy3D|0|0",
      "ds1|ent-b|FieldProxy3D|0|0",
    ]);
  });

  it("bakes display state per visible channel with dataset-level fallbacks", () => {
    const entities = [makeField("ent-a", "img-a", "well-0")];
    const activeSet: ActiveSetEntry[] = [
      {
        kind: "field",
        entityId: "ent-a",
        imageId: "img-a",
        mode: "fields-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: false,
        wellProxyAvailable: false,
      } as ActiveSetEntry,
    ];
    const dsSettings = makeDsSettings({
      opacity: 0.4,
      contrast_min: 50,
      contrast_max: 1000,
      gamma: 2,
      // Channel 0 has its own colormap; channel 1 falls back to defaults.
      channel_settings: [
        { visible: true, colormap: "viridis", contrast_min: 5, contrast_max: 500, gamma: 1.2 },
      ],
    });

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection({ visibleChannels: [0, 1] }),
      multiChannel: true,
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      matricesByEntity: makeMatrices(),
      dsSettings,
    });

    expect(msg.visibleChannels).toEqual([0, 1]);
    expect(msg.multiChannel).toBe(true);
    const ds0 = msg.activeSet[0].displayStateByChannel[0];
    expect(ds0.colormapName).toBe("viridis");
    expect(ds0.contrastMin).toBe(5);
    expect(ds0.contrastMax).toBe(500);
    expect(ds0.gamma).toBeCloseTo(1.2);
    expect(ds0.opacity).toBeCloseTo(0.4);

    const ds1 = msg.activeSet[0].displayStateByChannel[1];
    expect(ds1.colormapName).toBe("gray"); // default
    expect(ds1.contrastMin).toBe(50);       // dataset-level fallback
    expect(ds1.contrastMax).toBe(1000);
    expect(ds1.gamma).toBeCloseTo(2);
  });

  it("handles all three active-set variants in one tick (multi-variant)", () => {
    const entities = [
      makeField("ent-a", "img-a", "well-0"),
      makeField("ent-i", "img-i", "well-1"), // invisible owner
    ];

    const matrices = new Map<string, { model: Float32Array; inv: Float32Array }>();
    const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; // identity
    matrices.set("well-0", { model: m, inv: m });
    matrices.set("ent-a", { model: m, inv: m });

    const activeSet: ActiveSetEntry[] = [
      { kind: "well-as-proxy", entityId: "well-0" } as ActiveSetEntry,
      {
        kind: "field",
        entityId: "ent-a",
        imageId: "img-a",
        mode: "fields-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: false,
        wellProxyAvailable: false,
      } as ActiveSetEntry,
      { kind: "invisible", entityId: "ent-i", imageId: "img-i", coarsestLod: 2 } as ActiveSetEntry,
    ];

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection(),
      multiChannel: false,
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      matricesByEntity: matrices,
      dsSettings: undefined,
    });

    expect(msg.activeSet).toHaveLength(3);
    expect(msg.activeSet[0].mode).toBe("well-as-proxy");
    expect(msg.activeSet[1].mode).toBe("fields-with-detail");
    expect(msg.activeSet[2].mode).toBe("fields-with-detail"); // invisible legacy encoding
    expect(msg.activeSet[2].targetLod).toBe(2);              // invisible @ coarsestLod
  });

  it("empty active set → empty cold message activeSet", () => {
    const msg = buildColdState({
      datasetId: "ds1",
      activeSet: [],
      entities: [],
      selection: makeSelection(),
      multiChannel: false,
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      matricesByEntity: makeMatrices(),
      dsSettings: undefined,
    });

    expect(msg.type).toBe("coldState");
    expect(msg.activeSet).toEqual([]);
  });

  it("multi-dataset: two independent calls produce two distinct messages keyed by datasetId", () => {
    const sharedActive: ActiveSetEntry[] = [
      {
        kind: "field",
        entityId: "ent-a",
        imageId: "img-a",
        mode: "fields-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: false,
        wellProxyAvailable: false,
      } as ActiveSetEntry,
    ];
    const entities = [makeField("ent-a", "img-a", "well-0")];

    const msg1 = buildColdState({
      datasetId: "ds1",
      activeSet: sharedActive,
      entities,
      selection: makeSelection(),
      multiChannel: false,
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      matricesByEntity: makeMatrices(),
      dsSettings: undefined,
    });
    const msg2 = buildColdState({
      datasetId: "ds2",
      activeSet: sharedActive,
      entities,
      selection: makeSelection(),
      multiChannel: false,
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      matricesByEntity: makeMatrices(),
      dsSettings: undefined,
    });

    expect(msg1.datasetId).toBe("ds1");
    expect(msg2.datasetId).toBe("ds2");
    expect(msg1).not.toBe(msg2);
    expect(msg1.activeSet[0].entityId).toBe(msg2.activeSet[0].entityId);
    // Touch Axis to silence unused-import lint.
    expect(Axis.X).toBeGreaterThanOrEqual(0);
  });
});
