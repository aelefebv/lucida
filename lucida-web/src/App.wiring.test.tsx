// @vitest-environment happy-dom
//
// Wiring tests for App.tsx's invalidation intents: mount the real App over
// recording doubles for the boundary classes (Bridge, fetch pipeline, GPU
// RenderClient, WASM scene, workspace HTTP API), drive user interactions, and
// assert the planner-visible signal fires.
//
// App.tsx is where a user action fans out to invalidation. A missed tap
// compiles and silently no-ops (a layout switch or a saved-view restore that
// never replans), so these tests break on any broken hop from component prop
// to App handler to intent. The intents are module-spied (`spy: true`) and
// still run, so the planner-visible effect is observable too.

import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Boundary doubles. The WASM scene is a small stateful fake: it stores the
// loaded document and records every applied command, and serves the JSON
// reads the app performs (dataset order/settings/names, layouts, annotations,
// presence, camera). Everything else in the session stack is real.

vi.mock("lucida-core", () => {
  class FakeWasmScene {
    static instances: FakeWasmScene[] = [];
    doc: {
      manifests?: Record<string, { name?: string }>;
      annotations?: Record<string, unknown[]>;
    } = {};
    commands: Array<Record<string, unknown>> = [];
    // The selectors, with the epochs a selector or camera change bumps, so the
    // page's scene store reads what a command or a followed peer wrote.
    view = { z: 0, t: 0 };
    mode = "slice";
    epochCounts = { view: 0, selection: 0 };
    // The camera and the layer order and opacities, as presence carries them
    // between clients.
    camera: unknown = { mode: "slice", center: [0, 0], zoom: 1 };
    order: string[] | null = null;
    opacity: Record<string, number> = {};
    constructor(_w?: number, _h?: number) {
      FakeWasmScene.instances.push(this);
    }
    load_document(json: string) {
      this.doc = JSON.parse(json);
    }
    apply_command(json: string) {
      const cmd = JSON.parse(json);
      this.commands.push(cmd);
      if (cmd.type === "set_z") this.view.z = cmd.z;
      if (cmd.type === "set_z_range") this.view.z = cmd.start;
      if (cmd.type === "set_t") this.view.t = cmd.t;
      if (cmd.type === "set_dataset_order") this.order = cmd.order;
      if (cmd.type === "set_dataset_opacity") this.opacity[cmd.dataset_id] = cmd.opacity;
      if (typeof cmd.type === "string" && cmd.type.startsWith("set_mode_")) {
        this.mode = { set_mode_slice: "slice", set_mode_arcball: "arcball", set_mode_fly: "fly" }[cmd.type as string] ?? this.mode;
        this.epochCounts.view++;
      }
      this.epochCounts.selection++;
    }
    dataset_order() {
      return JSON.stringify(this.order ?? Object.keys(this.doc.manifests ?? {}));
    }
    dataset_ids() {
      return JSON.stringify(Object.keys(this.doc.manifests ?? {}));
    }
    pinnable_levels() {
      return Uint32Array.from([0]);
    }
    dataset_has_physical_scale() {
      return false;
    }
    dataset_user_transform() {
      return "null";
    }
    user_transforms() {
      return "{}";
    }
    dataset_units() {
      return "[null,null,null]";
    }
    datasets_line_up_by_hand() {
      return "[]";
    }
    datasets_line_up() {
      return JSON.stringify({ verdict: "no_physical_scale", datasets: [] });
    }
    comparison() {
      return "null";
    }
    comparison_span() {
      return new Float64Array();
    }
    dataset_placement() {
      return new Float64Array([0, 0, 0, 1, 1, 1]);
    }
    all_dataset_settings() {
      const out: Record<string, unknown> = {};
      for (const id of Object.keys(this.doc.manifests ?? {})) {
        out[id] = {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 65535,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [
            { visible: true, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1 },
          ],
          channel_blend_mode: "additive",
        };
      }
      return JSON.stringify(out);
    }
    dataset_name(id: string) {
      return this.doc.manifests?.[id]?.name ?? id;
    }
    available_layouts(_id: string) {
      return JSON.stringify([
        { id: "grid", name: "Grid" },
        { id: "row", name: "Row" },
      ]);
    }
    annotation_dataset_ids() {
      return JSON.stringify(Object.keys(this.doc.annotations ?? {}));
    }
    annotations(id: string) {
      return JSON.stringify(this.doc.annotations?.[id] ?? []);
    }
    z() { return this.view.z; }
    t() { return this.view.t; }
    resolved_layers() {
      return JSON.stringify(Object.keys(this.doc.manifests ?? {}).map((id) => ({
        dataset_id: id,
        visible: true,
        opacity: 1,
        render_mode: "translucent",
        channel_count: 1,
        solo: null,
        channels: [{ channel: 0, colormap: "gray", contrast_min: 0, contrast_max: 65535, gamma: 1, blend_mode: "alpha" }],
        z_range: { start: this.view.z, end: this.view.z + 1 },
        t: this.view.t,
        z_clamped: false,
        t_clamped: false,
        z_reach: "through",
        y_reach: "through",
        x_reach: "through",
      })));
    }
    camera_mode() { return this.mode; }
    active_view() { return 0; }
    view_ids() { return [0]; }
    view_datasets() { return '"all"'; }
    drawn_datasets() { return JSON.stringify(Object.keys(this.doc.manifests ?? {})); }
    view_layout() { return "single"; }
    maximized_view() { return undefined; }
    view_rect() { return [0, 0, 1, 1]; }
    view_camera_mode() { return this.mode; }
    view_mode() { return this.mode === "slice" ? "slice" : "volume"; }
    withheld() { return "[]"; }
    scale_bar() { return "null"; }
    slice_plane() { return "xy"; }
    cut_index() { return this.view.z; }
    zoom() { return 1; }
    view_proj() { return new Float32Array(16); }
    center() { return new Float64Array([0, 0]); }
    dataset_volume_shape(_id: string) { return new Uint32Array([4, 8, 8]); }
    dataset_fit_bounds(_id: string) { return new Float64Array([0, 0, 0, 8, 8, 0]); }
    export_presence() {
      return JSON.stringify({
        camera: this.camera,
        view: { z_range: { start: this.view.z, end: this.view.z + 1 }, t: this.view.t },
        display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
      });
    }
    // Shape-complete: `buildCapture` walks `dataset_settings`, so an empty
    // object makes every capture throw and no-op, and a "nothing was
    // persisted" assertion would pass for the wrong reason.
    export_dataset_presence() {
      const settings: Record<string, { opacity: number }> = {};
      for (const [id, opacity] of Object.entries(this.opacity)) settings[id] = { opacity };
      return JSON.stringify({
        dataset_order: JSON.parse(this.dataset_order()),
        dataset_settings: settings,
      });
    }
    camera_space() {
      return "null";
    }
    import_presence(json: string) {
      const presence = JSON.parse(json) as {
        camera?: unknown;
        view?: { z_range: { start: number }; t: number };
      };
      if (presence.camera) this.camera = presence.camera;
      if (presence.view) {
        this.view.z = presence.view.z_range.start;
        this.view.t = presence.view.t;
      }
      this.epochCounts.view++;
      this.epochCounts.selection++;
    }
    import_dataset_presence(json: string) {
      const presence = JSON.parse(json) as {
        dataset_order: string[];
        dataset_settings: Record<string, { opacity?: number }>;
      };
      if (presence.dataset_order.length > 0) this.order = presence.dataset_order;
      for (const [id, s] of Object.entries(presence.dataset_settings)) {
        if (s.opacity !== undefined) this.opacity[id] = s.opacity;
      }
      this.epochCounts.selection++;
    }
    compute_peer_cursors() { return JSON.stringify({ gpu: [], labels: [] }); }
    frame(_width: number, _height: number) { return false; }
    explore() { return JSON.stringify({ error: "unavailable" }); }
    epochs() {
      return JSON.stringify({ content: 0, layout: 0, ...this.epochCounts });
    }
    free() {}
  }
  return {
    default: vi.fn(() => Promise.resolve()),
    WasmScene: FakeWasmScene,
    set_debug_categories: vi.fn(),
    camera_matrices: vi.fn(() => new Float32Array(32)),
    is_local_dataset_url: vi.fn(() => true),
    normalize_dataset_url: vi.fn((url: string) => url),
    dataset_location_error: vi.fn(() => undefined),
    dataset_id_for_url: vi.fn((url: string) => `wds:${url}`),
    peer_palette: vi.fn(() => ["#ff6b6b", "#4ecdc4", "#ffe66d"]),
  };
});

