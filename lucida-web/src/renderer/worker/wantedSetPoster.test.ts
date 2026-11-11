import { describe, expect, it } from "vitest";

import { createWantedSetPoster } from "./bootstrap.ts";
import { attachView, fakeDraw } from "../viewIndirectionFixtures.ts";
import { createInitialState } from "./state.ts";
import { indexWantedChunks } from "../wantedChunks.ts";
import type { ColdStateMessage, WorkerToMainMessage } from "../workerProtocol.ts";

function sliceColdState(z: number): ColdStateMessage {
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  return {
    type: "coldState",
    labels: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    datasetId: "ds-0",
    currentT: 0,
    currentZ: z,
    visibleChannels: [0],
    visibleRegion: { xyBoundsVox: [0, 0, 128, 128], zRangeVox: [z, z + 1], effectiveZoom: 1, sortCenterVox: null, frustumPlanes: null },
    wantedChunks: [{ memberId: "img:ch0", tier: "detail", chunkKeys: ["0/0/0/0/0/0", "0/0/0/0/0/1"] }],
    activeSet: [{
      entityId: "img",
      imageId: "img",
      levels: [{ level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] }],
      detailLevels: [0],
      coarseLevel: null,
      modelMatrix: identity,
      invModelMatrix: identity,
      displayStateByChannel: {},
    }],
    view: 0,
    viewMode: "slice",
    drawnViews: [0],
    sampleFormat: "u16",
  };
}

describe("the wanted-set report", () => {
  it("reports a chunk held only at another plane missing at the plane the view cuts", () => {
    const state = createInitialState();
    const cold = sliceColdState(11);
    const draw = fakeDraw({ datasetId: "ds-0", mode: "slice", z: 11, wanted: indexWantedChunks(cold.wantedChunks) });
    draw.cold = cold;
    draw.routes.set("img:ch0", new Map([["detail:0", "pool"]]));
    state.draws.set("ds-0|0", draw);
    state.memberToDataset.set("img:ch0", "ds-0");
    const pool = {
      datasetId: "ds-0",
      // Cut at plane 10, in the same chunk as plane 11.
      slots: new Map([["img:ch0|0/0/0/0/0/0|10", 0]]),
      planesByChunk: new Map([["img:ch0|0/0/0/0/0/0", new Map([[10, 0]])]]),
      views: new Map(),
      totalSlots: 1,
    };
    attachView(pool as never, new Map([["img:ch0", [{ level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], levelDims: [64, 128, 128], offset: 0 }]]]), { draw });
    state.sliceAtlases.set("pool", pool as never);
    const posts: WorkerToMainMessage[] = [];

    createWantedSetPoster(state, (msg) => posts.push(msg))("ds-0");

    // The plane another view may draw stays held: only the view's own plane is asked for.
    expect(posts.map((m) => m.type)).toEqual(["wantedSetDelta", "entityLevels"]);
    const missing = posts[0].type === "wantedSetDelta" ? posts[0].missing : [];
    expect(missing.map((m) => [m.chunkKey, m.cut])).toEqual([
      ["0/0/0/0/0/0", { axis: "z", plane: 11 }],
      ["0/0/0/0/0/1", { axis: "z", plane: 11 }],
    ]);
  });
});
