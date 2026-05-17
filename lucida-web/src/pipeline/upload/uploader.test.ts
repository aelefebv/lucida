import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DatasetManifest } from "../../manifestTypes.ts";
import type { DatasetEntry } from "../../renderLoopTypes.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
  ReadyDelivery,
} from "../fetch/index.ts";
import type { TickContext } from "../../renderLoopTypes.ts";
import { AssetCatalog } from "../assetCatalog.ts";
import type { ChunkRequest, ProxyRequest } from "../planning/index.ts";
import type { ColdStateMessage, MissingProxy } from "../../renderer/workerProtocol.ts";
import type { DeliveryTracker } from "./delivery/tracker.ts";

// Upload-side describes for the `Uploader` surface. The Uploader owns
// delivery tracking, cold/hot state emission, drain/resend dispatch,
// and worker feedback; the Orchestrator drives `planAndFetch` and hands
// per-dataset results into the Uploader. Tests that exercise the
// upload-only surface use a standalone `Uploader`; tests that exercise
// the planner → uploader integration (cold-state display state,
// viewHotState emission, multi-dataset upload, cold-state lifecycle)
// construct both and rely on the orchestrator to wire the per-dataset
// calls through.

/** Stub WASM scene that satisfies AssetCatalog's narrow interface. */
function createMockAssetCatalog(): AssetCatalog {
  return new AssetCatalog({ apply_asset_catalog_delta: () => {} });
}

// ---------------------------------------------------------------------------
// Mock factories (shared with orchestrator.test.ts; copied here to keep the
// two test files independent — duplication is intentional, the fixtures
// rarely change and avoiding a shared helper module keeps the test
// files self-contained.)
// ---------------------------------------------------------------------------

function createMockCpuCache(): CpuCache {
  return {
    submit: vi.fn(),
    drain: vi.fn(() => []),
    snapshot: vi.fn(() => ({ cached: new Map(), inFlight: new Map() })),
    getCached: vi.fn(() => null),
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
// 1. Proxy delivery tracking
// ===========================================================================

describe("proxy delivery tracking", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let Orchestrator: typeof import("../orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    Orchestrator = (await import("../orchestrator.ts")).Orchestrator;
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
    const uploader = new Uploader();
    const delivery = makeProxyDelivery();
    const cpuCache = makeMockCpuCache({ drainResult: [delivery] });
    const proxyAssetData = vi.fn();
    const ctx = makeCtx({ cpuCache, proxyAssetDataMock: proxyAssetData });

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, null);

    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(uploader.getProxyDeliveredKeys().has(proxyKey(delivery))).toBe(true);
  });

  it("proxy resend uses getCachedProxy when key missing from delivered set", () => {
    const uploader = new Uploader();
    const delivery = makeProxyDelivery();
    const req = makeProxyRequest();

    // Pre-populate the uploader's last-proxy-requests so the resend
    // pass has work to do. The private field is per-dataset
    // (`Map<string, ProxyRequest[]>`); tests seed via the same
    // intent-named helper `recordPlanForDataset` the orchestrator
    // calls. multi_channel=false → workerMemberId = imageId.
    uploader.recordPlanForDataset("ds-test", [], [req], false);

    // Cache returns the proxy on getCachedProxy lookup.
    const cached = new Map<string, ReadyProxyDelivery>();
    cached.set(proxyKey(req), delivery);
    const cpuCache = makeMockCpuCache({ cachedProxies: cached });
    const proxyAssetData = vi.fn();
    const ctx = makeCtx({ cpuCache, proxyAssetDataMock: proxyAssetData });

    // First call: drain returns nothing (we left it empty), but the
    // resend pass should still pick up the cached proxy because the
    // key is missing from delivered tracking.
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, null);
    expect(proxyAssetData).toHaveBeenCalledTimes(1);
    expect(uploader.getProxyDeliveredKeys().has(proxyKey(req))).toBe(true);

    // Second call: key is now in delivered set → no resend.
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, null);
    expect(proxyAssetData).toHaveBeenCalledTimes(1);

    // After explicit clear, resend kicks in again.
    uploader.getProxyDeliveredKeys().delete(proxyKey(req));
    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, null);
    expect(proxyAssetData).toHaveBeenCalledTimes(2);
  });

  it("tracker proxy-delivered set persists across full plans (worker proxy pools survive cold state)", () => {
    // Worker proxy pools are not rebuilt on cold state (only chunk atlases
    // are). Re-sending proxies on every full plan would upload-spam them
    // every time a view epoch bumps (e.g., wheel scroll). Worker eviction
    // is reported via wantedSetDelta; that's the only signal that should
    // clear the tracking.
    const uploader = new Uploader();
    const orch = new Orchestrator(uploader);

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

    uploader.getProxyDeliveredKeys().add("ds1|x|FieldProxy3D|0|0");
    expect(uploader.getProxyDeliveredKeys().size).toBe(1);

    orch.planAndFetch(ctx, new Map());
    expect(uploader.getProxyDeliveredKeys().size).toBe(1);
  });

  it("handleWantedSetDelta with proxy entries clears delivered tracking", () => {
    const uploader = new Uploader();
    const key = "ds1|field-0|FieldProxy3D|0|0";
    uploader.getProxyDeliveredKeys().add(key);
    expect(uploader.getProxyDeliveredKeys().has(key)).toBe(true);

    const missing: MissingProxy = {
      kind: "proxy",
      datasetId: "ds1",
      entityId: "field-0",
      proxyKind: "FieldProxy3D",
      t: 0,
      c: 0,
    };
    uploader.handleWantedSetDelta([missing]);

    expect(uploader.getProxyDeliveredKeys().has(key)).toBe(false);
  });
});

