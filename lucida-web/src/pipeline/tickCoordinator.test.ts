import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { DatasetEntry } from "../renderLoopTypes.ts";
import type { CpuCache } from "./fetch/index.ts";
import type { TickContext } from "../renderLoopTypes.ts";
import { AssetCatalog } from "./assetCatalog.ts";
import type { ColdStateMessage } from "../renderer/workerProtocol.ts";
import type { RequestPlan } from "./planning/index.ts";
import { TickCoordinator } from "./tickCoordinator.ts";
import { Uploader } from "./upload/uploader.ts";
import { plan } from "./planning/index.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";
import { configStore } from "./planning/configStore.ts";
import { traceRecorder } from "../trace/recorder.ts";

// Planner-only tests: epoch caching + multi-dataset planning state.
// Upload-side describes live in `upload/uploader.test.ts`.
//
// The planner-mocking describes below INJECT their `plan` spy into the
// TickCoordinator constructor rather than `vi.resetModules()`-mocking the
// planning singleton. That older pattern (async `vi.doMock` factory + dynamic
// imports) raced under `--sequence.shuffle`: a spy from one test could be
// invoked before another test's own `planAndFetch`, inflating its call count
// (lucida-i7r). Direct injection removes the module-registry indirection
// entirely — each orchestrator calls exactly the spy it was handed.
//
// Because injection means the describes now share the real module singletons
// (no per-test module reset), reset the ones tests mutate after every test so
// order can't leak: configStore (which persists `coarseDetailEnabled` to
// happy-dom localStorage) and localStorage.
afterEach(() => {
  configStore.__resetForTesting();
  if (typeof localStorage !== "undefined") localStorage.clear();
});

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
    levelResidency: vi.fn(() => ({ cached: [], inFlight: [] })),
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
      target_level: number;
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
          target_level: 0,
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
    view_query_delta: (_dsId: string) => JSON.stringify({ Full: config.viewQuery }),
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


/** Manifest matching {@link createMockSceneWithTiles}: one group, `n` tiles. */
function createMockContentWithTiles(n: number): DatasetManifest {
  const entities: Array<Record<string, unknown>> = [
    { id: "group-0", kind: "Group", parent: null, labels: {} },
  ];
  const images: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    entities.push({ id: `tile-${i}`, kind: "Tile", parent: "group-0", labels: {} });
    images.push({
      image_id: `img-${i}`,
      owner: `tile-${i}`,
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
    });
  }
  return {
    dataset_id: "ds1",
    name: "test",
    kind: "Single",
    entities,
    transforms: [],
    images,
    source_layouts: [],
    default_layout_id: null,
  } as unknown as DatasetManifest;
}

// ===========================================================================
// 1. Epoch caching
// ===========================================================================

