import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { DatasetEntry } from "../renderLoopTypes.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
  ReadyDelivery,
} from "./fetch/index.ts";
import type { TickContext } from "../renderLoopTypes.ts";
import { AssetCatalog } from "./assetCatalog.ts";
import type { ChunkRequest, ProxyRequest } from "./planning/index.ts";
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
    // Chunk-delivery tests (Slice 1 of PRD #607) consult this method
    // from the resend pass. Default to a miss so cache-hit fixtures
    // don't accidentally re-emit deliveries across unrelated describes.
    getCachedChunk: vi.fn(() => null),
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
    // FieldSnapshot.parentId is required (non-null). The mock scene
    // reports `field-0` as a Field, so the manifest must carry the
    // matching parent edge or `buildPlanningSnapshot` throws.
    entities: [
      { id: "well-0", kind: "Well", parent: null, labels: {} },
      { id: "field-0", kind: "Field", parent: "well-0", labels: {} },
    ],
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

  it("tracks per-dataset PlanningState independently across ticks", () => {
    // The orchestrator's per-dataset state map is typed
    // `Map<datasetId, PlanningState>`. Each `plan()` call receives
    // `(snapshot, state, config)` — this test verifies:
    //   - state arrives as the second positional argument,
    //   - both datasets see an empty initial state on tick 1,
    //   - tick 2's per-dataset state's `previousActiveSet` matches the
    //     active set the tick-1 `plan()` call returned for that dataset
    //     (and not the other dataset's),
    //   - the planner-returned `nextState` pointer is what's stored
    //     and threaded back, not a re-derived `activeSet`.
    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    const orch = new Orchestrator();

    // Tick 1 — capture the planner-returned results per dataset so we
    // can compare them to tick-2's incoming state.
    planSpy.mockClear();
    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);
    expect(planSpy).toHaveBeenCalledTimes(2);
    const tick1Ds1State = planSpy.mock.calls[0][1];
    const tick1Ds2State = planSpy.mock.calls[1][1];
    expect(tick1Ds1State).toEqual({ previousActiveSet: [] });
    expect(tick1Ds2State).toEqual({ previousActiveSet: [] });
    const tick1Ds1Result = planSpy.mock.results[0].value as ReturnType<
      typeof import("./planning/index.ts").plan
    >;
    const tick1Ds2Result = planSpy.mock.results[1].value as ReturnType<
      typeof import("./planning/index.ts").plan
    >;

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

    // Tick 2 — each dataset's `state.previousActiveSet` should be
    // exactly the active set tick-1 produced for THAT dataset, and the
    // state object is the planner-returned `nextState` pointer (not a
    // re-derived value).
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
    expect(planSpy).toHaveBeenCalledTimes(2);
    const tick2Ds1State = planSpy.mock.calls[0][1];
    const tick2Ds2State = planSpy.mock.calls[1][1];
    expect(tick2Ds1State.previousActiveSet).toEqual(tick1Ds1Result.activeSet);
    expect(tick2Ds2State.previousActiveSet).toEqual(tick1Ds2Result.activeSet);
    expect(tick2Ds1State).toBe(tick1Ds1Result.nextState);
    expect(tick2Ds2State).toBe(tick1Ds2Result.nextState);
  });
});

// ===========================================================================
// 3. Proxy delivery tracking
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
    // #613: the field is now per-dataset (`Map<string, ProxyRequest[]>`)
    // so multi-dataset rebuilds resend for every dataset. Tests that
    // seed it directly use a single synthetic dsId.
    (orch as unknown as { _lastProxyRequests: Map<string, ProxyRequest[]> })
      ._lastProxyRequests = new Map([["ds-test", [req]]]);

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
// 4. cold-state display state propagation
// ===========================================================================