// Tests that need a mounted viewer bring the GPU worker up; the rest leave it
// down, so no RenderLoop exists and the intents run with a null loop, which
// their contract covers.
const gpu = vi.hoisted(() => ({ ready: false }));
// App calls this hook once per render, so its calls count App's renders.
const appRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("./renderer/renderClient.ts", () => {
  class MockRenderClient {
    onEntityLevels: unknown = null;
    pipelinesCompiled = false;
    ready() { return gpu.ready ? Promise.resolve() : new Promise(() => {}); }
    oncePipelinesCompiled() { return () => {}; }
    minimapInit() {}
    destroy() {}
    updateCursorData(_data: Float32Array, _count: number) {}
    removeLayerResources(_id: string) {}
    gpuMemory() { return null; }
    onGpuStatus() { return () => {}; }
  }
  return { RenderClient: MockRenderClient };
});

// The loop draws nothing here; a viewer only needs one to hold.
vi.mock("./renderLoop.ts", async (importOriginal) => {
  class StubRenderLoop {
    start() {}
    stop() {}
    markInput() {}
    markInteractiveDirty() {}
    markResidencyDirty() {}
    setRenderScale() {}
    addDataset() {}
    removeDataset() {}
    updateDatasetManifest() {}
    setMinimap() {}
    setThumbnailOverview() {}
    setAutoContrastListener() {}
    getTickCoordinator() { return {}; }
    captureFrame() { return Promise.resolve({ frame: null, reason: "stub" }); }
  }
  return { ...(await importOriginal<typeof import("./renderLoop.ts")>()), RenderLoop: StubRenderLoop };
});

vi.mock("./shell/useDeveloperSurfaces.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./shell/useDeveloperSurfaces.ts")>();
  return {
    ...real,
    useDeveloperSurfaces: (...args: Parameters<typeof real.useDeveloperSurfaces>) => {
      appRenders.count++;
      return real.useDeveloperSurfaces(...args);
    },
  };
});