describe("epoch caching", () => {
  // Inject a fresh `plan` spy into each orchestrator (no module mocking) to
  // verify caching behavior: the TickCoordinator should skip plan() when
  // epochs haven't changed.

  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    planSpy = vi.fn(plan);
  });

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), coldStateDisplay: vi.fn(), coldStateSelection: vi.fn(), coldStateDelta: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  function makeOrch(): TickCoordinator {
    return new TickCoordinator(new Uploader(), planSpy as unknown as typeof plan);
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

  it("records a per-tick trace aggregate with no debug surface open", () => {
    const { scene, datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();
    traceRecorder.reset();
    traceRecorder.setEnvironment({
      captureWarmth: () => ({
        detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
      }),
      captureConditions: () => ({
        datasetIds: ["ds"],
        composedView: { url: "/w/ws-1", mode: "slice" },
        devicePixelRatio: 2,
        viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
      }),
      captureOutstanding: () => ({
        pending: 0,
        inFlight: 0,
        speculativePending: 0,
        speculativeInFlight: 0,
        desiredDetailChunks: 0,
        residentDetailChunks: 0,
        desiredCoarseChunks: 0,
        residentCoarseChunks: 0,
      }),
    });
    traceRecorder.openRun({ epoch: "content", dirtyKind: "interactive", source: "test" });

    orch.planAndFetch(makeCtx(scene, datasets), emptyMinimap);

    const [run] = traceRecorder.exportDocument().runs;
    expect(run.ticks.length).toBeGreaterThan(0);
    traceRecorder.reset();
    traceRecorder.setEnvironment(null);
  });

  it("never takes the panel's per-rebuild cache snapshot", () => {
    // `snapshot()` walks every resident entity in the chunk and overview
    // stores. It existed for the debug panel's planning/entityDiag rows and
    // ran only while the panel was open. Recording is unconditional
    // (ADR 0049), so there is no longer a gate that could keep this walk off
    // a rebuild — which means the walk itself has to be gone, not merely
    // ungated. The trace reads counts the cache already keeps instead.
    const { scene, datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;

    orch.planAndFetch(ctx, emptyMinimap);

    expect(cpuCache.snapshot).not.toHaveBeenCalled();
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

  it("coalesces rapid view changes and re-plans once the view settles", () => {
    // A camera move (viewEpoch) no longer pays the O(visible-entities)
    // rebuild every frame: the render pass reflects the fresh camera from
    // the cached roster, so a rapid pan is coalesced. The change is not
    // lost — a trailing rebuild is owed and fires once the view settles
    // past the coalescing window.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { datasets } = makeTickCoordinatorDeps();
      const orch = makeOrch();

      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
      planSpy.mockClear();

      // Within the coalescing window: skipped, no rebuild, but a trailing
      // rebuild is owed.
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
      orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
      expect(planSpy).not.toHaveBeenCalled();
      expect(orch.hasPendingRebuild()).toBe(true);

      // Past the window: the settled view rebuilds and the deferral clears.
      vi.advanceTimersByTime(500);
      orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(orch.hasPendingRebuild()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  it("re-derives manifest-based planning inputs when ds.manifest is replaced without an epoch bump", () => {
    // The per-dataset snapshot-input cache keys camera-independent positions on
    // the content|layout|asset epoch, but the manifest-derived maps
    // (imageSpecById / parentByEntityId) track ds.manifest — which the
    // generated-availability path replaces with a NEW manifest object WITHOUT
    // bumping any scene epoch (renderLoop.updateDatasetManifest only setDirty()s).
    // The cache must therefore also invalidate on ds.manifest reference identity;
    // an epoch-only key would serve a stale ImageSpec and the planner would never
    // request the progressively-generated coarse level (a silent wrong LOD set).
    const manifestFor = (coarseLevelIndex: number | null): DatasetManifest =>
      ({
        dataset_id: "ds1",
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
              coarse_level_index: coarseLevelIndex,
              generated_levels: [],
              levels: [
                { level_index: 0, shape: [1, 1, 1, 1024, 1024], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 4, 4], scale: [1, 1, 1, 1, 1] },
                { level_index: 1, shape: [1, 1, 1, 512, 512], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 2, 2], scale: [1, 1, 1, 2, 2] },
              ],
            },
          },
        ],
        source_layouts: [],
        default_layout_id: null,
      }) as unknown as DatasetManifest;

    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const orch = makeOrch();
      // v1: no coarse level advertised.
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: manifestFor(null) }]]);
      orch.planAndFetch(
        makeCtx(createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } }), datasets),
        emptyMinimap,
      );
      planSpy.mockClear();

      // Generated-availability arrives: ds.manifest is REPLACED (new object) with
      // coarse level 1 now advertised. No scene epoch changes.
      datasets.set("ds1", { manifest: manifestFor(1) });

      // A settled camera move (view epoch only) forces a full replan at the
      // unchanged content|layout|asset key.
      vi.advanceTimersByTime(500);
      orch.planAndFetch(
        makeCtx(createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } }), datasets),
        emptyMinimap,
      );

      expect(planSpy).toHaveBeenCalledTimes(1);
      const snapshot = planSpy.mock.calls[planSpy.mock.calls.length - 1][0] as { entities: Array<{ entityId: string; coarseLevel: number | null }> };
      const entity = snapshot.entities.find((e) => e.entityId === "tile-0");
      // A stale (epoch-only) cache would serve the v1 ImageSpec → coarseLevel null.
      expect(entity?.coarseLevel).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds on the leading selection change, coalesces the rest, then re-plans on settle", () => {
    // Selection (T/C/Z, contrast/gamma/colormap/display) changes what's
    // shown, so the leading change rebuilds promptly. A continuous scrub
    // then coalesces — no per-frame rebuild — and a trailing rebuild
    // applies the settled value.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { datasets } = makeTickCoordinatorDeps();
      const orch = makeOrch();

      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
      planSpy.mockClear();

      // Leading selection change after a settled baseline rebuilds promptly.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 2 } });
      orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(orch.hasPendingRebuild()).toBe(false);
      planSpy.mockClear();

      // A further change within the window coalesces (mid-scrub).
      const scene3 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 3 } });
      orch.planAndFetch(makeCtx(scene3, datasets), emptyMinimap);
      expect(planSpy).not.toHaveBeenCalled();
      expect(orch.hasPendingRebuild()).toBe(true);

      // Past the window: the settled selection rebuilds.
      vi.advanceTimersByTime(500);
      orch.planAndFetch(makeCtx(scene3, datasets), emptyMinimap);
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(orch.hasPendingRebuild()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never coalesces a structural change, even inside the coalescing window", () => {
    // Structural changes (content/layout/asset) must render immediately —
    // a newly-added dataset or layout change can't wait for a window.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { datasets } = makeTickCoordinatorDeps();
      const orch = makeOrch();

      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
      planSpy.mockClear();

      // No time advance — well inside every coalescing window. A content
      // change still rebuilds immediately and owes no deferral.
      const scene2 = createMockScene({ epochs: { content: 2, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(orch.hasPendingRebuild()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps coalescing when a single rebuild runs longer than the window", () => {
    // The coalescing anchor is stamped at rebuild COMPLETION, so the
    // window measures idle time since the rebuild finished. A single
    // rebuild that itself takes longer than the window — routine on a
    // wide collection, where one rebuild is tens to hundreds of ms —
    // must still coalesce the frames that follow it. If the anchor were
    // the tick start, the rebuild's own duration would consume the whole
    // window and every interactive frame would rebuild, which is the
    // frame-rate collapse the fast-path exists to prevent.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { datasets } = makeTickCoordinatorDeps();

      // Plan spy that consumes 210ms of (fake) wall clock per call —
      // longer than the 200ms view window.
      const slowPlan = vi.fn((...args: Parameters<typeof plan>) => {
        vi.advanceTimersByTime(210);
        return plan(...args);
      });
      const orch = new TickCoordinator(
        new Uploader(),
        slowPlan as unknown as typeof plan,
      );

      // Leading rebuild. Runs 210ms; the anchor lands at its completion.
      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
      expect(slowPlan).toHaveBeenCalledTimes(1);
      slowPlan.mockClear();

      // The very next interactive frame lands right after the long
      // rebuild finished. Because the window is measured from rebuild
      // END, it coalesces instead of paying another rebuild.
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
      orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
      expect(slowPlan).not.toHaveBeenCalled();
      expect(orch.hasPendingRebuild()).toBe(true);

      // A run of further interactive frames (still faster than the
      // 200ms window since the rebuild finished) all coalesce too.
      for (let view = 3; view <= 6; view++) {
        vi.advanceTimersByTime(20);
        const s = createMockScene({ epochs: { content: 1, layout: 1, view, selection: 1 } });
        orch.planAndFetch(makeCtx(s, datasets), emptyMinimap);
      }
      expect(slowPlan).not.toHaveBeenCalled();
      expect(orch.hasPendingRebuild()).toBe(true);

      // Once the view settles past the window, the trailing rebuild fires
      // and applies the settled view.
      vi.advanceTimersByTime(300);
      const settled = createMockScene({ epochs: { content: 1, layout: 1, view: 6, selection: 1 } });
      orch.planAndFetch(makeCtx(settled, datasets), emptyMinimap);
      expect(slowPlan).toHaveBeenCalledTimes(1);
      expect(orch.hasPendingRebuild()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears an owed deferral on a genuine cache hit so the loop can idle", () => {
    // Defensive invariant: `pendingDeferredRebuild` drives the render
    // loop to keep ticking. It is set on a coalesced skip and must be
    // cleared on a real cache hit — otherwise a cache hit that arrives
    // while a deferral is still owed (reachable only if an epoch counter
    // regresses, e.g. a future scene reset) would leave the loop spinning
    // at full frame rate with no way to recover. A cache hit means the
    // current scene already matches the last rebuilt state, so there is
    // nothing left to defer.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { datasets } = makeTickCoordinatorDeps();
      const orch = makeOrch();

      // Rebuild at view=1 (anchors lastEpochs at view=1).
      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets), emptyMinimap);
      planSpy.mockClear();

      // view=2 within the window coalesces; the deferral is now owed and
      // `lastEpochs` is deliberately left at view=1.
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
      orch.planAndFetch(makeCtx(scene2, datasets), emptyMinimap);
      expect(planSpy).not.toHaveBeenCalled();
      expect(orch.hasPendingRebuild()).toBe(true);

      // The view epoch regresses back to 1 — now matching `lastEpochs`, so
      // this tick is a genuine cache hit. It must serve the cache AND
      // clear the owed deferral.
      const sceneReset = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(sceneReset, datasets), emptyMinimap);
      expect(planSpy).not.toHaveBeenCalled();
      expect(orch.hasPendingRebuild()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits only budget-admitted legacy proxies while preserving detail requests", () => {
    configStore.set("coarseDetailEnabled", false);
    const { scene, datasets } = makeTickCoordinatorDeps();
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const coldState = vi.fn();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;
    ctx.client = { coldState, coldStateDelta: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"];
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
    } finally {
      configStore.__resetForTesting();
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

  // Scene settings that turn the single label ON — masks are opt-in (hidden by
  // default), so the fetch-merge tests below must explicitly reveal the mask.
  function labeledSettings() {
    return {
      ds1: {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 1,
        gamma: 1,
        blend_mode: "alpha",
        channel_settings: [],
        channel_blend_mode: "additive",
        label_settings: [{ visible: true, opacity: 0.5 }],
      },
    };
  }

  it("merges the label's FULL z-grid into the fetch plan in volume mode", () => {
    const scene = createMockScene({ allSettings: labeledSettings() });
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: labeledContent() }]]);
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;
    ctx.mode = "volume";

    // Force a fresh read of this scene's settings (the module cache persists
    // across tests); in the app a settings change bumps this generation.
    bumpSettingsGeneration();
    orch.planAndFetch(ctx, emptyMinimap);

    const labelReqs = labelRequestsFromSubmit(cpuCache);
    // gz=2 z-chunks (the whole label volume), not a single mapped plane.
    expect(labelReqs.length).toBe(2);
    expect(new Set(labelReqs.map((r) => r.z))).toEqual(new Set([0, 1]));
    // Scoped under the label's own image id, so intensity eviction is untouched.
    expect(labelReqs.every((r) => r.imageId === "img-0:label:region-b")).toBe(true);
  });

  it("merges only the mapped z-plane in slice mode (unchanged)", () => {
    const scene = createMockScene({ allSettings: labeledSettings() });
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: labeledContent() }]]);
    const orch = makeOrch();
    const cpuCache = createMockCpuCache();
    const ctx = makeCtx(scene, datasets);
    ctx.cpuCache = cpuCache;
    ctx.mode = "slice";

    // Force a fresh read of this scene's settings (the module cache persists
    // across tests); in the app a settings change bumps this generation.
    bumpSettingsGeneration();
    orch.planAndFetch(ctx, emptyMinimap);

    const labelReqs = labelRequestsFromSubmit(cpuCache);
    expect(labelReqs.length).toBe(1); // single z-plane
    expect(new Set(labelReqs.map((r) => r.z))).toEqual(new Set([0]));
  });
});

