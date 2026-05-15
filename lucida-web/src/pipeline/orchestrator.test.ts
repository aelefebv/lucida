import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { DatasetEntry } from "../renderLoopTypes.ts";
import type {
  CpuCache,
  ReadyProxyDelivery,
  ReadyDelivery,
} from "./cpuCache.ts";
import type { TickContext } from "../renderLoopTypes.ts";
import { AssetCatalog } from "./assetCatalog.ts";
import type { ProxyRequest } from "./planning/index.ts";
import type { ColdStateMessage, MissingProxy } from "../renderer/workerProtocol.ts";

/** Stub WASM scene that satisfies AssetCatalog's narrow interface. */
function createMockAssetCatalog(): AssetCatalog {
  return new AssetCatalog({ apply_asset_catalog_delta: () => {} });
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockCpuCache(): CpuCache {
  return {
    submit: vi.fn(),
    drain: vi.fn(() => []),
    snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
    getCached: vi.fn(() => null),
    telemetry: vi.fn(),
    updateConfig: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    reset: vi.fn(),
    markRejected: vi.fn(),
    clearRejected: vi.fn(),
  } as unknown as CpuCache;
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
          entity_id: "field-0",
          image_id: "img-0",
          kind: "Field",
          visible: true,
          projected_diagonal_px: 100,
          projected_area_px2: 10000,
          centroid_world: [0, 0, 0],
          ideal_target_lod: 0,
          importance: 1.0,
        },
      ],
    },
    memberPositions: { "field-0": [0, 0] },
    visibleRegion: {
      xy_bounds: [0, 0, 1024, 1024],
      z_range: [0, 1],
      effective_zoom: 1.0,
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
    view_query: (_dsId: string) => JSON.stringify(config.viewQuery),
    member_positions: (_dsId: string) => JSON.stringify(config.memberPositions),
    visible_region: (_dsId: string) => JSON.stringify(config.visibleRegion),
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
    zoom: () => 1.0,
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
    ray_hit_local_image: () => new Float32Array([0.5, 0.5, 0.5]),
  } as unknown;
}

function createMockContent(): DatasetManifest {
  return {
    dataset_id: "ds1",
    name: "test",
    kind: "Single",
    entities: [],
    transforms: [],
    images: [
      {
        image_id: "img-0",
        owner: "field-0",
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
      },
    ],
    source_layouts: [],
    default_layout_id: null,
  } as unknown as DatasetManifest;
}

// ===========================================================================
// 1. Epoch caching
// ===========================================================================