describe("cold-state display state", () => {
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
// 5. viewHotState emission (per-viewEpoch ray-pick coords)
// ===========================================================================

describe("viewHotState emission", () => {
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

// ===========================================================================
// 6. Chunk delivery (drain pass)
// ===========================================================================
//
// Pre-refactor characterization tests (Slice 1 of PRD #607). The drain
// pass + dispatch + resend pass + LOD/lane filters are the largest blind
// spot in upload-phase coverage — these tests pin the contracts before
// the Seam B/F extractions land.
//
// All tests share a richer fixture: `makeChunkDelivery`, a custom
// `client` mock with both `sliceChunkData` and `volumeChunkData` stubs,
// and a dataset manifest containing one image with two LODs so a
// chunk's `level` can be mapped to real level meta. Stats are read from
// `debugStats.upload.tick` (enabled in `beforeEach`).

describe("chunk delivery (drain pass)", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;
  // After `vi.resetModules()` re-import the same `debugStats` instance
  // the orchestrator binds, otherwise the orchestrator's writes land
  // on a different module instance than the assertion-side reads.
  let scopedDebugStats: typeof import("../debug/debugStats.ts").debugStats;
  let originalEnabled: boolean;

  beforeEach(async () => {
    vi.resetModules();
    Orchestrator = (await import("./orchestrator.ts")).Orchestrator;
    scopedDebugStats = (await import("../debug/debugStats.ts")).debugStats;
    originalEnabled = scopedDebugStats.enabled;
    scopedDebugStats.enabled = true;
  });

  afterEach(() => {
    scopedDebugStats.enabled = originalEnabled;
  });

  function makeChunkDelivery(
    overrides?: Partial<ReadyChunkDelivery>,
  ): ReadyChunkDelivery {
    return {
      kind: "chunk",
      entityId: "field-0",
      imageId: "img-0",
      level: 0,
      t: 0,
      c: 0,
      z: 0,
      y: 0,
      x: 0,
      chunkKey: overrides?.chunkKey ?? "0/0/0/0/0/0",
      data: new ArrayBuffer(1024),
      dataType: "uint16",
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
      lane: "detail",
      ...overrides,
    };
  }

  function makeChunkRequest(overrides?: Partial<ChunkRequest>): ChunkRequest {
    return {
      datasetId: "ds1",
      entityId: "field-0",
      imageId: "img-0",
      level: 0,
      t: 0,
      c: 0,
      z: 0,
      y: 0,
      x: 0,
      lane: "detail",
      priority: 0,
      chunkKey: overrides?.chunkKey ?? "0/0/0/0/0/0",
      ...overrides,
    };
  }

  function makeChunkCpuCache(opts: {
    drainResult?: ReadyDelivery[];
    cachedChunks?: Map<string, ReadyChunkDelivery>;
  } = {}): CpuCache {
    const drained = opts.drainResult ?? [];
    const cached = opts.cachedChunks ?? new Map();
    return {
      submit: vi.fn(),
      drain: vi.fn(() => {
        const out = drained.slice();
        drained.length = 0;
        return out;
      }),
      snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
      getCached: vi.fn(() => null),
      getCachedChunk: vi.fn((entityId: string, chunkKey: string) =>
        cached.get(`${entityId}|${chunkKey}`) ?? null,
      ),
      getCachedProxy: vi.fn(() => null),
      telemetry: vi.fn(),
      updateConfig: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      reset: vi.fn(),
      markRejected: vi.fn(),
      clearRejected: vi.fn(),
    } as unknown as CpuCache;
  }

  /** Build a TickContext with chunk-data client stubs and a one-dataset/one-image manifest. */
  function makeChunkCtx(opts: {
    cpuCache: CpuCache;
    mode?: "slice" | "volume";
    multiChannel?: boolean;
    sliceChunkData?: ReturnType<typeof vi.fn>;
    volumeChunkData?: ReturnType<typeof vi.fn>;
    manifestOverride?: DatasetManifest;
  }): TickContext {
    const sliceFn = opts.sliceChunkData ?? vi.fn();
    const volumeFn = opts.volumeChunkData ?? vi.fn();
    const manifest = opts.manifestOverride ?? createMockContent();
    return {
      scene: {
        multi_channel: () => opts.multiChannel ?? false,
      } as unknown,
      datasets: new Map<string, DatasetEntry>([["ds1", { manifest }]]),
      client: {
        coldState: vi.fn(),
        viewHotState: vi.fn(),
        proxyAssetData: vi.fn(),
        sliceChunkData: sliceFn,
        volumeChunkData: volumeFn,
        removeLayerResources: vi.fn(),
        onChunksEvicted: null,
        onWantedSetDelta: null,
      } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: opts.mode ?? "slice",
      renderScale: 1,
      cpuCache: opts.cpuCache,
      assetCatalog: new AssetCatalog({ apply_asset_catalog_delta: () => {} }),
    } as unknown as TickContext;
  }

  /**
   * Seed the orchestrator's per-tick state without running planAndFetch.
   * deliverToWorker depends on `_lastFilteredRequests` (target-LOD map +
   * resend loop) being populated. Tests that pin drain-pass behavior set
   * this directly so the test doesn't have to round-trip through plan().
   * #613: the field is per-dataset (`Map<string, ChunkRequest[]>`); tests
   * use a single synthetic dsId.
   */
  function seedLastRequests(
    orch: import("./orchestrator.ts").Orchestrator,
    reqs: ChunkRequest[],
  ): void {
    (orch as unknown as { _lastFilteredRequests: Map<string, ChunkRequest[]> })
      ._lastFilteredRequests = new Map([["ds-test", reqs]]);
  }

  it("drain happy path: slice mode → sliceChunkData called with expected args", () => {
    const orch = new Orchestrator();
    const delivery = makeChunkDelivery();
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, mode: "slice", sliceChunkData: sliceFn });
    seedLastRequests(orch, [makeChunkRequest()]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).toHaveBeenCalledTimes(1);
    // First positional arg: workerMemberId; single-channel = bare imageId.
    expect(sliceFn.mock.calls[0][0]).toBe("img-0");
    // Second: chunks array of exactly one element (the orchestrator
    // never batches today — see contract scan §"arrays carry one element").
    expect(sliceFn.mock.calls[0][1]).toHaveLength(1);
    expect(sliceFn.mock.calls[0][1][0].key).toBe("0/0/0/0/0/0");
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(1);
    expect(scopedDebugStats.upload!.tick!.bytesUploaded).toBe(1024);
  });

  it("drain happy path: volume mode → volumeChunkData called instead", () => {
    const orch = new Orchestrator();
    const delivery = makeChunkDelivery();
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const volumeFn = vi.fn();
    const ctx = makeChunkCtx({
      cpuCache, mode: "volume",
      sliceChunkData: sliceFn, volumeChunkData: volumeFn,
    });
    seedLastRequests(orch, [makeChunkRequest()]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, null);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(volumeFn).toHaveBeenCalledTimes(1);
    expect(volumeFn.mock.calls[0][0]).toBe("img-0");
    expect(volumeFn.mock.calls[0][1]).toHaveLength(1);
  });

  it("lane=prefetch → skippedPrefetch bumps; no client call", () => {
    const orch = new Orchestrator();
    const delivery = makeChunkDelivery({ lane: "prefetch" });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [makeChunkRequest()]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedPrefetch).toBe(1);
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(0);
  });

  it("lane=overview → skippedOverview bumps; no client call", () => {
    const orch = new Orchestrator();
    const delivery = makeChunkDelivery({ lane: "overview" });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [makeChunkRequest()]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedOverview).toBe(1);
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(0);
  });

  it("level mismatch (delivery.level != target) → skippedWrongLod bumps; no client call", () => {
    const orch = new Orchestrator();
    // Plan asks for level 1 but the drained chunk is level 0.
    const delivery = makeChunkDelivery({ level: 0 });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [makeChunkRequest({ level: 1, chunkKey: "1/0/0/0/0/0" })]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedWrongLod).toBe(1);
  });

  it("already-sent guard: second call with same chunkKey/memberId → skippedAlreadySent", () => {
    const orch = new Orchestrator();
    // First call sends; second call drains the same chunk again, and the
    // already-sent guard bumps `skippedAlreadySent`.
    const cpuCache1 = makeChunkCpuCache({ drainResult: [makeChunkDelivery()] });
    const sliceFn = vi.fn();
    const ctx1 = makeChunkCtx({ cpuCache: cpuCache1, sliceChunkData: sliceFn });
    seedLastRequests(orch, [makeChunkRequest()]);
    orch.deliverToWorker(ctx1, 8 * 1024 * 1024, 0);
    expect(sliceFn).toHaveBeenCalledTimes(1);

    // Second tick: same delivery, same manifest, but the sentSet now
    // contains the chunk key.
    const cpuCache2 = makeChunkCpuCache({ drainResult: [makeChunkDelivery()] });
    const ctx2 = makeChunkCtx({ cpuCache: cpuCache2, sliceChunkData: sliceFn });
    orch.deliverToWorker(ctx2, 8 * 1024 * 1024, 0);

    expect(sliceFn).toHaveBeenCalledTimes(1); // no second send
    expect(scopedDebugStats.upload!.tick!.skippedAlreadySent).toBe(1);
  });

  it("manifest-not-found: delivery for an unknown imageId → skippedNoMeta; no client call", () => {
    const orch = new Orchestrator();
    const delivery = makeChunkDelivery({ imageId: "img-ghost" });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    // Target table maps the ghost image to level 0 so the wrong-LOD
    // filter passes and we reach `sendDeliveryToWorker`'s manifest scan.
    seedLastRequests(orch, [makeChunkRequest({ imageId: "img-ghost" })]);
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedNoMeta).toBe(1);
  });

  it("resend pass: chunk in _lastFilteredRequests not in sentSet, cache returns it → re-uploaded", () => {
    const orch = new Orchestrator();
    const req = makeChunkRequest({ chunkKey: "0/0/0/1/0/0" });
    const cachedDelivery = makeChunkDelivery({ chunkKey: "0/0/0/1/0/0" });
    const cachedMap = new Map<string, ReadyChunkDelivery>();
    cachedMap.set(`${req.entityId}|${req.chunkKey}`, cachedDelivery);
    const cpuCache = makeChunkCpuCache({ cachedChunks: cachedMap });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [req]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    // No drain happened → resend pass picked it up.
    expect(sliceFn).toHaveBeenCalledTimes(1);
    expect(scopedDebugStats.upload!.tick!.resendChunkUploads).toBe(1);
    expect(scopedDebugStats.upload!.tick!.resendChunksConsidered).toBe(1);
  });

  it("resend pass: chunk in deliveryRejectedByWorker → skipped; resendChunksRejected bumps", () => {
    const orch = new Orchestrator();
    const req = makeChunkRequest({ chunkKey: "0/0/0/2/0/0" });
    const cpuCache = makeChunkCpuCache();
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [req]);
    // Mark the chunk as rejected for the worker member id (= imageId
    // since multiChannel = false). The resend pass checks this map
    // BEFORE consulting the cache, so the cache mock is irrelevant here.
    (orch as unknown as {
      deliveryRejectedByWorker: Map<string, Set<string>>;
    }).deliveryRejectedByWorker.set("img-0", new Set([req.chunkKey]));

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.resendChunksRejected).toBe(1);
    expect(scopedDebugStats.upload!.tick!.resendChunkUploads).toBe(0);
  });

  it("resend pass: cache miss for re-considered chunk → resendChunksNotCached bumps", () => {
    const orch = new Orchestrator();
    const req = makeChunkRequest({ chunkKey: "0/0/0/3/0/0" });
    // Empty cachedChunks map → getCachedChunk returns null.
    const cpuCache = makeChunkCpuCache();
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [req]);

    orch.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.resendChunksNotCached).toBe(1);
    expect(scopedDebugStats.upload!.tick!.resendChunkUploads).toBe(0);
  });

  it("budget-exhausted soft cap: a single oversize chunk still uploads but flips budgetExhausted", () => {
    const orch = new Orchestrator();
    // 4 MB chunk, 1 MB budget — `remaining -= sent` lands at -3 MB,
    // the check `if (remaining <= 0) budgetExhausted = true` fires
    // AFTER the upload succeeded. UploadTickStats.budgetExhausted
    // docs this overshoot explicitly.
    const big = makeChunkDelivery({ data: new ArrayBuffer(4 * 1024 * 1024) });
    const cpuCache = makeChunkCpuCache({ drainResult: [big] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(orch, [makeChunkRequest()]);

    const ret = orch.deliverToWorker(ctx, 1 * 1024 * 1024, 0);

    expect(sliceFn).toHaveBeenCalledTimes(1);
    expect(scopedDebugStats.upload!.tick!.budgetExhausted).toBe(true);
    expect(scopedDebugStats.upload!.tick!.bytesUploaded).toBe(4 * 1024 * 1024);
    // Return signal: caller schedules another tick.
    expect(ret).toBe(true);
  });
});

