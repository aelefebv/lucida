/**
 * Suite D: member registry invariants. Locks the memberId matrix for
 * `memberIdForColdEntry` and `iterateColdMembers`, which every call site
 * routes through.
 *
 * Group-as-proxy entries have no `imageId`, so building the key from it
 * would give ":ch5", a key with no entity prefix.
 */

import { describe, it, expect } from "vitest";

import {
  iterateColdMembers,
  memberIdForColdEntry,
} from "../descriptorBuffer.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ColdStateTileEntry,
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
  opts: Partial<Omit<ColdStateTileEntry, "kind" | "mode">> & {
    entityId: string;
    imageId: string;
    mode: ColdStateActiveEntry["mode"];
  },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
    ],
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    groupProxyAvailable: opts.groupProxyAvailable ?? false,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
  if (opts.mode === "group-as-proxy") {
    return {
      ...base,
      kind: "group-as-proxy",
      mode: "group-as-proxy",
      parentGroupId: null,
    };
  }
  return {
    ...base,
    kind: "tile",
    imageId: opts.imageId,
    mode: opts.mode,
    detailLevels: opts.detailLevels ?? [0],
    coarseLevel: opts.coarseLevel ?? null,
    parentGroupId: opts.parentGroupId ?? null,
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
    wantedChunks: [],
    activeSet,
    viewMode: "slice",
    sampleFormat: "u16",
  };
}

// Construction matrix — locks the four corner cases callers must agree on
// (group-as-proxy is the easy one to get wrong).

describe("Suite D — memberIdForColdEntry matrix", () => {
  it("single-channel tile → imageId", () => {
    const e = makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail" });
    expect(memberIdForColdEntry(e, 0, false)).toBe("imgA");
  });

  it("multi-channel tile → imageId:chN", () => {
    const e = makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail" });
    expect(memberIdForColdEntry(e, 2, true)).toBe("imgA:ch2");
  });

  it("single-channel group-as-proxy → entityId (NOT empty string)", () => {
    // The helper routes on `entry.kind` and resolves to `entityId`. Building
    // the key from `entry.imageId` would give "".
    const e = makeEntry({ entityId: "groupA", imageId: "", mode: "group-as-proxy" });
    expect(memberIdForColdEntry(e, 0, false)).toBe("groupA");
    expect(memberIdForColdEntry(e, 0, false)).not.toBe("");
  });

  it("multi-channel group-as-proxy → entityId:chN (NOT ':chN')", () => {
    // `${entry.imageId}:ch${channel}` would give ":ch2", a member key with
    // no entity prefix.
    const e = makeEntry({ entityId: "groupA", imageId: "", mode: "group-as-proxy" });
    expect(memberIdForColdEntry(e, 2, true)).toBe("groupA:ch2");
    expect(memberIdForColdEntry(e, 2, true)).not.toBe(":ch2");
  });

  it("memberIdForColdEntry narrows the union via `entry.kind`", () => {
    // Both variants of the discriminated union must produce their
    // respective memberId without TypeScript or runtime needing to
    // inspect `imageId === ""`. This test asserts both arms of the
    // union round-trip through the helper correctly.
    const tile = makeEntry({ entityId: "ent-a", imageId: "img-a", mode: "tiles-with-detail" });
    const group = makeEntry({ entityId: "group-b", imageId: "", mode: "group-as-proxy" });
    expect(tile.kind).toBe("tile");
    expect(group.kind).toBe("group-as-proxy");
    expect(memberIdForColdEntry(tile, 0, false)).toBe("img-a");
    expect(memberIdForColdEntry(group, 0, false)).toBe("group-b");
    expect(memberIdForColdEntry(tile, 1, true)).toBe("img-a:ch1");
    expect(memberIdForColdEntry(group, 1, true)).toBe("group-b:ch1");
  });

  it("mixed cold state (tiles + groups, multi-channel) → canonical order", () => {
    // Canonical iteration order: activeSet outer, visibleChannels inner.
    const cold = makeCold(
      [
        makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "imgB", imageId: "imgB", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "imgC", imageId: "imgC", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "groupA", imageId: "", mode: "group-as-proxy" }),
        makeEntry({ entityId: "groupB", imageId: "", mode: "group-as-proxy" }),
      ],
      [0, 1],
    );
    const ids = Array.from(iterateColdMembers(cold)).map(x => x.memberId);
    expect(ids).toEqual([
      "imgA:ch0", "imgA:ch1",
      "imgB:ch0", "imgB:ch1",
      "imgC:ch0", "imgC:ch1",
      "groupA:ch0", "groupA:ch1",
      "groupB:ch0", "groupB:ch1",
    ]);
    // Sanity: no canonical id is a bare ":chN" or empty string.
    for (const id of ids) {
      expect(id).not.toMatch(/^:ch/);
      expect(id).not.toBe("");
    }
  });

  it("canonical iteration uses explicit multi-channel mode with one visible channel", () => {
    const cold = makeCold(
      [makeEntry({ entityId: "imgA", imageId: "imgA", mode: "tiles-with-detail" })],
      [2],
      true,
    );

    expect(Array.from(iterateColdMembers(cold)).map(x => x.memberId)).toEqual([
      "imgA:ch2",
    ]);
  });
});

