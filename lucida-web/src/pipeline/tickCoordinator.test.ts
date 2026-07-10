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
import { debugStats } from "../debug/debugStats.ts";

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
// happy-dom localStorage), debugStats (`enabled`/`orch`), and localStorage.
afterEach(() => {
  configStore.__resetForTesting();
  debugStats.enabled = false;
  debugStats.orch = null;
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
    getCachedChunk: vi.fn(() => null),
    isChunkSent: vi.fn(() => false),
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

/** Scene with `n` visible tiles (`tile-0` … `tile-{n-1}`) laid out in a row. */
function createMockSceneWithTiles(n: number) {
  const rows: MockSceneConfig["viewQuery"]["visible_entities"] = [];
  const memberPositions: Record<string, [number, number]> = {};
  for (let i = 0; i < n; i++) {
    rows.push({
      entity_id: `tile-${i}`,
      image_id: `img-${i}`,
      kind: "Tile",
      visible: true,
      projected_diagonal_px: 100,
      projected_area_px2: 10000,
      centroid_world: [i * 1024, 0, 0],
      ideal_target_lod: 0,
      importance: 1.0,
    });
    memberPositions[`tile-${i}`] = [i * 1024, 0];
  }
  return createMockScene({ viewQuery: { visible_entities: rows }, memberPositions });
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
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
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
    },
  ): TickContext {
    return {
      scene,
      datasets,
      client: {
        coldState: over?.coldState ?? vi.fn(),
        coldStateDisplay: over?.coldStateDisplay ?? vi.fn(),
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

  it("does a full rebuild when a selection edit changes T (different chunks)", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();

      bumpSettingsGeneration();
      const scene1 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 1 },
        allSettings: baseSettings(),
        t: 0,
      });
      orch.planAndFetch(makeCtx(scene1, datasets, { coldState, coldStateDisplay }), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();

      // A T scrub bumps selection AND moves T — the chunks differ, so this
      // must NOT take the display-only path.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({
        epochs: { content: 1, layout: 1, view: 1, selection: 2 },
        allSettings: baseSettings(),
        t: 5,
      });
      orch.planAndFetch(makeCtx(scene2, datasets, { coldState, coldStateDisplay }), emptyMinimap);

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldState).toHaveBeenCalledTimes(1);
      expect(coldStateDisplay).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does a full rebuild on a view move (the display-only path never fires)", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
      const orch = makeOrch();
      const cpuCache = createMockCpuCache();
      const coldState = vi.fn();
      const coldStateDisplay = vi.fn();

      const scene1 = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
      orch.planAndFetch(makeCtx(scene1, datasets, { cpuCache, coldState, coldStateDisplay }), emptyMinimap);
      planSpy.mockClear();
      coldState.mockClear();
      vi.mocked(cpuCache.submit).mockClear();
      vi.mocked(cpuCache.onPlanRebuildStart).mockClear();

      // Past the window: a pure camera move (view epoch advanced). This is
      // not a selection change, so the display-only path is not eligible and
      // the full rebuild runs — roster, cold state, and submit all fire.
      vi.advanceTimersByTime(500);
      const scene2 = createMockScene({ epochs: { content: 1, layout: 1, view: 2, selection: 1 } });
      orch.planAndFetch(makeCtx(scene2, datasets, { cpuCache, coldState, coldStateDisplay }), emptyMinimap);

      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(coldState).toHaveBeenCalledTimes(1);
      expect(coldStateDisplay).not.toHaveBeenCalled();
      expect(cpuCache.submit).toHaveBeenCalledTimes(1);
      expect(cpuCache.onPlanRebuildStart).toHaveBeenCalledTimes(1);
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
// 3. Cache-occupancy telemetry
// ===========================================================================