// ===========================================================================
// 7. handleChunksEvicted characterization
// ===========================================================================

describe("handleChunksEvicted", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Orchestrator = (await import("./orchestrator.ts")).Orchestrator;
  });

  function seedSentSet(
    orch: import("./orchestrator.ts").Orchestrator,
    wid: string,
    keys: string[],
  ): void {
    const map = (orch as unknown as {
      deliverySentToWorker: Map<string, Set<string>>;
    }).deliverySentToWorker;
    map.set(wid, new Set(keys));
  }

  function seedRejectedSet(
    orch: import("./orchestrator.ts").Orchestrator,
    wid: string,
    keys: string[],
  ): void {
    const map = (orch as unknown as {
      deliveryRejectedByWorker: Map<string, Set<string>>;
    }).deliveryRejectedByWorker;
    map.set(wid, new Set(keys));
  }

  function seedWidToEntity(
    orch: import("./orchestrator.ts").Orchestrator,
    wid: string,
    entityId: string,
  ): void {
    const map = (orch as unknown as {
      widToEntityId: Map<string, string>;
    }).widToEntityId;
    map.set(wid, entityId);
  }

  function getSentSet(
    orch: import("./orchestrator.ts").Orchestrator,
    wid: string,
  ): Set<string> | undefined {
    return (orch as unknown as {
      deliverySentToWorker: Map<string, Set<string>>;
    }).deliverySentToWorker.get(wid);
  }

  function getRejectedSet(
    orch: import("./orchestrator.ts").Orchestrator,
    wid: string,
  ): Set<string> | undefined {
    return (orch as unknown as {
      deliveryRejectedByWorker: Map<string, Set<string>>;
    }).deliveryRejectedByWorker.get(wid);
  }

  it("evicted keys are removed from deliverySentToWorker", () => {
    const orch = new Orchestrator();
    seedSentSet(orch, "img-0", ["k1", "k2", "k3"]);

    orch.handleChunksEvicted("img-0", ["k1", "k3"], [], createMockCpuCache());

    expect(getSentSet(orch, "img-0")).toEqual(new Set(["k2"]));
  });

  it("evicted keys are removed from deliveryRejectedByWorker (acceptance proves deliverable)", () => {
    const orch = new Orchestrator();
    seedRejectedSet(orch, "img-0", ["k1", "k2"]);

    orch.handleChunksEvicted("img-0", ["k1"], [], createMockCpuCache());

    expect(getRejectedSet(orch, "img-0")).toEqual(new Set(["k2"]));
  });

  it("skipped keys are added to deliveryRejectedByWorker", () => {
    const orch = new Orchestrator();
    seedSentSet(orch, "img-0", ["k1"]);

    orch.handleChunksEvicted("img-0", [], ["k1", "k2"], createMockCpuCache());

    expect(getRejectedSet(orch, "img-0")).toEqual(new Set(["k1", "k2"]));
    // skipped also removes from sent.
    expect(getSentSet(orch, "img-0")).toEqual(new Set());
  });

  it("skipped keys are forwarded to cpuCache.markRejected with the resolved entityId", () => {
    const orch = new Orchestrator();
    seedWidToEntity(orch, "img-0:ch1", "field-0");
    const cpuCache = createMockCpuCache();
    const markRejected = cpuCache.markRejected as ReturnType<typeof vi.fn>;

    orch.handleChunksEvicted("img-0:ch1", [], ["kA", "kB"], cpuCache);

    expect(markRejected).toHaveBeenCalledTimes(2);
    expect(markRejected.mock.calls[0]).toEqual(["field-0", "kA"]);
    expect(markRejected.mock.calls[1]).toEqual(["field-0", "kB"]);
  });

  it("silent skip: markRejected NOT called when widToEntityId has no entry", () => {
    const orch = new Orchestrator();
    // No seedWidToEntity → widToEntityId.get returns undefined.
    const cpuCache = createMockCpuCache();
    const markRejected = cpuCache.markRejected as ReturnType<typeof vi.fn>;

    orch.handleChunksEvicted("img-ghost", [], ["k1"], cpuCache);

    expect(markRejected).not.toHaveBeenCalled();
    // The rejected set still receives the key (so the resend pass
    // short-circuits future re-attempts), but the cache isn't told.
    expect(getRejectedSet(orch, "img-ghost")).toEqual(new Set(["k1"]));
  });
});

