import { describe, it, expect, vi, beforeEach } from "vitest";
import { SavedViewApplier, type ApplierBridge, clampViewIndices } from "./applier.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "./types.ts";

// Mock WasmScene: records every apply_command call and lets the test
// pre-seed dataset_ids/available_layouts/dataset_volume_shape.
//
// We pass it through as `unknown as WasmScene` to side-step the opaque
// wasm-bindgen class type; the applier only uses the methods we mock.
function createMockScene(opts: {
  datasetIds?: string[];
  availableLayouts?: Record<string, Array<{ id: string; name: string; active?: boolean }>>;
  volumeShapes?: Record<string, Uint32Array>;
} = {}) {
  const calls: string[] = [];
  const ids = [...(opts.datasetIds ?? [])];
  const layouts = { ...(opts.availableLayouts ?? {}) };
  const shapes = { ...(opts.volumeShapes ?? {}) };
  // Track presence as a JSON object the applier can export/import on.
  const presence = {
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
  };
  const datasetPresence = {
    dataset_order: [...ids],
    dataset_settings: {},
  };
  return {
    calls,
    addDataset(id: string, layouts_: Array<{ id: string; name: string; active?: boolean }> = []) {
      if (!ids.includes(id)) ids.push(id);
      layouts[id] = layouts_;
      datasetPresence.dataset_order.push(id);
    },
    setShape(id: string, shape: Uint32Array) {
      shapes[id] = shape;
    },
    apply_command(json: string) {
      calls.push(json);
      // Track the active layout in our mock so the next available_layouts
      // call reflects it.
      try {
        const cmd = JSON.parse(json);
        if (cmd.type === "set_active_layout" && layouts[cmd.dataset_id]) {
          layouts[cmd.dataset_id] = layouts[cmd.dataset_id].map((l) => ({
            ...l,
            active: l.id === cmd.layout_id,
          }));
        }
      } catch {
        /* ignore */
      }
    },
    dataset_ids() {
      return JSON.stringify(ids);
    },
    available_layouts(id: string) {
      return JSON.stringify(layouts[id] ?? []);
    },
    dataset_volume_shape(id: string) {
      return shapes[id] ?? new Uint32Array(0);
    },
    export_presence() {
      return JSON.stringify(presence);
    },
    export_dataset_presence() {
      return JSON.stringify(datasetPresence);
    },
    import_presence(json: string) {
      const obj = JSON.parse(json);
      Object.assign(presence, obj);
    },
  };
}

