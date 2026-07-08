import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest } from "../../manifestTypes.ts";
import type { DatasetEntry, TickContext } from "../../renderLoopTypes.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyDelivery,
  ReadyProxyDelivery,
} from "../fetch/index.ts";
import type { ActiveSetEntry } from "../planning/index.ts";
import { AssetCatalog } from "../assetCatalog.ts";
import type {
  ColdStateMessage,
  MissingChunk,
  MissingProxy,
} from "../../renderer/workerProtocol.ts";

function createMockAssetCatalog(): AssetCatalog {
  return new AssetCatalog({ apply_asset_catalog_delta: () => {} });
}

interface MockSceneConfig {
  epochs: { content: number; layout: number; view: number; selection: number };
  viewQuery: {
    visible_entities: {
      entity_id: string;
      image_id: string;
      kind: string;
      visible: boolean;
      projected_diagonal_px: number;
      projected_area_px2: number;
      centroid_world: [number, number, number];
      ideal_target_lod: number;
      importance: number;
    }[];
  };
  memberPositions: Record<string, [number, number]>;
  visibleRegion: {
    xy_bounds: [number, number, number, number];
    z_range: [number, number];
    effective_zoom: number;
    sort_center: [number, number, number] | null;
    frustum_planes: [number, number, number, number][] | null;
  };
  t: number;
  c: number;
  z: number;
  multiChannel: boolean;
  datasetOrder: string[];
  allSettings: Record<string, unknown>;
}

function createMockScene(overrides?: Partial<MockSceneConfig>) {
  const config: MockSceneConfig = {
    epochs: { content: 1, layout: 1, view: 1, selection: 1 },
    viewQuery: {
      visible_entities: [
        {
          entity_id: "tile-0",
          image_id: "img-0",
          kind: "Tile",
          visible: true,
          projected_diagonal_px: 100,
          projected_area_px2: 10000,
          centroid_world: [0, 0, 0],
          ideal_target_lod: 0,
          importance: 1,
        },
      ],
    },
    memberPositions: { "tile-0": [0, 0] },
    visibleRegion: {
      xy_bounds: [0, 0, 1024, 1024],
      z_range: [0, 1],
      effective_zoom: 1,
      sort_center: null,
      frustum_planes: null,
    },
    t: 0,
    c: 0,
    z: 0,
    multiChannel: false,
    datasetOrder: ["ds1"],
    allSettings: {
      ds1: {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 1,
        gamma: 1,
        blend_mode: "alpha",
        channel_settings: [],
        channel_blend_mode: "additive",
      },
    },
    ...overrides,
  };

  return {
    epochs: () => JSON.stringify(config.epochs),
    view_query: () => JSON.stringify(config.viewQuery),
    member_positions: () => JSON.stringify(config.memberPositions),
    visible_region: () => JSON.stringify(config.visibleRegion),
    t: () => config.t,
    c: () => config.c,
    z: () => config.z,
    multi_channel: () => config.multiChannel,
    camera_mode: () => "slice",
    dataset_order: () => JSON.stringify(config.datasetOrder),
    all_dataset_settings: () => JSON.stringify(config.allSettings),
    set_viewport: () => {},
    set_z: () => {},
    set_t: () => {},
    set_c: () => {},
    center: () => new Float32Array([512, 512]),
    zoom: () => 1,
    member_model_matrix: () => {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    inv_member_model_matrix: () => {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    ray_hit_local_image: () => new Float32Array([0.25, 0.5, 0.75]),
  } as unknown;
}

function createMockContent(datasetId = "ds1"): DatasetManifest {
  return {
    dataset_id: datasetId,
    name: "test",
    kind: "Single",
    entities: [
      { id: "group-0", kind: "Group", parent: null, labels: {} },
      { id: "tile-0", kind: "Tile", parent: "group-0", labels: {} },
    ],
    transforms: [],
    images: [
      {
        image_id: "img-0",
        owner: "tile-0",
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
          ],
        },
      },
    ],
    source_layouts: [],
    default_layout_id: null,
  } as unknown as DatasetManifest;
}

function makeCpuCache(deliveries: ReadyDelivery[] = []): CpuCache {
  return {
    submit: vi.fn(),
    onPlanRebuildStart: vi.fn(),
    getDeliverable: vi.fn(function* () {
      yield* deliveries;
    }),
    markSent: vi.fn(),
    markRejected: vi.fn(),
    markChunkEvicted: vi.fn(),
    markChunkMissing: vi.fn(),
    markProxyMissing: vi.fn(),
    snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
    getCachedChunk: vi.fn(() => null),
    getCachedProxy: vi.fn(() => null),
    telemetry: vi.fn(),
    updateConfig: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    reset: vi.fn(),
    clearRejected: vi.fn(),
  } as unknown as CpuCache;
}