// removeLayerResources cleanup contract: every memberToDataset and
// memberSourcePools entry owned by datasetId is gone afterward, and so are
// the dataset's groups in groupToTiles. Without it these maps grow for the
// worker's lifetime and a recurring memberId could collide. GPU teardown is
// in `worker/poolLifetime.test.ts`.

import { createInitialState, type RendererState } from "../worker/state.ts";
import { removeDatasetResources } from "../worker/lifecycle.ts";
import type { WorkerCtx } from "../workerContext.ts";

function removeMemberRoutingForDataset(state: RendererState, datasetId: string): void {
  removeDatasetResources({ state } as unknown as WorkerCtx, datasetId);
}

describe("Suite D — removeLayerResources cleanup", () => {
  it("removeLayerResources clears memberToDataset / memberSourcePools entries for the dataset", () => {
    const state = createInitialState();
    // Two datasets share the worker. Seed routing for each.
    state.memberToDataset.set("imgA", "ds1");
    state.memberToDataset.set("imgB", "ds1");
    state.memberToDataset.set("imgC", "ds2");
    state.memberSourcePools.set("imgA", new Map([["detail:0", "ds1:64x64x32:detail"]]));
    state.memberSourcePools.set("imgB", new Map([["detail:0", "ds1:64x64x32:detail"]]));
    state.memberSourcePools.set("imgC", new Map([["detail:0", "ds2:64x64x32:detail"]]));
    state.currentSourcesByDataset.set("ds1", new Map());
    state.currentSourcesByDataset.set("ds2", new Map());

    removeMemberRoutingForDataset(state, "ds1");

    // ds1's entries are gone.
    expect(state.memberToDataset.has("imgA")).toBe(false);
    expect(state.memberToDataset.has("imgB")).toBe(false);
    expect(state.memberSourcePools.has("imgA")).toBe(false);
    expect(state.memberSourcePools.has("imgB")).toBe(false);
    expect(state.currentSourcesByDataset.has("ds1")).toBe(false);
    // ds2's entries are untouched.
    expect(state.memberToDataset.get("imgC")).toBe("ds2");
    expect(state.memberSourcePools.get("imgC")?.get("detail:0")).toBe("ds2:64x64x32:detail");
    expect(state.currentSourcesByDataset.has("ds2")).toBe(true);
  });

  it("removeLayerResources clears group→tiles entries owned by the dataset", () => {
    const state = createInitialState();
    // Seed two groups across two datasets.
    state.groupToTiles.set("groupA", new Set(["tileA1", "tileA2"]));
    state.groupToTiles.set("groupB", new Set(["tileB1"]));
    state.groupsByDataset.set("ds1", new Set(["groupA"]));
    state.groupsByDataset.set("ds2", new Set(["groupB"]));

    removeMemberRoutingForDataset(state, "ds1");

    // ds1's group is gone; ds2's group remains.
    expect(state.groupToTiles.has("groupA")).toBe(false);
    expect(state.groupToTiles.has("groupB")).toBe(true);
    expect(state.groupsByDataset.has("ds1")).toBe(false);
    expect(state.groupsByDataset.has("ds2")).toBe(true);
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
