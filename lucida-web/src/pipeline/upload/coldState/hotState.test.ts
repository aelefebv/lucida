import { describe, expect, it } from "vitest";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
} from "../../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { buildViewHotState, buildViewHotStateFromMembers } from "./hotState.ts";

const epochs: SceneEpochs = {
  content: 0,
  layout: 0,
  view: 0,
  selection: 0,
  request: 0,
};

function entry(entityId: string, imageId: string): ColdStateActiveEntry {
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  return {
    kind: "tile",
    entityId,
    imageId,
    targetLod: 0,
    detailOwnedLodRange: [0, 0],
    detailLevel: 0,
    coarseLevel: null,
    wantedLodLevels: [0],
    levels: [],
    modelMatrix: identity,
    invModelMatrix: identity.slice(),
    displayStateByChannel: {},
  };
}

function cold(activeSet: ColdStateActiveEntry[], visibleChannels = [0]): ColdStateMessage {
  return {
    type: "coldState",
    epochs,
    datasetId: "ds-1",
    currentT: 0,
    currentZ: 0,
    multiChannel: visibleChannels.length > 1,
    visibleChannels,
    visibleRegion: {
      xyBoundsVox: [0, 0, 1, 1],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    activeSet,
    viewMode: "slice",
  };
}

describe("buildViewHotState", () => {
  it("fans one dataset ray hit out to every cold-state member", () => {
    const state = cold([entry("a", "image-a"), entry("b", "image-b")]);
    const result = buildViewHotState({
      coldMsg: state,
      rayHit: [10, 20, 30],
      epochs,
      datasetId: "ds-1",
    });

    expect(result).toEqual({
      type: "viewHotState",
      epochs,
      datasetId: "ds-1",
      rayHitsByEntity: [
        ["image-a", [10, 20, 30]],
        ["image-b", [10, 20, 30]],
      ],
    });
  });

  it("uses canonical channel-suffixed member ids in composite mode", () => {
    const state = cold([entry("a", "image-a")], [0, 2]);
    const result = buildViewHotState({
      coldMsg: state,
      rayHit: [1, 2, 3],
      epochs,
      datasetId: "ds-1",
    });
    expect(result.rayHitsByEntity.map(([id]) => id)).toEqual([
      "image-a:ch0",
      "image-a:ch2",
    ]);
  });

  it("deduplicates repeated member ids in first-seen order", () => {
    const result = buildViewHotStateFromMembers({
      memberIds: ["same", "same", "other"],
      rayHit: [1, 2, 3],
      epochs,
      datasetId: "ds-1",
    });
    expect(result.rayHitsByEntity.map(([id]) => id)).toEqual(["same", "other"]);
  });

  it("returns an empty update for an empty cold state", () => {
    const result = buildViewHotState({
      coldMsg: cold([]),
      rayHit: [0, 0, 0],
      epochs,
      datasetId: "ds-1",
    });
    expect(result.rayHitsByEntity).toEqual([]);
  });
});
