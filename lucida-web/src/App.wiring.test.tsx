// @vitest-environment happy-dom
//
// Wiring tests for App.tsx's invalidation intents: mount the REAL App (real
// hooks, real SessionController + Session, real LayerPanel/LayoutSwitcher)
// over instance-recording doubles for the boundary classes (Bridge / fetch
// pipeline / GPU RenderClient / WASM scene / workspace HTTP API), then drive
// user-visible interactions and assert the planner-visible signal fires.
//
// What is pinned, and why HERE rather than in a unit test:
//   App.tsx is where a user action fans out to the invalidation mechanisms
//   (settings-generation bump for the planner's cached snapshot, dirty marks
//   for the render loop). A missed tap silently no-ops — the named bug
//   classes (#780 layout-switch, the #802/#814 restore family) were all
//   "everything compiled, nothing signaled". These tests mount the whole
//   wiring so a regression in ANY hop (component prop → App handler →
//   composed intent) fails, not just a change to the intent helpers
//   themselves (those have their own unit suite in invalidation.test.ts).
//
// The composed intents (src/invalidation.ts) are module-spied (`spy: true`),
// so assertions read "the handler invoked the right intent" while the real
// implementation still runs — letting the same tests ALSO observe the
// planner-visible effect through `getSceneSettings` cache identity.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Boundary doubles. The WASM scene is a small stateful fake: it stores the
// loaded document and records every applied command, and serves the JSON
// reads the app performs (dataset order/settings/names, layouts, annotations,
// presence, camera). Everything else in the session stack is real.
// ---------------------------------------------------------------------------

