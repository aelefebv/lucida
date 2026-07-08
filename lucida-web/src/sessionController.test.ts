// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";

// The controller constructs the real connection stack; replace the classes
// holding live resources (WebSocket, decode workers, request timers) with
// instance-recording doubles. The Session and its catalogs are real.
vi.mock("./bridge.ts", () => {
  class MockBridge {
    static instances: MockBridge[] = [];
    handlers: unknown;
    workspaceId: string | undefined;
    destroy = vi.fn();
    send = vi.fn();
    sendCommand = vi.fn();
    sendPresence = vi.fn();
    sendDatasetPresence = vi.fn();
    sendCursor = vi.fn();
    sendFollow = vi.fn();
    sendOpenRemoteDataset = vi.fn();
    subscribeBookmarkChanged = vi.fn(() => () => {});
    constructor(handlers: unknown, _url?: string, workspaceId?: string) {
      this.handlers = handlers;
      this.workspaceId = workspaceId;
      MockBridge.instances.push(this);
    }
  }
  return { Bridge: MockBridge, bridgeLog: vi.fn() };
});

vi.mock("./pipeline/fetch/index.ts", () => {
  class MockDecodePool {
    static instances: MockDecodePool[] = [];
    size = 2;
    terminate = vi.fn();
    constructor() {
      MockDecodePool.instances.push(this);
    }
  }
  class MockProxiedContentSource {
    static instances: MockProxiedContentSource[] = [];
    rejectAll = vi.fn();
    rejectDataset = vi.fn();
    registerImage = vi.fn();
    handleBinary = vi.fn();
    handleChunkStatus = vi.fn();
    constructor(_send: unknown) {
      MockProxiedContentSource.instances.push(this);
    }
  }
  class MockCpuCache {
    static instances: MockCpuCache[] = [];
    reset = vi.fn();
    resetChunkFailureStreak = vi.fn();
    config: unknown;
    constructor(_source: unknown, _pool: unknown, config?: unknown) {
      this.config = config;
      MockCpuCache.instances.push(this);
    }
  }
  return {
    DecodePool: MockDecodePool,
    ProxiedContentSource: MockProxiedContentSource,
    CpuCache: MockCpuCache,
  };
});

import {
  SessionController,
  type RemoteDatasetActivity,
  type SessionControllerDeps,
  type SessionControllerEvents,
} from "./sessionController.ts";
import { applyDocumentCommand, applyViewportCommand } from "./applyAndSend.ts";
import { Bridge, type BridgeHandlers, type PresenceState } from "./bridge.ts";
import { DecodePool, ProxiedContentSource, CpuCache } from "./pipeline/fetch/index.ts";
import type { WasmScene } from "lucida-core";

const MockedBridge = Bridge as unknown as {
  instances: Array<{
    handlers: BridgeHandlers;
    workspaceId?: string;
    destroy: ReturnType<typeof vi.fn>;
    sendPresence: ReturnType<typeof vi.fn>;
    sendFollow: ReturnType<typeof vi.fn>;
  }>;
};
const MockedContentSource = ProxiedContentSource as unknown as {
  instances: Array<{
    registerImage: ReturnType<typeof vi.fn>;
    rejectAll: ReturnType<typeof vi.fn>;
  }>;
};
const MockedDecodePool = DecodePool as unknown as {
  instances: Array<{ terminate: ReturnType<typeof vi.fn> }>;
};
const MockedCpuCache = CpuCache as unknown as {
  instances: Array<{
    reset: ReturnType<typeof vi.fn>;
    resetChunkFailureStreak: ReturnType<typeof vi.fn>;
    config?: {
      onChunkFailureStreak?: (consecutiveFailures: number, lastError: string) => void;
      onChunkFailureRecovered?: () => void;
    };
  }>;
};