vi.mock("./bridge.ts", () => {
  class MockBridge {
    static instances: MockBridge[] = [];
    handlers: unknown;
    url: string;
    destroy = vi.fn();
    send = vi.fn();
    sendCommand = vi.fn();
    sendPresence = vi.fn();
    sendDatasetPresence = vi.fn();
    sendCursor = vi.fn();
    sendFollow = vi.fn();
    sendOpenRemoteDataset = vi.fn();
    constructor(handlers: unknown, url: string) {
      this.handlers = handlers;
      this.url = url;
      MockBridge.instances.push(this);
    }
  }
  return {
    Bridge: MockBridge,
    bridgeLog: vi.fn(),
    workspaceSocketUrl: (id: string) => `ws://test/ws/workspaces/${id}`,
  };
});

vi.mock("./pipeline/fetch/index.ts", () => {
  class MockDecodePool {
    size = 2;
    terminate = vi.fn();
  }
  class MockProxiedContentSource {
    rejectAll = vi.fn();
    rejectDataset = vi.fn();
    registerImage = vi.fn();
    unregisterDataset = vi.fn();
    handleBinary = vi.fn();
    handleChunkStatus = vi.fn();
    constructor(_send: unknown) {}
  }
  class MockCpuCache {
    reset = vi.fn();
    applyKnobs = vi.fn();
    subscribe = vi.fn(() => () => {});
    cancelDataset = vi.fn();
    // The HUD's two cache reads, so a shown HUD can tick over this double.
    poolResidency = vi.fn(() => ({
      main: { bytes: 0, budgetBytes: 1 },
      overview: { bytes: 0, budgetBytes: 1 },
    }));
    laneOutstanding = vi.fn((out: unknown) => out);
    constructor(_source: unknown, _pool: unknown) {}
  }
  return {
    DecodePool: MockDecodePool,
    ProxiedContentSource: MockProxiedContentSource,
    CpuCache: MockCpuCache,
  };
});

vi.mock("./workspaceApi.ts", () => ({
  listWorkspaceSavedViews: vi.fn(async () => []),
  getWorkspaceSavedView: vi.fn(async () => {
    throw new Error("no saved view in this test");
  }),
  createWorkspaceSavedView: vi.fn(async () => ({ id: "sv-1" })),
  updateWorkspaceSavedView: vi.fn(async () => ({})),
  deleteWorkspaceSavedView: vi.fn(async () => {}),
  setWorkspaceSavedViewVisibility: vi.fn(async () => ({})),
  approveWorkspaceSavedView: vi.fn(async () => ({})),
  rejectWorkspaceSavedView: vi.fn(async () => ({})),
  getWorkspaceViewerProfile: vi.fn(async () => null),
  getWorkspaceSharing: vi.fn(async () => ({ link_access: "restricted", members: [] })),
  getWorkspaceUserState: vi.fn(async () => ({ last_view: null })),
  updateWorkspaceLastView: vi.fn(async () => {}),
  updateWorkspaceDefaultSavedView: vi.fn(async () => ({})),
  updateWorkspacePin: vi.fn(async () => ({})),
}));

vi.mock("./auth/whoami.ts", () => ({
  fetchAuthState: vi.fn(async () => ({ authenticated: false })),
  postLogout: vi.fn(async () => {}),
  fetchDevAuthStatus: vi.fn(async () => ({
    enabled: false,
    default_principal: {
      email: "dev@local",
      display_name: "Local Dev",
      picture_url: null,
      is_admin: false,
    },
  })),
  postDevLogin: vi.fn(async () => {}),
}));

// Spy the intents in place: calls are recorded and the real implementation
// runs, so both the call and its planner-visible effect are assertable.
vi.mock("./invalidation.ts", { spy: true });

import App from "./App.tsx";
// The code-split surfaces, loaded with the file. A first import transforms
// them cold, which on a loaded host outlasts any wait for them to mount, and
// the wiring is what these tests are about.
import "./hud/Hud.tsx";
import "./monitor/MonitorDock.tsx";
import { AuthSessionContext } from "./auth/AuthSession.ts";
import { Bridge, type BridgeHandlers, type PresenceState } from "./bridge.ts";
import { WasmScene } from "lucida-core";
import { SessionController } from "./sessionController.ts";
import { getSceneSettings } from "./tickCommon.ts";
import {
  getWorkspaceUserState,
  listWorkspaceSavedViews,
  updateWorkspaceLastView,
} from "./workspaceApi.ts";
import {
  __resetPreferencesForTesting,
  developerToolsPreference,
  getPreference,
  setPreference,
} from "./theme/preferences.ts";
import { leftPanelOpenPreference, rightPanelOpenPreference } from "./shell/layoutPreferences.ts";
import { showKeyboardHelp } from "./ui/keyboardHelpState.ts";
import { frameClock } from "./frameClock.ts";
import {
  invalidateDisplaySettings,
  invalidateAfterViewRestore,
  invalidateSelection,
} from "./invalidation.ts";