describe("cache occupancy telemetry", () => {
  // `CpuCache.snapshot()` walks every resident entity in the chunk and
  // overview stores, so a rebuild must take at most ONE snapshot — and
  // none at all while no debug surface consumes it. These tests pin
  // both the call count and the entityDiag content derived from it.

  let TickCoordinator: typeof import("./tickCoordinator.ts").TickCoordinator;
  let Uploader: typeof import("./upload/uploader.ts").Uploader;
  let debugStats: typeof import("../debug/debugStats.ts").debugStats;

  beforeEach(async () => {
    // Fresh module registry so the module-global debugStats sink can't
    // leak panel state between tests.
    vi.resetModules();
    TickCoordinator = (await import("./tickCoordinator.ts")).TickCoordinator;
    Uploader = (await import("./upload/uploader.ts")).Uploader;
    debugStats = (await import("../debug/debugStats.ts")).debugStats;
  });

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
    cpuCache: CpuCache,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache,
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  const emptyMinimap = new Map<string, never[]>();
  const N = 6; // > 5 so the entityDiag cap is exercised too.

  function makeDeps() {
    const scene = createMockSceneWithTiles(N);
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContentWithTiles(N) }],
    ]);
    return { scene, datasets };
  }

  it("never snapshots the cpu cache while debug stats are off", () => {
    const { scene, datasets } = makeDeps();
    const cpuCache = createMockCpuCache();
    const orch = new TickCoordinator(new Uploader());

    expect(debugStats.enabled).toBe(false);
    orch.planAndFetch(makeCtx(scene, datasets, cpuCache), emptyMinimap);

    expect(cpuCache.snapshot).not.toHaveBeenCalled();
  });

  it("snapshots the cpu cache at most once per rebuild while debug stats are on", () => {
    const { scene, datasets } = makeDeps();
    const cpuCache = createMockCpuCache();
    const orch = new TickCoordinator(new Uploader());

    debugStats.enabled = true;
    debugStats.orch = null;
    try {
      orch.planAndFetch(makeCtx(scene, datasets, cpuCache), emptyMinimap);

      expect(vi.mocked(cpuCache.snapshot).mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      debugStats.enabled = false;
    }
  });

  it("reports per-entity cached-key counts in entityDiag from the snapshot", () => {
    const { scene, datasets } = makeDeps();
    const cpuCache = createMockCpuCache();
    vi.mocked(cpuCache.snapshot).mockReturnValue({
      cached: new Map([
        ["tile-0", new Set(["0/0.0.0.0.0", "0/0.0.0.1.0"])],
        ["tile-2", new Set(["0/0.0.0.0.1"])],
      ]),
      inFlight: new Map(),
    });
    const orch = new TickCoordinator(new Uploader());

    debugStats.enabled = true;
    debugStats.orch = null;
    try {
      orch.planAndFetch(makeCtx(scene, datasets, cpuCache), emptyMinimap);

      // `debugStats.orch = null` above narrows the property to `null`;
      // planAndFetch repopulates it, so widen back for the read.
      const orchDebug = debugStats.orch as {
        entityDiag: Array<{ entityId: string; cachedKeys: number }>;
      } | null;
      const diag = orchDebug?.entityDiag ?? [];
      // Capped at 5 entries even though 6 entities are visible.
      expect(diag).toHaveLength(5);
      expect(diag.map((e) => [e.entityId, e.cachedKeys])).toEqual([
        ["tile-0", 2],
        ["tile-1", 0],
        ["tile-2", 1],
        ["tile-3", 0],
        ["tile-4", 0],
      ]);
    } finally {
      debugStats.enabled = false;
    }
  });
});

// ===========================================================================
// 4. Debug-stat row bounds on wide member sets
// ===========================================================================

describe("debug stat row bounds", () => {
  // The panel consumes per-member arrays every poll and renders rows from
  // them; on a wide collection an unbounded build (tens of thousands of
  // rows per rebuild) freezes the page for seconds. The arrays must stay
  // capped while the scalar totals keep reporting the full population.

  let TickCoordinator: typeof import("./tickCoordinator.ts").TickCoordinator;
  let Uploader: typeof import("./upload/uploader.ts").Uploader;
  let debugStats: typeof import("../debug/debugStats.ts").debugStats;
  let DEBUG_MEMBER_ROW_CAP: number;

  beforeEach(async () => {
    vi.resetModules();
    TickCoordinator = (await import("./tickCoordinator.ts")).TickCoordinator;
    Uploader = (await import("./upload/uploader.ts")).Uploader;
    const dbg = await import("../debug/debugStats.ts");
    debugStats = dbg.debugStats;
    DEBUG_MEMBER_ROW_CAP = dbg.DEBUG_MEMBER_ROW_CAP;
  });

  function makeCtx(scene: unknown, datasets: Map<string, DatasetEntry>): TickContext {
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

  it("caps per-member debug arrays while totals report the full population", () => {
    const N = 150; // wider than the row cap
    const scene = createMockSceneWithTiles(N);
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContentWithTiles(N) }],
    ]);
    const orch = new TickCoordinator(new Uploader());

    debugStats.enabled = true;
    debugStats.orch = null;
    try {
      orch.planAndFetch(makeCtx(scene, datasets), new Map());

      expect(DEBUG_MEMBER_ROW_CAP).toBeGreaterThan(0);
      expect(debugStats.memberStats.length).toBeLessThanOrEqual(DEBUG_MEMBER_ROW_CAP);
      expect(debugStats.totalMembers).toBe(N);

      const orchDebug = debugStats.orch as {
        members: unknown[];
        membersTotal: number;
        activeSet: unknown[];
        activeSetTotal: number;
      } | null;
      expect(orchDebug).not.toBeNull();
      expect(orchDebug!.members.length).toBeLessThanOrEqual(DEBUG_MEMBER_ROW_CAP);
      expect(orchDebug!.membersTotal).toBe(N);
      expect(orchDebug!.activeSet.length).toBeLessThanOrEqual(DEBUG_MEMBER_ROW_CAP);
      expect(orchDebug!.activeSetTotal).toBe(N);
    } finally {
      debugStats.enabled = false;
    }
  });
});

