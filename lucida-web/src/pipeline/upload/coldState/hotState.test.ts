/**
 * Unit tests for `buildViewHotState`, which mirrors `iterateColdMembers` and
 * emits one ray hit per unique member id.
 */
import { describe, it, expect } from "vitest";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
} from "../../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { buildViewHotState } from "./hotState.ts";

function makeEntry(over: Partial<ColdStateActiveEntry>): ColdStateActiveEntry {
  return {
    entityId: over.entityId ?? "ent",
    levels: over.levels ?? [],
    modelMatrix: over.modelMatrix ?? new Float32Array(16),
    invModelMatrix: over.invModelMatrix ?? new Float32Array(16),
    displayStateByChannel: over.displayStateByChannel ?? {},
    imageId: over.imageId ?? "img",
    detailLevels: over.detailLevels ?? [0],
    coarseLevel: over.coarseLevel ?? null,
  };
}

function makeColdMsg(
  visibleChannels: number[],
  activeSet: ColdStateActiveEntry[],
): ColdStateMessage {
  const epochs: SceneEpochs = { content: 0, layout: 0, view: 0, selection: 0, request: 0 };
  return {
    type: "coldState",
    epochs,
    datasetId: "ds1",
    currentT: 0,
    currentZ: 0,
    visibleChannels,
    visibleRegion: {
      xyBoundsVox: [0, 0, 1, 1],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    },
    wantedChunks: [],
    activeSet,
    view: 0,
    viewMode: "slice",
    drawnViews: [0],
    sampleFormat: "u16",
  };
}

describe("buildViewHotState", () => {
  it("emits one rayHit entry per cold-state member (per-member fan-out)", () => {
    const cold = makeColdMsg(
      [0], // single channel
      [
        makeEntry({ entityId: "ent-a", imageId: "img-a" }),
        makeEntry({ entityId: "ent-b", imageId: "img-b" }),
      ],
    );
    const rayHit: [number, number, number] = [10, 20, 30];

    const msg = buildViewHotState({
      coldMsg: cold,
      rayHit,
      epochs: cold.epochs,
      datasetId: "ds1",
    });

    expect(msg.type).toBe("viewHotState");
    expect(msg.datasetId).toBe("ds1");
    expect(msg.epochs).toBe(cold.epochs);

    // 2 members → 2 entries, each with the same rayHit.
    expect(msg.rayHitsByEntity).toHaveLength(2);
    const memberIds = msg.rayHitsByEntity.map(([id]) => id);
    expect(memberIds).toEqual(["img-a:ch0", "img-b:ch0"]);
    for (const [, hit] of msg.rayHitsByEntity) {
      expect(hit).toEqual([10, 20, 30]);
    }
  });

  it("dedupes when two entries produce the same memberId", () => {
    // Two entries share imageId "dup", so both yield memberId "dup:ch0".
    // Only the first one emits.
    const cold = makeColdMsg(
      [0],
      [
        makeEntry({ entityId: "dup-ent", imageId: "dup" }),
        makeEntry({ entityId: "other-ent", imageId: "dup" }),
        makeEntry({ entityId: "ent-c", imageId: "img-c" }),
      ],
    );

    const msg = buildViewHotState({
      coldMsg: cold,
      rayHit: [1, 2, 3],
      epochs: cold.epochs,
      datasetId: "ds1",
    });

    // 2 unique memberIds → 2 entries (the second "dup" is deduped).
    expect(msg.rayHitsByEntity).toHaveLength(2);
    expect(msg.rayHitsByEntity.map(([id]) => id)).toEqual(["dup:ch0", "img-c:ch0"]);
  });

  it("empty cold msg → empty rayHitsByEntity", () => {
    const cold = makeColdMsg([0], []);
    const msg = buildViewHotState({
      coldMsg: cold,
      rayHit: [0, 0, 0],
      epochs: cold.epochs,
      datasetId: "ds1",
    });
    expect(msg.rayHitsByEntity).toEqual([]);
    expect(msg.type).toBe("viewHotState");
    expect(msg.datasetId).toBe("ds1");
  });
});