// ===========================================================================
// 2. cold-state display state propagation
// ===========================================================================

describe("cold-state display state", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let Orchestrator: typeof import("../orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    Orchestrator = (await import("../orchestrator.ts")).Orchestrator;
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
    const orch = new Orchestrator(new Uploader());
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
    const { bumpSettingsGeneration } = await import("../../tickCommon.ts");
    const orch = new Orchestrator(new Uploader());
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
    const orch = new Orchestrator(new Uploader());
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
// 3. viewHotState emission (per-viewEpoch ray-pick coords)
// ===========================================================================

describe("viewHotState emission", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let Orchestrator: typeof import("../orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    Orchestrator = (await import("../orchestrator.ts")).Orchestrator;
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
    const orch = new Orchestrator(new Uploader());
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
    const orch = new Orchestrator(new Uploader());
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
    const orch = new Orchestrator(new Uploader());
    const datasets = new Map<string, DatasetEntry>([["ds1", { manifest: createMockContent() }]]);
    const sceneA = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 1 } });
    const viewHotA = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(sceneA, datasets, viewHotA), new Map());
    expect(viewHotA).toHaveBeenCalledTimes(1);

    // Selection epoch bumps but view epoch does NOT — re-plan happens but
    // hot state should be skipped since the camera-ray pick can't have
    // moved without a viewEpoch advance.
    const { bumpSettingsGeneration } = await import("../../tickCommon.ts");
    bumpSettingsGeneration();
    const sceneB = createMockScene({ epochs: { content: 1, layout: 1, view: 1, selection: 2 } });
    const viewHotB = vi.fn();
    orch.planAndFetch(makeCtxWithViewHotSpy(sceneB, datasets, viewHotB), new Map());
    expect(viewHotB).not.toHaveBeenCalled();
  });

  it("re-emits viewHotState when viewEpoch advances", () => {
    const orch = new Orchestrator(new Uploader());
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
    const orch = new Orchestrator(new Uploader());
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
// 4. Chunk delivery (drain pass)
// ===========================================================================
//
// The drain pass + dispatch + resend pass + LOD/lane filters were the
// largest blind spot in upload-phase coverage; these tests pin the
// contracts so the dispatch/drain extractions stay honest.

describe("chunk delivery (drain pass)", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  // After `vi.resetModules()` re-import the same `debugStats` instance
  // the uploader binds, otherwise the uploader's writes land on a
  // different module instance than the assertion-side reads.
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
   * Seed the uploader's per-tick request state without running
   * planAndFetch. `deliverToWorker` depends on the per-dataset
   * `lastFilteredRequests` (target-LOD map + resend loop) being
   * populated. Tests that pin drain-pass behavior call
   * `recordPlanForDataset` directly so the test doesn't have to
   * round-trip through plan().
   */
  function seedLastRequests(
    uploader: InstanceType<typeof Uploader>,
    reqs: ChunkRequest[],
    multiChannel = false,
  ): void {
    uploader.recordPlanForDataset("ds-test", reqs, [], multiChannel);
  }

  it("drain happy path: slice mode → sliceChunkData called with expected args", () => {
    const uploader = new Uploader();
    const delivery = makeChunkDelivery();
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, mode: "slice", sliceChunkData: sliceFn });
    seedLastRequests(uploader, [makeChunkRequest()]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).toHaveBeenCalledTimes(1);
    // First positional arg: workerMemberId; single-channel = bare imageId.
    expect(sliceFn.mock.calls[0][0]).toBe("img-0");
    // Second: chunks array of exactly one element (the uploader
    // never batches today — see contract scan §"arrays carry one element").
    expect(sliceFn.mock.calls[0][1]).toHaveLength(1);
    expect(sliceFn.mock.calls[0][1][0].key).toBe("0/0/0/0/0/0");
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(1);
    expect(scopedDebugStats.upload!.tick!.bytesUploaded).toBe(1024);
  });

  it("drain happy path: volume mode → volumeChunkData called instead", () => {
    const uploader = new Uploader();
    const delivery = makeChunkDelivery();
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const volumeFn = vi.fn();
    const ctx = makeChunkCtx({
      cpuCache, mode: "volume",
      sliceChunkData: sliceFn, volumeChunkData: volumeFn,
    });
    seedLastRequests(uploader, [makeChunkRequest()]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, null);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(volumeFn).toHaveBeenCalledTimes(1);
    expect(volumeFn.mock.calls[0][0]).toBe("img-0");
    expect(volumeFn.mock.calls[0][1]).toHaveLength(1);
  });

  it("lane=prefetch → skippedPrefetch bumps; no client call", () => {
    const uploader = new Uploader();
    const delivery = makeChunkDelivery({ lane: "prefetch" });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [makeChunkRequest()]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedPrefetch).toBe(1);
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(0);
  });

  it("lane=overview → skippedOverview bumps; no client call", () => {
    const uploader = new Uploader();
    const delivery = makeChunkDelivery({ lane: "overview" });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [makeChunkRequest()]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedOverview).toBe(1);
    expect(scopedDebugStats.upload!.tick!.uploadedChunks).toBe(0);
  });

  it("level mismatch (delivery.level != target) → skippedWrongLod bumps; no client call", () => {
    const uploader = new Uploader();
    // Plan asks for level 1 but the drained chunk is level 0.
    const delivery = makeChunkDelivery({ level: 0 });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [makeChunkRequest({ level: 1, chunkKey: "1/0/0/0/0/0" })]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedWrongLod).toBe(1);
  });

  it("already-sent guard: second call with same chunkKey/memberId → skippedAlreadySent", () => {
    const uploader = new Uploader();
    // First call sends; second call drains the same chunk again, and the
    // already-sent guard bumps `skippedAlreadySent`.
    const cpuCache1 = makeChunkCpuCache({ drainResult: [makeChunkDelivery()] });
    const sliceFn = vi.fn();
    const ctx1 = makeChunkCtx({ cpuCache: cpuCache1, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [makeChunkRequest()]);
    uploader.deliverToWorker(ctx1, 8 * 1024 * 1024, 0);
    expect(sliceFn).toHaveBeenCalledTimes(1);

    // Second tick: same delivery, same manifest, but the sentSet now
    // contains the chunk key.
    const cpuCache2 = makeChunkCpuCache({ drainResult: [makeChunkDelivery()] });
    const ctx2 = makeChunkCtx({ cpuCache: cpuCache2, sliceChunkData: sliceFn });
    uploader.deliverToWorker(ctx2, 8 * 1024 * 1024, 0);

    expect(sliceFn).toHaveBeenCalledTimes(1); // no second send
    expect(scopedDebugStats.upload!.tick!.skippedAlreadySent).toBe(1);
  });

  it("manifest-not-found: delivery for an unknown imageId → skippedNoMeta; no client call", () => {
    const uploader = new Uploader();
    const delivery = makeChunkDelivery({ imageId: "img-ghost" });
    const cpuCache = makeChunkCpuCache({ drainResult: [delivery] });
    const sliceFn = vi.fn();
    // Target table maps the ghost image to level 0 so the wrong-LOD
    // filter passes and we reach the manifest scan.
    seedLastRequests(uploader, [makeChunkRequest({ imageId: "img-ghost" })]);
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.skippedNoMeta).toBe(1);
  });

  it("resend pass: chunk in _lastFilteredRequests not in sentSet, cache returns it → re-uploaded", () => {
    const uploader = new Uploader();
    const req = makeChunkRequest({ chunkKey: "0/0/0/1/0/0" });
    const cachedDelivery = makeChunkDelivery({ chunkKey: "0/0/0/1/0/0" });
    const cachedMap = new Map<string, ReadyChunkDelivery>();
    cachedMap.set(`${req.entityId}|${req.chunkKey}`, cachedDelivery);
    const cpuCache = makeChunkCpuCache({ cachedChunks: cachedMap });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [req]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    // No drain happened → resend pass picked it up.
    expect(sliceFn).toHaveBeenCalledTimes(1);
    expect(scopedDebugStats.upload!.tick!.resendChunkUploads).toBe(1);
    expect(scopedDebugStats.upload!.tick!.resendChunksConsidered).toBe(1);
  });

  it("resend pass: chunk in tracker's rejected set → skipped; resendChunksRejected bumps", () => {
    const uploader = new Uploader();
    const req = makeChunkRequest({ chunkKey: "0/0/0/2/0/0" });
    const cpuCache = makeChunkCpuCache();
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [req]);
    // Mark the chunk as rejected for the worker member id (= imageId
    // since multiChannel = false). The resend pass checks the tracker
    // BEFORE consulting the cache, so the cache mock is irrelevant here.
    // Drive through the worker-eviction path so we exercise the same
    // tracker contract the runtime uses.
    uploader.handleChunksEvicted("img-0", [], [req.chunkKey], cpuCache);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.resendChunksRejected).toBe(1);
    expect(scopedDebugStats.upload!.tick!.resendChunkUploads).toBe(0);
  });

  it("resend pass: cache miss for re-considered chunk → resendChunksNotCached bumps", () => {
    const uploader = new Uploader();
    const req = makeChunkRequest({ chunkKey: "0/0/0/3/0/0" });
    // Empty cachedChunks map → getCachedChunk returns null.
    const cpuCache = makeChunkCpuCache();
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [req]);

    uploader.deliverToWorker(ctx, 8 * 1024 * 1024, 0);

    expect(sliceFn).not.toHaveBeenCalled();
    expect(scopedDebugStats.upload!.tick!.resendChunksNotCached).toBe(1);
    expect(scopedDebugStats.upload!.tick!.resendChunkUploads).toBe(0);
  });

  it("budget-exhausted soft cap: a single oversize chunk still uploads but flips budgetExhausted", () => {
    const uploader = new Uploader();
    // 4 MB chunk, 1 MB budget — `remaining -= sent` lands at -3 MB,
    // the check `if (remaining <= 0) budgetExhausted = true` fires
    // AFTER the upload succeeded. UploadTickStats.budgetExhausted
    // docs this overshoot explicitly.
    const big = makeChunkDelivery({ data: new ArrayBuffer(4 * 1024 * 1024) });
    const cpuCache = makeChunkCpuCache({ drainResult: [big] });
    const sliceFn = vi.fn();
    const ctx = makeChunkCtx({ cpuCache, sliceChunkData: sliceFn });
    seedLastRequests(uploader, [makeChunkRequest()]);

    const ret = uploader.deliverToWorker(ctx, 1 * 1024 * 1024, 0);

    expect(sliceFn).toHaveBeenCalledTimes(1);
    expect(scopedDebugStats.upload!.tick!.budgetExhausted).toBe(true);
    expect(scopedDebugStats.upload!.tick!.bytesUploaded).toBe(4 * 1024 * 1024);
    // Return signal: caller schedules another tick.
    expect(ret).toBe(true);
  });
});

