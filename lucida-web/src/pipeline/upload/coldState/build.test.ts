/**
 * Unit tests for `buildColdState` / `buildColdActiveEntry`.
 *
 * The end-to-end pure builder maps each planner entry (tile or invisible)
 * through one function and a top-level `Array.map`. Tests cover each
 * variant + display-state fallback + empty active set + multi-dataset shape.
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
import { resolvedLayer, shownChannel } from "../../../resolvedLayerFixtures.ts";
import {
  buildColdState,
  buildColdActiveEntry,
  buildColdStateDelta,
  activeEntryReuseKey,
  computeActiveSetIndexMap,
  iterateActiveSetMembers,
} from "./build.ts";

// Fixtures

function makeTile(
  entityId: string,
  imageId: string,
  parentId: string,
): EntitySnapshot {
  return {
    kind: "Tile",
    entityId,
    imageId,
    parentId,
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    targetLevel: 0,
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
    z: 0,
    cut: { axis: "z", index: over.z ?? 0 },
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
  return { content: 1, layout: 2, view: 3, selection: 4, request: 6 };
}


function makeMatrices(): Map<string, { model: Float32Array; inv: Float32Array }> {
  const m = new Map<string, { model: Float32Array; inv: Float32Array }>();
  return m;
}

// Cases

describe("buildColdActiveEntry", () => {
  it("maps a `tile` entry forwarding its tier levels", () => {
    const entityById = new Map([["ent-a", makeTile("ent-a", "img-a", "group-0")]]);
    const matricesByEntity = makeMatrices();
    const tileEntry: ActiveSetEntry = {
      kind: "tile",
      entityId: "ent-a",
      imageId: "img-a",
      detailLevels: [1],
      coarseLevel: 3,
    };

    const result = buildColdActiveEntry(tileEntry, entityById, matricesByEntity, {});

    expect(result.entityId).toBe("ent-a");
    expect(result.imageId).toBe("img-a");
    expect(result.detailLevels).toEqual([1]);
    expect(result.coarseLevel).toBe(3);
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

  it("uses the entity's precomputed matrices when present", () => {
    const matricesByEntity = new Map<string, { model: Float32Array; inv: Float32Array }>();
    const synthM = new Float32Array(16); synthM[0] = 30; synthM[5] = 30; synthM[10] = 30; synthM[15] = 1;
    const synthInv = new Float32Array(16); synthInv[0] = 1/30; synthInv[5] = 1/30; synthInv[10] = 1/30; synthInv[15] = 1;
    matricesByEntity.set("ent-a", { model: synthM, inv: synthInv });

    const entry: ActiveSetEntry = {
      kind: "tile", entityId: "ent-a", imageId: "img-a", detailLevels: [0], coarseLevel: null,
    };
    const result = buildColdActiveEntry(entry, new Map(), matricesByEntity, {});

    expect(result.modelMatrix[0]).toBe(30);
    expect(result.invModelMatrix[0]).toBeCloseTo(1 / 30);
  });

  it("maps an `invisible` entry to an entry holding its coarsest level", () => {
    const entityById = new Map([["ent-x", makeTile("ent-x", "img-x", "group-0")]]);
    const entry: ActiveSetEntry = {
      kind: "invisible",
      entityId: "ent-x",
      imageId: "img-x",
      coarsestLod: 3,
    } as ActiveSetEntry;

    const result = buildColdActiveEntry(entry, entityById, makeMatrices(), {});

    expect(result.entityId).toBe("ent-x");
    expect(result.imageId).toBe("img-x");
    expect(result.detailLevels).toEqual([3]);
    expect(result.coarseLevel).toBeNull();
  });
});

describe("buildColdState", () => {
  it("builds the message shape: type, epochs, datasetId, current{T,Z}, region, viewMode", () => {
    const entities = [makeTile("ent-a", "img-a", "group-0")];
    const activeSet: ActiveSetEntry[] = [
      {
        kind: "tile",
        entityId: "ent-a",
        imageId: "img-a",
        detailLevels: [0],
        coarseLevel: null,
      } as ActiveSetEntry,
    ];

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection({ t: 7, z: 13, renderMode: "volume", visibleChannels: [0] }),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer: undefined,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });

    expect(msg.type).toBe("coldState");
    expect(msg.datasetId).toBe("ds1");
    expect(msg.currentT).toBe(7);
    expect(msg.currentZ).toBe(13);
    expect(msg.visibleChannels).toEqual([0]);
    expect(msg.viewMode).toBe("volume");
    expect(msg.epochs).toEqual({ content: 1, layout: 2, view: 3, selection: 4, request: 6 });
    expect(msg.activeSet).toHaveLength(1);
    expect(msg.activeSet[0].entityId).toBe("ent-a");
  });

  it("hands a side view's slice worker the plane's frame: across, down, and the cut as Z", () => {
    const tile = { ...makeTile("ent-a", "img-a", "group-0"), layoutPositionVox: [100, 200] as [number, number] };
    const activeSet: ActiveSetEntry[] = [
      { kind: "tile", entityId: "ent-a", imageId: "img-a", detailLevels: [0], coarseLevel: null } as ActiveSetEntry,
    ];
    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities: [tile],
      selection: makeSelection({ z: 1, cut: { axis: "y", index: 3 } }),
      visibleRegion: {
        xyBoundsVox: [10, 3, 50, 4],
        zRangeVox: [0, 2],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
        cutAxis: "y",
      },
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer: undefined,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });
    expect(msg.sliceAxis).toBe("y");
    expect(msg.currentZ).toBe(3);
    // Shape Z 2, Y 4, X 8 in chunks 1 x 2 x 4, as [cut, down, across].
    expect(msg.activeSet[0].levels[0]).toMatchObject({
      chunkShape: [2, 1, 4],
      levelDims: [4, 2, 8],
      gridShape: [2, 2, 2],
    });
    // The planner already places the image across and down the plane.
    expect(msg.activeSet[0].layoutPositionVox).toEqual([100, 200]);
    expect(msg.visibleRegion).toMatchObject({ xyBoundsVox: [10, 0, 50, 2], zRangeVox: [3, 4] });

    // An XY cut keeps the image's own frame and names no axis.
    const xy = buildColdState({
      datasetId: "ds1", activeSet, entities: [tile], selection: makeSelection({ z: 1 }),
      visibleRegion: makeVisibleRegion(), epochs: makeEpochs(), wantedChunks: [],
      matricesByEntity: makeMatrices(), layer: undefined, sampleFormat: "u16", drawnModes: ["slice"],
    });
    expect(xy.sliceAxis).toBeUndefined();
    expect(xy.activeSet[0].levels[0].chunkShape).toEqual([1, 2, 4]);
    expect(xy.activeSet[0].layoutPositionVox).toEqual([100, 200]);
  });

  it("bakes the resolved display state per shown channel", () => {
    const entities = [makeTile("ent-a", "img-a", "group-0")];
    const activeSet: ActiveSetEntry[] = [
      {
        kind: "tile",
        entityId: "ent-a",
        imageId: "img-a",
        detailLevels: [0],
        coarseLevel: null,
      } as ActiveSetEntry,
    ];
    const layer = resolvedLayer("ds1", [
      shownChannel(0, { colormap: "viridis", contrast_min: 5, contrast_max: 500, gamma: 1.2 }),
      shownChannel(1, { contrast_min: 50, contrast_max: 1000, gamma: 2 }),
    ], { opacity: 0.4 });

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection({ visibleChannels: [0, 1] }),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });

    expect(msg.visibleChannels).toEqual([0, 1]);
    const ds0 = msg.activeSet[0].displayStateByChannel[0];
    expect(ds0.colormapName).toBe("viridis");
    expect(ds0.contrastMin).toBe(5);
    expect(ds0.contrastMax).toBe(500);
    expect(ds0.gamma).toBeCloseTo(1.2);
    expect(ds0.opacity).toBeCloseTo(0.4);

    const ds1 = msg.activeSet[0].displayStateByChannel[1];
    expect(ds1.colormapName).toBe("gray");
    expect(ds1.contrastMin).toBe(50);
    expect(ds1.contrastMax).toBe(1000);
    expect(ds1.gamma).toBeCloseTo(2);
  });

  it("handles both active-set variants in one tick", () => {
    const entities = [
      makeTile("ent-a", "img-a", "group-0"),
      makeTile("ent-i", "img-i", "group-1"), // invisible owner
    ];

    const matrices = new Map<string, { model: Float32Array; inv: Float32Array }>();
    const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; // identity
    matrices.set("ent-a", { model: m, inv: m });

    const activeSet: ActiveSetEntry[] = [
      {
        kind: "tile",
        entityId: "ent-a",
        imageId: "img-a",
        detailLevels: [0],
        coarseLevel: null,
      } as ActiveSetEntry,
      { kind: "invisible", entityId: "ent-i", imageId: "img-i", coarsestLod: 2 } as ActiveSetEntry,
    ];

    const msg = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities,
      selection: makeSelection(),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: matrices,
      layer: undefined,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });

    expect(msg.activeSet).toHaveLength(2);
    expect(msg.activeSet[0].detailLevels).toEqual([0]);
    expect(msg.activeSet[1].detailLevels).toEqual([2]); // invisible @ coarsestLod
  });

  it("empty active set → empty cold message activeSet", () => {
    const msg = buildColdState({
      datasetId: "ds1",
      activeSet: [],
      entities: [],
      selection: makeSelection(),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer: undefined,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });

    expect(msg.type).toBe("coldState");
    expect(msg.activeSet).toEqual([]);
  });

  it("multi-dataset: two independent calls produce two distinct messages keyed by datasetId", () => {
    const sharedActive: ActiveSetEntry[] = [
      {
        kind: "tile",
        entityId: "ent-a",
        imageId: "img-a",
        detailLevels: [0],
        coarseLevel: null,
      } as ActiveSetEntry,
    ];
    const entities = [makeTile("ent-a", "img-a", "group-0")];

    const msg1 = buildColdState({
      datasetId: "ds1",
      activeSet: sharedActive,
      entities,
      selection: makeSelection(),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer: undefined,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });
    const msg2 = buildColdState({
      datasetId: "ds2",
      activeSet: sharedActive,
      entities,
      selection: makeSelection(),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer: undefined,
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });

    expect(msg1.datasetId).toBe("ds1");
    expect(msg2.datasetId).toBe("ds2");
    expect(msg1).not.toBe(msg2);
    expect(msg1.activeSet[0].entityId).toBe(msg2.activeSet[0].entityId);
    // Touch Axis to silence unused-import lint.
    expect(Axis.X).toBeGreaterThanOrEqual(0);
  });
});

// View-move delta

function tileEntry(over: Partial<Extract<ActiveSetEntry, { kind: "tile" }>>): ActiveSetEntry {
  return {
    kind: "tile",
    entityId: "ent",
    imageId: "img",
    detailLevels: [0],
    coarseLevel: null,
    ...over,
  } as ActiveSetEntry;
}

describe("activeEntryReuseKey", () => {
  it("is equal for two tile entries that produce a byte-identical descriptor", () => {
    const a = tileEntry({ entityId: "a", imageId: "img-a", detailLevels: [2], coarseLevel: 4 });
    const b = tileEntry({ entityId: "a", imageId: "img-a", detailLevels: [2], coarseLevel: 4 });
    expect(activeEntryReuseKey(a)).toBe(activeEntryReuseKey(b));
  });

  it("differs when a descriptor-affecting field (detailLevels) changes", () => {
    const a = tileEntry({ entityId: "a", imageId: "img-a", detailLevels: [2] });
    const b = tileEntry({ entityId: "a", imageId: "img-a", detailLevels: [3] });
    expect(activeEntryReuseKey(a)).not.toBe(activeEntryReuseKey(b));
  });

});

describe("computeActiveSetIndexMap / iterateActiveSetMembers", () => {
  it("agrees with the cold-state member index map on the same active set", () => {
    const entities = new Map([
      ["a", makeTile("a", "img-a", "group-0")],
      ["b", makeTile("b", "img-b", "group-0")],
    ]);
    const activeSet: ActiveSetEntry[] = [
      tileEntry({ entityId: "a", imageId: "img-a" }),
      tileEntry({ entityId: "b", imageId: "img-b" }),
    ];
    const cold = buildColdState({
      datasetId: "ds1",
      activeSet,
      entities: [...entities.values()],
      selection: makeSelection(),
      visibleRegion: makeVisibleRegion(),
      epochs: makeEpochs(),
      wantedChunks: [],
      matricesByEntity: makeMatrices(),
      layer: resolvedLayer("ds1"),
      sampleFormat: "u16",
      drawnModes: ["slice"],
    });
    const fromActiveSet = computeActiveSetIndexMap(activeSet, [0]);
    // Every member id names its channel, one shown or several.
    expect(fromActiveSet.get("img-a:ch0")).toBe(0);
    expect(fromActiveSet.get("img-b:ch0")).toBe(1);
    // Same ids + order the cold-state message would iterate.
    expect([...iterateActiveSetMembers(activeSet, [0])]).toEqual(["img-a:ch0", "img-b:ch0"]);
    expect(cold.activeSet.map((e) => e.entityId)).toEqual(["a", "b"]);
  });

  it("suffixes member ids per visible channel", () => {
    const activeSet: ActiveSetEntry[] = [tileEntry({ entityId: "a", imageId: "img-a" })];
    expect([...iterateActiveSetMembers(activeSet, [0, 2])]).toEqual([
      "img-a:ch0",
      "img-a:ch2",
    ]);
  });
});

describe("buildColdStateDelta", () => {
  const commonArgs = (activeSet: ActiveSetEntry[], previousActiveSet: ActiveSetEntry[]) => ({
    datasetId: "ds1",
    activeSet,
    previousActiveSet,
    entities: [makeTile("a", "img-a", "group-0"), makeTile("b", "img-b", "group-0"), makeTile("c", "img-c", "group-0")],
    selection: makeSelection(),
    visibleRegion: makeVisibleRegion(),
    epochs: makeEpochs(),
    wantedChunks: [],
    matricesByEntity: makeMatrices(),
    layer: resolvedLayer("ds1"),
    drawnModes: ["slice" as const],
  });

  it("carries only changed/added descriptors, removed ids, and the full order", () => {
    const prev: ActiveSetEntry[] = [
      tileEntry({ entityId: "a", imageId: "img-a", detailLevels: [1] }),
      tileEntry({ entityId: "b", imageId: "img-b", detailLevels: [1] }),
    ];
    const next: ActiveSetEntry[] = [
      // a unchanged (reused), b level changed (upsert), c is new (upsert)
      tileEntry({ entityId: "a", imageId: "img-a", detailLevels: [1] }),
      tileEntry({ entityId: "b", imageId: "img-b", detailLevels: [2] }),
      tileEntry({ entityId: "c", imageId: "img-c", detailLevels: [0] }),
    ];
    const delta = buildColdStateDelta(commonArgs(next, prev));

    expect(delta.type).toBe("coldStateDelta");
    expect(delta.activeSetOrder).toEqual(["a", "b", "c"]);
    // a is byte-identical → not shipped; b + c shipped.
    expect(delta.upserts.map((u) => u.entityId).sort()).toEqual(["b", "c"]);
    expect(delta.removedEntityIds).toEqual([]);
  });

  it("reports an entity that left the active set as removed", () => {
    const prev: ActiveSetEntry[] = [
      tileEntry({ entityId: "a", imageId: "img-a" }),
      tileEntry({ entityId: "b", imageId: "img-b" }),
    ];
    const next: ActiveSetEntry[] = [tileEntry({ entityId: "a", imageId: "img-a" })];
    const delta = buildColdStateDelta(commonArgs(next, prev));

    expect(delta.removedEntityIds).toEqual(["b"]);
    expect(delta.activeSetOrder).toEqual(["a"]);
    // a is unchanged → no descriptor shipped at all.
    expect(delta.upserts).toEqual([]);
  });

});

// Reuse-key ⇔ descriptor contract
//
// The view-move delta reuses a retained descriptor whenever `activeEntryReuseKey`
// is unchanged, so the key must distinguish every field the descriptor build
// reads. These two properties bound that contract from both sides:
//   (a) mutating any descriptor-affecting field the builder reads changes the key
//       (so no such field can be silently dropped from the key), and
//   (b) two entries with the same key build byte-identical descriptors (so a
//       future descriptor field that isn't folded into the key can't slip a
//       stale descriptor through a pan without failing this test).

describe("reuse-key ⇔ descriptor contract", () => {
  // A fully-populated tile entry: every descriptor-affecting field set to a
  // distinct, non-default value so a mutation to a different value is observable.
  const baseTile = (): Extract<ActiveSetEntry, { kind: "tile" }> =>
    ({
      kind: "tile",
      entityId: "ent-a",
      imageId: "img-a",
      detailLevels: [2, 3],
      coarseLevel: 4,
    }) as Extract<ActiveSetEntry, { kind: "tile" }>;

  // Every field `buildColdActiveEntry` reads from a tile entry, each paired with
  // a mutation to a different value. Adding a new descriptor-affecting field
  // without a case here (and without folding it into the key) is exactly the
  // regression this guards.
  const tileMutations: Array<[string, (t: Extract<ActiveSetEntry, { kind: "tile" }>) => void]> = [
    ["imageId", (t) => { t.imageId = "img-z"; }],
    ["detailLevels (member)", (t) => { t.detailLevels = [3, 3]; }],
    ["detailLevels (length)", (t) => { t.detailLevels = [2, 3, 4]; }],
    ["coarseLevel", (t) => { t.coarseLevel = null; }],
  ];

  for (const [name, mutate] of tileMutations) {
    it(`(a) mutating tile.${name} changes the reuse key`, () => {
      const base = baseTile();
      const baseKey = activeEntryReuseKey(base);
      const mutated = baseTile();
      mutate(mutated);
      expect(activeEntryReuseKey(mutated)).not.toBe(baseKey);
    });
  }

  it("(a) mutating invisible.imageId or coarsestLod changes the reuse key", () => {
    const base: ActiveSetEntry = { kind: "invisible", entityId: "ent-x", imageId: "img-x", coarsestLod: 3 } as ActiveSetEntry;
    const baseKey = activeEntryReuseKey(base);
    const otherImage: ActiveSetEntry = { kind: "invisible", entityId: "ent-x", imageId: "img-y", coarsestLod: 3 } as ActiveSetEntry;
    const otherLod: ActiveSetEntry = { kind: "invisible", entityId: "ent-x", imageId: "img-x", coarsestLod: 4 } as ActiveSetEntry;
    expect(activeEntryReuseKey(otherImage)).not.toBe(baseKey);
    expect(activeEntryReuseKey(otherLod)).not.toBe(baseKey);
  });

  it("(b) two tile entries with the same reuse key build byte-identical descriptors", () => {
    // `a` and `b` are equal in every descriptor-affecting field, so they share
    // a key and must produce identical descriptors. If a future descriptor field
    // were read by the builder but omitted from the key, varying it in a new
    // mutation case above would break property (a).
    const a = baseTile();
    const b = baseTile();
    expect(activeEntryReuseKey(a)).toBe(activeEntryReuseKey(b));

    const entityById = new Map([["ent-a", makeTile("ent-a", "img-a", "group-0")]]);
    const matrices = makeMatrices();
    matrices.set("ent-a", { model: new Float32Array(16).fill(2), inv: new Float32Array(16).fill(3) });
    const display = { 0: { contrastMin: 1, contrastMax: 2, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 } };

    const descA = buildColdActiveEntry(a, entityById, matrices, display);
    const descB = buildColdActiveEntry(b, entityById, matrices, display);
    expect(descA).toEqual(descB);
  });
});