function emptyView(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

describe("SavedViewApplier", () => {
  let openCalls: string[];
  let docCmds: string[];
  let bridge: ApplierBridge;

  // Deterministic id derivation that doesn't need the WASM init in tests.
  // Real applier wiring uses the wasm `dataset_id_for_url` (covered by
  // its own Rust tests in `lucida-core/src/saved_view.rs`).
  const fakeIdForUrl = (url: string) => `ds-${url.length.toString(16).padStart(16, "0")}-${url.slice(-4)}`;

  beforeEach(() => {
    openCalls = [];
    docCmds = [];
    bridge = {
      sendOpenRemoteDataset: (url: string) => { openCalls.push(url); },
      sendCommand: (json: string) => { docCmds.push(json); },
    };
  });

  it("happy-path: applies pristine view with no datasets", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.view.t = 5;
    v.view.c = 2;
    v.display.gamma = 1.5;
    await applier.apply(v);

    // No dataset opens needed.
    expect(openCalls).toEqual([]);
    // SetT, SetC, SetZRange, SetContrast, SetGamma, SetMultiChannel called.
    expect(scene.calls.some((c) => c.includes('"type":"set_t"'))).toBe(true);
    expect(scene.calls.some((c) => c.includes('"type":"set_c"'))).toBe(true);
    expect(scene.calls.some((c) => c.includes('"type":"set_gamma"'))).toBe(true);
    expect(applier.isInProgress()).toBe(false);
  });

  it("opens missing datasets and waits for DatasetOpened notification", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl, 1000);
    const v = emptyView();
    v.datasets = ["gs://bucket/a.zarr"];
    const expectedId = fakeIdForUrl("gs://bucket/a.zarr");

    const promise = applier.apply(v);
    // Tick the event loop so the open dispatch fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls).toEqual(["gs://bucket/a.zarr"]);
    expect(applier.isInProgress()).toBe(true);

    // Simulate the bridge calling notifyDatasetOpened after server response.
    scene.addDataset(expectedId);
    applier.notifyDatasetOpened(expectedId);
    await promise;
    expect(applier.isInProgress()).toBe(false);
    expect(applier.getState().okOpened).toBe(1);
  });

  it("partial-failure: marks one URL as error but keeps applying", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl, 1000);
    const v = emptyView();
    v.datasets = ["gs://good.zarr", "gs://bad.zarr"];

    const promise = applier.apply(v);
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls.length).toBe(2);

    const goodId = fakeIdForUrl("gs://good.zarr");
    scene.addDataset(goodId);
    applier.notifyDatasetOpened(goodId);
    applier.notifyOpenFailed("gs://bad.zarr", "404 not found");
    await promise;

    const state = applier.getState();
    expect(state.anyOpenFailed).toBe(true);
    expect(state.openStatuses.find((s) => s.url === "gs://bad.zarr")?.state).toBe("error");
    expect(state.openStatuses.find((s) => s.url === "gs://good.zarr")?.state).toBe("ok");
  });

  it("clamps out-of-range z silently", async () => {
    const scene = createMockScene({ datasetIds: ["ds-x"] });
    scene.setShape("ds-x", new Uint32Array([10, 256, 256])); // Z=10
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.datasets = []; // already loaded
    v.view.z_range = { start: 50, end: 100 }; // out of range
    await applier.apply(v);

    const setZRangeCall = scene.calls.find((c) => c.includes('"type":"set_z_range"'));
    expect(setZRangeCall).toBeDefined();
    const parsed = JSON.parse(setZRangeCall!);
    expect(parsed.start).toBeLessThan(10);
    expect(parsed.end).toBeLessThanOrEqual(10);
  });

  it("missing-layout fallback: warns and skips", async () => {
    const scene = createMockScene({
      datasetIds: ["ds-x"],
      availableLayouts: {
        "ds-x": [{ id: "L0", name: "default", active: true }],
      },
    });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.active_layouts = { "ds-x": "missing-layout" };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applier.apply(v);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    // No SetActiveLayout doc command sent for the missing layout.
    expect(docCmds.find((c) => c.includes('"set_active_layout"'))).toBeUndefined();
  });

  it("apply order: opens → hides → SetActiveLayout → order → settings → camera", async () => {
    const scene = createMockScene({
      datasetIds: ["ds-loaded", "ds-extra"],
      availableLayouts: {
        "ds-loaded": [
          { id: "L0", name: "default", active: true },
          { id: "L1", name: "alt" },
        ],
      },
    });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);

    const v = emptyView();
    v.datasets = []; // ds-loaded is already loaded; ds-extra is in scene but NOT in link
    v.active_layouts = { "ds-loaded": "L1" };
    v.dataset_order = ["ds-loaded"];

    await applier.apply(v);

    const orderHide = scene.calls.findIndex((c) => c.includes('"set_dataset_visible"') && c.includes('"ds-extra"'));
    const orderSetActive = docCmds.findIndex((c) => c.includes('"set_active_layout"'));
    const orderSetOrder = scene.calls.findIndex((c) => c.includes('"set_dataset_order"'));
    expect(orderHide).toBeGreaterThanOrEqual(0);
    expect(orderSetActive).toBeGreaterThanOrEqual(0); // sent via doc bridge
    expect(orderSetOrder).toBeGreaterThanOrEqual(0);
    // hide before set_dataset_order
    expect(orderHide).toBeLessThan(orderSetOrder);
  });

  it("hides loaded-but-not-in-link datasets via ViewportCommand", async () => {
    const scene = createMockScene({
      datasetIds: ["ds-stale"],
    });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView(); // empty datasets list
    await applier.apply(v);

    const hideCall = scene.calls.find(
      (c) => c.includes('"set_dataset_visible"') && c.includes('"ds-stale"'),
    );
    expect(hideCall).toBeDefined();
    expect(JSON.parse(hideCall!)).toMatchObject({
      type: "set_dataset_visible",
      dataset_id: "ds-stale",
      visible: false,
    });
    // Was NOT sent as a document command (recipient-only).
    expect(docCmds.find((c) => c.includes("ds-stale"))).toBeUndefined();
  });

  it("applyInProgress flag is true between start and resolution", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl, 1000);

    const v = emptyView();
    v.datasets = ["gs://x.zarr"];

    expect(applier.isInProgress()).toBe(false);
    const promise = applier.apply(v);
    await new Promise((r) => setTimeout(r, 0));
    expect(applier.isInProgress()).toBe(true);

    const id = fakeIdForUrl("gs://x.zarr");
    scene.addDataset(id);
    applier.notifyDatasetOpened(id);
    await promise;
    expect(applier.isInProgress()).toBe(false);
  });

  it("subscriber notified on state changes", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const events: boolean[] = [];
    const unsub = applier.subscribe((s) => { events.push(s.inProgress); });
    await applier.apply(emptyView());
    unsub();
    // Should have seen at least one true and one false.
    expect(events).toContain(true);
    expect(events).toContain(false);
  });

  it("rejects re-entry while another apply is in progress", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl, 1000);
    const v = emptyView();
    v.datasets = ["gs://x.zarr"];
    const p = applier.apply(v);
    await new Promise((r) => setTimeout(r, 0));
    await expect(applier.apply(v)).rejects.toThrow(/in progress/);
    // Resolve the open so the first apply finishes.
    const id = fakeIdForUrl("gs://x.zarr");
    scene.addDataset(id);
    applier.notifyDatasetOpened(id);
    await p;
  });
});

describe("clampViewIndices", () => {
  it("clamps z when out of range", () => {
    const scene = {
      dataset_volume_shape: () => new Uint32Array([10, 256, 256]),
    } as unknown as Parameters<typeof clampViewIndices>[0];
    const v = emptyView();
    v.view.z_range = { start: 50, end: 100 };
    const out = clampViewIndices(scene, [{ url: "u", id: "ds-x" }], v);
    expect(out.zStart).toBeLessThan(10);
    expect(out.zEnd).toBeLessThanOrEqual(10);
  });

  it("does not clamp when in range", () => {
    const scene = {
      dataset_volume_shape: () => new Uint32Array([100, 256, 256]),
    } as unknown as Parameters<typeof clampViewIndices>[0];
    const v = emptyView();
    v.view.z_range = { start: 5, end: 10 };
    const out = clampViewIndices(scene, [{ url: "u", id: "ds-x" }], v);
    expect(out.zStart).toBe(5);
    expect(out.zEnd).toBe(10);
  });
});