vi.mock("lucida-core", () => {
  class FakeWasmScene {
    static instances: FakeWasmScene[] = [];
    doc: {
      manifests?: Record<string, { name?: string }>;
      annotations?: Record<string, unknown[]>;
    } = {};
    commands: Array<Record<string, unknown>> = [];
    constructor(_w?: number, _h?: number) {
      FakeWasmScene.instances.push(this);
    }
    load_document(json: string) {
      this.doc = JSON.parse(json);
    }
    apply_command(json: string) {
      this.commands.push(JSON.parse(json));
    }
    dataset_order() {
      return JSON.stringify(Object.keys(this.doc.manifests ?? {}));
    }
    dataset_ids() {
      return this.dataset_order();
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
    z() { return 0; }
    t() { return 0; }
    c() { return 0; }
    multi_channel() { return false; }
    camera_mode() { return "slice"; }
    zoom() { return 1; }
    center() { return new Float64Array([0, 0]); }
    dataset_volume_shape(_id: string) { return new Uint32Array([4, 8, 8]); }
    export_presence() {
      return JSON.stringify({
        camera: { mode: "slice", center: [0, 0], zoom: 1 },
        view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
        display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
      });
    }
    // Shape-complete: `buildCapture` walks `dataset_settings`, so an empty
    // object here makes every capture throw and silently no-op — which would
    // make a "nothing was persisted" assertion pass for the wrong reason.
    export_dataset_presence() {
      return JSON.stringify({
        dataset_order: Object.keys(this.doc.manifests ?? {}),
        dataset_settings: {},
      });
    }
    import_presence(_json: string) {}
    import_dataset_presence(_json: string) {}
    compute_peer_cursors() { return JSON.stringify({ gpu: [], labels: [] }); }
    fit_camera_to_dataset_bounds(_id: string) {}
    apply_asset_catalog_delta(_datasetId: string, _deltaJson: string) {}
    asset_epoch() { return 0; }
    epochs() {
      return JSON.stringify({ content: 0, layout: 0, view: 0, selection: 0, asset: 0 });
    }
    free() {}
  }
  return {
    default: vi.fn(() => Promise.resolve()),
    WasmScene: FakeWasmScene,
    set_debug_categories: vi.fn(),
    explore_view: vi.fn(() => JSON.stringify({ error: "unavailable" })),
    camera_matrices: vi.fn(() => new Float32Array(32)),
    is_local_dataset_url: vi.fn(() => true),
    normalize_dataset_url: vi.fn((url: string) => url),
    dataset_id_for_url: vi.fn((url: string) => `wds:${url}`),
  };
});

vi.mock("./renderer/renderClient.ts", () => {
  class MockRenderClient {
    onIntensityRange: unknown = null;
    // Never settles: the GPU worker never comes up in this environment, so
    // the canvas-bound viewers stay unmounted and no RenderLoop exists —
    // the intents run with a null loop (their contract covers that).
    ready() { return new Promise(() => {}); }
    destroy() {}
    updateCursorData(_data: Float32Array, _count: number) {}
    removeLayerResources(_id: string) {}
  }
  return { RenderClient: MockRenderClient };
});

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
    subscribe = vi.fn(() => () => {});
    cancelDataset = vi.fn();
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

// Spy the composed intents in place: calls are recorded AND the real
// implementation runs, so both the intent invocation and its
// planner-visible effect are assertable.
vi.mock("./invalidation.ts", { spy: true });

import App from "./App.tsx";
import { AuthSessionContext } from "./auth/AuthSession.ts";
import { Bridge, type BridgeHandlers } from "./bridge.ts";
import { WasmScene } from "lucida-core";
import { getSceneSettings } from "./tickCommon.ts";
import { updateWorkspaceLastView } from "./workspaceApi.ts";
import {
  invalidateDisplaySettings,
  invalidateAfterViewRestore,
} from "./invalidation.ts";

const MockedBridge = Bridge as unknown as {
  instances: Array<{ handlers: BridgeHandlers; sendCommand: ReturnType<typeof vi.fn> }>;
};
const FakeScene = WasmScene as unknown as {
  instances: Array<{
    commands: Array<Record<string, unknown>>;
    doc: unknown;
  }>;
};

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
              shape: [1, 1, 4, 8, 8],
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
): string {
  const manifests: Record<string, unknown> = {};
  for (const id of datasetIds) manifests[id] = makeManifest(id);
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

/** Mount the app, let the (mocked) WASM init settle so the session controller
 *  connects, then deliver the join snapshot through the recorded bridge
 *  handlers — the same entry the real WebSocket uses. */
async function mountWithSnapshot(docJson: string) {
  renderApp();
  // Flush wasm init → wasmReady → controller construction.
  await act(async () => {});
  const bridge = MockedBridge.instances[MockedBridge.instances.length - 1];
  await act(async () => {
    bridge.handlers.onSnapshot(1, docJson, [], 1, {});
  });
  const scene = FakeScene.instances[FakeScene.instances.length - 1];
  return { bridge, scene };
}

beforeEach(() => {
  vi.clearAllMocks();
  MockedBridge.instances.length = 0;
  FakeScene.instances.length = 0;
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("App wiring: layout switch (the #780 class)", () => {
  it("switching layouts fires the display-settings intent so the planner re-reads", async () => {
    const { scene } = await mountWithSnapshot(documentJson(["wds-1"]));

    // The dataset auto-selected and auto-expanded; the layout switcher shows
    // the first available layout.
    const switcher = await screen.findByDisplayValue("Grid");

    // Prime the planner's settings cache so a served-from-cache read is
    // distinguishable from a re-read.
    const primed = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);

    fireEvent.change(switcher, { target: { value: "row" } });

    // The switch applied the command to the scene...
    expect(scene.commands).toContainEqual({
      type: "set_active_layout",
      dataset_id: "wds-1",
      layout_id: "row",
    });
    // ...and App signaled the replan through the composed intent — the
    // planner-visible half is the settings cache invalidation.
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
    const { scene } = await mountWithSnapshot(
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
  });
});

describe("App wiring: the capture surface writes no user state (#923)", () => {
  // The whole point of these two is that they mount the REAL App: the gate is
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

describe("App wiring: dataset-settings mutation canary", () => {
  it("toggling a layer's visibility lands the planner-visible signal in the same task", async () => {
    const { scene } = await mountWithSnapshot(documentJson(["wds-1"]));

    await screen.findByLabelText("Hide layer wds-1.zarr");
    const primed = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);

    fireEvent.click(screen.getByLabelText("Hide layer wds-1.zarr"));

    // Assert synchronously after the event dispatch — no flushing — so a
    // deferred (and hence missable) signal would fail here.
    expect(scene.commands).toContainEqual({
      type: "set_dataset_visible",
      dataset_id: "wds-1",
      visible: false,
    });
    expect(vi.mocked(invalidateDisplaySettings)).toHaveBeenCalled();
    const reread = getSceneSettings(scene as unknown as InstanceType<typeof WasmScene>);
    expect(reread).not.toBe(primed);
  });
});