/** The WASM surface the controller touches, as call-recording stubs. */
function makeFakeScene() {
  return {
    load_document: vi.fn(),
    apply_command: vi.fn(),
    apply_asset_catalog_delta: vi.fn(),
    available_layouts: vi.fn(() => "[]"),
    export_presence: vi.fn(() => "{}"),
    import_presence: vi.fn(),
    import_dataset_presence: vi.fn(),
    fit_camera_to_dataset_bounds: vi.fn(),
    z: vi.fn(() => 0),
    t: vi.fn(() => 0),
    c: vi.fn(() => 0),
    camera_mode: vi.fn(() => "slice"),
    multi_channel: vi.fn(() => false),
  };
}

function makeManifest(datasetId: string) {
  return {
    dataset_id: datasetId,
    name: `${datasetId}.zarr`,
    kind: "Single",
    entities: [],
    transforms: [],
    images: [
      {
        image_id: `${datasetId}-img`,
        owner: `${datasetId}-entity`,
        multiscale: {
          axes: [
            { name: "t", kind: "Time" },
            { name: "c", kind: "Channel" },
            { name: "z", kind: "Space" },
            { name: "y", kind: "Space" },
            { name: "x", kind: "Space" },
          ],
          levels: [
            {
              level_index: 0,
              shape: [1, 1, 1, 4, 4],
              chunk_shape: [1, 1, 1, 4, 4],
              grid_shape: [1, 1, 1, 1, 1],
              scale: [1, 1, 1, 1, 1],
            },
          ],
          data_type: "Uint16",
          pinned_axes: [],
        },
      },
    ],
    source_layouts: [],
    default_layout_id: null,
  };
}

function snapshotJson(datasetIds: string[]): string {
  const manifests: Record<string, unknown> = {};
  for (const id of datasetIds) manifests[id] = makeManifest(id);
  return JSON.stringify({ manifests });
}

function datasetOpenedJson(datasetId: string, openerClientId: number | null): string {
  const manifest = makeManifest(datasetId);
  return JSON.stringify({
    type: "dataset_opened",
    manifest,
    fetch: {
      Proxied: {
        images: [
          { image_id: `${datasetId}-img`, wire_format: { Raw: { data_type: "Uint16" } } },
        ],
      },
    },
    catalog: { entries: [] },
    opener_client_id: openerClientId,
  });
}