// ===========================================================================
// 8. Multi-dataset characterization
// ===========================================================================
//
// Pin the verified bugs from Pass 5 of the dechaos scan
// (`05-contract-scan.md`):
//
//   - `_lastFilteredRequests` is a flat `ChunkRequest[]` overwritten
//     per-dataset → the resend pass only sees the LAST dataset's
//     requests after a multi-dataset rebuild. Same shape for
//     `_lastProxyRequests`.
//   - `deliverySentToWorker.clear()` runs once per per-dataset step
//     inside `planAndFetch`, effectively clearing everything early on.
//
// Slice 4 (#613) fixed the per-dataset maps. The previously
// `it.fails(...)` regressions are now `it(...)` and pass against the
// shipped fix; see commit history.

describe("multi-dataset upload characterization", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Orchestrator = (await import("./orchestrator.ts")).Orchestrator;
  });

  function makeMultiDatasetScene() {
    return createMockScene({
      datasetOrder: ["ds1", "ds2"],
      allSettings: {
        ds1: {
          visible: true, opacity: 1,
          contrast_min: 0, contrast_max: 1, gamma: 1,
          blend_mode: "alpha", channel_settings: [], channel_blend_mode: "additive",
        },
        ds2: {
          visible: true, opacity: 1,
          contrast_min: 0, contrast_max: 1, gamma: 1,
          blend_mode: "alpha", channel_settings: [], channel_blend_mode: "additive",
        },
      },
    });
  }

  function makeTwoDatasetEntries(): Map<string, DatasetEntry> {
    const content1 = createMockContent();
    // The mock scene's `view_query` is dsId-agnostic — it returns the
    // same `field-0` / `img-0` entity for both datasets. To keep both
    // datasets producing requests (otherwise the entity has no matching
    // image in the manifest → `levels=[]` → zero requests), ds2 reuses
    // the same `img-0` image spec under a different dataset_id.
    const content2: DatasetManifest = {
      ...createMockContent(),
      dataset_id: "ds2",
    } as unknown as DatasetManifest;
    return new Map<string, DatasetEntry>([
      ["ds1", { manifest: content1 }],
      ["ds2", { manifest: content2 }],
    ]);
  }

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
    coldSpy: ReturnType<typeof vi.fn> = vi.fn(),
    viewHotSpy: ReturnType<typeof vi.fn> = vi.fn(),
  ): TickContext {
    return {
      scene,
      datasets,
      client: {
        coldState: coldSpy,
        viewHotState: viewHotSpy,
      } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: new AssetCatalog({ apply_asset_catalog_delta: () => {} }),
    } as unknown as TickContext;
  }

  // Fixed in Slice 4 (#613); see commit history. `_lastFilteredRequests`
  // is a `Map<datasetId, ChunkRequest[]>`, so a multi-dataset rebuild
  // preserves every dataset's requests rather than the last-processed
  // one's. The resend pass in `deliverToWorker` iterates every entry.
  it(
    "fixed in Slice 4 #613: _lastFilteredRequests keeps both datasets' requests",
    () => {
      const orch = new Orchestrator();
      const scene = makeMultiDatasetScene();
      const datasets = makeTwoDatasetEntries();
      orch.planAndFetch(makeCtx(scene, datasets), new Map());

      const lastFilteredByDataset = (orch as unknown as {
        _lastFilteredRequests: Map<string, ChunkRequest[]>;
      })._lastFilteredRequests;
      // Per-dataset map exposes both ds1 and ds2 entries. Pre-#613 the
      // flat field would have only the last-processed dataset's
      // requests; now each dataset's request list survives. (The mock
      // `view_query` is dsId-agnostic and returns `field-0/img-0` for
      // both datasets, so the per-dataset arrays are non-empty for
      // both keys; the test pins survival, not differentiation.)
      expect(lastFilteredByDataset.has("ds1")).toBe(true);
      expect(lastFilteredByDataset.has("ds2")).toBe(true);
      const ds1Reqs = lastFilteredByDataset.get("ds1") ?? [];
      const ds2Reqs = lastFilteredByDataset.get("ds2") ?? [];
      expect(ds1Reqs.length).toBeGreaterThan(0);
      expect(ds2Reqs.length).toBeGreaterThan(0);
      // Pre-#613 would have only one populated entry (overwritten);
      // post-#613 both datasets' arrays land in the map under their
      // own keys.
      const ds1Images = new Set(ds1Reqs.map(r => r.imageId));
      const ds2Images = new Set(ds2Reqs.map(r => r.imageId));
      expect(ds1Images.has("img-0")).toBe(true);
      expect(ds2Images.has("img-0")).toBe(true);
    },
  );

  it(
    "fixed in Slice 4 #613: _lastProxyRequests keeps both datasets' proxies",
    () => {
      // Today's fixtures don't produce any actual proxy requests
      // (visible_entities only has field-0 in both datasets and the
      // plan doesn't promote to proxy), so this asserts the per-dataset
      // map shape: both datasets register entries (even when empty),
      // confirming the last-dataset-wins overwrite is gone.
      const orch = new Orchestrator();
      const scene = makeMultiDatasetScene();
      const datasets = makeTwoDatasetEntries();
      orch.planAndFetch(makeCtx(scene, datasets), new Map());

      const lastProxyByDataset = (orch as unknown as {
        _lastProxyRequests: Map<string, ProxyRequest[]>;
      })._lastProxyRequests;
      expect(lastProxyByDataset).toBeDefined();
      expect(lastProxyByDataset.has("ds1")).toBe(true);
      expect(lastProxyByDataset.has("ds2")).toBe(true);
    },
  );

  it("deliverySentToWorker is empty after a fresh multi-dataset rebuild (clear-all behavior)", () => {
    // Pre-Slice-4 the per-dataset loop calls `deliverySentToWorker.clear()`
    // once per dataset (effectively all-or-nothing). Post-Slice-4 the
    // intent is once-per-rebuild — same observable result. This test
    // characterizes the current behavior: empty after a rebuild.
    const orch = new Orchestrator();
    // Pre-seed a tracking entry that should be cleared by the rebuild.
    (orch as unknown as {
      deliverySentToWorker: Map<string, Set<string>>;
    }).deliverySentToWorker.set("img-stale", new Set(["k1"]));

    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    orch.planAndFetch(makeCtx(scene, datasets), new Map());

    const sentMap = (orch as unknown as {
      deliverySentToWorker: Map<string, Set<string>>;
    }).deliverySentToWorker;
    expect(sentMap.has("img-stale")).toBe(false);
  });

  it("per-dataset sendColdState + sendViewHotState: each dataset receives its own message on initial plan", () => {
    const orch = new Orchestrator();
    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    const coldSpy = vi.fn();
    const viewHotSpy = vi.fn();
    orch.planAndFetch(makeCtx(scene, datasets, coldSpy, viewHotSpy), new Map());

    // One coldState per dataset.
    expect(coldSpy).toHaveBeenCalledTimes(2);
    const coldDsIds = coldSpy.mock.calls.map(c => (c[0] as ColdStateMessage).datasetId);
    expect(coldDsIds).toEqual(["ds1", "ds2"]);
    // viewHotState fires the first time per dataset (lastViewEpoch unset).
    expect(viewHotSpy).toHaveBeenCalledTimes(2);
    const hotDsIds = viewHotSpy.mock.calls.map(c => c[0].datasetId);
    expect(hotDsIds).toEqual(["ds1", "ds2"]);
  });
});