function makeChunkDelivery(overrides?: Partial<ReadyChunkDelivery>): ReadyChunkDelivery {
  return {
    kind: "chunk",
    entityId: "tile-0",
    imageId: "img-0",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: "0/0/0/0/0/0",
    data: new ArrayBuffer(1024),
    dataType: "uint16",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    lane: "detail",
    priority: 10,
    ...overrides,
  };
}

function makeProxyDelivery(overrides?: Partial<ReadyProxyDelivery>): ReadyProxyDelivery {
  return {
    kind: "proxy",
    datasetId: "ds1",
    entityId: "tile-0",
    imageId: "img-0",
    proxyKind: "TileProxy3D",
    t: 0,
    c: 0,
    header: {
      algorithmVersion: 1,
      sourceContentHash: new Uint8Array(32),
      dims: [4, 4, 4],
      dtype: "u16",
    },
    data: new ArrayBuffer(128),
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    priority: 5,
    ...overrides,
  };
}

function makeCtx(args: {
  cpuCache?: CpuCache;
  scene?: unknown;
  datasets?: Map<string, DatasetEntry>;
  client?: Partial<TickContext["client"]>;
  mode?: "slice" | "volume";
} = {}): TickContext {
  return {
    scene: args.scene ?? createMockScene(),
    datasets: args.datasets ?? new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContent() }],
    ]),
    client: {
      coldState: vi.fn(),
      viewHotState: vi.fn(),
      proxyAssetData: vi.fn(),
      sliceChunkData: vi.fn(),
      volumeChunkData: vi.fn(),
      removeLayerResources: vi.fn(),
      onChunksEvicted: null,
      onWantedSetDelta: null,
      ...args.client,
    } as TickContext["client"],
    canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
    mode: args.mode ?? "slice",
    renderScale: 1,
    cpuCache: args.cpuCache ?? makeCpuCache(),
    assetCatalog: createMockAssetCatalog(),
  } as TickContext;
}