function makePresence(clientId: number): PresenceState {
  return {
    client_id: clientId,
    camera: { position: [0, 0, 1] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    following: null,
    cursor: null,
    dataset_order: [],
    dataset_settings: {},
  };
}

function makeEvents(): SessionControllerEvents {
  return {
    onConnectedChanged: vi.fn(),
    onSessionReadyChanged: vi.fn(),
    onSelfIdChanged: vi.fn(),
    onPeersChanged: vi.fn(),
    onFollowTargetChanged: vi.fn(),
    onRemoteDatasetActivity: vi.fn(),
    onSceneChanged: vi.fn(),
    onDatasetsChanged: vi.fn(),
    onRemoteDocumentChanged: vi.fn(),
    onWorkspaceArchived: vi.fn(),
  };
}

function makeHarness() {
  const scene = makeFakeScene();
  const sceneRef: { current: WasmScene | null } = { current: null };
  const events = makeEvents();
  const datasets = new Map<string, never>();
  const savedViewHooks = {
    onDatasetOpened: vi.fn(),
    onOpenDatasetFailed: vi.fn(),
    isInProgress: vi.fn(() => false),
  };
  const deps = {
    workspaceId: "ws-1",
    ensureScene: vi.fn(() => {
      sceneRef.current = scene as unknown as WasmScene;
      return sceneRef.current;
    }),
    getScene: () => sceneRef.current,
    getLoop: () => null,
    datasets,
    removeDatasetLocal: vi.fn(),
    getSavedViewHooks: () => savedViewHooks,
    bumpLayerSettingsVersion: vi.fn(),
    initLayerMaps: vi.fn(),
    setSelectedDatasetId: vi.fn(),
    viewState: {
      setZ: vi.fn(),
      setC: vi.fn(),
      setT: vi.fn(),
      setViewMode: vi.fn(),
      setMultiChannel: vi.fn(),
    },
    events,
  } satisfies SessionControllerDeps;
  const controller = new SessionController(deps);
  const handlers = MockedBridge.instances[MockedBridge.instances.length - 1].handlers;
  return { controller, handlers, deps, events, scene, savedViewHooks, datasets };
}

beforeEach(() => {
  MockedBridge.instances.length = 0;
  MockedContentSource.instances.length = 0;
  MockedDecodePool.instances.length = 0;
  MockedCpuCache.instances.length = 0;
});

describe("SessionController dataset registration", () => {
  it("a live open for a dataset the snapshot already registered reuses its pipeline but still fires the open reactions", () => {
    const { handlers, scene, savedViewHooks, events } = makeHarness();
    const contentSource = MockedContentSource.instances[0];

    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    expect(contentSource.registerImage).toHaveBeenCalledTimes(1);
    // A snapshot registration is a join/repair, not a user-initiated open.
    expect(savedViewHooks.onDatasetOpened).not.toHaveBeenCalled();
    expect(scene.fit_camera_to_dataset_bounds).not.toHaveBeenCalled();

    // The dedup rebroadcast case: the same dataset arrives as a live
    // `dataset_opened` (opened by us). Registration is idempotent; the
    // open reactions (applier notify, loading clear, auto-fit) still run.
    handlers.onCommand(2, datasetOpenedJson("wds-1", 4));
    expect(contentSource.registerImage).toHaveBeenCalledTimes(1);
    expect(savedViewHooks.onDatasetOpened).toHaveBeenCalledWith("wds-1");
    expect(scene.fit_camera_to_dataset_bounds).toHaveBeenCalledWith("wds-1");
    expect(events.onRemoteDatasetActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ loading: false, progress: null }),
    );
  });

  it("registers a brand-new dataset exactly once from a live open", () => {
    const { handlers, deps, savedViewHooks } = makeHarness();
    const contentSource = MockedContentSource.instances[0];

    handlers.onSnapshot(1, snapshotJson([]), [], 4, {});
    handlers.onCommand(2, datasetOpenedJson("wds-9", 4));

    expect(contentSource.registerImage).toHaveBeenCalledTimes(1);
    expect(deps.datasets.has("wds-9")).toBe(true);
    expect(deps.initLayerMaps).toHaveBeenCalledExactlyOnceWith("wds-9");
    expect(deps.setSelectedDatasetId).toHaveBeenCalledWith("wds-9");
    expect(savedViewHooks.onDatasetOpened).toHaveBeenCalledWith("wds-9");
  });
});

describe("SessionController self id", () => {
  it("a dataset_opened handled in the same tick as the snapshot sees the snapshot's self id", () => {
    const { handlers, scene } = makeHarness();

    // The bridge replays pending commands through onCommand synchronously
    // right after onSnapshot returns; the opener gate must already see the
    // snapshot's your_id (NOT a deferred/stale value), or the opener's own
    // auto-fit is suppressed.
    handlers.onSnapshot(1, snapshotJson([]), [], 3, {});
    handlers.onCommand(1, datasetOpenedJson("wds-1", 3));
    expect(scene.fit_camera_to_dataset_bounds).toHaveBeenCalledTimes(1);

    // A peer's open (different opener id) never reframes this client.
    handlers.onCommand(2, datasetOpenedJson("wds-2", 8));
    expect(scene.fit_camera_to_dataset_bounds).toHaveBeenCalledTimes(1);
  });

  it("a follow steer addressed to the live self id adopts the target's presence", () => {
    const { handlers, events, scene } = makeHarness();

    handlers.onSnapshot(1, snapshotJson([]), [makePresence(2)], 7, {});
    handlers.onFollowChanged?.(7, 2);

    expect(events.onFollowTargetChanged).toHaveBeenCalledWith(2);
    expect(scene.import_presence).toHaveBeenCalledTimes(1);
    expect(MockedBridge.instances[0].sendPresence).toHaveBeenCalled();
  });
});

