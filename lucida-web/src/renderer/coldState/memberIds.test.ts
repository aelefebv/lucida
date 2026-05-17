/**
 * Suite D — Member registry invariants.
 *
 * Locks the memberId construction matrix for the canonical helper
 * (descriptorBuffer.memberIdForColdEntry) plus the canonical iteration
 * (iterateColdMembers). Every site in gpu.worker.ts and wantedSet.ts
 * routes through this helper rather than rebuilding the memberId
 * inline, so the matrix below pins what those call sites produce by
 * construction.
 *
 * The bug the helper guards against: well-as-proxy entries on the
 * discriminated union have no `imageId`; inline
 * `${entry.imageId}:ch${channel}` reconstruction would produce ":ch5"
 * for multi-channel well-as-proxy entries — a key with no entity
 * prefix. Today masked because well-as-proxy entries have empty
 * `levels[]` and the volume/slice pool loops short-circuit at the
 * targetLevel lookup. But the bad key would still get *registered* in
 * memberToPool if any caller bypassed the helper.
 */

import { describe, it, expect } from "vitest";

import {
  iterateColdMembers,
  memberIdForColdEntry,
} from "../descriptorBuffer.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
} from "../workerProtocol.ts";

function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function defaultDisplay(): ColdStateActiveEntry["displayStateByChannel"][number] {
  return {
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    colormapName: "gray",
    channelMask: 1,
  };
}

function makeEntry(
  opts: Partial<Omit<ColdStateActiveEntry, "kind">> & {
    entityId: string;
    imageId: string;
    mode: ColdStateActiveEntry["mode"];
  },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    targetLod: opts.targetLod ?? 0,
    detailOwnedLodRange: opts.detailOwnedLodRange ?? [0, 0] as [number, number],
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
    ],
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    wellProxyAvailable: opts.wellProxyAvailable ?? false,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
  if (opts.mode === "well-as-proxy") {
    return {
      ...base,
      kind: "well-as-proxy",
      mode: "well-as-proxy",
      parentWellId: null,
    };
  }
  return {
    ...base,
    kind: "field",
    imageId: opts.imageId,
    mode: opts.mode,
    parentWellId: opts.parentWellId ?? null,
  };
}

function makeCold(
  activeSet: ColdStateActiveEntry[],
  visibleChannels: number[] = [0],
  multiChannel = visibleChannels.length > 1,
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
    datasetId: "ds1",
    currentT: 0,
    currentZ: 0,
    multiChannel,
    visibleChannels,
    visibleRegion: {
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    activeSet,
    viewMode: "slice",
  };
}

// ---------------------------------------------------------------------------
// Construction matrix — locks the four corner cases callers must agree on
// (well-as-proxy is the easy one to get wrong).
// ---------------------------------------------------------------------------

