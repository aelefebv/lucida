import { describe, expect, it, vi } from "vitest";

import type { DatasetManifest, LevelGeometry, WireFormat } from "../manifestTypes.ts";
import type { DatasetEntry, TickContext } from "../renderLoopTypes.ts";
import type {
  ContentSource,
  FetchRequest,
  FetchResult,
} from "./fetch/contentSource.ts";
import { CpuCache } from "./fetch/cpuCache.ts";
import type { DecodePool } from "./fetch/decodePool.ts";
import {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  mergeConfig,
  plan,
} from "./planning/index.ts";
import { identityMatrix } from "./upload/coldState/identity.ts";
import { Uploader } from "./upload/uploader.ts";
import { makeSceneEpochs } from "../test/fixtures.ts";
import type { ChunkContract } from "../chunkContract.ts";

const LEVEL: LevelGeometry = {
  level_index: 0,
  shape: [1, 1, 1, 2, 2],
  chunk_shape: [1, 1, 1, 2, 2],
  grid_shape: [1, 1, 1, 1, 1],
  scale: [1, 1, 1, 1, 1],
};

function makeManifest(): DatasetManifest {
  return {
    dataset_id: "ds-1",
    name: "cross-stage fixture",
    kind: "Single",
    entities: [
      { id: "entity-0", kind: "Image", parent: null, labels: {} },
    ],
    transforms: [],
    images: [{
      image_id: "image-0",
      owner: "entity-0",
      multiscale: {
        axes: [],
        levels: [LEVEL],
        data_type: "uint16",
      },
    }],
    source_layouts: [],
    default_layout_id: null,
  };
}

describe("planner → CPU cache → uploader contract", () => {
  it("preserves request identity, decoded bytes, geometry, and epochs across real stages", async () => {
    const entity = createSyntheticEntity({
      entityId: "entity-0",
      imageId: "image-0",
      levels: [LEVEL],
      detailLevel: 0,
      coarseLevel: null,
    });
    const snapshot = createSyntheticSnapshot({
      datasetId: "ds-1",
      epochs: makeSceneEpochs(),
      entities: [entity],
      visibleRegion: {
        xyBoundsVox: [0, 0, 2, 2],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
    });
    const requestPlan = plan(
      snapshot,
      createSyntheticState(),
      mergeConfig({ prefetchDepth: 0 }),
    );

    expect(requestPlan.requests).toEqual([
      expect.objectContaining({
        datasetId: "ds-1",
        entityId: "entity-0",
        imageId: "image-0",
        chunkKey: "0/0/0/0/0/0",
        lane: "detail",
        tier: "detail",
      }),
    ]);

    const sourcePixels = new Uint16Array([11, 22, 33, 44]);
    const wireFormat: WireFormat = { Raw: { data_type: "uint16" } };
    const fetch = vi.fn(
      async (_request: FetchRequest, _signal: AbortSignal): Promise<FetchResult> => ({
        bytes: sourcePixels.buffer.slice(0),
        wireFormat,
        dataType: "uint16",
      }),
    );
    const source: ContentSource = { fetch, handleBinary: vi.fn() };
    const decode = vi.fn(
      async (
        bytes: ArrayBuffer,
        _format: WireFormat,
        _contract: ChunkContract,
      ): Promise<ArrayBuffer> => bytes,
    );
    const decodePool = { size: 1, decode } as unknown as DecodePool;
    const cpuCache = new CpuCache(source, decodePool, {
      mainBudgetBytes: 1024,
      overviewBudgetBytes: 1024,
      maxConcurrentFetches: 1,
      maxBytesInFlight: 1024,
    });

    const coldState = vi.fn();
    const sliceChunkData = vi.fn();
    const manifest = makeManifest();
    const datasets = new Map<string, DatasetEntry>([
      ["ds-1", { manifest }],
    ]);
    const ctx = {
      scene: { multi_channel: () => false },
      datasets,
      client: { coldState, sliceChunkData },
      canvas: {},
      mode: "slice",
      renderScale: 1,
      cpuCache,
    } as unknown as TickContext;

    // Mirror the production rebuild order: advance cache generation, publish
    // the planner's cold state, then submit its request stream.
    cpuCache.onPlanRebuildStart();
    const uploader = new Uploader();
    uploader.sendColdState({
      ctx,
      datasetId: snapshot.datasetId,
      activeSet: requestPlan.activeSet,
      entities: snapshot.entities,
      selection: snapshot.selection,
      multiChannel: false,
      visibleRegion: snapshot.visibleRegion,
      epochs: requestPlan.epochs,
      matricesByEntity: new Map([
        ["entity-0", { model: identityMatrix(), inv: identityMatrix() }],
      ]),
      dsSettings: undefined,
    });
    cpuCache.submit(requestPlan);

    await vi.waitFor(() => {
      expect(Array.from(cpuCache.getDeliverable())).toHaveLength(1);
    });

    expect(fetch).toHaveBeenCalledWith(
      {
        datasetId: "ds-1",
        imageId: "image-0",
        chunkKey: "0/0/0/0/0/0",
      },
      expect.any(AbortSignal),
    );
    const plannedContract = requestPlan.requests[0].contract;
    expect(decode).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      wireFormat,
      plannedContract,
    );
    expect(coldState).toHaveBeenCalledWith(expect.objectContaining({
      datasetId: "ds-1",
      epochs: requestPlan.epochs,
      activeSet: [expect.objectContaining({ entityId: "entity-0", imageId: "image-0" })],
    }));

    expect(uploader.deliverToWorker(ctx, 1024, 0)).toBe(true);
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    const upload = sliceChunkData.mock.calls[0];
    expect(upload[0]).toBe("image-0");
    expect(upload[1]).toEqual([
      expect.objectContaining({
        contract: plannedContract,
        x: 0,
        y: 0,
        z: 0,
        key: "0/0/0/0/0/0",
      }),
    ]);
    expect(new Uint16Array(upload[1][0].data)).toEqual(sourcePixels);
    expect(upload.slice(2, 14)).toEqual([
      0, 0, 0, 0, // level, selected Z, T, C
      2, 2, 2, 2, 1, // level W/H and chunk X/Y/Z
      1, 1, 0, // full-res depth, level depth, full-res Z
    ]);
    expect(upload[14]).toEqual(requestPlan.epochs);
    expect(upload[15]).toBe("detail");
    expect(Array.from(cpuCache.getDeliverable())).toEqual([]);
  });
});