// ===========================================================================
// 1b. Display-only fast path
// ===========================================================================

describe("display-only fast path", () => {
  // Once the coalescing window elapses a rebuild is normally due, but a pure
  // per-channel intensity edit (contrast/gamma/colormap/opacity) needs only
  // a small descriptor patch — the roster, active set, and residency are
  // unchanged, so no plan()/cold-state/submit runs. The path fires ONLY when
  // it can prove nothing else changed: a bundled label toggle, a z-slab
  // extension, a T/C move, or a view move all fall through to a full rebuild.

  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    planSpy = vi.fn(plan);
  });

  function makeOrch(): TickCoordinator {
    return new TickCoordinator(new Uploader(), planSpy as unknown as typeof plan);
  }

  const emptyMinimap = new Map<string, never[]>();

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
    over?: {
      cpuCache?: CpuCache;
      coldState?: ReturnType<typeof vi.fn>;
      coldStateDisplay?: ReturnType<typeof vi.fn>;
      coldStateSelection?: ReturnType<typeof vi.fn>;
      coldStateDelta?: ReturnType<typeof vi.fn>;
    },
  ): TickContext {
    return {
      scene,
      datasets,
      client: {
        coldState: over?.coldState ?? vi.fn(),
        coldStateDisplay: over?.coldStateDisplay ?? vi.fn(),
        coldStateSelection: over?.coldStateSelection ?? vi.fn(),
        coldStateDelta: over?.coldStateDelta ?? vi.fn(),
        viewHotState: vi.fn(),
      } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache: over?.cpuCache ?? createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  const baseSettings = (over: Record<string, unknown> = {}) => ({
    ds1: {
      visible: true,
      opacity: 1,
      contrast_min: 0,
      contrast_max: 1,
      gamma: 1,
      blend_mode: "alpha",
      channel_settings: [],
      channel_blend_mode: "additive",
      ...over,
    },
  });

  it("serves a display-only edit with a descriptor patch, no plan or cold state", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();

      // Leading full rebuild at the baseline display.
      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
      });
      orch.planAndFetch(makeCtx(scene1, datasets, { coldState, coldStateDisplay }), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();

      // Past the window: selection bumps and contrast changes, but T/C/Z,
      // z-range, and every non-display setting are unchanged — a pure
      // intensity-display edit.
      vi.advanceTimersByTime(500);
      bumpSettingsGeneration();
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings({ contrast_min: 1000 }),
      });
      orch.planAndFetch(makeCtx(scene2, datasets, { coldState, coldStateDisplay }), emptyMinimap);

      expect(planSpy).not.toHaveBeenCalled();
      expect(coldState).not.toHaveBeenCalled();
      expect(coldStateDisplay).toHaveBeenCalledTimes(1);
      const pushed = coldStateDisplay.mock.calls[0][0] as {
        datasetId: string;
        displayStateByChannel: Record<number, { contrastMin: number }>;
      };
      expect(pushed.datasetId).toBe("ds1");
      expect(pushed.displayStateByChannel[0].contrastMin).toBe(1000);
      expect(orch.hasPendingRebuild()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves a T scrub with a selection patch — fetches the new T's chunks, no full cold-state resend", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();
      const coldStateSelection = vi.fn();

      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
        t: 0,
      });
      orch.planAndFetch(
        makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDisplay, coldStateSelection }),
        emptyMinimap,
      );
      planSpy.mockClear();
      coldState.mockClear();
      vi.mocked(cpuCache.submit).mockClear();
      vi.mocked(cpuCache.onPlanRebuildStart).mockClear();

      // A T scrub bumps selection AND moves T. The visible set / geometry / LOD
      // / display are unchanged, so it takes the scrub fast path: it regenerates
      // ONLY the changed-T chunk requests from the cached active set (no
      // snapshot rebuild, no re-run of the full plan) and submits them, pushing
      // a compact selection patch instead of rebuilding + re-sending the
      // O(active-set) descriptor array — and never the display-only patch.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings(),
        t: 5,
      });
      orch.planAndFetch(
        makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDisplay, coldStateSelection }),
        emptyMinimap,
      );

      // The full plan is NOT re-run — requests are regenerated from the cached
      // active set — but the new T's chunks are still submitted (the fetch is
      // preserved) and the fetch lifecycle advances once.
      expect(planSpy).not.toHaveBeenCalled();
      expect(cpuCache.submit).toHaveBeenCalledTimes(1);
      expect(cpuCache.onPlanRebuildStart).toHaveBeenCalledTimes(1);
      // The submitted requests target the NEW timepoint (t = 5): a level-0
      // detail chunk key is "level/t/c/z/y/x", so it starts "0/5/".
      const submitted = vi.mocked(cpuCache.submit).mock.calls[0][0] as {
        requests: { t: number; chunkKey: string }[];
      };
      expect(submitted.requests.length).toBeGreaterThan(0);
      expect(submitted.requests.some((r) => r.chunkKey.startsWith("0/5/"))).toBe(true);
      // The O(active-set) cold-state resend is skipped; a compact selection
      // patch carries the new T instead. The display patch never fires.
      expect(coldState).not.toHaveBeenCalled();
      expect(coldStateDisplay).not.toHaveBeenCalled();
      expect(coldStateSelection).toHaveBeenCalledTimes(1);
      const patch = coldStateSelection.mock.calls[0][0] as {
        datasetId: string;
        currentT: number;
      };
      expect(patch.datasetId).toBe("ds1");
      expect(patch.currentT).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves a Z-plane move with a selection patch carrying the new z-range", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateSelection = vi.fn();

      const planeRegion = (start: number) => ({
        xy_bounds: [0, 0, 1024, 1024] as [number, number, number, number],
        z_range: [start, start + 1] as [number, number],
        effective_zoom: 1.0,
        sort_center: null,
        frustum_planes: null,
      });
      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
        z: 0,
        visibleRegion: planeRegion(0),
      });
      orch.planAndFetch(makeCtx(scene1, datasets, { cpuCache, coldState, coldStateSelection }), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();
      vi.mocked(cpuCache.submit).mockClear();

      // A Z-plane move: the range SHIFTS by one plane (same width), so it is a
      // scrub, not a slab extension. New plane's chunks are fetched; a compact
      // patch carries the new z-range.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings(),
        z: 1,
        visibleRegion: planeRegion(1),
      });
      orch.planAndFetch(makeCtx(scene2, datasets, { cpuCache, coldState, coldStateSelection }), emptyMinimap);

      // The full plan is NOT re-run — the request stream is regenerated from the
      // cached active set for the new z-range — while the fetch + patch still go.
      expect(planSpy).not.toHaveBeenCalled();
      expect(cpuCache.submit).toHaveBeenCalledTimes(1);
      expect(coldState).not.toHaveBeenCalled();
      expect(coldStateSelection).toHaveBeenCalledTimes(1);
      const patch = coldStateSelection.mock.calls[0][0] as {
        currentZ: number;
        visibleRegion: { zRangeVox: [number, number] };
      };
      expect(patch.currentZ).toBe(1);
      expect(patch.visibleRegion.zRangeVox).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through to a full rebuild when a contrast edit rides the same T scrub", () => {
    // Compose with the display-only path: when a display edit and a T scrub
    // land in the same coalescing window, neither cheap path can prove its
    // exact precondition, so the full rebuild applies BOTH (nothing dropped).
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();
      const coldStateSelection = vi.fn();

      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
        t: 0,
      });
      orch.planAndFetch(
        makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDisplay, coldStateSelection }),
        emptyMinimap,
      );
      planSpy.mockClear();
      coldState.mockClear();

      vi.advanceTimersByTime(500);
      bumpSettingsGeneration();
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings({ contrast_min: 1000 }),
        t: 5,
      });
      orch.planAndFetch(
        makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDisplay, coldStateSelection }),
        emptyMinimap,
      );

      // Full rebuild: cold state reflects both the new T and the new contrast.
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldState).toHaveBeenCalledTimes(1);
      expect(coldStateDisplay).not.toHaveBeenCalled();
      expect(coldStateSelection).not.toHaveBeenCalled();
      const cold = coldState.mock.calls[0][0] as ColdStateMessage;
      expect(cold.currentT).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does a full rebuild for a T scrub in volume mode (scoped to the slice view)", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const coldState = vi.fn();
      const coldStateSelection = vi.fn();

      const volumeCtx = (scene: unknown) => {
        const c = makeCtx(scene, datasets, { coldState, coldStateSelection });
        return { ...c, mode: "volume" } as TickContext;
      };

      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
        t: 0,
      });
      orch.planAndFetch(volumeCtx(scene1), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();

      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings(),
        t: 5,
      });
      orch.planAndFetch(volumeCtx(scene2), emptyMinimap);

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldState).toHaveBeenCalledTimes(1);
      expect(coldStateSelection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships a view-move delta on a pure camera move (not a display patch or a full cold state)", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();
      const coldStateDelta = vi.fn();

      // First tick: a full cold state syncs the worker's active set.
      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(
        makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDisplay, coldStateDelta }),
        emptyMinimap,
      );
      expect(coldState).toHaveBeenCalledTimes(1);
      planSpy.mockClear();
      coldState.mockClear();
      vi.mocked(cpuCache.submit).mockClear();
      vi.mocked(cpuCache.onPlanRebuildStart).mockClear();

      // Past the window: a pure camera move (view epoch advanced). This is not a
      // selection change, so the display-only path is not eligible; the active
      // set genuinely changed, so plan + fetch still run — but only the compact
      // delta is shipped, not a full O(active-set) cold state.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
      orch.planAndFetch(
        makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDisplay, coldStateDelta }),
        emptyMinimap,
      );

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldStateDelta).toHaveBeenCalledTimes(1);
      expect(coldState).not.toHaveBeenCalled();
      expect(coldStateDisplay).not.toHaveBeenCalled();
      expect(cpuCache.submit).toHaveBeenCalledTimes(1);
      expect(cpuCache.onPlanRebuildStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships a second delta on a chained view move with no full send between (sync + previousActiveSet thread)", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDelta = vi.fn();

      // Full send syncs the worker.
      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDelta }), emptyMinimap);
      expect(coldState).toHaveBeenCalledTimes(1);
      coldState.mockClear();

      // First view move → delta. The dataset stays synced and `planningState`
      // advances to this move's active set.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
      orch.planAndFetch(makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDelta }), emptyMinimap);
      expect(coldStateDelta).toHaveBeenCalledTimes(1);

      // Second view move with NO full send between: the delta must fire again —
      // `coldStateSyncedDatasets` stayed true and `previousActiveSet` threaded
      // from the first delta's active set — never falling back to a full send.
      vi.advanceTimersByTime(500);
      const scene3 = createMockScene({ epochs: { content: 1, layout: 1, view: 3, selection: 1 } });
      orch.planAndFetch(makeCtx(scene3, datasets, { cpuCache, coldState, coldStateDelta }), emptyMinimap);

      expect(coldStateDelta).toHaveBeenCalledTimes(2);
      expect(coldState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does a full rebuild when a label-settings change rides the same selection diff", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();

      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings({ label_settings: [{ visible: false, opacity: 1 }] }),
      });
      orch.planAndFetch(makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDisplay }), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();
      vi.mocked(cpuCache.submit).mockClear();

      // Past the window: a label toggle (visible false → true) bundled with
      // a contrast edit in one selection diff. The label chunk-fetch must
      // not be skipped, so this falls through to a full rebuild — not the
      // display-only patch.
      vi.advanceTimersByTime(500);
      bumpSettingsGeneration();
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings({
          contrast_min: 1000,
          label_settings: [{ visible: true, opacity: 1 }],
        }),
      });
      orch.planAndFetch(makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDisplay }), emptyMinimap);

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldState).toHaveBeenCalledTimes(1);
      expect(cpuCache.submit).toHaveBeenCalledTimes(1);
      expect(coldStateDisplay).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does a full rebuild when a z-slab extension rides the same selection diff", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();

      const singlePlaneRegion = {
        xy_bounds: [0, 0, 1024, 1024] as [number, number, number, number],
        z_range: [0, 1] as [number, number],
        effective_zoom: 1.0,
        sort_center: null,
        frustum_planes: null,
      };
      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
        visibleRegion: singlePlaneRegion,
      });
      orch.planAndFetch(makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDisplay }), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();
      vi.mocked(cpuCache.submit).mockClear();

      // Past the window: the slab deepens (z_range end 1 → 4) bundled with a
      // contrast edit in one selection diff. `scene.z()` (the slab start) is
      // unchanged, so only the full z-range reveals the extension — the
      // deeper z-chunks must be fetched, so this falls through to a rebuild.
      vi.advanceTimersByTime(500);
      bumpSettingsGeneration();
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings({ contrast_min: 1000 }),
        visibleRegion: { ...singlePlaneRegion, z_range: [0, 4] },
      });
      orch.planAndFetch(makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDisplay }), emptyMinimap);

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldState).toHaveBeenCalledTimes(1);
      expect(cpuCache.submit).toHaveBeenCalledTimes(1);
      expect(coldStateDisplay).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// 2. Multi-dataset
