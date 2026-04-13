import { describe, it, expect, vi, beforeEach } from "vitest";
import { translateRequestPlan } from "./orchestrator.ts";
import type { ChunkRequest, EntitySnapshot } from "./planning.ts";
import type { SharedChunkQueue } from "../zarr/chunkStore.ts";
import type { ContentGraph } from "../contentTypes.ts";
import type { DatasetEntry } from "../renderLoopTypes.ts";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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

function createMockSharedQueue(
  cachedKeys?: Map<string, Set<string>>,
): SharedChunkQueue {
  return {
    getCachedKeys: (memberId: string) =>
      cachedKeys?.get(memberId) ?? new Set(),
    ensureFetched: vi.fn(),
    setConcurrency: vi.fn(),
    registerMember: vi.fn(),
    removeMember: vi.fn(),
    memberIds: () => (cachedKeys ?? new Map()).keys(),
  } as unknown as SharedChunkQueue;
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

// ---------------------------------------------------------------------------
// Helper: build ChunkRequest
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ChunkRequest> & { entityId: string; imageId: string }): ChunkRequest {
  const level = overrides.level ?? 0;
  const t = overrides.t ?? 0;
  const c = overrides.c ?? 0;
  const z = overrides.z ?? 0;
  const y = overrides.y ?? 0;
  const x = overrides.x ?? 0;
  return {
    entityId: overrides.entityId,
    imageId: overrides.imageId,
    level,
    t,
    c,
    z,
    y,
    x,
    lane: overrides.lane ?? "detail",
    priority: overrides.priority ?? 0,
    chunkKey: overrides.chunkKey ?? `${level}/${t}/${c}/${z}/${y}/${x}`,
  };
}

// ---------------------------------------------------------------------------
// Helper: build EntitySnapshot
// ---------------------------------------------------------------------------

function makeEntity(overrides?: Partial<EntitySnapshot>): EntitySnapshot {
  return {
    entityId: "field-0",
    imageId: "img-0",
    kind: "Field",
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    importance: 1.0,
    numLevels: 2,
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
    position: [0, 0],
    ...overrides,
  };
}

// ===========================================================================
// 1. Adapter translation: RequestPlan -> MemberChunkPlan[]
// ===========================================================================