describe("SessionController remote-document-changed coalescing", () => {
  it("a snapshot with N pending replays emits onRemoteDocumentChanged exactly once, after the replays", async () => {
    const { handlers, events, scene } = makeHarness();
    const docChanged = events.onRemoteDocumentChanged as ReturnType<typeof vi.fn>;
    let applyCallsAtEmit = -1;
    docChanged.mockImplementation(() => {
      applyCallsAtEmit = scene.apply_command.mock.calls.length;
    });

    // Mirror the bridge's snapshot burst: onSnapshot, then the pending local
    // commands replayed synchronously through onCommand with the snapshot's
    // seq (bridge.ts hands `snapshotSeq` to each replay).
    handlers.onSnapshot(5, snapshotJson(["wds-1"]), [], 4, {});
    handlers.onCommand(5, JSON.stringify({ type: "set_dataset_visible", dataset_id: "wds-1", visible: false }));
    handlers.onCommand(5, JSON.stringify({ type: "set_dataset_opacity", dataset_id: "wds-1", opacity: 0.5 }));

    // Nothing yet — the burst is still in its synchronous window.
    expect(docChanged).not.toHaveBeenCalled();

    await Promise.resolve();

    // Exactly one signal for snapshot + 2 replays, delivered after the
    // replays applied (a synchronous listener sees post-replay state).
    expect(docChanged).toHaveBeenCalledTimes(1);
    expect(applyCallsAtEmit).toBe(scene.apply_command.mock.calls.length);
    expect(scene.apply_command).toHaveBeenCalledWith(
      JSON.stringify({ type: "set_dataset_opacity", dataset_id: "wds-1", opacity: 0.5 }),
    );
  });

  it("a live command outside a snapshot burst still emits synchronously", async () => {
    const { handlers, events } = makeHarness();
    const docChanged = events.onRemoteDocumentChanged as ReturnType<typeof vi.fn>;

    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    await Promise.resolve();
    expect(docChanged).toHaveBeenCalledTimes(1);

    handlers.onCommand(2, JSON.stringify({ type: "set_dataset_visible", dataset_id: "wds-1", visible: false }));
    // Synchronous — no flush needed.
    expect(docChanged).toHaveBeenCalledTimes(2);
  });

  it("a controller destroyed before the scheduled emission never emits", async () => {
    const { controller, handlers, events } = makeHarness();
    const docChanged = events.onRemoteDocumentChanged as ReturnType<typeof vi.fn>;

    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    controller.destroy();
    await Promise.resolve();

    expect(docChanged).not.toHaveBeenCalled();
  });
});

/** Activity emissions that carry a non-null error (the visible banner). */
function errorEmissions(events: SessionControllerEvents): string[] {
  return (events.onRemoteDatasetActivity as ReturnType<typeof vi.fn>).mock.calls
    .map(([activity]) => (activity as { error: string | null }).error)
    .filter((error): error is string => error !== null);
}

/** The most recent activity emission — the state the UI is showing now. */
function lastActivity(events: SessionControllerEvents): RemoteDatasetActivity {
  const calls = (events.onRemoteDatasetActivity as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as RemoteDatasetActivity;
}

describe("SessionController scene failure surfacing", () => {
  const visibilityCmd = JSON.stringify({
    type: "set_dataset_visible",
    dataset_id: "wds-1",
    visible: false,
  });

  it("repeated apply_command failures surface a visible error", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new Error("state mismatch");
    });

    handlers.onCommand(2, visibilityCmd);
    handlers.onCommand(3, visibilityCmd);
    expect(errorEmissions(events)).toHaveLength(0);

    handlers.onCommand(4, visibilityCmd);
    const errors = errorEmissions(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("state mismatch");
  });

  it("a fatal-class engine error surfaces on the first failure", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new Error(
        "recursive use of an object detected which would lead to unsafe aliasing in rust",
      );
    });

    handlers.onCommand(2, visibilityCmd);
    expect(errorEmissions(events)).toHaveLength(1);
  });

  it("a wasm trap (RuntimeError) surfaces on the first failure", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });

    handlers.onCommand(2, visibilityCmd);
    expect(errorEmissions(events)).toHaveLength(1);
  });

  it("isolated failures between successful applies never trip the surface", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});

    let fail = false;
    scene.apply_command.mockImplementation(() => {
      if (fail) throw new Error("transient hiccup");
    });
    // fail → ok → fail → ok → fail: three failures, never consecutive.
    for (let i = 0; i < 5; i++) {
      fail = i % 2 === 0;
      handlers.onCommand(2 + i, visibilityCmd);
    }

    expect(errorEmissions(events)).toHaveLength(0);
  });

  it("healthy applies emit no error at all", () => {
    const { handlers, events } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    for (let i = 0; i < 10; i++) {
      handlers.onCommand(2 + i, visibilityCmd);
    }
    expect(errorEmissions(events)).toHaveLength(0);
  });

  it("an already-visible failure is not re-emitted per subsequent failure", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });

    for (let i = 0; i < 8; i++) {
      handlers.onCommand(2 + i, visibilityCmd);
    }
    expect(errorEmissions(events)).toHaveLength(1);
  });

  it("a chunk fetch failure streak reported by the cache surfaces through the same channel", () => {
    const { events } = makeHarness();
    const config = MockedCpuCache.instances[0].config;
    expect(config?.onChunkFailureStreak).toBeTypeOf("function");

    config!.onChunkFailureStreak!(12, "403 rejected");

    const errors = errorEmissions(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("12");
    expect(errors[0]).toContain("403 rejected");
  });
});

