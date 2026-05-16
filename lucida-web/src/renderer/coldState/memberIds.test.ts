/**
 * Suite D — Member registry invariants.
 *
 * Locks the memberId construction matrix for the canonical helper
 * (descriptorBuffer.memberIdForColdEntry) plus the canonical iteration
 * (iterateColdMembers). After Slice 2, every site in gpu.worker.ts and
 * wantedSet.ts routes through this helper rather than rebuilding the
 * memberId inline, so the matrix below pins what those call sites now
 * produce by construction.
 *
 * The bug the helper guards against: well-as-proxy entries carry
 * `imageId === ""` (sentinel for "no field — render the well's proxy").
 * Inline `${entry.imageId}:ch${channel}` reconstruction would produce
 * ":ch5" for multi-channel well-as-proxy entries — a key with no entity
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
  opts: Partial<ColdStateActiveEntry> & {
    entityId: string;
    imageId: string;
    mode: ColdStateActiveEntry["mode"];
  },
): ColdStateActiveEntry {
  return {
    entityId: opts.entityId,
    imageId: opts.imageId,
    targetLod: opts.targetLod ?? 0,
    detailOwnedLodRange: opts.detailOwnedLodRange ?? [0, 0],
    levels: opts.levels ?? [
      { level: 0, chunkShape: [1, 64, 64], gridShape: [1, 4, 4], levelDims: [1, 256, 256] },
    ],
    mode: opts.mode,
    proxyKind: opts.proxyKind,
    proxyAvailable: opts.proxyAvailable ?? false,
    wellProxyAvailable: opts.wellProxyAvailable ?? false,
    parentWellId: opts.parentWellId ?? null,
    modelMatrix: opts.modelMatrix ?? identityMatrix(),
    invModelMatrix: opts.invModelMatrix ?? identityMatrix(),
    displayStateByChannel: opts.displayStateByChannel ?? { 0: defaultDisplay() },
  };
}

function makeCold(activeSet: ColdStateActiveEntry[], visibleChannels: number[] = [0]): ColdStateMessage {
  return {
    type: "coldState",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
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
    activeSet,
    viewMode: "slice",
  };
}

// ---------------------------------------------------------------------------
// Construction matrix — locks the four corner cases that gpu.worker.ts and
// wantedSet.ts call sites previously hand-rolled (and got subtly wrong for
// the well-as-proxy variants).
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
    // Regression: well-as-proxy carries imageId === "". The old inline
    // `entry.imageId` construction in memberToPool / wantedSet would
    // have produced "" here. The helper resolves to entityId.
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
});

// ---------------------------------------------------------------------------
// Slice 8 cleanup invariant — stubbed.
//
// removeLayerResources currently doesn't clean memberToDataset /
// memberToPool, so entries remain after dataset removal. Minor memory
// leak today; future risk if memberIds collide across datasets. Will be
// fixed in Slice 8 (de-globalize state) when state ownership becomes
// explicit and the registry maps live on a ctx-owned RendererState.
//
// This is awkward to assert without mocking the worker ctx + module
// globals, so the test is a placeholder TODO. The Slice 8 work will
// either replace this with a real assertion against RendererState or
// drop it once the leak is closed.
// ---------------------------------------------------------------------------

describe("Suite D — removeLayerResources cleanup (Slice 8)", () => {
  it.skip("TODO Slice 8: removeLayerResources should clear memberToDataset/memberToPool entries for the dataset", () => {
    // Pending: requires ctx-owned RendererState (Slice 8) before we can
    // assert against the registry without mocking module globals.
    expect(true).toBe(true);
  });
});