const MockedBridge = Bridge as unknown as {
  instances: Array<{
    handlers: BridgeHandlers;
    sendCommand: ReturnType<typeof vi.fn>;
    sendFollow: ReturnType<typeof vi.fn>;
    sendPresence: ReturnType<typeof vi.fn>;
    sendDatasetPresence: ReturnType<typeof vi.fn>;
  }>;
};
type FakeSceneInstance = {
  commands: Array<Record<string, unknown>>;
  doc: unknown;
  view: { z: number; t: number };
  camera: unknown;
  order: string[] | null;
  opacity: Record<string, number>;
  compute_peer_cursors: () => string;
};
const FakeScene = WasmScene as unknown as {
  new (): FakeSceneInstance;
  instances: FakeSceneInstance[];
};

function makeManifest(datasetId: string, channels = 1) {
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
              shape: [1, channels, 4, 8, 8],
              chunk_shape: [1, 1, 4, 8, 8],
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

/** A pin carrying the author's captured view, for the restore-flow test. */
function makePinWithView(pinId: string) {
  return {
    id: pinId,
    position: [2, 2] as [number, number],
    z: 1,
    t: 0,
    c: 0,
    author: "author-1",
    kind: "point",
    comments: [],
    view: {
      v: 1,
      datasets: [],
      active_layouts: {},
      camera: { mode: "slice", center: [4, 4], zoom: 2 },
      view: { z_range: { start: 1, end: 2 }, t: 0, c: 0 },
      display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
      dataset_order: [],
      dataset_settings: {},
    },
  };
}

function documentJson(
  datasetIds: string[],
  annotations?: Record<string, unknown[]>,
  channels = 1,
): string {
  const manifests: Record<string, unknown> = {};
  for (const id of datasetIds) manifests[id] = makeManifest(id, channels);
  return JSON.stringify({ manifests, annotations: annotations ?? {} });
}

const authSession = {
  principal: {
    email: "me@example.com",
    display_name: "Me",
    picture_url: null,
    is_admin: false,
  },
  refresh: async () => {},
  signOut: async () => {},
};

function renderApp() {
  return render(
    <AuthSessionContext.Provider value={authSession}>
      <App
        workspaceId="ws-1"
        workspaceName="Wiring"
        workspaceRole="editor"
        defaultSavedViewId={null}
        canRenameWorkspace={false}
        onBackToDashboard={() => {}}
        onRenameWorkspace={async () => {}}
        onSetDefaultSavedView={async () => {}}
      />
    </AuthSessionContext.Provider>,
  );
}

/** Mount the app, let the mocked WASM init settle so the session controller
 *  connects, then deliver the join snapshot through the recorded bridge
 *  handlers, the same entry the real WebSocket uses. */
async function mountWithSnapshot(docJson: string, peers: unknown[] = []) {
  renderApp();
  // Flush wasm init, then wasmReady, then controller construction.
  await act(async () => {});
  const bridge = MockedBridge.instances[MockedBridge.instances.length - 1];
  await act(async () => {
    bridge.handlers.onSnapshot(1, docJson, peers as never, 1, {});
  });
  const scene = FakeScene.instances[FakeScene.instances.length - 1];
  return { bridge, scene };
}

beforeEach(() => {
  gpu.ready = false;
  localStorage.clear();
  __resetPreferencesForTesting();
  vi.clearAllMocks();
  MockedBridge.instances.length = 0;
  FakeScene.instances.length = 0;
  // The page draws through the mocked render client, as in a WebGPU browser.
  Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
});

afterEach(() => {
  cleanup();
  showKeyboardHelp(null);
  window.location.hash = "";
  delete (navigator as { gpu?: unknown }).gpu;
});

describe("App wiring: channels", () => {
  // The composite is the scene's own default, so opening sends no mode.
  it("opens a multichannel dataset without writing a channel mode", async () => {
    const { scene } = await mountWithSnapshot(documentJson(["wds-1"], undefined, 3));
    expect(scene.commands.some((cmd) => cmd.type === "set_channel_solo")).toBe(false);
  });

  it("opens Add data from the layer panel's header", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    // The dialog's file browser lists a folder as it opens.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ path: "/", entries: [] })));
    const panel = screen.getByRole("complementary", { name: "Layers" });
    await userEvent.click(within(panel).getByRole("button", { name: "Add data" }));
    expect(await screen.findByRole("dialog", { name: "Add data" })).toBeTruthy();
    fetchSpy.mockRestore();
  });
});

describe("App wiring: layout switch", () => {
  it("switching layouts fires the display-settings intent so the planner re-reads", async () => {
    const { scene } = await mountWithSnapshot(documentJson(["wds-1"]));

    // The dataset auto-selected and auto-expanded; the layout switcher sits
    // under Advanced and shows the first available layout.
    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    const switcher = screen.getByRole("button", { name: /Layout/ });
    expect(switcher.textContent).toContain("Grid");

    // Prime the planner's settings cache so a served-from-cache read is
    // distinguishable from a re-read.
    const primed = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);

    await userEvent.click(switcher);
    await userEvent.click(screen.getByRole("option", { name: "Row" }));

    // The switch applied the command to the scene...
    expect(scene.commands).toContainEqual({
      type: "set_active_layout",
      dataset_id: "wds-1",
      layout_id: "row",
    });
    // ...and App signaled the replan through the intent; the planner-visible
    // half is the settings cache invalidation.
    expect(vi.mocked(invalidateDisplaySettings)).toHaveBeenCalledWith(
      null,
      "layout_switch",
    );
    const reread = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);
    expect(reread).not.toBe(primed);
  });
});

