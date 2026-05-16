/**
 * Tests for `classifyChunkResend` / `classifyProxyResend` (pure dedup
 * filters) and the `runChunkResendPass` / `runProxyResendPass` loops.
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChunkRequest,
  ProxyRequest,
} from "../../planning/index.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
} from "../../fetch/index.ts";
import type { RenderClient } from "../../../renderer/renderClient.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { emptyUploadTickStats } from "../../../debug/debugStats.ts";
import {
  classifyChunkResend,
  classifyProxyResend,
  runChunkResendPass,
  runProxyResendPass,
} from "./resend.ts";
import { DeliveryTracker } from "./tracker.ts";
import type { ManifestEntry } from "./manifestIndex.ts";
import type { ImageSpec } from "../../../manifestTypes.ts";
import { proxyKeyFromRequest } from "../proxyKeys.ts";

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

function makeChunkReq(overrides: Partial<ChunkRequest> = {}): ChunkRequest {
  return {
    datasetId: "ds1",
    entityId: "field-0",
    imageId: "img-0",
    level: 1,
    t: 0, c: 0, z: 0, y: 0, x: 0,
    lane: "detail",
    priority: 0,
    chunkKey: "1/0/0/0/0/0",
    ...overrides,
  };
}

function makeProxyReq(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    datasetId: "ds1",
    entityId: "field-0",
    imageId: "img-0",
    kind: "FieldProxy3D",
    t: 0,
    c: 0,
    priority: 0,
    ...overrides,
  };
}

function makeChunkDelivery(
  req: ChunkRequest,
  byteLength = 128,
): ReadyChunkDelivery {
  return {
    kind: "chunk",
    entityId: req.entityId,
    imageId: req.imageId,
    level: req.level,
    t: req.t, c: req.c, z: req.z, y: req.y, x: req.x,
    chunkKey: req.chunkKey,
    data: new ArrayBuffer(byteLength),
    dataType: "uint16",
    epochs: EPOCHS,
    lane: req.lane,
  };
}

function makeProxyDelivery(
  req: ProxyRequest,
  byteLength = 256,
): ReadyProxyDelivery {
  return {
    kind: "proxy",
    datasetId: req.datasetId,
    entityId: req.entityId,
    imageId: req.imageId,
    proxyKind: req.kind,
    t: req.t,
    c: req.c,
    header: {
      algorithmVersion: 1,
      sourceContentHash: new Uint8Array(32),
      dims: [4, 4, 4],
      dtype: "u16",
    },
    data: new ArrayBuffer(byteLength),
    epochs: EPOCHS,
  };
}

function makeMockCache(opts?: {
  chunks?: Map<string, ReadyChunkDelivery>;
  proxies?: Map<string, ReadyProxyDelivery>;
}): CpuCache {
  const chunks = opts?.chunks ?? new Map();
  const proxies = opts?.proxies ?? new Map();
  return {
    getCachedChunk: vi.fn((entityId: string, chunkKey: string) => {
      return chunks.get(`${entityId}|${chunkKey}`) ?? null;
    }),
    getCachedProxy: vi.fn(
      (datasetId: string, entityId: string, kind: string, t: number, c: number) => {
        return proxies.get(`${datasetId}|${entityId}|${kind}|${t}|${c}`) ?? null;
      },
    ),
  } as unknown as CpuCache;
}

function makeMockClient(): {
  client: RenderClient;
  sliceChunkData: ReturnType<typeof vi.fn>;
  proxyAssetData: ReturnType<typeof vi.fn>;
} {
  const sliceChunkData = vi.fn();
  const proxyAssetData = vi.fn();
  return {
    client: {
      sliceChunkData,
      volumeChunkData: vi.fn(),
      proxyAssetData,
    } as unknown as RenderClient,
    sliceChunkData,
    proxyAssetData,
  };
}

// ---------------------------------------------------------------------------
// classifyChunkResend
// ---------------------------------------------------------------------------

describe("classifyChunkResend", () => {
  it("prefetch → skip prefetch", () => {
    const req = makeChunkReq({ lane: "prefetch" });
    const verdict = classifyChunkResend(req, "img-0", new DeliveryTracker(), makeMockCache());
    expect(verdict).toEqual({ action: "skip", reason: "prefetch" });
  });

  it("already-sent → skip alreadySent", () => {
    const req = makeChunkReq();
    const t = new DeliveryTracker();
    t.markChunkSent("img-0", "field-0", req.chunkKey);
    const verdict = classifyChunkResend(req, "img-0", t, makeMockCache());
    expect(verdict).toEqual({ action: "skip", reason: "alreadySent" });
  });

  it("rejected → skip rejected", () => {
    const req = makeChunkReq();
    const t = new DeliveryTracker();
    t.markChunkEvicted("img-0", [], [req.chunkKey]);
    const verdict = classifyChunkResend(req, "img-0", t, makeMockCache());
    expect(verdict).toEqual({ action: "skip", reason: "rejected" });
  });

  it("not in cache → skip notCached", () => {
    const req = makeChunkReq();
    const verdict = classifyChunkResend(req, "img-0", new DeliveryTracker(), makeMockCache());
    expect(verdict).toEqual({ action: "skip", reason: "notCached" });
  });

  it("happy path → send with cached delivery", () => {
    const req = makeChunkReq();
    const cached = makeChunkDelivery(req);
    const cache = makeMockCache({
      chunks: new Map([[`${req.entityId}|${req.chunkKey}`, cached]]),
    });
    const verdict = classifyChunkResend(req, "img-0", new DeliveryTracker(), cache);
    expect(verdict).toEqual({ action: "send", cached });
  });
});

// ---------------------------------------------------------------------------
// classifyProxyResend
// ---------------------------------------------------------------------------

describe("classifyProxyResend", () => {
  it("already delivered → skip alreadyDelivered", () => {
    const req = makeProxyReq();
    const t = new DeliveryTracker();
    t.markProxyDelivered(proxyKeyFromRequest(req));
    const verdict = classifyProxyResend(req, t, makeMockCache());
    expect(verdict).toEqual({ action: "skip", reason: "alreadyDelivered" });
  });

  it("not in cache → skip notCached", () => {
    const req = makeProxyReq();
    const verdict = classifyProxyResend(req, new DeliveryTracker(), makeMockCache());
    expect(verdict).toEqual({ action: "skip", reason: "notCached" });
  });

  it("happy path → send with cached delivery", () => {
    const req = makeProxyReq();
    const cached = makeProxyDelivery(req);
    const cache = makeMockCache({
      proxies: new Map([[proxyKeyFromRequest(req), cached]]),
    });
    const verdict = classifyProxyResend(req, new DeliveryTracker(), cache);
    expect(verdict).toEqual({ action: "send", cached });
  });
});

// ---------------------------------------------------------------------------
// runChunkResendPass
// ---------------------------------------------------------------------------

describe("runChunkResendPass", () => {
  it("resends a cached not-yet-sent chunk and bumps resendChunkUploads", () => {
    const req = makeChunkReq();
    const cached = makeChunkDelivery(req);
    const cache = makeMockCache({
      chunks: new Map([[`${req.entityId}|${req.chunkKey}`, cached]]),
    });
    const tracker = new DeliveryTracker();
    const { client, sliceChunkData } = makeMockClient();
    const stats = emptyUploadTickStats();
    const events: Array<{ bytes: number; isResend: boolean }> = [];

    const out = runChunkResendPass({
      requestsByDataset: new Map([["ds1", [req]]]),
      manifestByImage: new Map([["img-0", makeMeta("img-0")]]),
      tracker,
      cpuCache: cache,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: (bytes, isResend) => events.push({ bytes, isResend }),
      remaining: 1024,
    });

    expect(out.budgetExhausted).toBe(false);
    expect(stats.resendChunksConsidered).toBe(1);
    expect(stats.resendChunkUploads).toBe(1);
    expect(events).toEqual([{ bytes: 128, isResend: true }]);
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
  });

  it("skip-reason counters increment per dedup branch (alreadySent / rejected / notCached / prefetch)", () => {
    const reqs: ChunkRequest[] = [
      makeChunkReq({ chunkKey: "a", lane: "prefetch" }),       // prefetch
      makeChunkReq({ chunkKey: "b" }),                          // alreadySent
      makeChunkReq({ chunkKey: "c" }),                          // rejected
      makeChunkReq({ chunkKey: "d" }),                          // notCached
    ];
    const tracker = new DeliveryTracker();
    tracker.markChunkSent("img-0", "field-0", "b");
    tracker.markChunkEvicted("img-0", [], ["c"]);
    const cache = makeMockCache();
    const { client } = makeMockClient();
    const stats = emptyUploadTickStats();

    runChunkResendPass({
      requestsByDataset: new Map([["ds1", reqs]]),
      manifestByImage: new Map([["img-0", makeMeta("img-0")]]),
      tracker,
      cpuCache: cache,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 1024,
    });

    // prefetch is NOT counted as considered (matches the inline pre-#616 behavior).
    expect(stats.resendChunksConsidered).toBe(3);
    expect(stats.resendChunksAlreadySent).toBe(1);
    expect(stats.resendChunksRejected).toBe(1);
    expect(stats.resendChunksNotCached).toBe(1);
    expect(stats.resendChunkUploads).toBe(0);
  });

  it("iterates every dataset in the per-dataset map (#613 multi-dataset)", () => {
    const reqA = makeChunkReq({ chunkKey: "a", imageId: "img-a" });
    const reqB = makeChunkReq({ chunkKey: "b", imageId: "img-b", entityId: "field-1" });
    const cache = makeMockCache({
      chunks: new Map([
        [`${reqA.entityId}|${reqA.chunkKey}`, makeChunkDelivery(reqA)],
        [`${reqB.entityId}|${reqB.chunkKey}`, makeChunkDelivery(reqB)],
      ]),
    });
    const tracker = new DeliveryTracker();
    const { client, sliceChunkData } = makeMockClient();
    const stats = emptyUploadTickStats();

    runChunkResendPass({
      requestsByDataset: new Map([
        ["dsA", [reqA]],
        ["dsB", [reqB]],
      ]),
      manifestByImage: new Map([
        ["img-a", makeMeta("img-a")],
        ["img-b", makeMeta("img-b")],
      ]),
      tracker,
      cpuCache: cache,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 1024,
    });

    expect(stats.resendChunkUploads).toBe(2);
    expect(sliceChunkData).toHaveBeenCalledTimes(2);
  });

  it("budget exhaustion stops both inner and outer loops", () => {
    const reqA = makeChunkReq({ chunkKey: "a" });
    const reqB = makeChunkReq({ chunkKey: "b" });
    const cache = makeMockCache({
      chunks: new Map([
        [`${reqA.entityId}|${reqA.chunkKey}`, makeChunkDelivery(reqA)],
        [`${reqB.entityId}|${reqB.chunkKey}`, makeChunkDelivery(reqB)],
      ]),
    });
    const tracker = new DeliveryTracker();
    const { client } = makeMockClient();
    const stats = emptyUploadTickStats();

    const out = runChunkResendPass({
      requestsByDataset: new Map([["ds1", [reqA, reqB]]]),
      manifestByImage: new Map([["img-0", makeMeta("img-0")]]),
      tracker,
      cpuCache: cache,
      client,
      multiChannel: false,
      viewMode: "slice",
      sliceZ: 0,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 100, // first 128-byte send exhausts
    });

    expect(out.budgetExhausted).toBe(true);
    expect(stats.resendChunkUploads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runProxyResendPass
// ---------------------------------------------------------------------------

describe("runProxyResendPass", () => {
  it("resends a cached not-yet-delivered proxy", () => {
    const req = makeProxyReq();
    const cached = makeProxyDelivery(req);
    const cache = makeMockCache({
      proxies: new Map([[proxyKeyFromRequest(req), cached]]),
    });
    const tracker = new DeliveryTracker();
    const { client, proxyAssetData } = makeMockClient();
    const stats = emptyUploadTickStats();
    const events: Array<{ bytes: number; isResend: boolean }> = [];

    const out = runProxyResendPass({
      requestsByDataset: new Map([["ds1", [req]]]),
      tracker,
      cpuCache: cache,
      client,
      epochs: EPOCHS,
      stats,
      recordUpload: (bytes, isResend) => events.push({ bytes, isResend }),
      remaining: 1024,
    });

    expect(out.budgetExhausted).toBe(false);
    expect(stats.resendProxiesConsidered).toBe(1);
    expect(stats.resendProxyUploads).toBe(1);
    expect(events).toEqual([{ bytes: 256, isResend: true }]);
    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(tracker.wasProxyDelivered(proxyKeyFromRequest(req))).toBe(true);
  });

  it("alreadyDelivered + notCached skip counters increment without dispatch", () => {
    const reqA = makeProxyReq({ entityId: "field-a" });
    const reqB = makeProxyReq({ entityId: "field-b" });
    const tracker = new DeliveryTracker();
    tracker.markProxyDelivered(proxyKeyFromRequest(reqA));
    const cache = makeMockCache();
    const { client, proxyAssetData } = makeMockClient();
    const stats = emptyUploadTickStats();

    runProxyResendPass({
      requestsByDataset: new Map([["ds1", [reqA, reqB]]]),
      tracker,
      cpuCache: cache,
      client,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 1024,
    });

    expect(stats.resendProxiesConsidered).toBe(2);
    expect(stats.resendProxiesAlreadyDelivered).toBe(1);
    expect(stats.resendProxiesNotCached).toBe(1);
    expect(proxyAssetData).not.toHaveBeenCalled();
  });

  it("iterates every dataset in the per-dataset map (#613)", () => {
    const reqA = makeProxyReq({ datasetId: "dsA" });
    const reqB = makeProxyReq({ datasetId: "dsB", entityId: "field-1" });
    const cache = makeMockCache({
      proxies: new Map([
        [proxyKeyFromRequest(reqA), makeProxyDelivery(reqA)],
        [proxyKeyFromRequest(reqB), makeProxyDelivery(reqB)],
      ]),
    });
    const tracker = new DeliveryTracker();
    const { client, proxyAssetData } = makeMockClient();
    const stats = emptyUploadTickStats();

    runProxyResendPass({
      requestsByDataset: new Map([
        ["dsA", [reqA]],
        ["dsB", [reqB]],
      ]),
      tracker,
      cpuCache: cache,
      client,
      epochs: EPOCHS,
      stats,
      recordUpload: () => {},
      remaining: 1024,
    });

    expect(stats.resendProxyUploads).toBe(2);
    expect(proxyAssetData).toHaveBeenCalledTimes(2);
  });
});
