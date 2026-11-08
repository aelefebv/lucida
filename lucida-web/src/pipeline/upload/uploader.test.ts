import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest } from "../../manifestTypes.ts";
import type { DatasetEntry, TickContext } from "../../renderLoopTypes.ts";
import { resolvedLayersJson } from "../../resolvedLayerFixtures.ts";
import type { CpuCache, FailedChunk, ReadyChunkDelivery } from "../fetch/index.ts";
import type {
  ColdStateMessage,
  FailedChunksMessage,
  MissingChunk,
} from "../../renderer/workerProtocol.ts";

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
      target_level: number;
      level_pinned: boolean;
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
  z: number;
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
          target_level: 0,
          level_pinned: false,
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
    z: 0,
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
    view_query_delta: () => JSON.stringify({ Full: config.viewQuery }),
    member_positions: () => JSON.stringify(config.memberPositions),
    visible_region: () => JSON.stringify(config.visibleRegion),
    t: () => config.t,
    z: () => config.z,
    resolved_layers: () => resolvedLayersJson(config.datasetOrder, config.allSettings, config),
    camera_mode: () => "slice",
    dataset_order: () => JSON.stringify(config.datasetOrder),
    all_dataset_settings: () => JSON.stringify(config.allSettings),
    set_viewport: () => {},
    set_z: () => {},
    set_t: () => {},
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

function makeCpuCache(deliveries: ReadyChunkDelivery[] = []): CpuCache {
  return {
    submit: vi.fn(),
    onPlanRebuildStart: vi.fn(),
    tierCapacity: vi.fn(() => ({ detail: Infinity, coarse: Infinity })),
    getDeliverable: vi.fn(function* () {
      yield* deliveries;
    }),
    markSent: vi.fn(),
    markRejected: vi.fn(),
    markChunksHeld: vi.fn(),
    markChunksRefused: vi.fn(),
    markChunksLost: vi.fn(),
    markChunkMissing: vi.fn(() => false),

    snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
    levelResidency: vi.fn(() => ({ cached: [], inFlight: [] })),
    getCachedChunk: vi.fn(() => null),

    telemetry: vi.fn(),
    updateConfig: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    reset: vi.fn(),
    clearRejected: vi.fn(),
  } as unknown as CpuCache;
}

function makeChunkDelivery(overrides?: Partial<ReadyChunkDelivery>): ReadyChunkDelivery {
  return {
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
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    lane: "detail",
    residencyTier: "detail",
    priority: 10,
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
      gpuCapacity: () => null,
      viewHotState: vi.fn(),

      sliceChunkData: vi.fn(),
      volumeChunkData: vi.fn(),
      removeLayerResources: vi.fn(),
      datasetLevels: vi.fn(() => null),
      onChunkResidency: null,
      onWantedSetDelta: null,
      ...args.client,
    } as TickContext["client"],
    canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
    mode: args.mode ?? "slice",
    renderScale: 1,
    resolutionScale: 1,
    cpuCache: args.cpuCache ?? makeCpuCache(),
  } as TickContext;
}