describe("debug member stats honesty", () => {
  // The Per-Member panel header and the sent/needed columns must report
  // real state on every tick — including the epoch-hit (idle) ticks
  // that replay the last rebuild's rows.

  let TickCoordinator: typeof import("./tickCoordinator.ts").TickCoordinator;
  let Uploader: typeof import("./upload/uploader.ts").Uploader;
  let debugStats: typeof import("../debug/debugStats.ts").debugStats;
  let resetFrameStats: typeof import("../debug/debugStats.ts").resetFrameStats;

  beforeEach(async () => {
    vi.resetModules();
    TickCoordinator = (await import("./tickCoordinator.ts")).TickCoordinator;
    Uploader = (await import("./upload/uploader.ts")).Uploader;
    const dbg = await import("../debug/debugStats.ts");
    debugStats = dbg.debugStats;
    resetFrameStats = dbg.resetFrameStats;
  });

  function makeCtx(
    scene: unknown,
    datasets: Map<string, DatasetEntry>,
    cpuCache?: CpuCache,
  ): TickContext {
    return {
      scene,
      datasets,
      client: { coldState: vi.fn(), viewHotState: vi.fn() } as unknown as TickContext["client"],
      canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement,
      mode: "slice",
      renderScale: 1,
      cpuCache: cpuCache ?? createMockCpuCache(),
      assetCatalog: createMockAssetCatalog(),
    } as unknown as TickContext;
  }

  function makeDeps(n: number) {
    const scene = createMockSceneWithTiles(n);
    const datasets = new Map<string, DatasetEntry>([
      ["ds1", { manifest: createMockContentWithTiles(n) }],
    ]);
    return { scene, datasets };
  }

  it("replays the uncapped active-member total on epoch-hit ticks", () => {
    const { scene, datasets } = makeDeps(3);
    const orch = new TickCoordinator(new Uploader());
    debugStats.enabled = true;
    try {
      const ctx = makeCtx(scene, datasets);
      orch.planAndFetch(ctx, new Map());
      const total = debugStats.memberStatsActiveTotal;
      const rows = debugStats.memberStats.length;
      expect(total).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);

      // Idle tick: the render loop resets per-frame stats, then the
      // epoch fast-path replays the last rebuild's member snapshot.
      resetFrameStats();
      orch.planAndFetch(ctx, new Map());
      expect(debugStats.memberStats.length).toBe(rows);
      expect(debugStats.memberStatsActiveTotal).toBe(total);
    } finally {
      debugStats.enabled = false;
    }
  });

  it("computes per-member sent counts from the cache's delivery ledger", () => {
    const { scene, datasets } = makeDeps(2);
    const orch = new TickCoordinator(new Uploader());
    const cpuCache = createMockCpuCache();
    vi.mocked(cpuCache.isChunkSent).mockReturnValue(true);
    debugStats.enabled = true;
    try {
      orch.planAndFetch(makeCtx(scene, datasets, cpuCache), new Map());
      expect(debugStats.memberStats.length).toBeGreaterThan(0);
      for (const row of debugStats.memberStats) {
        expect(row.chunksNeeded).toBeGreaterThan(0);
        expect(row.chunksSent).toBe(row.chunksNeeded);
      }
    } finally {
      debugStats.enabled = false;
    }
  });

  it("refreshes sent counts on epoch-hit ticks as idle deliveries land", () => {
    const { scene, datasets } = makeDeps(2);
    const orch = new TickCoordinator(new Uploader());
    const cpuCache = createMockCpuCache();
    debugStats.enabled = true;
    try {
      const ctx = makeCtx(scene, datasets, cpuCache);
      orch.planAndFetch(ctx, new Map());
      expect(debugStats.memberStats.length).toBeGreaterThan(0);
      for (const row of debugStats.memberStats) {
        expect(row.chunksSent).toBe(0);
      }

      // Deliveries land while the camera is idle; the next replayed
      // tick must show the progress instead of the rebuild-time zeros.
      vi.mocked(cpuCache.isChunkSent).mockReturnValue(true);
      resetFrameStats();
      orch.planAndFetch(ctx, new Map());
      for (const row of debugStats.memberStats) {
        expect(row.chunksSent).toBe(row.chunksNeeded);
      }
    } finally {
      debugStats.enabled = false;
    }
  });
});