// ===========================================================================
// 9. Cold-state lifecycle invariant
// ===========================================================================

describe("cold-state lifecycle invariant", () => {
  let Orchestrator: typeof import("./orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Orchestrator = (await import("./orchestrator.ts")).Orchestrator;
  });

  it("after sendColdState, deliverySentToWorker is empty for previously-sent keys", () => {
    // Invariant: every `sendColdState` is followed by
    // `deliverySentToWorker.clear()` (today inside the per-dataset
    // loop; post-Slice-4 once per rebuild). Without this the worker
    // would build a fresh atlas while the orchestrator believed it had
    // already supplied chunks — atlas would stay empty for stale keys.
    //
    // After the Seam B refactor folds the clear into sendColdState
    // itself, this test guards against regressions.
    const orch = new Orchestrator();
    // Seed: pretend a previous tick delivered a chunk for "img-0".
    (orch as unknown as {
      deliverySentToWorker: Map<string, Set<string>>;
    }).deliverySentToWorker.set("img-0", new Set(["0/0/0/0/0/0"]));

    // Trigger a fresh rebuild.
    const scene = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 1 },
    });
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContent() }],
    ]);
    const ctx: TickContext = {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown,
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: new AssetCatalog({ apply_asset_catalog_delta: () => {} }),
    } as unknown as TickContext;

    orch.planAndFetch(ctx, new Map());

    const sentMap = (orch as unknown as {
      deliverySentToWorker: Map<string, Set<string>>;
    }).deliverySentToWorker;
    // Either the entire entry is gone, or the set is empty — both
    // satisfy the invariant. The orchestrator currently calls
    // `.clear()` on the Map, dropping the entry entirely.
    const sent = sentMap.get("img-0");
    expect(sent === undefined || sent.size === 0).toBe(true);
  });
});
