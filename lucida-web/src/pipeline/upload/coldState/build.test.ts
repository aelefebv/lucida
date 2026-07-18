import { describe, expect, it } from "vitest";
import type { DatasetSettings } from "../../../tickCommon.ts";
import type { SceneEpochs } from "../../epochs.ts";
import {
  createSyntheticEntity,
  type ActiveSetEntry,
  type EntitySnapshot,
  type SelectionState,
} from "../../planning/index.ts";
import type { VisibleRegion } from "../../viewport.ts";
import {
  activeEntryReuseKey,
  buildColdActiveEntry,
  buildColdState,
  buildColdStateDelta,
  computeActiveSetIndexMap,
  iterateActiveSetMembers,
} from "./build.ts";

const epochs: SceneEpochs = {
  content: 1,
  layout: 2,
  view: 3,
  selection: 4,
  request: 5,
};

const visibleRegion: VisibleRegion = {
  xyBoundsVox: [0, 0, 100, 100],
  zRangeVox: [0, 2],
  effectiveZoom: 1,
  sortCenterVox: null,
  frustumPlanes: null,
};

function entity(entityId = "entity-a", imageId = "image-a"): EntitySnapshot {
  return createSyntheticEntity({
    kind: "Image",
    entityId,
    imageId,
    layoutPositionVox: [12, 34],
    detailLevel: 0,
    coarseLevel: 1,
    levels: [
      {
        level_index: 0,
        shape: [2, 2, 2, 4, 8],
        chunk_shape: [1, 1, 1, 2, 4],
        grid_shape: [2, 2, 2, 2, 2],
        scale: [1, 1, 1, 1, 1],
      },
      {
        level_index: 1,
        shape: [2, 2, 1, 2, 4],
        chunk_shape: [1, 1, 1, 2, 4],
        grid_shape: [2, 2, 1, 1, 1],
        scale: [1, 1, 2, 2, 2],
      },
    ],
  });
}

function tile(entityId = "entity-a", imageId = "image-a"): ActiveSetEntry {
  return {
    kind: "tile",
    entityId,
    imageId,
    mode: "tiles-with-detail",
    targetLod: 0,
    coarsestDetailLod: 1,
    detailOwnedLodRange: [0, 1],
    detailLevel: 0,
    coarseLevel: 1,
    wantedLodLevels: [0, 1],
  };
}