// ===========================================================================

describe("multi-dataset planning", () => {
  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    planSpy = vi.fn(plan);
  });

  function makeOrch(): TickCoordinator {
    return new TickCoordinator(new Uploader(), planSpy as unknown as typeof plan);
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
            target_level: 0,
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
      client: { coldState: vi.fn(), coldStateDisplay: vi.fn(), coldStateSelection: vi.fn(), coldStateDelta: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
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
    // Bump a structural epoch (content) so tick 2 does a full rebuild —
    // interactive-only epochs (view/selection) coalesce and would skip
    // the rebuild this test needs to observe state threading across.
    const scene2 = createMockScene({
      datasetOrder: ["ds1", "ds2"],
      epochs: { content: 2, layout: 1, view: 1, selection: 1 },
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
// 2b. Incremental delta fold
// ===========================================================================

describe("incremental delta fold", () => {
  // Under coarseDetail (the shipping default), a settled camera move
  // reconstructs each dataset's `entities` by folding `view_query_delta` onto a
  // per-dataset cursor instead of re-parsing the full visible set. These tests
  // exercise the `Delta` branch directly — the shared `createMockScene` mock
  // hardcodes `view_query_delta` to a `Full`, so that branch is otherwise
  // uncovered at this layer.
  //
  // Both tests drive ONE scene object across ticks: a delta cursor is keyed on
  // scene identity, so a fresh scene per tick would reset it before the fold
  // could engage. The scene carries mutable epochs (bumped per tick) and a
  // scripted `view_query_delta` (one payload per fold call, in order), with
  // `view_query` a spy standing in for the authoritative full set.

  let planSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    planSpy = vi.fn(plan);
  });

  function makeOrch(): TickCoordinator {
    return new TickCoordinator(new Uploader(), planSpy as unknown as typeof plan);
  }

  const emptyMinimap = new Map<string, never[]>();

  function makeCtx(scene: unknown, datasets: Map<string, DatasetEntry>): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), coldStateDisplay: vi.fn(), coldStateSelection: vi.fn(), coldStateDelta: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache: createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  type FoldRow = MockSceneConfig["viewQuery"]["visible_entities"][number];

  function foldRow(over: Partial<FoldRow> = {}): FoldRow {
    return {
      entity_id: "tile-0",
      image_id: "img-0",
      kind: "Tile",
      visible: true,
      projected_diagonal_px: 100,
      projected_area_px2: 10000,
      centroid_world: [0, 0, 0],
      target_level: 0,
      importance: 1.0,
      ...over,
    };
  }

  const deltaEpochs = { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 };

  function fullPayload(rows: FoldRow[]): string {
    return JSON.stringify({ Full: { epochs: deltaEpochs, visible_entities: rows } });
  }

  function deltaPayload(entered: FoldRow[], left: string[], changed: FoldRow[]): string {
    return JSON.stringify({ Delta: { epochs: deltaEpochs, entered, left, changed } });
  }

  /**
   * A single scene object (stable identity across ticks) whose epochs are
   * mutable, whose `view_query` is a spy returning the current full set (the
   * reseed oracle), and whose `view_query_delta` replays a script one payload
   * per call. Bump the view epoch via `setView` between ticks to force a
   * settled replan.
   */
  function makeFoldScene(opts: {
    fullRows: FoldRow[];
    deltaScript: string[];
    memberPositions: Record<string, [number, number]>;
  }) {
    const epochs = { content: 1, layout: 1, view: 1, selection: 1 };
    const fullRows = opts.fullRows;
    const script = [...opts.deltaScript];
    const viewQuery = vi.fn(() => JSON.stringify({ visible_entities: fullRows }));
    const viewQueryDelta = vi.fn(() => {
      const next = script.shift();
      if (next === undefined) throw new Error("view_query_delta script exhausted");
      return next;
    });
    const base = createMockScene({ epochs, memberPositions: opts.memberPositions }) as Record<string, unknown>;
    const scene = {
      ...base,
      epochs: () => JSON.stringify(epochs),
      view_query: viewQuery,
      view_query_delta: viewQueryDelta,
    };
    return {
      scene,
      viewQuery,
      viewQueryDelta,
      setView: (v: number) => { epochs.view = v; },
    };
  }

  const positions4: Record<string, [number, number]> = {
    "tile-0": [0, 0],
    "tile-1": [1024, 0],
    "tile-2": [2048, 0],
    "tile-3": [3072, 0],
    "tile-orphan": [9999, 0],
  };

  it("folds a real Delta on the second replan instead of re-querying the full set", () => {
    // Guards against a green-but-inert fold: if the incremental path silently
    // always reseeded (or always went Full), this Delta's entered/left/changed
    // would still be reflected via the full re-parse and the test would pass
    // for the wrong reason — so it also asserts the full `view_query` was NOT
    // consulted on the folding replan.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContentWithTiles(4) }]]);
      const orch = makeOrch();

      const fold = makeFoldScene({
        fullRows: [
          foldRow({ entity_id: "tile-0", image_id: "img-0" }),
          foldRow({ entity_id: "tile-1", image_id: "img-1" }),
        ],
        deltaScript: [
          // Tick 1 — Full seeds the cursor with img-0, img-1.
          fullPayload([
            foldRow({ entity_id: "tile-0", image_id: "img-0" }),
            foldRow({ entity_id: "tile-1", image_id: "img-1" }),
          ]),
          // Tick 2 — a real Delta: img-2 enters, img-0 leaves, img-1's LOD changes.
          deltaPayload(
            [foldRow({ entity_id: "tile-2", image_id: "img-2" })],
            ["img-0"],
            [foldRow({ entity_id: "tile-1", image_id: "img-1", target_level: 2 })],
          ),
        ],
        memberPositions: positions4,
      });

      // Tick 1 — leading full rebuild seeds the fold cursor from the Full.
      orch.planAndFetch(makeCtx(fold.scene, datasets), emptyMinimap);
      planSpy.mockClear();
      fold.viewQuery.mockClear();

      // Tick 2 — a settled camera move (view epoch only) past the coalescing
      // window folds the Delta onto the cursor.
      vi.advanceTimersByTime(500);
      fold.setView(2);
      orch.planAndFetch(makeCtx(fold.scene, datasets), emptyMinimap);

      // The fold engaged — the Delta was applied without a full re-parse.
      expect(fold.viewQuery).not.toHaveBeenCalled();
      expect(planSpy).toHaveBeenCalledTimes(1);

      const snapshot = planSpy.mock.calls[0][0] as {
        entities: Array<{ imageId: string; targetLevel: number }>;
      };
      const byImage = new Map(snapshot.entities.map((e) => [e.imageId, e]));
      expect(byImage.get("img-1")?.targetLevel).toBe(2); // changed row applied
      expect(byImage.has("img-2")).toBe(true); // entered row present
      expect(byImage.has("img-0")).toBe(false); // left row absent
    } finally {
      vi.useRealTimers();
    }
  });

  it("reseeds from a fresh full build after a fold throws, never onto the stale pre-throw cursor", () => {
    // A mid-fold throw (a Tile with no parent edge violates a producer
    // invariant in makeEntitySnapshot) advances the Rust cursor but must not
    // leave the TS cursor holding the prior tick's map: the next tick would
    // then fold onto that stale base and silently drop the throwing tick's
    // entered/left/changed forever. After the throwing tick the reconstructed
    // set must equal a fresh full build — no ghost of a left record, no stale
    // change, the correct entered record.
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContentWithTiles(4) }]]);
      const orch = makeOrch();

      const fold = makeFoldScene({
        // The reseed oracle: the true current set at tick 3 (img-0 left,
        // img-2 + the orphan entered-then-left, img-1 changed to LOD 2,
        // img-3 entered).
        fullRows: [
          foldRow({ entity_id: "tile-1", image_id: "img-1", target_level: 2 }),
          foldRow({ entity_id: "tile-3", image_id: "img-3" }),
        ],
        deltaScript: [
          // Tick 1 — Full seeds the cursor {img-0, img-1}.
          fullPayload([
            foldRow({ entity_id: "tile-0", image_id: "img-0" }),
            foldRow({ entity_id: "tile-1", image_id: "img-1" }),
          ]),
          // Tick 2 — a Delta upserting a Tile with NO parent edge → throws
          // mid-fold. It also carries a legit left (img-0) and change
          // (img-1 → LOD 2) that a stale-cursor fold would bury forever.
          deltaPayload(
            [
              foldRow({ entity_id: "tile-orphan", image_id: "img-orphan" }),
              foldRow({ entity_id: "tile-2", image_id: "img-2" }),
            ],
            ["img-0"],
            [foldRow({ entity_id: "tile-1", image_id: "img-1", target_level: 2 })],
          ),
          // Tick 3 — a Delta the fold must NOT apply onto the pre-throw map.
          deltaPayload(
            [foldRow({ entity_id: "tile-3", image_id: "img-3" })],
            ["img-2", "img-orphan"],
            [],
          ),
        ],
        memberPositions: positions4,
      });

      // Tick 1 — seed.
      orch.planAndFetch(makeCtx(fold.scene, datasets), emptyMinimap);
      planSpy.mockClear();

      // Tick 2 — the fold throws; the failure must stay loud (propagate).
      vi.advanceTimersByTime(500);
      fold.setView(2);
      expect(() => orch.planAndFetch(makeCtx(fold.scene, datasets), emptyMinimap)).toThrow(/parent edge/);

      // Tick 3 — the next settled replan must reconstruct the true current set
      // from a fresh full build, not fold tick 3's Delta onto the stale cursor.
      vi.advanceTimersByTime(500);
      fold.setView(3);
      orch.planAndFetch(makeCtx(fold.scene, datasets), emptyMinimap);

      expect(planSpy).toHaveBeenCalledTimes(1);
      const snapshot = planSpy.mock.calls[0][0] as {
        entities: Array<{ imageId: string; targetLevel: number }>;
      };
      const byImage = new Map(snapshot.entities.map((e) => [e.imageId, e]));
      // Equals a fresh full build: no ghost left record (img-0), the change
      // applied (img-1 at its new LOD), the correct entered record (img-3).
      expect([...byImage.keys()].sort()).toEqual(["img-1", "img-3"]);
      expect(byImage.get("img-1")?.targetLevel).toBe(2);
      expect(byImage.has("img-0")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
