/**
 * Suite D: member registry invariants. Locks the memberId matrix for
 * `memberIdForColdEntry` and `iterateColdMembers`, which every call site
 * routes through.
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
  opts: Partial<ColdStateActiveEntry> & { entityId: string; imageId: string },
): ColdStateActiveEntry {
  const base = {
    entityId: opts.entityId,
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
    ],
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
  return {
    ...base,
    imageId: opts.imageId,
    detailLevels: opts.detailLevels ?? [0],
    coarseLevel: opts.coarseLevel ?? null,
  };
}

function makeCold(
  activeSet: ColdStateActiveEntry[],
  visibleChannels: number[] = [0],
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 0 },
    datasetId: "ds1",
    currentT: 0,
    currentZ: 0,
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
    drawnModes: ["slice"],
    sampleFormat: "u16",
  };
}

// Construction matrix — locks the cases callers must agree on.

describe("Suite D — memberIdForColdEntry matrix", () => {
  it("tile → imageId:chN", () => {
    const e = makeEntry({ entityId: "imgA", imageId: "imgA" });
    expect(memberIdForColdEntry(e, 0)).toBe("imgA:ch0");
    expect(memberIdForColdEntry(e, 2)).toBe("imgA:ch2");
  });

  it("cold state → canonical order", () => {
    // Canonical iteration order: activeSet outer, visibleChannels inner.
    const cold = makeCold(
      [
        makeEntry({ entityId: "imgA", imageId: "imgA" }),
        makeEntry({ entityId: "imgB", imageId: "imgB" }),
        makeEntry({ entityId: "imgC", imageId: "imgC" }),
      ],
      [0, 1],
    );
    const ids = Array.from(iterateColdMembers(cold)).map(x => x.memberId);
    expect(ids).toEqual([
      "imgA:ch0", "imgA:ch1",
      "imgB:ch0", "imgB:ch1",
      "imgC:ch0", "imgC:ch1",
    ]);
    // Sanity: no canonical id is a bare ":chN" or empty string.
    for (const id of ids) {
      expect(id).not.toMatch(/^:ch/);
      expect(id).not.toBe("");
    }
  });

  it("canonical iteration keys a lone shown channel by that channel", () => {
    const cold = makeCold(
      [makeEntry({ entityId: "imgA", imageId: "imgA" })],
      [2],
    );

    expect(Array.from(iterateColdMembers(cold)).map(x => x.memberId)).toEqual([
      "imgA:ch2",
    ]);
  });
});

// removeLayerResources cleanup contract: every memberToDataset and
// memberSourcePools entry owned by datasetId is gone afterward. Without it
// these maps grow for the worker's lifetime and a recurring memberId could
// collide. GPU teardown is
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
    state.memberSourcePools.volume.set("imgA", new Map([["detail:0", "ds1:64x64x32:detail"]]));
    state.memberSourcePools.volume.set("imgB", new Map([["detail:0", "ds1:64x64x32:detail"]]));
    state.memberSourcePools.volume.set("imgC", new Map([["detail:0", "ds2:64x64x32:detail"]]));
    state.currentSourcesByDatasetMode.set("ds1|volume", new Map());
    state.currentSourcesByDatasetMode.set("ds2|volume", new Map());

    removeMemberRoutingForDataset(state, "ds1");

    // ds1's entries are gone.
    expect(state.memberToDataset.has("imgA")).toBe(false);
    expect(state.memberToDataset.has("imgB")).toBe(false);
    expect(state.memberSourcePools.volume.has("imgA")).toBe(false);
    expect(state.memberSourcePools.volume.has("imgB")).toBe(false);
    expect(state.currentSourcesByDatasetMode.has("ds1|volume")).toBe(false);
    // ds2's entries are untouched.
    expect(state.memberToDataset.get("imgC")).toBe("ds2");
    expect(state.memberSourcePools.volume.get("imgC")?.get("detail:0")).toBe("ds2:64x64x32:detail");
    expect(state.currentSourcesByDatasetMode.has("ds2|volume")).toBe(true);
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