describe("epoch caching", () => {
  // We dynamically import and spy on plan() to verify caching behavior.
  // The Orchestrator should skip plan() when epochs haven't changed.

  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;
  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset modules so we can spy on plan() freshly.
    vi.resetModules();

    const planningModule = await import("./planning/index.ts");
    planSpy = vi.fn(planningModule.plan);

    // Mock the planning module's plan function.
    vi.doMock("./planning/index.ts", async () => {
      const actual = await import("./planning/index.ts");
      return { ...actual, plan: planSpy };
    });

    const orchestratorModule = await import("./orchestrator.ts");
    Orchestrator = orchestratorModule.Orchestrator;
  });

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  function makeOrchestratorDeps(epochOverrides?: Partial<{ content: number; layout: number; view: number; selection: number }>) {
    const scene = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 1, ...epochOverrides },
    });
    const manifest = createMockContent();
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest }],
    ]);

    return { scene, datasets, manifest };
  }

  const emptyMinimap = new Map<string, never[]>();

  it("calls plan() on the first invocation", () => {
    const { scene, datasets } = makeOrchestratorDeps();
    const orch = new Orchestrator();

    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("returns cached result when epochs are unchanged", () => {
    const { scene, datasets } = makeOrchestratorDeps();
    const orch = new Orchestrator();

    const ctx = makeCtx(scene, datasets);
    const result1 = orch.planAndFetch(ctx, emptyMinimap);
    planSpy.mockClear();

    const result2 = orch.planAndFetch(ctx, emptyMinimap);

    expect(planSpy).not.toHaveBeenCalled();
    expect(result2).toBe(result1);
  });

  it("re-plans when viewEpoch changes", () => {
    const { datasets } = makeOrchestratorDeps();
    const orch = new Orchestrator();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("re-plans when contentEpoch changes", () => {
    const { datasets } = makeOrchestratorDeps();
    const orch = new Orchestrator();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 2, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("re-plans when layoutEpoch changes", () => {
    const { datasets } = makeOrchestratorDeps();
    const orch = new Orchestrator();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 1, layout: 2, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("re-plans when selectionEpoch changes", () => {
    const { datasets } = makeOrchestratorDeps();
    const orch = new Orchestrator();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 2 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2. Multi-dataset
// ===========================================================================

describe("multi-dataset planning", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;
  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const planningModule = await import("./planning/index.ts");
    planSpy = vi.fn(planningModule.plan);

    vi.doMock("./planning/index.ts", async () => {
      const actual = await import("./planning/index.ts");
      return { ...actual, plan: planSpy };
    });

    const orchestratorModule = await import("./orchestrator.ts");
    Orchestrator = orchestratorModule.Orchestrator;
  });

  function makeMultiDatasetScene() {
    return createMockScene({
      datasetOrder: ["ds1", "ds2"],
      viewQuery: {
        visible_entities: [
          {
            entity_id: "field-0",
            image_id: "img-0",
            kind: "Field",
            visible: true,
            projected_diagonal_px: 100,
            projected_area_px2: 10000,
            centroid_world: [0, 0, 0],
            ideal_target_lod: 0,
            importance: 1.0,
          },
        ],
      },
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
  }

  function makeTwoDatasetEntries() {
    const content1 = createMockContent();
    const content2: DatasetManifest = {
      ...createMockContent(),
      dataset_id: "ds2",
      images: [
        {
          image_id: "img-1",
          owner: "field-0",
          multiscale: {
            axes: [],
            data_type: "uint16",
            levels: [
              {
                level_index: 0,
                shape: [1, 1, 1, 512, 512],
                chunk_shape: [1, 1, 1, 256, 256],
                grid_shape: [1, 1, 1, 2, 2],
                scale: [1, 1, 1, 1, 1],
              },
            ],
          },
        },
      ],
    } as unknown as DatasetManifest;

    return new Map<string, DatasetEntry>([
      ["ds1", { manifest: content1 }],
      ["ds2", { manifest: content2 }],
    ]);
  }

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  const emptyMinimap = new Map<string, never[]>();

  it("calls plan() once per dataset", () => {
    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    const orch = new Orchestrator();

    planSpy.mockClear();
    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    // 2 datasets → 2 plan() calls
    expect(planSpy).toHaveBeenCalledTimes(2);
  });

  it("merged result contains entries from both datasets", () => {
    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    const orch = new Orchestrator();

    const result = orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    expect(result).toBeDefined();
    expect(result).not.toBeNull();
  });

  it("tracks previousActiveSet independently per dataset", () => {
    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    const orch = new Orchestrator();

    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    planSpy.mockClear();
    const scene2 = createMockScene({
      datasetOrder: ["ds1", "ds2"],
      epochs: { content: 1, layout: 1, view: 2, selection: 1 },
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

    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(2);

    const call1Snapshot = planSpy.mock.calls[0][0];
    const call2Snapshot = planSpy.mock.calls[1][0];

    expect(call1Snapshot.previousActiveSet).toBeDefined();
    expect(call2Snapshot.previousActiveSet).toBeDefined();
    expect(Array.isArray(call1Snapshot.previousActiveSet)).toBe(true);
    expect(Array.isArray(call2Snapshot.previousActiveSet)).toBe(true);
  });
});

// ===========================================================================
// 3. Proxy delivery tracking (PRD #409 / S2)
// ===========================================================================

describe("proxy delivery tracking", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    const orchestratorModule = await import("./orchestrator.ts");
    Orchestrator = orchestratorModule.Orchestrator;
  });

  function makeProxyRequest(
    overrides?: Partial<ProxyRequest>,
  ): ProxyRequest {
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

  function makeProxyDelivery(
    overrides?: Partial<ReadyProxyDelivery>,
  ): ReadyProxyDelivery {
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
      data: new ArrayBuffer(128),
      epochs: {
        content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1,
      },
      ...overrides,
    };
  }

  function makeMockCpuCache(opts?: {
    drainResult?: ReadyDelivery[];
    cachedProxies?: Map<string, ReadyProxyDelivery>;
  }): CpuCache {
    const drained = opts?.drainResult ?? [];
    const cached = opts?.cachedProxies ?? new Map();
    return {
      submit: vi.fn(),
      // drain() consumed once per call
      drain: vi.fn(() => {
        const out = drained.slice();
        drained.length = 0;
        return out;
      }),
      snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
      getCached: vi.fn(() => null),
      getCachedProxy: vi.fn(
        (datasetId: string, entityId: string, kind: string, t: number, c: number) => {
          return cached.get(`${datasetId}|${entityId}|${kind}|${t}|${c}`) ?? null;
        },
      ),
      telemetry: vi.fn(),
      updateConfig: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      reset: vi.fn(),
      markRejected: vi.fn(),
      clearRejected: vi.fn(),
    } as unknown as CpuCache;
  }

  function makeCtx(opts: {
    cpuCache: CpuCache;
    proxyAssetDataMock?: ReturnType<typeof vi.fn>;
  }): TickContext {
    return {
      scene: {
        multi_channel: () => false,
      } as unknown,
      datasets: new Map(),
      client: {
        coldState: vi.fn(),
        viewHotState: vi.fn(),
        proxyAssetData: opts.proxyAssetDataMock ?? vi.fn(),
      } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: "slice",
      renderScale: 1,
      cpuCache: opts.cpuCache,
      assetCatalog: new AssetCatalog({ apply_asset_catalog_delta: () => {} }),
    } as unknown as TickContext;
  }

  function proxyKey(req: ProxyRequest | ReadyProxyDelivery): string {
    if ("kind" in req && req.kind === "proxy") {
      return `${req.datasetId}|${req.entityId}|${req.proxyKind}|${req.t}|${req.c}`;
    }
    const r = req as ProxyRequest;
    return `${r.datasetId}|${r.entityId}|${r.kind}|${r.t}|${r.c}`;
  }

  it("proxy delivery tracked after first send", () => {
    const orch = new Orchestrator();
    const delivery = makeProxyDelivery();
    const cpuCache = makeMockCpuCache({ drainResult: [delivery] });
    const proxyAssetData = vi.fn();
    const ctx = makeCtx({ cpuCache, proxyAssetDataMock: proxyAssetData });

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, null);

    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(orch.getProxyDeliveredKeys().has(proxyKey(delivery))).toBe(true);
  });

  it("proxy resend uses getCachedProxy when key missing from delivered set", () => {
    const orch = new Orchestrator();
    const delivery = makeProxyDelivery();
    const req = makeProxyRequest();

    // Pre-populate _lastProxyRequests so the resend pass has work to do.
    (orch as unknown as { _lastProxyRequests: ProxyRequest[] })._lastProxyRequests = [req];

    // Cache returns the proxy on getCachedProxy lookup.
    const cached = new Map<string, ReadyProxyDelivery>();
    cached.set(proxyKey(req), delivery);
    const cpuCache = makeMockCpuCache({ cachedProxies: cached });
    const proxyAssetData = vi.fn();
    const ctx = makeCtx({ cpuCache, proxyAssetDataMock: proxyAssetData });

    // First call: drain returns nothing (we left it empty), but the
    // resend pass should still pick up the cached proxy because the
    // key is missing from delivered tracking.
    orch.deliverToWorker(ctx, 8 * 1024 * 1024, null);
    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(orch.getProxyDeliveredKeys().has(proxyKey(req))).toBe(true);

    // Second call: key is now in delivered set → no resend.
    orch.deliverToWorker(ctx, 8 * 1024 * 1024, null);
    expect(proxyAssetData).toHaveBeenCalledTimes(1);

    // After explicit clear, resend kicks in again.
    orch.getProxyDeliveredKeys().delete(proxyKey(req));
    orch.deliverToWorker(ctx, 8 * 1024 * 1024, null);
    expect(proxyAssetData).toHaveBeenCalledTimes(2);
  });

  it("proxyDeliveredToWorker persists across full plans (worker proxy pools survive cold state)", async () => {
    // Worker proxy pools are not rebuilt on cold state (only chunk atlases
    // are). Re-sending proxies on every full plan would upload-spam them
    // every time a view epoch bumps (e.g., wheel scroll). Worker eviction
    // is reported via wantedSetDelta; that's the only signal that should
    // clear the tracking.
    const orch = new Orchestrator();

    const scene = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 1 },
    });
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContent() }],
    ]);
    const cpuCache = makeMockCpuCache();
    const ctx = {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: "slice",
      renderScale: 1,
      cpuCache,
      assetCatalog: new AssetCatalog({ apply_asset_catalog_delta: () => {} }),
    } as unknown as TickContext;

    orch.getProxyDeliveredKeys().add("ds1|x|FieldProxy3D|0|0");
    expect(orch.getProxyDeliveredKeys().size).toBe(1);

    orch.planAndFetch(ctx, new Map());
    expect(orch.getProxyDeliveredKeys().size).toBe(1);
  });

  it("handleWantedSetDelta with proxy entries clears delivered tracking", () => {
    const orch = new Orchestrator();
    const key = "ds1|field-0|FieldProxy3D|0|0";
    orch.getProxyDeliveredKeys().add(key);
    expect(orch.getProxyDeliveredKeys().has(key)).toBe(true);

    const missing: MissingProxy = {
      kind: "proxy",
      datasetId: "ds1",
      entityId: "field-0",
      proxyKind: "FieldProxy3D",
      t: 0,
      c: 0,
    };
    orch.handleWantedSetDelta([missing]);

    expect(orch.getProxyDeliveredKeys().has(key)).toBe(false);
  });
});