describe("Uploader unified delivery", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let scopedDebugStats: typeof import("../../debug/debugStats.ts").debugStats;
  let originalEnabled: boolean;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    scopedDebugStats = (await import("../../debug/debugStats.ts")).debugStats;
    originalEnabled = scopedDebugStats.enabled;
    scopedDebugStats.enabled = true;
  });

  afterEach(() => {
    scopedDebugStats.enabled = originalEnabled;
  });

  it("dispatches deliverables from CpuCache and marks sent only after dispatch", () => {
    const chunk = makeChunkDelivery();
    const proxy = makeProxyDelivery();
    const cpuCache = makeCpuCache([proxy, chunk]);
    const markSent = cpuCache.markSent as ReturnType<typeof vi.fn>;
    const sliceChunkData = vi.fn();
    const proxyAssetData = vi.fn();
    const ctx = makeCtx({
      cpuCache,
      client: { sliceChunkData, proxyAssetData },
    });

    const ret = new Uploader().deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    expect(markSent.mock.calls.map(c => c[0])).toEqual([proxy, chunk]);
    expect(scopedDebugStats.upload!.tick!.uploadedProxies).toBe(1);
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(1);
    expect(ret).toBe(true);
  });

  it("does not mark a chunk sent when manifest metadata is missing", () => {
    const chunk = makeChunkDelivery({ imageId: "ghost" });
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    new Uploader().deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(cpuCache.markSent).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedNoMeta).toBe(1);
  });

  it("preserves the one-item soft budget cap", () => {
    const large = makeChunkDelivery({
      data: new ArrayBuffer(4 * 1024 * 1024),
      priority: 1,
    });
    const smallerLowerPriority = makeChunkDelivery({
      chunkKey: "0/0/0/0/0/1",
      data: new ArrayBuffer(64),
      priority: 100,
    });
    const cpuCache = makeCpuCache([large, smallerLowerPriority]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    const ret = new Uploader().deliverToWorker(ctx, 1 * 1024 * 1024, 0);

    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    expect(sliceChunkData.mock.calls[0][1][0].key).toBe(large.chunkKey);
    expect(scopedDebugStats.upload!.tick!.budgetExhausted).toBe(true);
    expect(scopedDebugStats.upload!.tick!.bytesUploaded).toBe(4 * 1024 * 1024);
    expect(ret).toBe(true);
  });

  it("splits upload budget across detail and coarse when both tiers have deliverables", () => {
    const largeDetail = makeChunkDelivery({
      data: new ArrayBuffer(700),
      priority: 1,
      residencyTier: "detail",
      lane: "detail",
    });
    const secondDetail = makeChunkDelivery({
      chunkKey: "0/0/0/0/0/1",
      data: new ArrayBuffer(100),
      priority: 2,
      residencyTier: "detail",
      lane: "detail",
    });
    const coarse = makeChunkDelivery({
      chunkKey: "0/0/0/0/0/2",
      data: new ArrayBuffer(100),
      priority: 100,
      residencyTier: "coarse",
      lane: "coarse",
    });
    const cpuCache = makeCpuCache([largeDetail, secondDetail, coarse]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    new Uploader().deliverToWorker(ctx, 1000, 0);

    expect(sliceChunkData).toHaveBeenCalledTimes(2);
    expect(sliceChunkData.mock.calls.map((call) => call[1][0].key)).toEqual([
      largeDetail.chunkKey,
      coarse.chunkKey,
    ]);
    expect((cpuCache.markSent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      largeDetail,
      coarse,
    ]);
  });

  it("reports real posted bytes against the caller's budget for the panel header", () => {
    const chunk = makeChunkDelivery({ data: new ArrayBuffer(2048) });
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    new Uploader().deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(scopedDebugStats.uploadBytesUsed).toBe(2048);
    expect(scopedDebugStats.uploadBudgetTotal).toBe(8 * 1024 * 1024);
    expect(scopedDebugStats.budgetExhausted).toBe(false);
  });

  it("flags the panel header when the upload budget is exhausted", () => {
    const chunk = makeChunkDelivery({ data: new ArrayBuffer(2048) });
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    new Uploader().deliverToWorker(ctx, 1024, 0);

    expect(scopedDebugStats.uploadBytesUsed).toBe(2048);
    expect(scopedDebugStats.budgetExhausted).toBe(true);
  });

  it("skips telemetry aggregation when neither the panel nor the orch category is on", () => {
    // debugStats.enabled=false + no `orch` log category (node env has no
    // localStorage, so no categories) → orchTelemetryActive() is false.
    scopedDebugStats.enabled = false;
    const chunk = makeChunkDelivery();
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    const ret = new Uploader().deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    // The send loop itself is unaffected by the telemetry gate.
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    expect(cpuCache.markSent).toHaveBeenCalledTimes(1);
    expect(ret).toBe(true);
    // No rolling-window aggregation was published.
    expect(scopedDebugStats.upload.tick).toBeNull();
    expect(scopedDebugStats.upload.rolling).toBeNull();
  });

  it("tracks worker member ids for lifecycle cleanup without using delivery state", () => {
    const cpuCache = makeCpuCache([makeChunkDelivery({ c: 2 })]);
    const sliceChunkData = vi.fn();
    const scene = createMockScene({ multiChannel: true });
    const uploader = new Uploader();

    uploader.deliverToWorker(
      makeCtx({ cpuCache, scene, client: { sliceChunkData } }),
      8 * 1024 * 1024,
      0,
    );

    expect(sliceChunkData.mock.calls[0][0]).toBe("img-0:ch2");
    expect(uploader.getTrackedResourceMemberIds()).toEqual(["img-0:ch2"]);
    uploader.clearMember("img-0:ch2");
    expect(uploader.getTrackedResourceMemberIds()).toEqual([]);
  });
});