describe("App wiring: annotation-view restore fan-out", () => {
  it("a #a= deep-link restore fires the full view-restore intent once", async () => {
    window.location.hash = "#a=pin-1";
    const { bridge, scene } = await mountWithSnapshot(
      documentJson(["wds-1"], { "wds-1": [makePinWithView("pin-1")] }),
    );

    // The deep-link hook runs off the post-snapshot document version bump;
    // the mount helper already flushed it. The restore must have applied the
    // captured view to the scene...
    expect(scene.commands).toContainEqual({ type: "set_z_range", start: 1, end: 2 });
    // ...and fired the composed restore intent (settings re-read + immediate
    // frame + residency trail) exactly once.
    const restoreCalls = vi
      .mocked(invalidateAfterViewRestore)
      .mock.calls.filter(([, source]) => source === "annotation_view_restore");
    expect(restoreCalls).toHaveLength(1);
    // Peers hear the restored camera and the restored layer display.
    expect(JSON.parse(bridge.sendPresence.mock.lastCall![0] as string).view.z_range.start).toBe(1);
    expect(bridge.sendDatasetPresence).toHaveBeenCalled();
  });
});

describe("App wiring: the capture surface writes no user state", () => {
  // These two must mount the real App: the gate is
  // a prop threaded from a URL read at the top of App.tsx down into
  // useSavedViewSync, and a hook-level test cannot fail if that thread breaks.
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    vi.useRealTimers();
  });

  it("persists the last view on an ordinary session", async () => {
    vi.useFakeTimers();
    await mountWithSnapshot(documentJson(["wds-1"]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(vi.mocked(updateWorkspaceLastView)).toHaveBeenCalled();
  });

  it("persists nothing when loaded as ?render=1", async () => {
    window.history.replaceState(null, "", "/?render=1");
    vi.useFakeTimers();
    await mountWithSnapshot(documentJson(["wds-1"]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(vi.mocked(updateWorkspaceLastView)).not.toHaveBeenCalled();
  });
});

describe("App wiring: the top bar opens the monitor's dock", () => {
  // The dock is code-split and reads the page's trace seam, which this
  // harness never installs, so what it shows is its "no seam" reason. The
  // wiring under test is the top bar toggle and the dock's own close.
  it("toggles the dock from the monitor button, and the dock closes itself", async () => {
    setPreference(developerToolsPreference, true);
    await mountWithSnapshot(documentJson(["wds-1"]));
    const toggle = screen.getByRole("button", { name: "Pipeline monitor" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("monitor-dock")).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
    });

    const dock = await screen.findByTestId("monitor-dock");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(dock).getByTestId("monitor-empty").textContent).toContain("trace seam");

    await act(async () => {
      fireEvent.click(within(dock).getByTestId("monitor-close"));
    });
    expect(screen.queryByTestId("monitor-dock")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("App wiring: dataset-settings mutation canary", () => {
  it("toggling a layer's visibility lands the planner-visible signal in the same task", async () => {
    const { scene } = await mountWithSnapshot(documentJson(["wds-1"]));

    await screen.findByLabelText("Hide layer wds-1.zarr");
    const primed = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);

    fireEvent.click(screen.getByLabelText("Hide layer wds-1.zarr"));

    // Assert synchronously after the dispatch, with no flushing, so a deferred
    // signal would fail here.
    expect(scene.commands).toContainEqual({
      type: "set_dataset_visible",
      dataset_id: "wds-1",
      visible: false,
    });
    // Hiding a dataset is a select, not a display-settings change.
    expect(vi.mocked(invalidateSelection)).toHaveBeenCalled();
    const reread = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);
    expect(reread).not.toBe(primed);
  });
});

describe("App wiring: the pipeline HUD", () => {
  it("shows on the top bar control and hides on its key, with developer tools on", async () => {
    setPreference(developerToolsPreference, true);
    await mountWithSnapshot(documentJson(["wds-1"]));
    expect(screen.queryByTestId("hud")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Pipeline HUD" });

    fireEvent.click(toggle);
    // The HUD is code-split, so it mounts after the import resolves.
    expect(await screen.findByTestId("hud")).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "chunk grid" })).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "h" });
    });
    expect(screen.queryByTestId("hud")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("App wiring: developer tools off (the default)", () => {
  it("shows no developer surface, and H does nothing", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    expect(getPreference(developerToolsPreference)).toBe(false);
    for (const name of ["Pipeline monitor", "Pipeline HUD", "Dev controls"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByText(/FPS$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dev" })).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "h" });
    });
    expect(screen.queryByTestId("hud")).toBeNull();
  });

  it("brings every surface back when the setting turns on", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    await act(async () => {
      setPreference(developerToolsPreference, true);
    });
    for (const name of ["Pipeline monitor", "Pipeline HUD", "Dev controls"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByText(/FPS$/)).toBeTruthy();
  });
});

describe("App wiring: the shell", () => {
  it("names the page after the workspace", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    expect(document.title).toBe("Wiring · lucida");
  });

  it("explains a browser without WebGPU in place of the viewer", async () => {
    delete (navigator as { gpu?: unknown }).gpu;
    await mountWithSnapshot(documentJson(["wds-1"]));
    const message = screen.getByRole("alert");
    expect(message.textContent).toContain("This browser can’t show the viewer");
    expect(message.textContent).toContain("Chrome, Edge, or Safari");
    // Nothing over the canvas to drive, and no error banner for it.
    expect(screen.queryByRole("button", { name: "Point tool" })).toBeNull();
    expect(screen.queryByText(/WebGPU is not supported/)).toBeNull();
    // The rest of the workspace still works.
    expect(screen.getByRole("complementary", { name: "Layers" })).toBeTruthy();
  });

  it("collapses the left panel on Alt+[ and remembers it", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    const panel = screen.getByRole("complementary", { name: "Layers" });
    expect(panel.hidden).toBe(false);

    await act(async () => {
      fireEvent.keyDown(window, { key: "[", code: "BracketLeft", altKey: true });
    });
    expect(panel.hidden).toBe(true);
    expect(getPreference(leftPanelOpenPreference)).toBe(false);
    // Collapsed, the panel stays mounted, so its controls keep their state.
    expect(screen.getByLabelText("Hide layer wds-1.zarr", { selector: "button" })).toBeTruthy();
  });

  it("opens one rail panel at a time, closed by default", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    const savedViews = () => screen.queryByRole("region", { name: "Saved views" });
    expect(savedViews()).toBeNull();
    expect(screen.queryByTestId("explore-panel")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Saved views" }));
    expect(await screen.findByRole("region", { name: "Saved views" })).toBeTruthy();
    expect(getPreference(rightPanelOpenPreference)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(screen.getByRole("region", { name: "Comments" })).toBeTruthy();
    expect(savedViews()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByRole("region", { name: "Info" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(screen.getByTestId("explore-panel")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Info" })).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "]", code: "BracketRight", altKey: true });
    });
    expect(screen.queryByTestId("explore-panel")).toBeNull();
    expect(getPreference(rightPanelOpenPreference)).toBe(false);
  });

  it("follows a peer from their presence avatar", async () => {
    const peer = {
      client_id: 7,
      camera: { mode: "slice", center: [0, 0], zoom: 1 },
      view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
      display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
      following: null,
      cursor: null,
      dataset_order: [],
      dataset_settings: {},
      identity: { display_name: "Ada Lovelace" },
    };
    const { bridge } = await mountWithSnapshot(documentJson(["wds-1"]), [peer]);
    expect(screen.queryByText(/Peers \(/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Follow Ada Lovelace" }));
    });
    expect(bridge.sendFollow).toHaveBeenCalledWith(7);
    const avatar = screen.getByRole("button", { name: "Stop following Ada Lovelace" });
    expect(avatar.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(avatar);
    });
    expect(bridge.sendFollow).toHaveBeenLastCalledWith(null);
  });

  it("shows a followed peer's plane on the Z scrubber", async () => {
    const peer = {
      client_id: 7,
      camera: { mode: "slice", center: [0, 0], zoom: 1 },
      view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
      display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
      following: null,
      cursor: null,
      dataset_order: [],
      dataset_settings: {},
      identity: { display_name: "Ada Lovelace" },
    };
    const { bridge } = await mountWithSnapshot(documentJson(["wds-1"]), [peer]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Follow Ada Lovelace" }));
    });

    await act(async () => {
      bridge.handlers.onPresenceUpdate?.(7, peer.camera, { z_range: { start: 2, end: 3 }, t: 0 }, peer.display);
    });

    // The import wrote the scene alone; the scrubber reads it from there.
    const scrubber = document.querySelector('.lc-dim-scrubber[aria-label="Z plane"]');
    expect(scrubber?.querySelector(".lc-dim-readout")?.textContent).toBe("3 / 4");
  });
});

describe("App wiring: following after a restore", () => {
  const datasets = ["wds-1", "wds-2"];
  const restored = {
    v: 1,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [6, 2], zoom: 3, viewport: [800, 600] },
    view: { z_range: { start: 2, end: 3 }, t: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    dataset_order: ["wds-2", "wds-1"],
    dataset_settings: Object.fromEntries(datasets.map((id) => [id, {
      visible: true,
      opacity: id === "wds-2" ? 0.25 : 1,
      contrast_min: 0,
      contrast_max: 65535,
      gamma: 1,
      blend_mode: "alpha",
    }])),
  };

  /** A second client that joins once the leader has restored, as a session
   *  controller over its own scene: the server hands it the leader's last
   *  reported presence in its snapshot. */
  function joinAndFollow(leader: PresenceState) {
    const scene = new FakeScene();
    const follower = new SessionController({
      workspaceId: "ws-1",
      ensureScene: () => scene as never,
      getScene: () => scene as never,
      getLoop: () => null,
      getViewportSize: () => null,
      datasets: new Map(),
      removeDatasetLocal: () => {},
      getSavedViewHooks: () => null,
      bumpLayerSettingsVersion: () => {},
      initLayerMaps: () => {},
      setSelectedDatasetId: () => {},
      events: {
        onConnectedChanged: () => {},
        onSessionReadyChanged: () => {},
        onSelfIdChanged: () => {},
        onPeersChanged: () => {},
        onFollowTargetChanged: () => {},
        onRemoteDatasetActivity: () => {},
        onSceneChanged: () => {},
        onDatasetsChanged: () => {},
        onRemoteDocumentChanged: () => {},
        onWorkspaceArchived: () => {},
        onAccessRevoked: () => {},
        onCommandRejected: () => {},
        onDatasetImportWarnings: () => {},
      },
    });
    onTestFinished(() => follower.destroy());
    const bridge = MockedBridge.instances[MockedBridge.instances.length - 1];
    bridge.handlers.onSnapshot(1, documentJson(datasets), [leader], 2, {});
    follower.follow(leader.client_id);
    return scene;
  }

  it("a peer who follows after the last view was restored sees the restored view", async () => {
    vi.mocked(getWorkspaceUserState).mockResolvedValueOnce({ last_view: restored } as never);
    const { bridge, scene } = await mountWithSnapshot(documentJson(datasets));
    await waitFor(() => expect(scene.view.z).toBe(2));
    expect(bridge.sendPresence).toHaveBeenCalled();
    expect(bridge.sendDatasetPresence).toHaveBeenCalled();

    const leader: PresenceState = {
      client_id: 1,
      following: null,
      cursor: null,
      ...JSON.parse(bridge.sendPresence.mock.lastCall![0] as string),
      ...JSON.parse(bridge.sendDatasetPresence.mock.lastCall![0] as string),
    };
    const followerScene = joinAndFollow(leader);

    expect(followerScene.camera).toEqual(restored.camera);
    expect(followerScene.view.z).toBe(2);
    expect(followerScene.order).toEqual(["wds-2", "wds-1"]);
    expect(followerScene.opacity["wds-2"]).toBe(0.25);
  });
});

describe("App wiring: a navigation ends a follow", () => {
  const leader = {
    client_id: 7,
    camera: { mode: "slice", center: [0, 0], zoom: 1 },
    view: { z_range: { start: 3, end: 4 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    following: null,
    cursor: null,
    dataset_order: [],
    dataset_settings: {},
    identity: { display_name: "Ada Lovelace" },
  };
  const savedView = {
    v: 1,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [6, 2], zoom: 3, viewport: [800, 600] },
    view: { z_range: { start: 1, end: 2 }, t: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    dataset_order: ["wds-1"],
    dataset_settings: {
      "wds-1": {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 65535,
        gamma: 1,
        blend_mode: "alpha",
      },
    },
  };

  async function following() {
    const { bridge, scene } = await mountWithSnapshot(documentJson(["wds-1"]), [leader]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Follow Ada Lovelace" }));
    });
    expect(scene.view.z).toBe(3);
    return { bridge, scene };
  }

  /** The leader moves on: the view this client chose must stay. */
  async function leaderMoves(bridge: { handlers: BridgeHandlers }) {
    await act(async () => {
      bridge.handlers.onPresenceUpdate?.(7, leader.camera, { z_range: { start: 2, end: 3 }, t: 0 }, leader.display);
    });
  }

  it("opening a saved view stops following", async () => {
    vi.mocked(listWorkspaceSavedViews).mockResolvedValue([{
      id: "sv-1",
      workspace_id: "ws-1",
      name: "Second plane",
      created_by: "me@example.com",
      created_by_name: "Me",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      visibility: "shared",
      view: savedView,
    }] as never);
    const { bridge, scene } = await following();

    fireEvent.click(screen.getByRole("button", { name: "Saved views" }));
    await act(async () => {
      fireEvent.click(await screen.findByText("Second plane"));
    });

    await waitFor(() => expect(scene.view.z).toBe(1));
    expect(bridge.sendFollow).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "Follow Ada Lovelace" })).toBeTruthy();
    await leaderMoves(bridge);
    expect(scene.view.z).toBe(1);
  });

  it("going Home in Explore stops following", async () => {
    const { bridge, scene } = await following();
    const home = { ...savedView, view: { z_range: { start: 0, end: 1 }, t: 0 } };
    (scene as unknown as { explore: () => string }).explore = () => JSON.stringify({
      v: 1,
      current: { handle: "here", view: savedView },
      cells: [{ handle: "home", transform: "home", label: "Home", view: home }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("explore-home"));
    });

    await waitFor(() => expect(scene.view.z).toBe(0));
    expect(bridge.sendFollow).toHaveBeenLastCalledWith(null);
    await leaderMoves(bridge);
    expect(scene.view.z).toBe(0);
  });
});

