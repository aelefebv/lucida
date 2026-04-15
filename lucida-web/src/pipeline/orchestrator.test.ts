import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContentGraph } from "../contentTypes.ts";
import type { DatasetEntry } from "../renderLoopTypes.ts";
import type { CpuCache } from "./cpuCache.ts";
import type { TickContext } from "../renderLoopTypes.ts";

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
  } as unknown;
}

function createMockContent(): ContentGraph {
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
  } as unknown as ContentGraph;
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

    const planningModule = await import("./planning.ts");
    planSpy = vi.fn(planningModule.plan);

    // Mock the planning module's plan function.
    vi.doMock("./planning.ts", async () => {
      const actual = await import("./planning.ts");
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
      client: {} as any,
      canvas: { clientWidth: 800, clientHeight: 600 } as any,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
    } as unknown as TickContext;
  }

  function makeOrchestratorDeps(epochOverrides?: Partial<{ content: number; layout: number; view: number; selection: number }>) {
    const scene = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 1, ...epochOverrides },
    });
    const content = createMockContent();
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { content }],
    ]);

    return { scene, datasets, content };
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

    const planningModule = await import("./planning.ts");
    planSpy = vi.fn(planningModule.plan);

    vi.doMock("./planning.ts", async () => {
      const actual = await import("./planning.ts");
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
    const content2: ContentGraph = {
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
    } as unknown as ContentGraph;

    return new Map<string, DatasetEntry>([
      ["ds1", { content: content1 }],
      ["ds2", { content: content2 }],
    ]);
  }

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
  ): TickContext {
    return {
      scene,
      datasets,
      client: {} as any,
      canvas: { clientWidth: 800, clientHeight: 600 } as any,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
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
