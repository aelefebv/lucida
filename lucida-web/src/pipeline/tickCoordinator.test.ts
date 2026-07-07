import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { DatasetEntry } from "../renderLoopTypes.ts";
import type { CpuCache } from "./fetch/index.ts";
import type { TickContext } from "../renderLoopTypes.ts";
import { AssetCatalog } from "./assetCatalog.ts";
import type { ColdStateMessage } from "../renderer/workerProtocol.ts";
import type { RequestPlan } from "./planning/index.ts";

// Planner-only tests: epoch caching + multi-dataset planning state.
// Upload-side describes live in `upload/uploader.test.ts`.

/** Stub WASM scene that satisfies AssetCatalog's narrow interface. */
function createMockAssetCatalog(entries: Parameters<AssetCatalog["applyInitial"]>[1]["entries"] = []): AssetCatalog {
  const catalog = new AssetCatalog({ apply_asset_catalog_delta: () => {} });
  if (entries.length > 0) {
    catalog.applyInitial("ds1", { entries });
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockCpuCache(): CpuCache {
  return {
    submit: vi.fn(),
    onPlanRebuildStart: vi.fn(),
    getDeliverable: vi.fn(function* () {}),
    markSent: vi.fn(),
    snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
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
          entity_id: "tile-0",
          image_id: "img-0",
          kind: "Tile",
          visible: true,
          projected_diagonal_px: 100,
          projected_area_px2: 10000,
          centroid_world: [0, 0, 0],
          ideal_target_lod: 0,
          importance: 1.0,
        },
      ],
    },
    memberPositions: { "tile-0": [0, 0] },
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
    // TileSnapshot.parentId is required (non-null). The mock scene
    // reports `tile-0` as a Tile, so the manifest must carry the
    // matching parent edge or `buildPlanningSnapshot` throws.
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
  // The TickCoordinator should skip plan() when epochs haven't changed.

  let TickCoordinator: typeof import("./tickCoordinator.ts").TickCoordinator;
  let Uploader: typeof import("./upload/uploader.ts").Uploader;
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

    TickCoordinator = (await import("./tickCoordinator.ts")).TickCoordinator;
    Uploader = (await import("./upload/uploader.ts")).Uploader;
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

  function makeOrch(): InstanceType<typeof TickCoordinator> {
    return new TickCoordinator(new Uploader());
  }

  function makeTickCoordinatorDeps(epochOverrides?: Partial<{ content: number; layout: number; view: number; selection: number }>) {
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
    const { scene, datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();

    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("returns cached result when epochs are unchanged", () => {
    const { scene, datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();

    const ctx = makeCtx(scene, datasets);
    const result1 = orch.planAndFetch(ctx, emptyMinimap);
    planSpy.mockClear();

    const result2 = orch.planAndFetch(ctx, emptyMinimap);

    expect(planSpy).not.toHaveBeenCalled();
    expect(result2).toBe(result1);
  });

  it("re-plans when viewEpoch changes", () => {
    const { datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("re-plans when contentEpoch changes", () => {
    const { datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 2, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("re-plans when layoutEpoch changes", () => {
    const { datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 1, layout: 2, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("re-plans when selectionEpoch changes", () => {
    const { datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();

    const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
    planSpy.mockClear();

    const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 2 } });
    orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);

    expect(planSpy).toHaveBeenCalledTimes(1);
  });

  it("submits only budget-admitted legacy proxies while preserving detail requests", async () => {
    const { debugStats } = await import("../debug/debugStats.ts");
    const { configStore } = await import("./planning/configStore.ts");
    const previousDebugEnabled = debugStats.enabled;
    debugStats.enabled = true;
    debugStats.orch = null;
    configStore.set("coarseDetailEnabled", false);
    const { scene, datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const coldState = vi.fn();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;
    ctx.client = { coldState, viewHotState: vi.fn() } as unknown as TickContext["client"];
    ctx.assetCatalog = createMockAssetCatalog([
      {
        entity_id: "tile-0",
        kinds: ["TileProxy3D"],
        footprints: [{ kind: "TileProxy3D", dims: [1, 128, 128], bytes: 512 * 1024 * 1024 }],
      },
      {
        entity_id: "group-0",
        kinds: ["GroupProxy3D"],
        footprints: [{ kind: "GroupProxy3D", dims: [1, 128, 128], bytes: 512 * 1024 * 1024 }],
      },
    ]);

    try {
      orch.planAndFetch(ctx, emptyMinimap);

      const submitted = vi.mocked(cpuCache.submit).mock.calls[0][0] as RequestPlan;
      expect(submitted.requests.length).toBeGreaterThan(0);
      expect(submitted.proxyRequests).toEqual([]);
      const cold = coldState.mock.calls[0][0] as ColdStateMessage;
      expect(cold.desiredProxyKeys).toEqual([]);
      const orchDebug = debugStats.orch as { proxyResidency?: unknown } | null;
      expect(orchDebug?.proxyResidency).toMatchObject({
        desiredProxyCount: 0,
        skippedProxyCount: 2,
        admittedBytes: 0,
      });
    } finally {
      debugStats.enabled = previousDebugEnabled;
    }
  });

  // A uint32 label over `img-0` with a 4-deep, 2-chunk-Z level: slice mode
  // fetches one z-plane (1 chunk), volume mode the whole volume (2 z-chunks).
  function labeledContent(): DatasetManifest {
    const manifest = createMockContent();
    (manifest as DatasetManifest).labels = [{
      name: "region-b",
      source_image_id: "img-0",
      image: {
        image_id: "img-0:label:region-b",
        owner: "tile-0",
        multiscale: {
          axes: [],
          data_type: "Uint32",
          levels: [{
            level_index: 0,
            shape: [1, 1, 4, 64, 64],
            chunk_shape: [1, 1, 2, 64, 64],
            grid_shape: [1, 1, 2, 1, 1],
            scale: [1, 1, 1, 1, 1],
          }],
        },
      },
      colors: [],
    }];
    return manifest;
  }

  function labelRequestsFromSubmit(cpuCache: CpuCache) {
    const submitted = vi.mocked(cpuCache.submit).mock.calls[0][0] as RequestPlan;
    return submitted.requests.filter((r) => r.imageId === "img-0:label:region-b");
  }

  it("merges the label's FULL z-grid into the fetch plan in volume mode", () => {
    const scene = createMockScene();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: labeledContent() }]]);
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;
    ctx.mode = "volume";

    orch.planAndFetch(ctx, emptyMinimap);

    const labelReqs = labelRequestsFromSubmit(cpuCache);
    // gz=2 z-chunks (the whole label volume), not a single mapped plane.
    expect(labelReqs.length).toBe(2);
    expect(new Set(labelReqs.map((r) => r.z))).toEqual(new Set([0, 1]));
    // Scoped under the label's own image id, so intensity eviction is untouched.
    expect(labelReqs.every((r) => r.imageId === "img-0:label:region-b")).toBe(true);
  });

  it("merges only the mapped z-plane in slice mode (unchanged)", () => {
    const scene = createMockScene();
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: labeledContent() }]]);
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;
    ctx.mode = "slice";

    orch.planAndFetch(ctx, emptyMinimap);

    const labelReqs = labelRequestsFromSubmit(cpuCache);
    expect(labelReqs.length).toBe(1); // single z-plane
    expect(new Set(labelReqs.map((r) => r.z))).toEqual(new Set([0]));
  });
});

// ===========================================================================
// 2. Multi-dataset
// ===========================================================================

describe("multi-dataset planning", () => {
  let TickCoordinator: typeof import("./tickCoordinator.ts").TickCoordinator;
  let Uploader: typeof import("./upload/uploader.ts").Uploader;
  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const planningModule = await import("./planning/index.ts");
    planSpy = vi.fn(planningModule.plan);

    vi.doMock("./planning/index.ts", async () => {
      const actual = await import("./planning/index.ts");
      return { ...actual, plan: planSpy };
    });

    TickCoordinator = (await import("./tickCoordinator.ts")).TickCoordinator;
    Uploader = (await import("./upload/uploader.ts")).Uploader;
  });

  function makeOrch(): InstanceType<typeof TickCoordinator> {
    return new TickCoordinator(new Uploader());
  }

  function makeMultiDatasetScene() {
    return createMockScene({
      datasetOrder: ["ds1", "ds2"],
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
          owner: "tile-0",
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
    const orch = makeOrch();

    planSpy.mockClear();
    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    // 2 datasets → 2 plan() calls
    expect(planSpy).toHaveBeenCalledTimes(2);
  });

  it("merged result contains entries from both datasets", () => {
    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    const orch = makeOrch();

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
    const orch = makeOrch();

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
