/**
 * Unit tests for `buildViewHotState` — pure builder that mirrors
 * `iterateColdMembers`, fanning the per-dataset ray hit out to every
 * member.
 *
 * Cases:
 *   1. Per-member fan-out — one rayHit entry per cold-state member.
 *   2. Composite member id dedup — if two entries produce the same
 *      `memberId` (e.g. group-as-proxy with entityId X and a tile with
 *      imageId X), only the first emits a rayHit.
 *   3. Empty cold msg → empty rayHitsByEntity.
 */
import { describe, it, expect } from "vitest";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  ColdStateTileEntry,
} from "../../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { buildViewHotState } from "./hotState.ts";

function makeEntry(
  over: Partial<Omit<ColdStateTileEntry, "kind" | "mode">> & { mode?: ColdStateActiveEntry["mode"] },
): ColdStateActiveEntry {
  const base = {
    entityId: over.entityId ?? "ent",
    levels: over.levels ?? [],
    proxyKind: over.proxyKind,
    proxyAvailable: over.proxyAvailable ?? false,
    groupProxyAvailable: over.groupProxyAvailable ?? false,
    modelMatrix: over.modelMatrix ?? new Float32Array(16),
    invModelMatrix: over.invModelMatrix ?? new Float32Array(16),
    displayStateByChannel: over.displayStateByChannel ?? {},
  };
  // Discriminate via `mode` so existing call sites that pass
  // `mode: "group-as-proxy"` (with `imageId: ""`) keep working.
  const mode = over.mode ?? "tiles-with-detail";
  if (mode === "group-as-proxy") {
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
    imageId: over.imageId ?? "img",
    mode,
    detailLevels: over.detailLevels ?? [0],
    coarseLevel: over.coarseLevel ?? null,
    parentGroupId: over.parentGroupId ?? null,
  };
}

function makeColdMsg(
  visibleChannels: number[],
  activeSet: ColdStateActiveEntry[],
): ColdStateMessage {
  const epochs: SceneEpochs = { content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 };
  return {
    type: "coldState",
    epochs,
    datasetId: "ds1",
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
  it("emits one rayHit entry per cold-state member (per-member fan-out)", () => {
    const cold = makeColdMsg(
      [0], // single channel
      [
        makeEntry({ entityId: "ent-a", imageId: "img-a", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "ent-b", imageId: "img-b", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "group-c", imageId: "", mode: "group-as-proxy" }),
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

    // 3 members → 3 entries, each with the same rayHit.
    expect(msg.rayHitsByEntity).toHaveLength(3);
    const memberIds = msg.rayHitsByEntity.map(([id]) => id);
    expect(memberIds).toEqual(["img-a", "img-b", "group-c"]);
    for (const [, hit] of msg.rayHitsByEntity) {
      expect(hit).toEqual([10, 20, 30]);
    }
  });

  it("dedupes when two entries produce the same memberId", () => {
    // group-as-proxy entityId="dup", tile imageId="dup" → both yield
    // memberId "dup" in single-channel mode. Only the first one emits.
    const cold = makeColdMsg(
      [0],
      [
        makeEntry({ entityId: "dup", imageId: "", mode: "group-as-proxy" }),
        makeEntry({ entityId: "other-ent", imageId: "dup", mode: "tiles-with-detail" }),
        makeEntry({ entityId: "ent-c", imageId: "img-c", mode: "tiles-with-detail" }),
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
    expect(msg.rayHitsByEntity.map(([id]) => id)).toEqual(["dup", "img-c"]);
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
