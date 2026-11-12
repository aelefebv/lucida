import { describe, it, expect } from "vitest";
import type { SceneEpochs } from "../../epochs.ts";
import { buildViewHotState } from "./hotState.ts";

const epochs: SceneEpochs = { content: 0, layout: 0, view: 0, selection: 0, request: 0 };

describe("buildViewHotState", () => {
  it("emits one ray hit per member, each the dataset's, in the members' order", () => {
    const memberIds = new Map([["img-a:ch0", 0], ["img-b:ch0", 1], ["img-b:ch1", 2]]).keys();

    const msg = buildViewHotState({ memberIds, rayHit: [10, 20, 30], epochs, datasetId: "ds1", view: 2 });

    expect(msg).toEqual({
      type: "viewHotState",
      epochs,
      datasetId: "ds1",
      view: 2,
      rayHitsByEntity: [
        ["img-a:ch0", [10, 20, 30]],
        ["img-b:ch0", [10, 20, 30]],
        ["img-b:ch1", [10, 20, 30]],
      ],
    });
  });

  it("emits no ray hits for a view with no members", () => {
    const msg = buildViewHotState({ memberIds: [], rayHit: [0, 0, 0], epochs, datasetId: "ds1", view: 0 });
    expect(msg.rayHitsByEntity).toEqual([]);
  });
});