describe("SessionController local scene mutation surfacing", () => {
  it("a fatal local apply through applyAndSend surfaces without any remote command traffic", () => {
    const { events, scene, deps } = makeHarness();
    const sceneObj = deps.ensureScene();
    scene.apply_command.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    const sendCommand = vi.fn();

    expect(() =>
      applyDocumentCommand(sceneObj, { type: "remove_dataset", id: "wds-1" }, sendCommand),
    ).toThrow(WebAssembly.RuntimeError);

    const errors = errorEmissions(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Viewer engine failure");
    // The failed apply was never broadcast.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("three consecutive local viewport failures surface the engine banner", () => {
    const { events, scene, deps } = makeHarness();
    const sceneObj = deps.ensureScene();
    scene.apply_command.mockImplementation(() => {
      throw new Error("state mismatch");
    });

    for (let t = 0; t < 3; t++) {
      expect(() => applyViewportCommand(sceneObj, { type: "set_t", t })).toThrow(
        "state mismatch",
      );
    }

    const errors = errorEmissions(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Viewer engine failure");
  });

  it("a fatal load_document failure surfaces even though the snapshot catch swallows it", () => {
    const { handlers, events, scene } = makeHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      scene.load_document.mockImplementation(() => {
        throw new WebAssembly.RuntimeError("unreachable");
      });
      handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    } finally {
      warn.mockRestore();
    }

    const errors = errorEmissions(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Viewer engine failure");
  });

  it("a destroyed controller stops observing scene mutations", () => {
    const { controller, events, scene, deps } = makeHarness();
    const sceneObj = deps.ensureScene();
    controller.destroy();
    scene.apply_command.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });

    expect(() => applyViewportCommand(sceneObj, { type: "set_t", t: 0 })).toThrow();
    expect(errorEmissions(events)).toHaveLength(0);
  });
});