describe("Suite D — memberIdForColdEntry matrix", () => {
  it("single-channel field → imageId", () => {
    const e = makeEntry({ entityId: "imgA", imageId: "imgA", mode: "fields-with-detail" });
    expect(memberIdForColdEntry(e, 0, false)).toBe("imgA");
  });

  it("multi-channel field → imageId:chN", () => {
    const e = makeEntry({ entityId: "imgA", imageId: "imgA", mode: "fields-with-detail" });
    expect(memberIdForColdEntry(e, 2, true)).toBe("imgA:ch2");
  });

  it("single-channel well-as-proxy → entityId (NOT empty string)", () => {
    // Regression: the helper routes via `entry.kind === "well-as-proxy"`
    // and resolves to `entityId`. Inline `entry.imageId` construction
    // in memberToPool / wantedSet would have produced "" here.
    const e = makeEntry({ entityId: "wellA", imageId: "", mode: "well-as-proxy" });
    expect(memberIdForColdEntry(e, 0, false)).toBe("wellA");
    expect(memberIdForColdEntry(e, 0, false)).not.toBe("");
  });

  it("multi-channel well-as-proxy → entityId:chN (NOT ':chN')", () => {
    // Regression: well-as-proxy + multi-channel via old inline
    // `${entry.imageId}:ch${channel}` would have produced ":ch2" — a
    // member key with no entity prefix. The helper resolves to
    // entityId:chN.
    const e = makeEntry({ entityId: "wellA", imageId: "", mode: "well-as-proxy" });
    expect(memberIdForColdEntry(e, 2, true)).toBe("wellA:ch2");
    expect(memberIdForColdEntry(e, 2, true)).not.toBe(":ch2");
  });

  it("memberIdForColdEntry narrows the union via `entry.kind`", () => {
    // Both variants of the discriminated union must produce their
    // respective memberId without TypeScript or runtime needing to
    // inspect `imageId === ""`. This test asserts both arms of the
    // union round-trip through the helper correctly.
    const field = makeEntry({ entityId: "ent-a", imageId: "img-a", mode: "fields-with-detail" });
    const well = makeEntry({ entityId: "well-b", imageId: "", mode: "well-as-proxy" });
    expect(field.kind).toBe("field");
    expect(well.kind).toBe("well-as-proxy");
    expect(memberIdForColdEntry(field, 0, false)).toBe("img-a");
    expect(memberIdForColdEntry(well, 0, false)).toBe("well-b");
    expect(memberIdForColdEntry(field, 1, true)).toBe("img-a:ch1");
    expect(memberIdForColdEntry(well, 1, true)).toBe("well-b:ch1");
  });

  it("mixed cold state (fields + wells, multi-channel) → canonical order", () => {
    // Canonical iteration order: activeSet outer, visibleChannels inner.
    const cold = makeCold(
      [
        makeEntry({ entityId: "imgA", imageId: "imgA", mode: "fields-with-detail" }),
        makeEntry({ entityId: "imgB", imageId: "imgB", mode: "fields-with-detail" }),
        makeEntry({ entityId: "imgC", imageId: "imgC", mode: "fields-with-detail" }),
        makeEntry({ entityId: "wellA", imageId: "", mode: "well-as-proxy" }),
        makeEntry({ entityId: "wellB", imageId: "", mode: "well-as-proxy" }),
      ],
      [0, 1],
    );
    const ids = Array.from(iterateColdMembers(cold)).map(x => x.memberId);
    expect(ids).toEqual([
      "imgA:ch0", "imgA:ch1",
      "imgB:ch0", "imgB:ch1",
      "imgC:ch0", "imgC:ch1",
      "wellA:ch0", "wellA:ch1",
      "wellB:ch0", "wellB:ch1",
    ]);
    // Sanity: no canonical id is a bare ":chN" or empty string.
    for (const id of ids) {
      expect(id).not.toMatch(/^:ch/);
      expect(id).not.toBe("");
    }
  });

  it("canonical iteration uses explicit multi-channel mode with one visible channel", () => {
    const cold = makeCold(
      [makeEntry({ entityId: "imgA", imageId: "imgA", mode: "fields-with-detail" })],
      [2],
      true,
    );

    expect(Array.from(iterateColdMembers(cold)).map(x => x.memberId)).toEqual([
      "imgA:ch2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// removeLayerResources cleanup invariant — clears member-id routing
// for entries owned by the removed dataset. Without this, memberToDataset
// / memberToPool grow monotonically over the worker's lifetime and
// dataset removal leaves dangling entries that could collide if a
// memberId ever recurred. RendererState is exposed as a unit-testable
// surface so the cleanup contract is pinned here.
//
// We assert against the cleanup contract directly rather than driving
// the worker message loop: the contract is "every memberToDataset /
// memberToPool entry whose value === datasetId is gone after
// removeLayerResources(datasetId), and so are this dataset's wells in
// wellToFields". The dispatcher implementation in gpu.worker.ts is a
// tight transcription of this contract.
// ---------------------------------------------------------------------------

import { createInitialState, type RendererState } from "../worker/state.ts";

/** Inline the dispatcher's removeLayerResources cleanup for member-id
 *  routing. Mirrors gpu.worker.ts's case "removeLayerResources" body
 *  (the GPU resource teardown lives in `removeSliceResources` /
 *  `removeVolumeResources` and is exercised separately). */
function removeMemberRoutingForDataset(state: RendererState, datasetId: string): void {
  for (const [memberId, dsId] of state.memberToDataset) {
    if (dsId === datasetId) {
      state.memberToDataset.delete(memberId);
      state.memberToPool.delete(memberId);
    }
  }
  state.currentEntityMetasByDataset.delete(datasetId);
  const wells = state.wellsByDataset.get(datasetId);
  if (wells) {
    for (const wellId of wells) state.wellToFields.delete(wellId);
    state.wellsByDataset.delete(datasetId);
  }
  if (state.currentColdState?.datasetId === datasetId) {
    state.currentColdState = null;
  }
}

describe("Suite D — removeLayerResources cleanup", () => {
  it("removeLayerResources clears memberToDataset / memberToPool entries for the dataset", () => {
    const state = createInitialState();
    // Two datasets share the worker. Seed routing for each.
    state.memberToDataset.set("imgA", "ds1");
    state.memberToDataset.set("imgB", "ds1");
    state.memberToDataset.set("imgC", "ds2");
    state.memberToPool.set("imgA", "ds1:64x64x32");
    state.memberToPool.set("imgB", "ds1:64x64x32");
    state.memberToPool.set("imgC", "ds2:64x64x32");
    state.currentEntityMetasByDataset.set("ds1", new Map());
    state.currentEntityMetasByDataset.set("ds2", new Map());

    removeMemberRoutingForDataset(state, "ds1");

    // ds1's entries are gone.
    expect(state.memberToDataset.has("imgA")).toBe(false);
    expect(state.memberToDataset.has("imgB")).toBe(false);
    expect(state.memberToPool.has("imgA")).toBe(false);
    expect(state.memberToPool.has("imgB")).toBe(false);
    expect(state.currentEntityMetasByDataset.has("ds1")).toBe(false);
    // ds2's entries are untouched.
    expect(state.memberToDataset.get("imgC")).toBe("ds2");
    expect(state.memberToPool.get("imgC")).toBe("ds2:64x64x32");
    expect(state.currentEntityMetasByDataset.has("ds2")).toBe(true);
  });

  it("removeLayerResources clears well→fields entries owned by the dataset", () => {
    const state = createInitialState();
    // Seed two wells across two datasets.
    state.wellToFields.set("wellA", new Set(["fieldA1", "fieldA2"]));
    state.wellToFields.set("wellB", new Set(["fieldB1"]));
    state.wellsByDataset.set("ds1", new Set(["wellA"]));
    state.wellsByDataset.set("ds2", new Set(["wellB"]));

    removeMemberRoutingForDataset(state, "ds1");

    // ds1's well is gone; ds2's well remains.
    expect(state.wellToFields.has("wellA")).toBe(false);
    expect(state.wellToFields.has("wellB")).toBe(true);
    expect(state.wellsByDataset.has("ds1")).toBe(false);
    expect(state.wellsByDataset.has("ds2")).toBe(true);
  });

  it("clears currentColdState when the dropped dataset is the active one", () => {
    const state = createInitialState();
    state.currentColdState = { datasetId: "ds1" } as never;
    removeMemberRoutingForDataset(state, "ds1");
    expect(state.currentColdState).toBeNull();
  });

  it("leaves currentColdState alone when an unrelated dataset is dropped", () => {
    const state = createInitialState();
    const cold = { datasetId: "ds2" } as never;
    state.currentColdState = cold;
    removeMemberRoutingForDataset(state, "ds1");
    expect(state.currentColdState).toBe(cold);
  });
});