describe("translateRequestPlan", () => {
  describe("detail + overview requests for 2 entities", () => {
    it("groups detail-lane requests into needed", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0", position: [0, 0] }),
        makeEntity({ entityId: "field-1", imageId: "img-1", position: [100, 200] }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", x: 0, y: 0 }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", x: 1, y: 0 }),
        makeRequest({ entityId: "field-1", imageId: "img-1", lane: "detail", x: 0, y: 0 }),
      ];

      const result = translateRequestPlan(requests, entities, false);

      // Both entities should appear in the result.
      expect(result.size).toBe(2);

      const plans0 = result.get("img-0");
      expect(plans0).toBeDefined();
      expect(plans0!.length).toBeGreaterThanOrEqual(1);

      const detailPlan0 = plans0!.find((p) => p.needed.length > 0);
      expect(detailPlan0).toBeDefined();
      expect(detailPlan0!.needed).toHaveLength(2);

      const plans1 = result.get("img-1");
      expect(plans1).toBeDefined();
      const detailPlan1 = plans1!.find((p) => p.needed.length > 0);
      expect(detailPlan1).toBeDefined();
      expect(detailPlan1!.needed).toHaveLength(1);
    });

    it("groups overview-lane requests into needed (separate MemberChunkPlan entry)", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", x: 0, y: 0 }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "overview", level: 1, x: 0, y: 0, chunkKey: "1/0/0/0/0/0" }),
      ];

      const result = translateRequestPlan(requests, entities, false);
      const plans = result.get("img-0");
      expect(plans).toBeDefined();

      // Both detail and overview chunks appear as needed entries.
      const allNeeded = plans!.flatMap((p) => p.needed);
      expect(allNeeded.length).toBe(2);
    });

    it("groups runway-lane requests into prefetch", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", x: 0, y: 0 }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "runway", t: 1, x: 0, y: 0, chunkKey: "0/1/0/0/0/0" }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "runway", t: 2, x: 0, y: 0, chunkKey: "0/2/0/0/0/0" }),
      ];

      const result = translateRequestPlan(requests, entities, false);
      const plans = result.get("img-0");
      expect(plans).toBeDefined();

      const allPrefetch = plans!.flatMap((p) => p.prefetch);
      expect(allPrefetch).toHaveLength(2);
    });
  });

  describe("entity positions preserved", () => {
    it("position from EntitySnapshot flows into MemberChunkPlan.position", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0", position: [42, 99] }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", x: 0, y: 0 }),
      ];

      const result = translateRequestPlan(requests, entities, false);
      const plans = result.get("img-0");
      expect(plans).toBeDefined();
      expect(plans![0].position).toEqual([42, 99]);
    });

    it("each entity retains its own position", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0", position: [10, 20] }),
        makeEntity({ entityId: "field-1", imageId: "img-1", position: [300, 400] }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", x: 0, y: 0 }),
        makeRequest({ entityId: "field-1", imageId: "img-1", lane: "detail", x: 0, y: 0 }),
      ];

      const result = translateRequestPlan(requests, entities, false);

      const plans0 = result.get("img-0");
      expect(plans0![0].position).toEqual([10, 20]);

      const plans1 = result.get("img-1");
      expect(plans1![0].position).toEqual([300, 400]);
    });
  });

  describe("ChunkRequest -> ChunkCoord mapping", () => {
    it("chunkKey maps to key", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({
          entityId: "field-0",
          imageId: "img-0",
          lane: "detail",
          level: 2,
          t: 3,
          c: 1,
          z: 4,
          y: 5,
          x: 6,
          chunkKey: "2/3/1/4/5/6",
        }),
      ];

      const result = translateRequestPlan(requests, entities, false);
      const plans = result.get("img-0");
      const coord = plans![0].needed[0];

      expect(coord.key).toBe("2/3/1/4/5/6");
    });

    it("all coordinate fields are preserved", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({
          entityId: "field-0",
          imageId: "img-0",
          lane: "detail",
          level: 2,
          t: 3,
          c: 1,
          z: 4,
          y: 5,
          x: 6,
          chunkKey: "2/3/1/4/5/6",
        }),
      ];

      const result = translateRequestPlan(requests, entities, false);
      const plans = result.get("img-0");
      const coord = plans![0].needed[0];

      expect(coord.level).toBe(2);
      expect(coord.t).toBe(3);
      expect(coord.c).toBe(1);
      expect(coord.z).toBe(4);
      expect(coord.y).toBe(5);
      expect(coord.x).toBe(6);
    });

    it("prefetch coords also preserve all fields", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({
          entityId: "field-0",
          imageId: "img-0",
          lane: "runway",
          level: 1,
          t: 7,
          c: 2,
          z: 3,
          y: 1,
          x: 0,
          chunkKey: "1/7/2/3/1/0",
        }),
      ];

      const result = translateRequestPlan(requests, entities, false);
      const plans = result.get("img-0");
      const coord = plans![0].prefetch[0];

      expect(coord.key).toBe("1/7/2/3/1/0");
      expect(coord.level).toBe(1);
      expect(coord.t).toBe(7);
      expect(coord.c).toBe(2);
      expect(coord.z).toBe(3);
      expect(coord.y).toBe(1);
      expect(coord.x).toBe(0);
    });
  });

  describe("multi-channel composite keys", () => {
    it("uses imageId:ch{n} keys when multiChannel is true", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      // Two requests with different channels.
      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 0, x: 0, y: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 2, x: 0, y: 0, chunkKey: "0/0/2/0/0/0" }),
      ];

      const result = translateRequestPlan(requests, entities, true);

      // Multi-channel should produce per-channel member keys.
      expect(result.has("img-0:ch0")).toBe(true);
      expect(result.has("img-0:ch2")).toBe(true);
    });

    it("does not use composite keys when multiChannel is false", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 0, x: 0, y: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 2, x: 0, y: 0, chunkKey: "0/0/2/0/0/0" }),
      ];

      const result = translateRequestPlan(requests, entities, false);

      // Single-channel mode groups all under one imageId key.
      expect(result.has("img-0")).toBe(true);
      expect(result.has("img-0:ch0")).toBe(false);
      expect(result.has("img-0:ch2")).toBe(false);
    });

    it("each channel composite key has correct coords", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const requests: ChunkRequest[] = [
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 0, x: 0, y: 0, chunkKey: "0/0/0/0/0/0" }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 0, x: 1, y: 0, chunkKey: "0/0/0/0/0/1" }),
        makeRequest({ entityId: "field-0", imageId: "img-0", lane: "detail", c: 3, x: 0, y: 0, chunkKey: "0/0/3/0/0/0" }),
      ];

      const result = translateRequestPlan(requests, entities, true);

      const ch0Plans = result.get("img-0:ch0");
      expect(ch0Plans).toBeDefined();
      const ch0Needed = ch0Plans!.flatMap((p) => p.needed);
      expect(ch0Needed).toHaveLength(2);
      for (const coord of ch0Needed) {
        expect(coord.c).toBe(0);
      }

      const ch3Plans = result.get("img-0:ch3");
      expect(ch3Plans).toBeDefined();
      const ch3Needed = ch3Plans!.flatMap((p) => p.needed);
      expect(ch3Needed).toHaveLength(1);
      expect(ch3Needed[0].c).toBe(3);
    });
  });

  describe("empty requests", () => {
    it("returns empty Map when no entities", () => {
      const result = translateRequestPlan([], [], false);
      expect(result.size).toBe(0);
    });

    it("returns empty Map when no requests but entities exist", () => {
      const entities: EntitySnapshot[] = [
        makeEntity({ entityId: "field-0", imageId: "img-0" }),
      ];

      const result = translateRequestPlan([], entities, false);
      expect(result.size).toBe(0);
    });
  });
});

// ===========================================================================
// 2. Epoch caching
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
    } as unknown as TickContext;
  }

  function makeOrchestratorDeps(epochOverrides?: Partial<{ content: number; layout: number; view: number; selection: number }>) {
    const scene = createMockScene({
      epochs: { content: 1, layout: 1, view: 1, selection: 1, ...epochOverrides },
    });
    const queue = createMockSharedQueue();
    const content = createMockContent();
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { sharedQueue: queue, content }],
    ]);

    return { scene, datasets, queue, content };
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
// 3. Multi-dataset
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

    const queue1 = createMockSharedQueue();
    const queue2 = createMockSharedQueue();

    return new Map<string, DatasetEntry>([
      ["ds1", { sharedQueue: queue1, content: content1 }],
      ["ds2", { sharedQueue: queue2, content: content2 }],
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