// ===========================================================================
// 5. handleChunksEvicted characterization
// ===========================================================================

describe("handleChunksEvicted", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
  });

  function getTracker(
    uploader: InstanceType<typeof Uploader>,
  ): DeliveryTracker {
    // Private field access for test inspection. The tracker is the
    // canonical source of chunk-side state; `wasChunkSent` /
    // `wasChunkRejected` give us cleaner assertions than poking at the
    // raw `chunkSent` / `chunkRejected` maps.
    return (uploader as unknown as {
      deliveryTracker: DeliveryTracker;
    }).deliveryTracker;
  }

  function seedSentSet(
    uploader: InstanceType<typeof Uploader>,
    wid: string,
    keys: string[],
    entityId = "field-0",
  ): void {
    const tracker = getTracker(uploader);
    for (const k of keys) tracker.markChunkSent(wid, entityId, k);
  }

  // We seed rejected state through `markChunkEvicted` (skipped path)
  // so we exercise the same contract the runtime uses.
  function seedRejectedSet(
    uploader: InstanceType<typeof Uploader>,
    wid: string,
    keys: string[],
  ): void {
    getTracker(uploader).markChunkEvicted(wid, [], keys);
  }

  function seedWidToEntity(
    uploader: InstanceType<typeof Uploader>,
    wid: string,
    entityId: string,
  ): void {
    getTracker(uploader).recordMember(wid, entityId);
  }

  function getSentKeys(
    uploader: InstanceType<typeof Uploader>,
    wid: string,
    candidates: string[],
  ): Set<string> {
    const tracker = getTracker(uploader);
    return new Set(candidates.filter(k => tracker.wasChunkSent(wid, k)));
  }

  function getRejectedKeys(
    uploader: InstanceType<typeof Uploader>,
    wid: string,
    candidates: string[],
  ): Set<string> {
    const tracker = getTracker(uploader);
    return new Set(candidates.filter(k => tracker.wasChunkRejected(wid, k)));
  }

  it("evicted keys are removed from the tracker's sent set", () => {
    const uploader = new Uploader();
    seedSentSet(uploader, "img-0", ["k1", "k2", "k3"]);

    uploader.handleChunksEvicted("img-0", ["k1", "k3"], [], createMockCpuCache());

    expect(getSentKeys(uploader, "img-0", ["k1", "k2", "k3"])).toEqual(new Set(["k2"]));
  });

  it("evicted keys are removed from the tracker's rejected set (acceptance proves deliverable)", () => {
    const uploader = new Uploader();
    seedRejectedSet(uploader, "img-0", ["k1", "k2"]);

    uploader.handleChunksEvicted("img-0", ["k1"], [], createMockCpuCache());

    expect(getRejectedKeys(uploader, "img-0", ["k1", "k2"])).toEqual(new Set(["k2"]));
  });

  it("skipped keys are added to the tracker's rejected set", () => {
    const uploader = new Uploader();
    seedSentSet(uploader, "img-0", ["k1"]);

    uploader.handleChunksEvicted("img-0", [], ["k1", "k2"], createMockCpuCache());

    expect(getRejectedKeys(uploader, "img-0", ["k1", "k2"])).toEqual(new Set(["k1", "k2"]));
    // skipped also removes from sent.
    expect(getSentKeys(uploader, "img-0", ["k1", "k2"])).toEqual(new Set());
  });

  it("skipped keys are forwarded to cpuCache.markRejected with the resolved entityId", () => {
    const uploader = new Uploader();
    seedWidToEntity(uploader, "img-0:ch1", "field-0");
    const cpuCache = createMockCpuCache();
    const markRejected = cpuCache.markRejected as ReturnType<typeof vi.fn>;

    uploader.handleChunksEvicted("img-0:ch1", [], ["kA", "kB"], cpuCache);

    expect(markRejected).toHaveBeenCalledTimes(2);
    expect(markRejected.mock.calls[0]).toEqual(["field-0", "kA"]);
    expect(markRejected.mock.calls[1]).toEqual(["field-0", "kB"]);
  });

  it("silent skip: markRejected NOT called when no wid → entityId mapping exists", () => {
    const uploader = new Uploader();
    // No seedWidToEntity → tracker.entityIdFor returns null.
    const cpuCache = createMockCpuCache();
    const markRejected = cpuCache.markRejected as ReturnType<typeof vi.fn>;

    uploader.handleChunksEvicted("img-ghost", [], ["k1"], cpuCache);

    expect(markRejected).not.toHaveBeenCalled();
    // The rejected set still receives the key (so the resend pass
    // short-circuits future re-attempts), but the cache isn't told.
    expect(getRejectedKeys(uploader, "img-ghost", ["k1"])).toEqual(new Set(["k1"]));
  });
});