describe("Uploader worker feedback", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
  });

  it("forwards chunk eviction feedback to CpuCache by image/channel", () => {
    const cpuCache = makeCpuCache();
    new Uploader().handleChunksEvicted(
      "img-0:ch1",
      ["0/0/1/0/0/0"],
      ["0/0/1/0/0/1"],
      cpuCache,
    );

    expect(cpuCache.markChunkEvicted).toHaveBeenCalledWith(
      "img-0",
      1,
      ["0/0/1/0/0/0"],
      ["0/0/1/0/0/1"],
    );
  });

  it("clears missing proxy sent state through CpuCache", () => {
    const cpuCache = makeCpuCache();
    const missing: MissingProxy = {
      kind: "proxy",
      datasetId: "ds1",
      entityId: "tile-0",
      proxyKind: "TileProxy3D",
      t: 0,
      c: 2,
    };

    new Uploader().handleWantedSetDelta("ds1", [missing], cpuCache);

    expect(cpuCache.markProxyMissing).toHaveBeenCalledWith(
      "ds1|tile-0|TileProxy3D|0|2",
    );
  });

  it("clears missing chunk sent state through CpuCache", () => {
    const cpuCache = makeCpuCache();
    const missing: MissingChunk = {
      kind: "chunk",
      datasetId: "ds1",
      entityId: "tile-0",
      memberId: "img-0:ch2",
      c: 2,
      chunkKey: "0/0/2/0/0/0",
    };

    new Uploader().handleWantedSetDelta("ds1", [missing], cpuCache);

    expect(cpuCache.markChunkMissing).toHaveBeenCalledWith(
      "img-0",
      2,
      "0/0/2/0/0/0",
    );
  });
});

describe("Uploader cold and hot state", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let TickCoordinator: typeof import("../tickCoordinator.ts").TickCoordinator;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    TickCoordinator = (await import("../tickCoordinator.ts")).TickCoordinator;
  });

  it("populates display state by channel from dataset settings", () => {
    const scene = createMockScene({
      c: 1,
      allSettings: {
        ds1: {
          visible: true,
          opacity: 0.6,
          contrast_min: 0,
          contrast_max: 65535,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [
            { visible: true, colormap: "magenta", contrast_min: 10, contrast_max: 100, gamma: 1.1 },
            { visible: true, colormap: "viridis", contrast_min: 50, contrast_max: 500, gamma: 1.5 },
          ],
          channel_blend_mode: "additive",
        },
      },
    });
    const coldState = vi.fn();
    const cpuCache = makeCpuCache();
    const uploader = new Uploader();
    const orch = new TickCoordinator(uploader);

    orch.planAndFetch(makeCtx({ scene, cpuCache, client: { coldState } }), new Map());

    expect(cpuCache.onPlanRebuildStart).toHaveBeenCalledTimes(1);
    const cold = coldState.mock.calls[0][0] as ColdStateMessage;
    const display = cold.activeSet[0].displayStateByChannel[1];
    expect(display.contrastMin).toBe(50);
    expect(display.contrastMax).toBe(500);
    expect(display.gamma).toBe(1.5);
    expect(display.opacity).toBe(0.6);
    expect(display.colormapName).toBe("viridis");
  });

  it("emits one viewHotState per dataset and skips unchanged view epochs", () => {
    const scene = createMockScene();
    const viewHotState = vi.fn();
    const uploader = new Uploader();
    const orch = new TickCoordinator(uploader);
    const ctx = makeCtx({ scene, client: { viewHotState } });

    orch.planAndFetch(ctx, new Map());
    orch.planAndFetch(ctx, new Map());

    expect(viewHotState).toHaveBeenCalledTimes(1);
    expect(viewHotState.mock.calls[0][0].rayHitsByEntity[0][1]).toEqual([0.25, 0.5, 0.75]);
  });

  it("sends cold state for each visible dataset", () => {
    const scene = createMockScene({
      datasetOrder: ["ds1", "ds2"],
      allSettings: {
        ds1: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 1,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [],
          channel_blend_mode: "additive",
        },
        ds2: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 1,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [],
          channel_blend_mode: "additive",
        },
      },
    });
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContent("ds1") }],
      ["ds2", { manifest: createMockContent("ds2") }],
    ]);
    const coldState = vi.fn();

    new TickCoordinator(new Uploader()).planAndFetch(
      makeCtx({ scene, datasets, client: { coldState } }),
      new Map(),
    );

    expect(coldState.mock.calls.map(c => (c[0] as ColdStateMessage).datasetId)).toEqual([
      "ds1",
      "ds2",
    ]);
  });

  it("does not require uploader plan-staging hooks", () => {
    const methods = Object.getOwnPropertyNames(Uploader.prototype);
    expect(methods).not.toContain("recordPlanForDataset");
    expect(methods).not.toContain("onPlanRebuildStart");
  });

  it("still includes active-set entries for planning integration", () => {
    const coldState = vi.fn();
    new TickCoordinator(new Uploader()).planAndFetch(
      makeCtx({ client: { coldState } }),
      new Map(),
    );
    const cold = coldState.mock.calls[0][0] as ColdStateMessage;
    expect((cold.activeSet[0] as ActiveSetEntry).entityId).toBe("tile-0");
  });
});
