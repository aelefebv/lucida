/**
 * Tests for `classifyDelivery` (pure filter) + `runDrainPass` (loop).
 *
 * `classifyDelivery` is a 6-case table; `runDrainPass` exercises the
 * counter-mutation + budget-stop end-to-end with a mocked client and
 * tracker.
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
} from "../../fetch/index.ts";
import type { RenderClient } from "../../../renderer/renderClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import {
  emptyUploadTickStats,
} from "../../../debug/debugStats.ts";
import { classifyDelivery, runDrainPass } from "./drain.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import { DeliveryTracker } from "./tracker.ts";
import type { ImageSpec } from "../../../manifestTypes.ts";

const EPOCHS: SceneEpochs = {
  content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1,
};

function makeImage(imageId: string): ImageSpec {
  return {
    image_id: imageId,
    owner: imageId,
    multiscale: {
      axes: [],
      data_type: "uint16",
      levels: [
        {
          level_index: 0,
          shape: [1, 1, 1, 1024, 1024],
          chunk_shape: [1, 1, 1, 256, 256],
          grid_shape: [1, 1, 1, 4, 4],
          scale: [1, 1, 1, 1, 1],
        },
        {
          level_index: 1,
          shape: [1, 1, 1, 512, 512],
          chunk_shape: [1, 1, 1, 256, 256],
          grid_shape: [1, 1, 1, 2, 2],
          scale: [1, 1, 1, 2, 2],
        },
      ],
    },
  };
}

function makeMeta(imageId: string): ManifestEntry {
  const image = makeImage(imageId);
  return {
    manifest: { dataset_id: "ds1" } as ManifestEntry["manifest"],
    image,
    levels: image.multiscale.levels,
  };
}

function makeChunk(overrides: Partial<ReadyChunkDelivery> = {}): ReadyChunkDelivery {
  return {
    kind: "chunk",
    entityId: "field-0",
    imageId: "img-0",
    level: 1,
    t: 0, c: 0, z: 0, y: 0, x: 0,
    chunkKey: "1/0/0/0/0/0",
    data: new ArrayBuffer(128),
    dataType: "uint16",
    epochs: EPOCHS,
    lane: "detail",
    ...overrides,
  };
}

function makeProxy(overrides: Partial<ReadyProxyDelivery> = {}): ReadyProxyDelivery {
  return {
    kind: "proxy",
    datasetId: "ds1",
    entityId: "field-0",
    imageId: "img-0",
    proxyKind: "FieldProxy3D",
    t: 0,
    c: 0,
    header: {
      algorithmVersion: 1,
      sourceContentHash: new Uint8Array(32),
      dims: [4, 4, 4],
      dtype: "u16",
    },
    data: new ArrayBuffer(256),
    epochs: EPOCHS,
    ...overrides,
  };
}

function makeMockClient(): {
  client: RenderClient;
  sliceChunkData: ReturnType<typeof vi.fn>;
  volumeChunkData: ReturnType<typeof vi.fn>;
  proxyAssetData: ReturnType<typeof vi.fn>;
} {
  const sliceChunkData = vi.fn();
  const volumeChunkData = vi.fn();
  const proxyAssetData = vi.fn();
  return {
    client: { sliceChunkData, volumeChunkData, proxyAssetData } as unknown as RenderClient,
    sliceChunkData,
    volumeChunkData,
    proxyAssetData,
  };
}

// ---------------------------------------------------------------------------
// classifyDelivery
// ---------------------------------------------------------------------------

describe("classifyDelivery", () => {
  const target = new Map<string, number>([["img-0", 1]]);
  const meta = new Map<string, ManifestEntry>([["img-0", makeMeta("img-0")]]);

  it("proxy delivery → send-proxy always", () => {
    expect(classifyDelivery(makeProxy(), target, meta)).toEqual({ action: "send-proxy" });
  });

  it("chunk lane=prefetch → skip prefetch", () => {
    expect(classifyDelivery(makeChunk({ lane: "prefetch" }), target, meta)).toEqual({
      action: "skip", reason: "prefetch",
    });
  });

  it("chunk lane=overview → skip overview", () => {
    expect(classifyDelivery(makeChunk({ lane: "overview" }), target, meta)).toEqual({
      action: "skip", reason: "overview",
    });
  });

  it("chunk level != target → skip wrongLod", () => {
    expect(classifyDelivery(makeChunk({ level: 0 }), target, meta)).toEqual({
      action: "skip", reason: "wrongLod",
    });
  });

  it("chunk image not in target map → skip wrongLod", () => {
    expect(classifyDelivery(makeChunk({ imageId: "img-ghost" }), target, meta)).toEqual({
      action: "skip", reason: "wrongLod",
    });
  });

  it("chunk image not in manifest index → skip noMeta", () => {
    const t2 = new Map<string, number>([["img-x", 1]]);
    const m2 = new Map<string, ManifestEntry>();
    expect(
      classifyDelivery(makeChunk({ imageId: "img-x", level: 1 }), t2, m2),
    ).toEqual({ action: "skip", reason: "noMeta" });
  });

  it("chunk happy path → send-chunk", () => {
    expect(classifyDelivery(makeChunk(), target, meta)).toEqual({ action: "send-chunk" });
  });
});

// ---------------------------------------------------------------------------
// runDrainPass
// ---------------------------------------------------------------------------

describe("runDrainPass", () => {
  function setup(deliveries: ReadyDelivery[]) {
    const tracker = new DeliveryTracker();
    const { client, sliceChunkData, volumeChunkData, proxyAssetData } = makeMockClient();
    const stats = emptyUploadTickStats();
    const events: Array<{ bytes: number; isResend: boolean }> = [];
    const targetByImage = new Map<string, number>([["img-0", 1]]);
    const manifestByImage = new Map<string, ManifestEntry>([
      ["img-0", makeMeta("img-0")],
    ]);

    const result = runDrainPass({
      deliveries,
      targetByImage,
      manifestByImage,
      tracker,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: (bytes, isResend) => events.push({ bytes, isResend }),
      remaining: 1024 * 1024,
    });

    return {
      result, tracker, stats, events,
      sliceChunkData, volumeChunkData, proxyAssetData,
    };
  }

  it("sends a chunk + bumps uploadedChunks / bytesUploaded / recordUpload", () => {
    const { result, stats, events, sliceChunkData } = setup([makeChunk()]);

    expect(result.budgetExhausted).toBe(false);
    expect(stats.uploadedChunks).toBe(1);
    expect(stats.bytesUploaded).toBe(128);
    expect(events).toEqual([{ bytes: 128, isResend: false }]);
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
  });

  it("sends a proxy + bumps uploadedProxies / bytesUploaded / recordUpload", () => {
    const { stats, events, proxyAssetData } = setup([makeProxy()]);

    expect(stats.uploadedProxies).toBe(1);
    expect(stats.bytesUploaded).toBe(256);
    expect(events).toEqual([{ bytes: 256, isResend: false }]);
    expect(proxyAssetData).toHaveBeenCalledTimes(1);
  });

  it("filter skips bump the right counter and don't call client", () => {
    const { stats, sliceChunkData } = setup([
      makeChunk({ lane: "prefetch", chunkKey: "p" }),
      makeChunk({ lane: "overview", chunkKey: "o" }),
      makeChunk({ level: 0, chunkKey: "w" }),
    ]);

    expect(stats.skippedPrefetch).toBe(1);
    expect(stats.skippedOverview).toBe(1);
    expect(stats.skippedWrongLod).toBe(1);
    expect(sliceChunkData).not.toHaveBeenCalled();
  });

  it("budget exhaustion stops the loop and flags budgetExhausted", () => {
    const tracker = new DeliveryTracker();
    const { client } = makeMockClient();
    const stats = emptyUploadTickStats();
    const targetByImage = new Map<string, number>([["img-0", 1]]);
    const manifestByImage = new Map<string, ManifestEntry>([
      ["img-0", makeMeta("img-0")],
    ]);
    // Three chunks of 128 bytes each, budget = 100 → first send hits the
    // budget and the loop stops.
    const deliveries: ReadyDelivery[] = [
      makeChunk({ chunkKey: "a" }),
      makeChunk({ chunkKey: "b" }),
      makeChunk({ chunkKey: "c" }),
    ];
    const result = runDrainPass({
      deliveries,
      targetByImage,
      manifestByImage,
      tracker,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 100,
    });

    expect(result.budgetExhausted).toBe(true);
    expect(stats.uploadedChunks).toBe(1);
    // 'b' and 'c' never make it past the loop break.
    expect(tracker.wasChunkSent("img-0", "a")).toBe(true);
    expect(tracker.wasChunkSent("img-0", "b")).toBe(false);
  });

  it("already-sent chunks bump skippedAlreadySent and don't re-dispatch", () => {
    const tracker = new DeliveryTracker();
    tracker.markChunkSent("img-0", "field-0", "1/0/0/0/0/0");
    const { client, sliceChunkData } = makeMockClient();
    const stats = emptyUploadTickStats();
    const targetByImage = new Map<string, number>([["img-0", 1]]);
    const manifestByImage = new Map<string, ManifestEntry>([
      ["img-0", makeMeta("img-0")],
    ]);
    const result = runDrainPass({
      deliveries: [makeChunk()],
      targetByImage,
      manifestByImage,
      tracker,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 1024,
    });

    expect(result.budgetExhausted).toBe(false);
    expect(stats.uploadedChunks).toBe(0);
    expect(stats.skippedAlreadySent).toBe(1);
    expect(sliceChunkData).not.toHaveBeenCalled();
  });

  it("multi-channel composes workerMemberId from imageId:chN", () => {
    const tracker = new DeliveryTracker();
    const { client, volumeChunkData } = makeMockClient();
    const stats = emptyUploadTickStats();
    const targetByImage = new Map<string, number>([["img-0", 1]]);
    const manifestByImage = new Map<string, ManifestEntry>([
      ["img-0", makeMeta("img-0")],
    ]);
    runDrainPass({
      deliveries: [makeChunk({ c: 2 })],
      targetByImage,
      manifestByImage,
      tracker,
      client,
      multiChannel: true,
      viewMode: "volume",
      sliceZ: null,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 1024,
    });

    expect(volumeChunkData).toHaveBeenCalledTimes(1);
    expect(volumeChunkData.mock.calls[0][0]).toBe("img-0:ch2");
    expect(tracker.wasChunkSent("img-0:ch2", "1/0/0/0/0/0")).toBe(true);
  });
});