// ===========================================================================
// 6. Multi-dataset upload characterization
// ===========================================================================
//
// Pin two historical bugs so regressions can't sneak back in:
//
//   - `_lastFilteredRequests` was a flat `ChunkRequest[]` overwritten
//     per-dataset → the resend pass only saw the LAST dataset's
//     requests after a multi-dataset rebuild. Same shape for
//     `_lastProxyRequests`. The Uploader now keeps both as per-dataset
//     maps (`lastFilteredRequests` / `lastProxyRequests`).
//   - `deliverySentToWorker.clear()` ran once per per-dataset step
//     inside `planAndFetch`, effectively clearing everything early on;
//     the tracker reset is now hoisted to once-per-tick.

describe("multi-dataset upload characterization", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let Orchestrator: typeof import("../orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    Orchestrator = (await import("../orchestrator.ts")).Orchestrator;
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

  // `lastFilteredRequests` is a `Map<datasetId, ChunkRequest[]>`, so a
  // multi-dataset rebuild preserves every dataset's requests rather
  // than the last-processed one's. The resend pass in `deliverToWorker`
  // iterates every entry.
  it(
    "lastFilteredRequests keeps both datasets' requests across a multi-dataset rebuild",
    () => {
      const uploader = new Uploader();
      const orch = new Orchestrator(uploader);
      const scene = makeMultiDatasetScene();
      const datasets = makeTwoDatasetEntries();
      orch.planAndFetch(makeCtx(scene, datasets), new Map());

      const lastFilteredByDataset = (uploader as unknown as {
        lastFilteredRequests: Map<string, ChunkRequest[]>;
      }).lastFilteredRequests;
      // Per-dataset map exposes both ds1 and ds2 entries.
      expect(lastFilteredByDataset.has("ds1")).toBe(true);
      expect(lastFilteredByDataset.has("ds2")).toBe(true);
      const ds1Reqs = lastFilteredByDataset.get("ds1") ?? [];
      const ds2Reqs = lastFilteredByDataset.get("ds2") ?? [];
      expect(ds1Reqs.length).toBeGreaterThan(0);
      expect(ds2Reqs.length).toBeGreaterThan(0);
      const ds1Images = new Set(ds1Reqs.map(r => r.imageId));
      const ds2Images = new Set(ds2Reqs.map(r => r.imageId));
      expect(ds1Images.has("img-0")).toBe(true);
      expect(ds2Images.has("img-0")).toBe(true);
    },
  );

  it(
    "lastProxyRequests keeps both datasets' proxies across a multi-dataset rebuild",
    () => {
      // Today's fixtures don't produce any actual proxy requests
      // (visible_entities only has field-0 in both datasets and the
      // plan doesn't promote to proxy), so this asserts the per-dataset
      // map shape: both datasets register entries (even when empty),
      // confirming the last-dataset-wins overwrite is gone.
      const uploader = new Uploader();
      const orch = new Orchestrator(uploader);
      const scene = makeMultiDatasetScene();
      const datasets = makeTwoDatasetEntries();
      orch.planAndFetch(makeCtx(scene, datasets), new Map());

      const lastProxyByDataset = (uploader as unknown as {
        lastProxyRequests: Map<string, ProxyRequest[]>;
      }).lastProxyRequests;
      expect(lastProxyByDataset).toBeDefined();
      expect(lastProxyByDataset.has("ds1")).toBe(true);
      expect(lastProxyByDataset.has("ds2")).toBe(true);
    },
  );

  it("tracker.wasChunkSent returns false after a fresh multi-dataset rebuild (clear-all behavior)", async () => {
    // A single `uploader.onPlanRebuildStart()` at the top of the
    // rebuild path consolidates the chunk-tracker reset across every
    // dataset in the rebuild.
    const uploader = new Uploader();
    const orch = new Orchestrator(uploader);
    const tracker = (uploader as unknown as {
      deliveryTracker: DeliveryTracker;
    }).deliveryTracker;
    // Pre-seed a tracking entry that should be cleared by the rebuild.
    tracker.markChunkSent("img-stale", "field-stale", "k1");

    const scene = makeMultiDatasetScene();
    const datasets = makeTwoDatasetEntries();
    orch.planAndFetch(makeCtx(scene, datasets), new Map());

    expect(tracker.wasChunkSent("img-stale", "k1")).toBe(false);
  });

  it("per-dataset sendColdState + sendViewHotState: each dataset receives its own message on initial plan", () => {
    const uploader = new Uploader();
    const orch = new Orchestrator(uploader);
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
// 7. Cold-state lifecycle invariant
// ===========================================================================

describe("cold-state lifecycle invariant", () => {
  let Uploader: typeof import("./uploader.ts").Uploader;
  let Orchestrator: typeof import("../orchestrator.ts").Orchestrator;

  beforeEach(async () => {
    vi.resetModules();
    Uploader = (await import("./uploader.ts")).Uploader;
    Orchestrator = (await import("../orchestrator.ts")).Orchestrator;
  });

  it("after sendColdState, tracker.wasChunkSent returns false for previously-sent keys", async () => {
    // Invariant: `uploader.onPlanRebuildStart()` at the top of every
    // rebuild path calls `deliveryTracker.onColdStateRebuild()`, which
    // clears the sent / rejected / wid → entity maps in one shot.
    // Without this the worker would build a fresh atlas while the
    // orchestrator believed chunks were already supplied — atlas would
    // stay empty for stale keys.
    const uploader = new Uploader();
    const orch = new Orchestrator(uploader);
    // Seed: pretend a previous tick delivered a chunk for "img-0".
    const tracker = (uploader as unknown as {
      deliveryTracker: DeliveryTracker;
    }).deliveryTracker;
    tracker.markChunkSent("img-0", "field-0", "0/0/0/0/0/0");

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

    expect(tracker.wasChunkSent("img-0", "0/0/0/0/0/0")).toBe(false);
  });
});