describe("App wiring: peer messages", () => {
  const peer = {
    client_id: 7,
    camera: { mode: "slice", center: [0, 0], zoom: 1 },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    following: null,
    cursor: null,
    dataset_order: [],
    dataset_settings: {},
    identity: { display_name: "Ada Lovelace" },
  };

  it("leave the view's listeners and the frame clock alone, and never render App", async () => {
    gpu.ready = true;
    const paneBinds = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    const clockSubscribes = vi.spyOn(frameClock, "subscribe");
    const { bridge, scene } = await mountWithSnapshot(documentJson(["wds-1"]), [peer]);
    // The 2D viewer is up and has bound its listeners.
    expect(paneBinds.mock.calls.some(([type]) => type === "wheel")).toBe(true);
    paneBinds.mockClear();
    clockSubscribes.mockClear();
    const cursorPlacements = vi.spyOn(scene, "compute_peer_cursors");
    appRenders.count = 0;

    const messages = 10;
    for (let i = 0; i < messages; i++) {
      await act(async () => {
        bridge.handlers.onCursorUpdate?.(7, [i, i]);
      });
      await act(async () => {
        bridge.handlers.onPresenceUpdate?.(7, { ...peer.camera, center: [i, i] }, peer.view, peer.display);
      });
      await act(async () => {
        bridge.handlers.onDatasetPresenceUpdate?.(7, ["wds-1"], { "wds-1": { opacity: i / messages } });
      });
    }
    // The peer layer placed the cursors again for every one of them.
    expect(cursorPlacements.mock.calls.length).toBeGreaterThanOrEqual(3 * messages);

    // The avatars follow a peer arriving, following someone, and leaving.
    const grace = { ...peer, client_id: 8, identity: { display_name: "Grace Hopper" } };
    await act(async () => {
      bridge.handlers.onPeerJoined?.(8, grace);
    });
    expect(screen.getByRole("button", { name: "Follow Grace Hopper" })).toBeTruthy();
    await act(async () => {
      bridge.handlers.onFollowChanged?.(8, 7);
    });
    expect(screen.getByRole("button", { name: "Grace Hopper is following someone" })).toBeTruthy();
    await act(async () => {
      bridge.handlers.onPeerLeft?.(8);
    });
    expect(screen.queryByRole("button", { name: /Grace Hopper/ })).toBeNull();

    expect(paneBinds).not.toHaveBeenCalled();
    expect(clockSubscribes).not.toHaveBeenCalled();
    expect(appRenders.count).toBe(0);
    paneBinds.mockRestore();
    clockSubscribes.mockRestore();
  });

  it("leave the 3D viewer's listeners and frame clock alone too", async () => {
    gpu.ready = true;
    // The 2D/3D switch animates its selection, which happy-dom can't.
    const elementProto = Element.prototype as { getAnimations?: () => Animation[] };
    const stubbedAnimations = !elementProto.getAnimations;
    if (stubbedAnimations) elementProto.getAnimations = () => [];
    onTestFinished(() => {
      if (stubbedAnimations) delete elementProto.getAnimations;
    });
    const { bridge } = await mountWithSnapshot(documentJson(["wds-1"]), [peer]);
    const paneBinds = vi.spyOn(HTMLDivElement.prototype, "addEventListener");
    const clockSubscribes = vi.spyOn(frameClock, "subscribe");
    await act(async () => {
      fireEvent.keyDown(window, { key: "m", code: "KeyM" });
    });
    // The 3D viewer is up, bound to its view's pane and subscribed to the clock.
    expect(paneBinds.mock.calls.some(([type]) => type === "wheel")).toBe(true);
    expect(clockSubscribes).toHaveBeenCalled();
    paneBinds.mockClear();
    clockSubscribes.mockClear();

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        bridge.handlers.onCursorUpdate?.(7, [i, i]);
      });
    }

    expect(paneBinds).not.toHaveBeenCalled();
    expect(clockSubscribes).not.toHaveBeenCalled();
    paneBinds.mockRestore();
    clockSubscribes.mockRestore();
  });
});