function selection(overrides: Partial<SelectionState> = {}): SelectionState {
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

function settings(): DatasetSettings {
  return {
    visible: true,
    opacity: 0.75,
    contrast_min: 10,
    contrast_max: 100,
    gamma: 1.2,
    blend_mode: "alpha",
    channel_settings: [],
    channel_blend_mode: "additive",
  };
}

function matrices(entityId = "entity-a") {
  const model = new Float32Array(16);
  const inv = new Float32Array(16);
  model[0] = model[5] = model[10] = model[15] = 2;
  inv[0] = inv[5] = inv[10] = inv[15] = 0.5;
  return new Map([[entityId, { model, inv }]]);
}

describe("buildColdActiveEntry", () => {
  it("translates one planner entry into the worker chunk contract", () => {
    const source = entity();
    const result = buildColdActiveEntry(
      tile(),
      new Map([[source.imageId, source]]),
      matrices(),
      {},
    );

    expect(result).toMatchObject({
      kind: "tile",
      entityId: "entity-a",
      imageId: "image-a",
      layoutPositionVox: [12, 34],
      targetLod: 0,
      detailOwnedLodRange: [0, 1],
      detailLevel: 0,
      coarseLevel: 1,
      wantedLodLevels: [0, 1],
    });
    expect(result.levels).toEqual([
      { level: 0, chunkShape: [1, 2, 4], gridShape: [2, 2, 2], levelDims: [2, 4, 8] },
      { level: 1, chunkShape: [1, 2, 4], gridShape: [1, 1, 1], levelDims: [1, 2, 4] },
    ]);
    expect(result.modelMatrix[0]).toBe(2);
    expect(result.invModelMatrix[0]).toBe(0.5);
  });

  it("normalizes an invisible planner entry to a non-rendering coarsest chunk entry", () => {
    const source = entity();
    const result = buildColdActiveEntry(
      { kind: "invisible", entityId: source.entityId, imageId: source.imageId, coarsestLod: 1 },
      new Map([[source.imageId, source]]),
      new Map(),
      {},
    );

    expect(result).toMatchObject({
      kind: "tile",
      imageId: "image-a",
      targetLod: 1,
      detailOwnedLodRange: [1, 1],
      detailLevel: 1,
      coarseLevel: null,
      wantedLodLevels: [1],
    });
    expect(result.modelMatrix[0]).toBe(1);
    expect(result.invModelMatrix[15]).toBe(1);
  });
});

describe("buildColdState", () => {
  it("builds the complete worker message from one coherent input", () => {
    const msg = buildColdState({
      datasetId: "ds-1",
      activeSet: [tile()],
      entities: [entity()],
      selection: selection({ t: 7, z: 1, renderMode: "volume" }),
      multiChannel: false,
      visibleRegion,
      renderRadiusView: { detail: 1, coarse: 2 },
      epochs,
      matricesByEntity: matrices(),
      dsSettings: settings(),
    });

    expect(msg).toMatchObject({
      type: "coldState",
      datasetId: "ds-1",
      currentT: 7,
      currentZ: 1,
      multiChannel: false,
      visibleChannels: [0],
      viewMode: "volume",
      renderRadiusView: { detail: 1, coarse: 2 },
    });
    expect(msg.epochs).toBe(epochs);
    expect(msg.visibleRegion).toBe(visibleRegion);
    expect(msg.activeSet).toHaveLength(1);
    expect(msg.activeSet[0].displayStateByChannel[0]).toMatchObject({
      contrastMin: 10,
      contrastMax: 100,
      gamma: 1.2,
      opacity: 0.75,
    });
  });

  it("keeps independent datasets and accepts an empty active set", () => {
    const common = {
      activeSet: [] as ActiveSetEntry[],
      entities: [] as EntitySnapshot[],
      selection: selection(),
      multiChannel: false,
      visibleRegion,
      epochs,
      matricesByEntity: new Map<string, { model: Float32Array; inv: Float32Array }>(),
      dsSettings: undefined,
    };
    const a = buildColdState({ ...common, datasetId: "a" });
    const b = buildColdState({ ...common, datasetId: "b" });
    expect(a.activeSet).toEqual([]);
    expect(a.datasetId).toBe("a");
    expect(b.datasetId).toBe("b");
    expect(a).not.toBe(b);
  });

  it("preserves two images with one owner and uses each image's own geometry and layout", () => {
    const owner = "shared-owner";
    const imageA = entity(owner, "image-a");
    const imageBBase = entity(owner, "image-b");
    const imageB: EntitySnapshot = {
      ...imageBBase,
      layoutPositionVox: [90, 80],
      levels: imageBBase.levels.map((level, index) => ({
        ...level,
        shape: index === 0 ? [2, 2, 4, 20, 40] : [2, 2, 2, 10, 20],
      })),
    };

    const msg = buildColdState({
      datasetId: "ds-shared",
      activeSet: [tile(owner, imageA.imageId), tile(owner, imageB.imageId)],
      entities: [imageA, imageB],
      selection: selection(),
      multiChannel: false,
      visibleRegion,
      epochs,
      matricesByEntity: matrices(owner),
      dsSettings: undefined,
    });

    expect(msg.activeSet.map((entry) => entry.imageId)).toEqual(["image-a", "image-b"]);
    expect(msg.activeSet[0].layoutPositionVox).toEqual([12, 34]);
    expect(msg.activeSet[1].layoutPositionVox).toEqual([90, 80]);
    expect(msg.activeSet[0].levels[0].levelDims).toEqual([2, 4, 8]);
    expect(msg.activeSet[1].levels[0].levelDims).toEqual([4, 20, 40]);
  });
});

describe("cold-state member identity", () => {
  it("uses image ids and explicit channel suffixes", () => {
    expect([...iterateActiveSetMembers([tile()], [0, 2], true)])
      .toEqual(["image-a:ch0", "image-a:ch2"]);
    expect([...iterateActiveSetMembers([tile()], [2], false)])
      .toEqual(["image-a"]);
  });

  it("produces a dense first-seen index map", () => {
    const entries = [tile("a", "shared"), tile("b", "shared")];
    expect([...computeActiveSetIndexMap(entries, [0], false)]).toEqual([["shared", 0]]);
  });
});

describe("cold-state delta", () => {
  it("reuses byte-equivalent entries and upserts descriptor-affecting changes", () => {
    const previous = tile();
    const unchanged = { ...tile() };
    expect(activeEntryReuseKey(previous)).toBe(activeEntryReuseKey(unchanged));

    const changed = { ...tile(), detailLevel: 1, targetLod: 1, wantedLodLevels: [1] };
    const delta = buildColdStateDelta({
      datasetId: "ds-1",
      activeSet: [changed],
      previousActiveSet: [previous],
      entities: [entity()],
      selection: selection(),
      visibleRegion,
      epochs,
      matricesByEntity: matrices(),
      dsSettings: settings(),
    });

    expect(activeEntryReuseKey(changed)).not.toBe(activeEntryReuseKey(previous));
    expect(delta.upserts).toHaveLength(1);
    expect(delta.activeSetOrder).toEqual(["image-a"]);
    expect(delta.removedImageIds).toEqual([]);
  });

  it("reports removed entities and retains unchanged entries", () => {
    const retained = tile("retained", "retained-image");
    const removed = tile("removed", "removed-image");
    const delta = buildColdStateDelta({
      datasetId: "ds-1",
      activeSet: [retained],
      previousActiveSet: [retained, removed],
      entities: [entity("retained", "retained-image")],
      selection: selection(),
      visibleRegion,
      epochs,
      matricesByEntity: matrices("retained"),
      dsSettings: undefined,
    });

    expect(delta.upserts).toEqual([]);
    expect(delta.removedImageIds).toEqual(["removed-image"]);
    expect(delta.activeSetOrder).toEqual(["retained-image"]);
  });

  it("uses producer entity deltas without rebuilding a full order", () => {
    const changed = { ...tile("retained", "retained-image"), targetLod: 1 };
    const entered = tile("entered", "entered-image");
    const delta = buildColdStateDelta({
      datasetId: "ds-1",
      activeSet: [changed, entered],
      previousActiveSet: [tile("retained", "retained-image"), tile("left", "left-image")],
      entities: [entity("retained", "retained-image"), entity("entered", "entered-image")],
      selection: selection(),
      visibleRegion,
      epochs,
      matricesByEntity: new Map([
        ...matrices("retained"),
        ...matrices("entered"),
      ]),
      dsSettings: undefined,
      entityDeltaHint: {
        upsertEntries: [changed, entered],
        upsertEntities: [
          entity("retained", "retained-image"),
          entity("entered", "entered-image"),
        ],
        removedImageIds: ["left-image"],
        appendedImageIds: ["entered-image"],
      },
    });

    expect(delta.upserts.map((entry) => entry.entityId)).toEqual(["retained", "entered"]);
    expect(delta.removedImageIds).toEqual(["left-image"]);
    expect(delta.appendedImageIds).toEqual(["entered-image"]);
    expect(delta.activeSetOrder).toBeUndefined();
  });

  it("diffs same-owner images independently by image identity", () => {
    const owner = "shared-owner";
    const imageA = tile(owner, "image-a");
    const imageB = tile(owner, "image-b");
    const changedB = { ...imageB, targetLod: 1, detailLevel: 1, wantedLodLevels: [1] };

    const delta = buildColdStateDelta({
      datasetId: "ds-shared",
      activeSet: [changedB],
      previousActiveSet: [imageA, imageB],
      entities: [entity(owner, "image-b")],
      selection: selection(),
      visibleRegion,
      epochs,
      matricesByEntity: matrices(owner),
      dsSettings: undefined,
    });

    expect(delta.removedImageIds).toEqual(["image-a"]);
    expect(delta.activeSetOrder).toEqual(["image-b"]);
    expect(delta.upserts).toHaveLength(1);
    expect(delta.upserts[0]).toMatchObject({
      entityId: owner,
      imageId: "image-b",
      targetLod: 1,
    });
  });

  it("builds same-owner delta upserts from each image's own pyramid and layout", () => {
    const owner = "shared-owner";
    const previousA = tile(owner, "image-a");
    const previousB = tile(owner, "image-b");
    const changedA = { ...previousA, targetLod: 1, detailLevel: 1, wantedLodLevels: [1] };
    const changedB = { ...previousB, targetLod: 1, detailLevel: 1, wantedLodLevels: [1] };
    const entityA = entity(owner, "image-a");
    const entityBBase = entity(owner, "image-b");
    const entityB: EntitySnapshot = {
      ...entityBBase,
      layoutPositionVox: [90, 80],
      levels: entityBBase.levels.map((level, index) => ({
        ...level,
        shape: index === 0 ? [2, 2, 4, 20, 40] : [2, 2, 2, 10, 20],
      })),
    };

    const delta = buildColdStateDelta({
      datasetId: "ds-shared",
      activeSet: [changedA, changedB],
      previousActiveSet: [previousA, previousB],
      entities: [entityA, entityB],
      selection: selection(),
      visibleRegion,
      epochs,
      matricesByEntity: matrices(owner),
      dsSettings: undefined,
    });

    expect(delta.activeSetOrder).toEqual(["image-a", "image-b"]);
    expect(delta.upserts.map((entry) => entry.imageId)).toEqual(["image-a", "image-b"]);
    expect(delta.upserts[0].layoutPositionVox).toEqual([12, 34]);
    expect(delta.upserts[1].layoutPositionVox).toEqual([90, 80]);
    expect(delta.upserts[0].levels[0].levelDims).toEqual([2, 4, 8]);
    expect(delta.upserts[1].levels[0].levelDims).toEqual([4, 20, 40]);
  });
});