describe("SessionController error recovery and precedence", () => {
  const visibilityCmd = JSON.stringify({
    type: "set_dataset_visible",
    dataset_id: "wds-1",
    visible: false,
  });

  it("a successful apply clears a standing non-fatal engine banner", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new Error("state mismatch");
    });
    handlers.onCommand(2, visibilityCmd);
    handlers.onCommand(3, visibilityCmd);
    handlers.onCommand(4, visibilityCmd);
    expect(errorEmissions(events)).toHaveLength(1);

    // The scene recovers (e.g. the offending state was superseded): the
    // next successful apply retires the banner.
    scene.apply_command.mockImplementation(() => {});
    handlers.onCommand(5, visibilityCmd);
    expect(lastActivity(events).error).toBeNull();
  });

  it("a fatal banner persists through subsequent successful applies", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    handlers.onCommand(2, visibilityCmd);
    expect(errorEmissions(events)).toHaveLength(1);

    // Even if an isolated call slips through, a trapped instance is not
    // un-poisoned — the reload banner must stand.
    handlers.onCommand(3, visibilityCmd);
    expect(lastActivity(events).error).toContain("Viewer engine failure");
  });

  it("parse-boundary rejection bursts surface the softer notice, never the engine banner", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new Error("data did not match any variant of untagged enum Command");
    });
    handlers.onCommand(2, visibilityCmd);
    handlers.onCommand(3, visibilityCmd);
    handlers.onCommand(4, visibilityCmd);

    const errors = errorEmissions(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("Viewer engine failure");
    expect(errors[0]).not.toContain("Reload");
    expect(errors[0]).toContain("did not match any variant");

    // The scene provably applies other commands fine — the advisory clears.
    scene.apply_command.mockImplementation(() => {});
    handlers.onCommand(5, visibilityCmd);
    expect(lastActivity(events).error).toBeNull();
  });

  it("chunk-delivery recovery clears the data banner", () => {
    const { events } = makeHarness();
    const config = MockedCpuCache.instances[0].config;
    expect(config?.onChunkFailureRecovered).toBeTypeOf("function");

    config!.onChunkFailureStreak!(12, "403 rejected");
    expect(errorEmissions(events)).toHaveLength(1);

    config!.onChunkFailureRecovered!();
    expect(lastActivity(events).error).toBeNull();
  });

  it("chunk-delivery recovery never clears a banner it does not own", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    handlers.onCommand(2, visibilityCmd);

    MockedCpuCache.instances[0].config!.onChunkFailureRecovered!();
    expect(lastActivity(events).error).toContain("Viewer engine failure");
  });

  it("dataset-open progress does not wipe a fatal banner", () => {
    const { handlers, events, scene } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 4, {});
    scene.apply_command.mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    handlers.onCommand(2, visibilityCmd);

    handlers.onDatasetOpenProgress?.("req-1", "http://example/data.zarr", {
      stage: "metadata_import",
      message: "reading metadata",
    });
    expect(lastActivity(events).error).toContain("Viewer engine failure");
  });

  it("dataset-open progress still supersedes a previous open failure", () => {
    const { handlers, events } = makeHarness();
    handlers.onOpenDatasetFailed?.("http://example/a.zarr", "permission denied");
    expect(lastActivity(events).error).toBe("permission denied");

    handlers.onDatasetOpenProgress?.("req-1", "http://example/b.zarr", {
      stage: "metadata_import",
      message: "reading metadata",
    });
    expect(lastActivity(events).error).toBeNull();
  });

  it("the recurring data banner cannot overwrite a fresh open failure", () => {
    const { handlers, events } = makeHarness();
    handlers.onOpenDatasetFailed?.("http://example/a.zarr", "permission denied");

    MockedCpuCache.instances[0].config!.onChunkFailureStreak!(12, "403 rejected");
    expect(lastActivity(events).error).toBe("permission denied");
    expect(errorEmissions(events).some((e) => e.includes("Data loading"))).toBe(false);
  });

  it("a fresh open failure supersedes a standing data banner", () => {
    const { handlers, events } = makeHarness();
    MockedCpuCache.instances[0].config!.onChunkFailureStreak!(12, "403 rejected");

    handlers.onOpenDatasetFailed?.("http://example/a.zarr", "permission denied");
    expect(lastActivity(events).error).toBe("permission denied");
  });

  it("reconnect resets the cache chunk-failure streak", () => {
    const { handlers } = makeHarness();
    handlers.onConnected?.();
    expect(MockedCpuCache.instances[0].resetChunkFailureStreak).toHaveBeenCalledTimes(1);
  });
});

describe("SessionController teardown", () => {
  it("destroy releases the stack, clears the dataset registry, and is idempotent", () => {
    const { controller, handlers, deps } = makeHarness();
    handlers.onSnapshot(1, snapshotJson(["wds-1"]), [], 0, {});
    expect(deps.datasets.size).toBe(1);

    controller.destroy();
    controller.destroy();

    expect(MockedBridge.instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(MockedCpuCache.instances[0].reset).toHaveBeenCalledTimes(1);
    expect(MockedContentSource.instances[0].rejectAll).toHaveBeenCalledTimes(1);
    expect(MockedDecodePool.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(deps.datasets.size).toBe(0);
  });
});
