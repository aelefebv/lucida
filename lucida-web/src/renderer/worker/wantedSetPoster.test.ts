import { describe, expect, it } from "vitest";

import { createWantedSetPoster } from "./bootstrap.ts";
import { createInitialState } from "./state.ts";
import { indexWantedChunks } from "../wantedChunks.ts";
import type { ColdStateMessage, WorkerToMainMessage } from "../workerProtocol.ts";

function sliceColdState(z: number): ColdStateMessage {
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  return {
    type: "coldState",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    datasetId: "ds-0",
    currentT: 0,
    currentZ: z,
    visibleChannels: [0],
    visibleRegion: { xyBoundsVox: [0, 0, 128, 128], zRangeVox: [z, z + 1], effectiveZoom: 1, sortCenterVox: null, frustumPlanes: null },
    wantedChunks: [{ memberId: "img:ch0", tier: "detail", chunkKeys: ["0/0/0/0/0/0", "0/0/0/0/0/1"] }],
    activeSet: [{
      kind: "tile",
      entityId: "img",
      imageId: "img",
      mode: "tiles-with-detail",
      levels: [{ level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] }],
      detailLevels: [0],
      coarseLevel: null,
      parentGroupId: null,
      proxyAvailable: false,
      groupProxyAvailable: false,
      modelMatrix: identity,
      invModelMatrix: identity,
      displayStateByChannel: {},
    }],
    viewMode: "slice",
    sampleFormat: "u16",
  };
}

describe("the wanted-set report", () => {
  it("reports a wanted slot cut from a plane the current Z no longer maps to lost, ahead of the missing list", () => {
    const state = createInitialState();
    const cold = sliceColdState(11);
    state.coldStateByDataset.set("ds-0", cold);
    state.wantedByDataset.set("ds-0", indexWantedChunks(cold.wantedChunks));
    state.memberToDataset.set("img:ch0", "ds-0");
    state.memberSourcePools.set("img:ch0", new Map([["detail:0", "pool"]]));
    state.sliceAtlases.set("pool", {
      z: 11,
      // Cut at plane 10, in the same chunk as plane 11.
      slots: new Map([["img:ch0|0/0/0/0/0/0", 0]]),
      slotLevelZ: Int32Array.from([10]),
      entityMetas: new Map([["img:ch0", [{ level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], levelDims: [64, 128, 128], offset: 0 }]]]),
    } as never);
    const posts: WorkerToMainMessage[] = [];

    createWantedSetPoster(state, (msg) => posts.push(msg))("ds-0");

    expect(posts.map((m) => m.type)).toEqual(["chunkResidency", "wantedSetDelta", "entityLevels"]);
    expect(posts[0]).toEqual({
      type: "chunkResidency", memberId: "img:ch0", tier: "detail", change: "lost", keys: ["0/0/0/0/0/0"], reason: "wrong-slice",
    });
    const missing = posts[1].type === "wantedSetDelta" ? posts[1].missing : [];
    expect(missing.map((m) => (m.kind === "chunk" ? m.chunkKey : m.kind))).toEqual(["0/0/0/0/0/0", "0/0/0/0/0/1"]);
  });
});
