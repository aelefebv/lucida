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
        camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600] },
        view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
        display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
      });
    }
    export_dataset_presence() { return "{}"; }
    import_presence(_json: string) {}
    import_dataset_presence(_json: string) {}
    compute_peer_cursors() { return JSON.stringify({ gpu: [], labels: [] }); }
    fit_camera_to_dataset_bounds(_id: string) {}
    epochs() {
      return JSON.stringify({ content: 0, layout: 0, view: 0, selection: 0 });
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
    handleTransportReady = vi.fn();
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
import {
  invalidateDisplaySettings,
  invalidateAfterViewRestore,
} from "./invalidation.ts";

const MockedBridge = Bridge as unknown as {
  instances: Array<{
    handlers: BridgeHandlers;
    sendCommand: ReturnType<typeof vi.fn>;
    sendOpenRemoteDataset: ReturnType<typeof vi.fn>;
  }>;
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
      camera: { mode: "slice", center: [4, 4], zoom: 2, viewport: [800, 600] },
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

function snapshotFetch(document: string) {
  const parsed = JSON.parse(document) as { manifests?: Record<string, ReturnType<typeof makeManifest>> };
  return Object.fromEntries(Object.entries(parsed.manifests ?? {}).map(([datasetId, manifest]) => [
    datasetId,
    {
      Proxied: {
        images: manifest.images.map((image) => ({
          image_id: image.image_id,
          wire_format: { Raw: { data_type: image.multiscale.data_type } },
        })),
      },
    },
  ]));
}

const authSession = {
  principal: {
    email: "me@example.com",
    display_name: "Me",
    picture_url: null,
    is_admin: false,
  },
  refresh: async () => {},
  signOut: async () => true,
  logoutFailure: null,
};

interface RenderAppOptions {
  workspaceName?: string;
  canRenameWorkspace?: boolean;
  onRenameWorkspace?: (name: string) => Promise<void>;
}

function renderApp({
  workspaceName = "Wiring",
  canRenameWorkspace = false,
  onRenameWorkspace = async () => {},
}: RenderAppOptions = {}) {
  return render(
    <AuthSessionContext.Provider value={authSession}>
      <App
        workspaceId="ws-1"
        workspaceName={workspaceName}
        workspaceRole="editor"
        defaultSavedViewId={null}
        canRenameWorkspace={canRenameWorkspace}
        onBackToDashboard={() => {}}
        onRenameWorkspace={onRenameWorkspace}
        onSetDefaultSavedView={async () => {}}
      />
    </AuthSessionContext.Provider>,
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    bridge.handlers.onSnapshot(1, docJson, [], 1, {}, snapshotFetch(docJson));
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
  window.history.replaceState({}, "", "/");
});

describe("App wiring: chrome-free production capture", () => {
  it("?render=1 suppresses both inspectors even though Saved Views is the default", async () => {
    window.history.replaceState({}, "", "/w/ws-1?render=1");
    renderApp();
    await act(async () => {});

    expect(document.querySelector(".app.render-mode")).not.toBeNull();
    expect(document.querySelector(".saved-view-sidebar")).toBeNull();

    // The toolbar is clipped outside the capture viewport, but exercising its
    // state transition proves render mode remains authoritative even if an
    // inspector is selected after mount rather than only at initialization.
    fireEvent.click(screen.getByTestId("explore-toggle"));
    expect(screen.queryByTestId("explore-panel")).toBeNull();
    expect(document.querySelector(".saved-view-sidebar")).toBeNull();
  });
});

describe("App wiring: mobile Layers drawer", () => {
  it("keeps the closed panel inert and owns modal focus until Escape restores the trigger", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    try {
      await mountWithSnapshot(documentJson(["wds-1"]));

      const trigger = screen.getByRole("button", { name: "Layers" });
      const panel = document.getElementById("layers-panel")!;
      expect(trigger.getAttribute("aria-controls")).toBe("layers-panel");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      expect(panel.hasAttribute("inert")).toBe(true);

      trigger.focus();
      fireEvent.click(trigger);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      const dialog = screen.getByRole("dialog", { name: "Layers" });
      const close = screen.getByRole("button", { name: "Close layers panel" });
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(close);

      const scrim = document.querySelector<HTMLButtonElement>(".mobile-layer-scrim")!;
      expect(scrim.getAttribute("aria-hidden")).toBe("true");
      expect(scrim.tabIndex).toBe(-1);

      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(panel.getAttribute("aria-hidden")).toBe("true");
      expect(panel.hasAttribute("inert")).toBe(true);
      expect(document.activeElement).toBe(trigger);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
    }
  });
});

describe("App wiring: workspace rename operation contract", () => {
  it("announces pending and success states and rejects a double submit", async () => {
    const request = deferred();
    const rename = vi.fn(() => request.promise);
    renderApp({ canRenameWorkspace: true, onRenameWorkspace: rename });

    const input = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(input, { target: { value: "Renamed workspace" } });
    fireEvent.blur(input);

    const pending = await screen.findByRole("status");
    expect(pending.textContent).toBe("Renaming workspace to Renamed workspace…");
    expect(pending.getAttribute("aria-live")).toBe("polite");
    expect((input as HTMLInputElement).disabled).toBe(true);
    fireEvent.blur(input);
    expect(rename).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve());

    const success = await screen.findByRole("status");
    expect(success.textContent).toBe("Workspace renamed to Renamed workspace.");
    expect(success.getAttribute("data-operation-phase")).toBe("success");
    expect((input as HTMLInputElement).disabled).toBe(false);
  });

  it("keeps a failed value retryable and replaces the error with truthful recovery state", async () => {
    const retryRequest = deferred();
    const rename = vi
      .fn<(name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("rename endpoint unavailable"))
      .mockImplementationOnce(() => retryRequest.promise);
    renderApp({ canRenameWorkspace: true, onRenameWorkspace: rename });

    const input = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(input, { target: { value: "Retry me" } });
    fireEvent.blur(input);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Workspace name was not saved.");
    expect(alert.textContent).toContain("rename endpoint unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenLastCalledWith("Retry me");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((await screen.findByRole("status")).textContent).toContain("Renaming workspace");

    await act(async () => retryRequest.resolve());
    expect((await screen.findByRole("status")).textContent).toBe("Workspace renamed to Retry me.");
  });

  it("does not publish a late failure after its keyed workspace route unmounts", async () => {
    const request = deferred();
    const view = renderApp({
      canRenameWorkspace: true,
      onRenameWorkspace: () => request.promise,
    });
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(input, { target: { value: "Old route" } });
    fireEvent.blur(input);
    await screen.findByRole("status");

    view.unmount();
    await act(async () => request.reject(new Error("late response")));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
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

describe("App wiring: 2D canvas keyboard navigation", () => {
  it("routes arrow and zoom keys through the viewport transaction boundary", async () => {
    const { scene } = await mountWithSnapshot(documentJson(["wds-1"]));
    const canvas = screen.getByLabelText("2D slice viewer");

    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "+" });

    expect(scene.commands).toContainEqual({ type: "pan", dx: 32, dy: 0 });
    expect(scene.commands).toContainEqual({ type: "zoom_by", factor: 1.1 });
  });
});

describe("App wiring: dataset-open failure surface", () => {
  it("keeps the alert above viewer content and wires retry plus dismiss to the failed open", async () => {
    const { bridge } = await mountWithSnapshot(documentJson([]));
    const failedUrl = "gs://bucket/broken.zarr";

    await act(async () => {
      bridge.handlers.onOpenDatasetFailed?.(
        "req-broken-1",
        failedUrl,
        "This dataset could not be opened.",
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This dataset could not be opened.");
    expect(alert.classList.contains("viewer-error")).toBe(true);
    // App owns this ordering: workspace chrome, then the error, then the
    // heavier viewer surfaces. Keeping the alert here prevents the old
    // below-the-fold failure at supported short viewports.
    const chrome = document.querySelector(".workspace-chrome");
    expect(chrome).not.toBeNull();
    expect(chrome!.nextElementSibling).toBe(alert);

    fireEvent.click(screen.getByRole("button", { name: "Retry dataset" }));
    expect(bridge.sendOpenRemoteDataset).toHaveBeenLastCalledWith(failedUrl);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      bridge.handlers.onOpenDatasetFailed?.(
        "req-broken-2",
        failedUrl,
        "This dataset could not be opened.",
      );
    });
    const sendsBeforeDismiss = bridge.sendOpenRemoteDataset.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridge.sendOpenRemoteDataset).toHaveBeenCalledTimes(sendsBeforeDismiss);
  });
});