// ===========================================================================
// 4. M2: cold-state display state propagation
// ===========================================================================

describe("cold-state display state (M2)", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    const orchestratorModule = await import("./orchestrator.ts");
    Orchestrator = orchestratorModule.Orchestrator;
  });

  function makeCtxWithSpy(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
    coldStateSpy: ReturnType<typeof vi.fn>,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: coldStateSpy, viewHotState: vi.fn() } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  it("populates displayStateByChannel from per-channel settings on the active channel", () => {
    const orch = new Orchestrator();
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
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const coldStateSpy = vi.fn();
    orch.planAndFetch(makeCtxWithSpy(scene, datasets, coldStateSpy), new Map());

    expect(coldStateSpy).toHaveBeenCalledTimes(1);
    const cold = coldStateSpy.mock.calls[0][0] as ColdStateMessage;
    expect(cold.activeSet.length).toBeGreaterThan(0);
    const ds = cold.activeSet[0].displayStateByChannel[1];
    expect(ds).toBeDefined();
    expect(ds.contrastMin).toBe(50);
    expect(ds.contrastMax).toBe(500);
    expect(ds.gamma).toBe(1.5);
    expect(ds.opacity).toBe(0.6);
    expect(ds.colormapName).toBe("viridis");
    expect(ds.channelMask).toBe(1 << 1);
  });

  it("contrast change re-emits cold state when selectionEpoch bumps", async () => {
    // The dataset-settings cache is generation-keyed (`bumpSettingsGeneration`)
    // — the real codepath bumps it via `useDatasetSettings`. We bump
    // explicitly between the two ticks so the second `getSceneSettings`
    // call observes the new contrast value.
    const { bumpSettingsGeneration } = await import("../tickCommon.ts");
    const orch = new Orchestrator();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const sceneA = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 1 },
      allSettings: {
        ds1: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 1000,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [],
          channel_blend_mode: "additive",
        },
      },
    });
    const sceneB = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 2 },
      allSettings: {
        ds1: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 9999,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [],
          channel_blend_mode: "additive",
        },
      },
    });
    const spyA = vi.fn();
    const spyB = vi.fn();
    orch.planAndFetch(makeCtxWithSpy(sceneA, datasets, spyA), new Map());
    bumpSettingsGeneration();
    orch.planAndFetch(makeCtxWithSpy(sceneB, datasets, spyB), new Map());

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    const coldA = spyA.mock.calls[0][0] as ColdStateMessage;
    const coldB = spyB.mock.calls[0][0] as ColdStateMessage;
    expect(coldA.activeSet[0].displayStateByChannel[0].contrastMax).toBe(1000);
    expect(coldB.activeSet[0].displayStateByChannel[0].contrastMax).toBe(9999);
    expect(coldB.epochs.selection).toBe(2);
  });

  it("multi-channel emits per-channel display state for every visible channel", () => {
    const orch = new Orchestrator();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const scene = createMockScene({
      multiChannel: true,
      allSettings: {
        ds1: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 1,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [
            { visible: true, colormap: "magenta", contrast_min: 0, contrast_max: 100, gamma: 1 },
            { visible: true, colormap: "green",   contrast_min: 0, contrast_max: 200, gamma: 1.2 },
          ],
          channel_blend_mode: "additive",
        },
      },
    });
    const spy = vi.fn();
    orch.planAndFetch(makeCtxWithSpy(scene, datasets, spy), new Map());
    const cold = spy.mock.calls[0][0] as ColdStateMessage;
    expect(cold.visibleChannels).toEqual([0, 1]);
    const dsByCh = cold.activeSet[0].displayStateByChannel;
    expect(dsByCh[0].colormapName).toBe("magenta");
    expect(dsByCh[0].contrastMax).toBe(100);
    expect(dsByCh[1].colormapName).toBe("green");
    expect(dsByCh[1].contrastMax).toBe(200);
  });
});