describe("App wiring: tools and keyboard help", () => {
  it("takes keys right after load, with nothing focused", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    expect(document.activeElement).toBe(document.body);
    const point = screen.getByRole("button", { name: "Point tool" });
    expect(point.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.keyDown(window, { key: "p", code: "KeyP" });
    });
    expect(point.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    });
    expect(point.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Pan tool" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores keys typed into a field", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    // The dialog's file browser lists a folder as it opens.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ path: "/", entries: [] })));
    await act(async () => {
      fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true });
    });
    const dialog = await screen.findByRole("dialog", { name: "Add data" });
    const field = within(dialog).getByRole("textbox", { name: "Dataset path or URL" });
    await act(async () => {
      fireEvent.keyDown(field, { key: "p", code: "KeyP" });
    });
    expect(screen.getByRole("button", { name: "Point tool" }).getAttribute("aria-pressed")).toBe("false");
    fetchSpy.mockRestore();
  });

  it("runs a shell command from the palette", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    });
    const search = within(await screen.findByRole("dialog", { name: "Command palette" })).getByRole("searchbox");
    // A browser focuses the field on open; happy-dom leaves focus on the dialog.
    act(() => search.focus());
    await act(async () => {
      fireEvent(search, new InputEvent("beforeinput", { inputType: "insertText", data: "layers", bubbles: true }));
      fireEvent.change(search, { target: { value: "layers" } });
    });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(getPreference(leftPanelOpenPreference)).toBe(false);
  });

  it("lists the shell's keys in the shortcut sheet", async () => {
    await mountWithSnapshot(documentJson(["wds-1"]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const label of ["Command palette", "Show or hide the left panel", "Point tool", "Hide annotations"]) {
      expect(within(sheet).getByText(label)).toBeTruthy();
    }
  });
});