describe("Uploader unified delivery", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let priorLocalStorage: unknown;

  /**
   * The per-tick stats are handed to `UploadTelemetry.publish`, which the
   * Uploader calls only while the `orch` log category is on. Open the
   * category with an in-memory `localStorage` shim and read the stats off
   * the spy.
   */
  function captureTickStats(uploader: InstanceType<typeof Uploader>) {
    return vi.spyOn(uploader.uploadTelemetry, "publish");
  }

  beforeEach(async () => {
    const store = new Map<string, string>();
    priorLocalStorage = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    localStorage.setItem("debug", "orch");
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).localStorage = priorLocalStorage;
  });

  it("dispatches deliverables from CpuCache and marks sent only after dispatch", () => {
    const chunk = makeChunkDelivery();
    const cpuCache = makeCpuCache([chunk]);
    const markSent = cpuCache.markSent as ReturnType<typeof vi.fn>;
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({
      cpuCache,
      client: { sliceChunkData },
    });

    const uploader = new Uploader();
    const publish = captureTickStats(uploader);
    const ret = uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);

    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    expect(markSent.mock.calls.map(c => c[0])).toEqual([chunk]);
    expect(publish.mock.calls[0][1].uploadedChunks).toBe(1);
    expect(ret).toBe(true);
  });

  it("does not mark a chunk sent when manifest metadata is missing", () => {
    const chunk = makeChunkDelivery({ imageId: "ghost" });
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    const uploader = new Uploader();
    const publish = captureTickStats(uploader);
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);

    expect(sliceChunkData).not.toHaveBeenCalled();
    expect(cpuCache.markSent).not.toHaveBeenCalled();
    expect(publish.mock.calls[0][1].skippedNoMeta).toBe(1);
  });

  it("stops re-sending a chunk the worker keeps handing back, names it in the trace, and retries after a cold state", async () => {
    const { traceRecorder } = await import("../../trace/recorder.ts");
    const { PointEvent } = await import("../../trace/types.ts");
    const { RESEND_GUARD_TICKS } = await import("./delivery/resendGuard.ts");
    const recordPointEvent = vi.spyOn(traceRecorder, "recordPointEvent");
    // The cache offers the chunk every tick, as it does when every delivery
    // comes back refused and clears its sent mark.
    const chunk = makeChunkDelivery({ chunkKey: "0/0/0/0/1/1", y: 1, x: 1 });
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({
      cpuCache: makeCpuCache([chunk]),
      client: { sliceChunkData, coldStateDisplay: vi.fn(), coldStateSelection: vi.fn() },
    });
    const uploader = new Uploader();

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);
    for (let i = 0; i < RESEND_GUARD_TICKS; i++) {
      uploader.handleChunkResidency("img-0", "detail", "refused", [chunk.chunkKey], ctx.cpuCache, "wrong-slice");
      uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);
    }
    expect(sliceChunkData).toHaveBeenCalledTimes(RESEND_GUARD_TICKS + 1);
    const held = recordPointEvent.mock.calls.filter(([kind]) => kind === PointEvent.Held);
    expect(held.map(([, reason, source]) => [reason, (source as ReadyChunkDelivery).chunkKey])).toEqual([
      ["wrong-slice", chunk.chunkKey],
    ]);

    // Held: the next ticks send nothing and ask for no further tick.
    expect(uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0)).toBe(false);
    expect(sliceChunkData).toHaveBeenCalledTimes(RESEND_GUARD_TICKS + 1);

    uploader.sendColdStateDisplay({ ctx, datasetId: "ds1", displayStateByChannel: {} });
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);
    expect(sliceChunkData).toHaveBeenCalledTimes(RESEND_GUARD_TICKS + 1);

    uploader.sendColdStateSelection({
      ctx,
      datasetId: "ds1",
      currentT: 0,
      currentZ: 1,
      requests: [],
      visibleRegion: { xyBoundsVox: [0, 0, 1, 1], zRangeVox: [1, 2], effectiveZoom: 1, sortCenterVox: null, frustumPlanes: null },
      epochs: { content: 1, layout: 1, view: 1, selection: 2, request: 1 },
    });
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);
    expect(sliceChunkData).toHaveBeenCalledTimes(RESEND_GUARD_TICKS + 2);
    recordPointEvent.mockRestore();
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

    const uploader = new Uploader();
    const publish = captureTickStats(uploader);
    const ret = uploader.deliverToWorker(ctx, 1 * 1024 * 1024, () => 0);

    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    expect(sliceChunkData.mock.calls[0][1][0].key).toBe(large.chunkKey);
    expect(publish.mock.calls[0][1].budgetExhausted).toBe(true);
    expect(publish.mock.calls[0][1].bytesUploaded).toBe(4 * 1024 * 1024);
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

    new Uploader().deliverToWorker(ctx, 1000, () => 0);

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

  it("reports real posted bytes against the caller's budget", () => {
    const chunk = makeChunkDelivery({ data: new ArrayBuffer(2048) });
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    const uploader = new Uploader();
    const publish = captureTickStats(uploader);
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);

    expect(publish.mock.calls[0][1].bytesUploaded).toBe(2048);
    expect(publish.mock.calls[0][1].bytesBudget).toBe(8 * 1024 * 1024);
    expect(publish.mock.calls[0][1].budgetExhausted).toBe(false);
  });

  it("flags the tick when the upload budget is exhausted", () => {
    const chunk = makeChunkDelivery({ data: new ArrayBuffer(2048) });
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    const uploader = new Uploader();
    const publish = captureTickStats(uploader);
    uploader.deliverToWorker(ctx, 1024, () => 0);

    expect(publish.mock.calls[0][1].bytesUploaded).toBe(2048);
    expect(publish.mock.calls[0][1].budgetExhausted).toBe(true);
  });

  it("skips telemetry aggregation when the orch category is off", async () => {
    // The `orch` log category is the only thing that turns the aggregators on.
    localStorage.removeItem("debug");
    // The category set is cached at module load; this is the documented
    // same-tab refresh path.
    (await import("../../debug/logging.ts")).refreshDebugCategories();
    const chunk = makeChunkDelivery();
    const cpuCache = makeCpuCache([chunk]);
    const sliceChunkData = vi.fn();
    const ctx = makeCtx({ cpuCache, client: { sliceChunkData } });

    const uploader = new Uploader();
    const publish = captureTickStats(uploader);
    const ret = uploader.deliverToWorker(ctx, 8 * 1024 * 1024, () => 0);

    // The send loop itself is unaffected by the telemetry gate.
    expect(sliceChunkData).toHaveBeenCalledTimes(1);
    expect(cpuCache.markSent).toHaveBeenCalledTimes(1);
    expect(ret).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it("tracks worker member ids for lifecycle cleanup without using delivery state", () => {
    const cpuCache = makeCpuCache([makeChunkDelivery({ c: 2 })]);
    const sliceChunkData = vi.fn();
    const scene = createMockScene();
    const uploader = new Uploader();

    uploader.deliverToWorker(
      makeCtx({ cpuCache, scene, client: { sliceChunkData } }),
      8 * 1024 * 1024,
      () => 0,
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

  it("forwards each residency report to CpuCache by image, channel and tier", () => {
    const cpuCache = makeCpuCache();
    const uploader = new Uploader();

    expect(uploader.handleChunkResidency("img-0:ch1", "detail", "held", ["0/0/1/0/0/0"], cpuCache)).toBe(false);
    expect(cpuCache.markChunksHeld).toHaveBeenCalledWith("img-0", 1, "detail", ["0/0/1/0/0/0"]);

    expect(uploader.handleChunkResidency("img-0:ch1", "coarse", "lost", ["2/0/1/0/0/0"], cpuCache, "evicted")).toBe(true);
    expect(cpuCache.markChunksLost).toHaveBeenCalledWith("img-0", 1, "coarse", ["2/0/1/0/0/0"], "evicted");

    // A full atlas waits for the next plan; any other refusal may go again now.
    expect(uploader.handleChunkResidency("img-0:ch1", "detail", "refused", ["0/0/1/0/0/1"], cpuCache, "atlas-policy")).toBe(false);
    expect(uploader.handleChunkResidency("img-0:ch1", "detail", "refused", ["0/0/1/0/0/2"], cpuCache, "stale")).toBe(true);
    expect(cpuCache.markChunksRefused).toHaveBeenCalledWith("img-0", 1, "detail", ["0/0/1/0/0/1"], "atlas-policy");
    expect(cpuCache.markChunksRefused).toHaveBeenCalledWith("img-0", 1, "detail", ["0/0/1/0/0/2"], "stale");
  });

  it("checks a missing chunk against the residency mirror, and asks for a tick only on a disagreement", () => {
    const cpuCache = makeCpuCache();
    const missing: MissingChunk = {
      datasetId: "ds1",
      tier: "detail",
      entityId: "tile-0",
      memberId: "img-0:ch2",
      c: 2,
      chunkKey: "0/0/2/0/0/0",
    };
    const uploader = new Uploader();

    expect(uploader.handleWantedSetDelta("ds1", [missing], cpuCache)).toBe(false);
    expect(cpuCache.markChunkMissing).toHaveBeenCalledWith("img-0", 2, "0/0/2/0/0/0", "detail");

    vi.mocked(cpuCache.markChunkMissing).mockReturnValue(true);
    expect(uploader.handleWantedSetDelta("ds1", [missing], cpuCache)).toBe(true);
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
    expect(cold.activeSet[0].entityId).toBe("tile-0");
  });
});

describe("Uploader failed chunks", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
  });

  function cacheFailing(state: { version: number; failed: FailedChunk[] }): CpuCache {
    const cpuCache = makeCpuCache();
    Object.assign(cpuCache, {
      failedChunksVersion: () => state.version,
      failedChunks: () => state.failed,
    });
    return cpuCache;
  }

  const failure = (datasetId: string, chunkKey: string): FailedChunk => ({
    datasetId, imageId: `${datasetId}-img`, chunkKey, failure: "corrupt_chunk",
  });

  it("tells the worker each dataset's failures when they change, and clears a dataset that has none left", () => {
    const state = { version: 0, failed: [] as FailedChunk[] };
    const failedChunks = vi.fn();
    const ctx = makeCtx({ cpuCache: cacheFailing(state), client: { failedChunks } });
    const uploader = new Uploader();

    expect(uploader.syncFailedChunks(ctx)).toBeNull();
    expect(failedChunks).not.toHaveBeenCalled();

    state.version = 1;
    state.failed = [failure("a", "0/0/0/0/0/0"), failure("b", "1/0/0/0/0/0"), failure("a", "0/0/0/0/0/1")];
    expect(uploader.syncFailedChunks(ctx)).toHaveLength(3);
    expect(failedChunks.mock.calls.map(([msg]) => msg as FailedChunksMessage)).toEqual([
      { type: "failedChunks", datasetId: "a", images: [{ imageId: "a-img", chunkKeys: ["0/0/0/0/0/0", "0/0/0/0/0/1"] }] },
      { type: "failedChunks", datasetId: "b", images: [{ imageId: "b-img", chunkKeys: ["1/0/0/0/0/0"] }] },
    ]);

    // An unchanged version costs nothing.
    failedChunks.mockClear();
    expect(uploader.syncFailedChunks(ctx)).toBeNull();

    // Only the dataset whose list moved is sent; one with none left is cleared.
    state.version = 2;
    state.failed = [failure("a", "0/0/0/0/0/1"), failure("a", "0/0/0/0/0/0")];
    uploader.syncFailedChunks(ctx);
    expect(failedChunks.mock.calls.map(([msg]) => msg as FailedChunksMessage)).toEqual([
      { type: "failedChunks", datasetId: "b", images: [] },
    ]);
  });

  it("sends a reopened dataset's failures again", () => {
    const state = { version: 1, failed: [failure("a", "0/0/0/0/0/0")] };
    const failedChunks = vi.fn();
    const ctx = makeCtx({ cpuCache: cacheFailing(state), client: { failedChunks } });
    const uploader = new Uploader();
    uploader.syncFailedChunks(ctx);
    uploader.clearDataset("a");
    state.version = 2;
    uploader.syncFailedChunks(ctx);
    expect(failedChunks).toHaveBeenCalledTimes(2);
  });
});