// ===========================================================================
// 5. M3: viewHotState emission (per-viewEpoch ray-pick coords)
// ===========================================================================

describe("viewHotState emission (M3)", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    const orchestratorModule = await import("./orchestrator.ts");
    Orchestrator = orchestratorModule.Orchestrator;
  });

  function makeCtxWithViewHotSpy(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
    viewHotSpy: ReturnType<typeof vi.fn>,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: viewHotSpy } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  it("emits one viewHotState message per dataset on initial plan", () => {
    const orch = new Orchestrator();
    const scene = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const viewHotSpy = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(scene, datasets, viewHotSpy), new Map());
    expect(viewHotSpy).toHaveBeenCalledTimes(1);
    const msg = viewHotSpy.mock.calls[0][0];
    expect(msg.type).toBe("viewHotState");
    expect(msg.datasetId).toBe("ds1");
    expect(msg.epochs.view).toBe(1);
    expect(msg.rayHitsByEntity.length).toBeGreaterThan(0);
  });

  it("uses ray hits sourced from scene.ray_hit_local_image", () => {
    const orch = new Orchestrator();
    const customScene = createMockScene();
    (customScene as unknown as { ray_hit_local_image: () => Float32Array }).ray_hit_local_image =
      () => new Float32Array([0.25, 0.5, 0.75]);
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const viewHotSpy = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(customScene, datasets, viewHotSpy), new Map());
    const msg = viewHotSpy.mock.calls[0][0];
    expect(msg.rayHitsByEntity[0][1]).toEqual([0.25, 0.5, 0.75]);
  });

  it("does not re-emit viewHotState when viewEpoch is unchanged across ticks", async () => {
    const orch = new Orchestrator();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const sceneA = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    const viewHotA = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(sceneA, datasets, viewHotA), new Map());
    expect(viewHotA).toHaveBeenCalledTimes(1);

    // Selection epoch bumps but view epoch does NOT — re-plan happens but
    // hot state should be skipped since the camera-ray pick can't have
    // moved without a viewEpoch advance.
    const { bumpSettingsGeneration } = await import("../tickCommon.ts");
    bumpSettingsGeneration();
    const sceneB = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 2 } });
    const viewHotB = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(sceneB, datasets, viewHotB), new Map());
    expect(viewHotB).not.toHaveBeenCalled();
  });

  it("re-emits viewHotState when viewEpoch advances", () => {
    const orch = new Orchestrator();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const sceneA = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    const viewHotA = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(sceneA, datasets, viewHotA), new Map());
    expect(viewHotA).toHaveBeenCalledTimes(1);

    const sceneB = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
    const viewHotB = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(sceneB, datasets, viewHotB), new Map());
    expect(viewHotB).toHaveBeenCalledTimes(1);
    expect(viewHotB.mock.calls[0][0].epochs.view).toBe(2);
  });

  it("multi-channel emits one rayHit entry per (member, channel) composite", () => {
    const orch = new Orchestrator();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const scene = createMockScene({
      multiChannel: true,
      allSettings: {
        ds1: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 1,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [
            { visible: true, colormap: "magenta", contrast_min: 0, contrast_max: 100, gamma: 1 },
            { visible: true, colormap: "green",   contrast_min: 0, contrast_max: 200, gamma: 1.2 },
          ],
          channel_blend_mode: "additive",
        },
      },
    });
    const viewHotSpy = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(scene, datasets, viewHotSpy), new Map());
    const msg = viewHotSpy.mock.calls[0][0];
    const memberIds = msg.rayHitsByEntity.map((e: [string, unknown]) => e[0]);
    expect(memberIds).toContain("img-0:ch0");
    expect(memberIds).toContain("img-0:ch1");
  });
});
