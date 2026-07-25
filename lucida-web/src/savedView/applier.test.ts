import { describe, it, expect, vi, beforeEach } from "vitest";
import { SavedViewApplier, type ApplierBridge, clampViewIndices } from "./applier.ts";
import {
  SAVED_VIEW_VERSION,
  type BlendMode,
  type Colormap,
  type SavedView,
} from "./types.ts";

// Mock WasmScene: records every apply_command call and lets the test
// pre-seed dataset_ids/available_layouts/dataset_volume_shape.
//
// We pass it through as `unknown as WasmScene` to side-step the opaque
// wasm-bindgen class type; the applier only uses the methods we mock.
//
// `rejectCommand` lets a test refuse individual commands the way the real wasm
// deserializer does: it sees each parsed command and returns the message to
// throw (a serde "unknown variant …" for a value written by a newer build, or
// a wasm-bindgen "null pointer passed to rust" for a dead instance), or
// undefined to let it through. A refused command never reaches `calls`, so the
// recorded calls are exactly the ones that landed.
function createMockScene(opts: {
  datasetIds?: string[];
  availableLayouts?: Record<string, Array<{ id: string; name: string; active?: boolean }>>;
  volumeShapes?: Record<string, Uint32Array>;
  rejectCommand?: (cmd: Record<string, unknown>) => string | undefined;
} = {}) {
  const calls: string[] = [];
  const rejectCommand = opts.rejectCommand;
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
      // Refuse before recording: a rejected command changes nothing in the
      // real scene either.
      if (rejectCommand) {
        const message = rejectCommand(JSON.parse(json) as Record<string, unknown>);
        if (message !== undefined) throw new Error(message);
      }
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

  it("workspace viewer mode applies workspace-local ids without opening source URLs or document commands", async () => {
    const scene = createMockScene({
      datasetIds: ["wds-a", "wds-extra"],
      availableLayouts: {
        "wds-a": [
          { id: "L0", name: "default", active: true },
          { id: "L1", name: "alt" },
        ],
      },
    });
    const applier = new SavedViewApplier(
      bridge,
      () => scene as never,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
      false,
    );
    const v = emptyView();
    v.datasets = [];
    v.dataset_order = ["wds-a"];
    v.active_layouts = { "wds-a": "L1" };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applier.apply(v);

    expect(openCalls).toEqual([]);
    expect(docCmds.find((c) => c.includes('"wds-a"') && c.includes('"set_active_layout"'))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("leaving shared layout unchanged"),
    );
    expect(applier.getState().warnings.some((warning) => (
      warning.includes("leaving shared layout unchanged")
    ))).toBe(true);
    warn.mockRestore();
    const hideExtra = scene.calls.find(
      (c) => c.includes('"set_dataset_visible"') && c.includes('"wds-extra"'),
    );
    expect(JSON.parse(hideExtra!)).toMatchObject({
      type: "set_dataset_visible",
      dataset_id: "wds-extra",
      visible: false,
    });
  });

  it("workspace editor mode can apply active-layout document commands", async () => {
    const scene = createMockScene({
      datasetIds: ["wds-a"],
      availableLayouts: {
        "wds-a": [
          { id: "L0", name: "default", active: true },
          { id: "L1", name: "alt" },
        ],
      },
    });
    const applier = new SavedViewApplier(
      bridge,
      () => scene as never,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
      true,
    );
    const v = emptyView();
    v.dataset_order = ["wds-a"];
    v.active_layouts = { "wds-a": "L1" };

    await applier.apply(v);

    expect(openCalls).toEqual([]);
    const setActive = docCmds.find((c) => c.includes('"set_active_layout"'));
    expect(JSON.parse(setActive!)).toMatchObject({
      type: "set_active_layout",
      dataset_id: "wds-a",
      layout_id: "L1",
    });
  });

  it("workspace mode warns and partially applies when a view references missing workspace datasets", async () => {
    const scene = createMockScene({ datasetIds: ["wds-a"] });
    const applier = new SavedViewApplier(
      bridge,
      () => scene as never,
      fakeIdForUrl,
      10,
      "workspace-dataset-id",
    );
    const v = emptyView();
    v.dataset_order = ["wds-a", "wds-missing"];
    v.dataset_settings = {
      "wds-a": {
        visible: true,
        opacity: 0.5,
        contrast_min: 1,
        contrast_max: 2,
        gamma: 1,
        blend_mode: "alpha",
      },
      "wds-missing": {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 65535,
        gamma: 1,
        blend_mode: "alpha",
      },
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applier.apply(v);

    expect(openCalls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("wds-missing"));
    expect(applier.getState().warnings.some((warning) => warning.includes("wds-missing"))).toBe(true);
    expect(scene.calls.some((c) => c.includes('"wds-a"') && c.includes('"set_dataset_opacity"'))).toBe(true);
    expect(scene.calls.some((c) => c.includes('"wds-missing"'))).toBe(false);
    warn.mockRestore();
  });

  it("workspace mode does not hide every loaded dataset for camera-only hashes", async () => {
    const scene = createMockScene({ datasetIds: ["wds-a"] });
    const applier = new SavedViewApplier(
      bridge,
      () => scene as never,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
    );

    await applier.apply(emptyView());

    expect(scene.calls.find((c) => c.includes('"set_dataset_visible"'))).toBeUndefined();
  });

  it("applies explicit dataset detail level override", async () => {
    const scene = createMockScene({ datasetIds: ["ds-a"] });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.dataset_order = ["ds-a"];
    v.dataset_settings = {
      "ds-a": {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 65535,
        gamma: 1,
        blend_mode: "alpha",
        detail_level_override: 2,
      },
    };
    await applier.apply(v);

    const detailCall = scene.calls.find((c) => c.includes('"set_dataset_detail_level_override"'));
    expect(JSON.parse(detailCall!)).toMatchObject({
      type: "set_dataset_detail_level_override",
      dataset_id: "ds-a",
      level: 2,
    });
  });

  it("resets missing dataset detail level override to default", async () => {
    const scene = createMockScene({ datasetIds: ["ds-a"] });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.dataset_order = ["ds-a"];
    v.dataset_settings = {
      "ds-a": {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 65535,
        gamma: 1,
        blend_mode: "alpha",
      },
    };
    await applier.apply(v);

    const detailCall = scene.calls.find((c) => c.includes('"set_dataset_detail_level_override"'));
    expect(JSON.parse(detailCall!)).toMatchObject({
      type: "set_dataset_detail_level_override",
      dataset_id: "ds-a",
      level: null,
    });
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

  // --- selectedDatasetId wrinkle resolution (option c) -------------------

  it("emits ApplyResult with the first visible dataset after apply", async () => {
    const scene = createMockScene({ datasetIds: ["ds-a", "ds-b"] });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);

    const results: Array<{ first: string | null; visible: string[] }> = [];
    applier.subscribeApplyResult((r) => {
      results.push({ first: r.firstVisibleDatasetId, visible: r.visibleDatasetIds });
    });

    const v = emptyView();
    v.datasets = []; // both already loaded
    v.dataset_order = ["ds-a", "ds-b"];
    v.dataset_settings = {
      "ds-a": { visible: false, opacity: 1, contrast_min: 0, contrast_max: 1, gamma: 1, blend_mode: "alpha" },
      "ds-b": { visible: true,  opacity: 1, contrast_min: 0, contrast_max: 1, gamma: 1, blend_mode: "alpha" },
    };
    await applier.apply(v);

    expect(results).toHaveLength(1);
    expect(results[0].first).toBe("ds-b");
    expect(results[0].visible).toEqual(["ds-b"]);
  });

  it("ApplyResult uses dataset_order when populated", async () => {
    const scene = createMockScene({ datasetIds: ["ds-a", "ds-b", "ds-c"] });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const results: Array<string | null> = [];
    applier.subscribeApplyResult((r) => results.push(r.firstVisibleDatasetId));

    const v = emptyView();
    v.dataset_order = ["ds-c", "ds-a", "ds-b"];
    // No per-dataset settings = default visible.
    await applier.apply(v);
    expect(results[0]).toBe("ds-c");
  });

  it("ApplyResult emits null when nothing is visible", async () => {
    const scene = createMockScene({ datasetIds: ["ds-a"] });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const results: Array<string | null> = [];
    applier.subscribeApplyResult((r) => results.push(r.firstVisibleDatasetId));

    const v = emptyView();
    v.dataset_order = ["ds-a"];
    v.dataset_settings = {
      "ds-a": { visible: false, opacity: 1, contrast_min: 0, contrast_max: 1, gamma: 1, blend_mode: "alpha" },
    };
    await applier.apply(v);
    expect(results[0]).toBeNull();
  });

  it("subscribeApplyResult unsubscribe stops further callbacks", async () => {
    const scene = createMockScene({ datasetIds: ["ds-a"] });
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    let count = 0;
    const unsub = applier.subscribeApplyResult(() => { count++; });
    await applier.apply(emptyView());
    expect(count).toBe(1);
    unsub();
    await applier.apply(emptyView());
    expect(count).toBe(1);
  });

  // --- apply-complete channel (Bug #2 / #3 fix) -------------------------

  it("subscribeApplyComplete fires exactly once per apply", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    let count = 0;
    applier.subscribeApplyComplete(() => { count++; });

    await applier.apply(emptyView());
    expect(count).toBe(1);

    await applier.apply(emptyView());
    expect(count).toBe(2);
  });

  it("subscribeApplyComplete fires AFTER the WASM mutations (post-apply state visible)", async () => {
    // The fix relies on subscribers being able to read post-apply state
    // via the live scene. Verify the applier writes the view's c/t/z
    // BEFORE the apply-complete callback fires.
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    let setCSeen = false;
    let setTSeen = false;
    let setZSeen = false;
    applier.subscribeApplyComplete(() => {
      setCSeen = scene.calls.some((c) => c.includes('"type":"set_c"'));
      setTSeen = scene.calls.some((c) => c.includes('"type":"set_t"'));
      setZSeen = scene.calls.some((c) => c.includes('"type":"set_z_range"'));
    });
    const v = emptyView();
    v.view.t = 5;
    v.view.c = 2;
    await applier.apply(v);
    expect(setCSeen).toBe(true);
    expect(setTSeen).toBe(true);
    expect(setZSeen).toBe(true);
  });

  it("subscribeApplyComplete fires while inProgress is still true", async () => {
    // Subscribers want post-apply state but BEFORE the inProgress flag
    // flips back; this lets urlSync stay suppressed for the duration of
    // the apply-complete handler's render-dirty + state-sync work.
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    let inProgressDuringCallback = false;
    applier.subscribeApplyComplete(() => {
      inProgressDuringCallback = applier.isInProgress();
    });
    await applier.apply(emptyView());
    expect(inProgressDuringCallback).toBe(true);
    expect(applier.isInProgress()).toBe(false);
  });

  it("subscribeApplyComplete unsubscribe stops further callbacks", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    let count = 0;
    const unsub = applier.subscribeApplyComplete(() => { count++; });
    await applier.apply(emptyView());
    expect(count).toBe(1);
    unsub();
    await applier.apply(emptyView());
    expect(count).toBe(1);
  });

  it("subscribeApplyComplete supports multiple subscribers", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    let a = 0;
    let b = 0;
    applier.subscribeApplyComplete(() => { a++; });
    applier.subscribeApplyComplete(() => { b++; });
    await applier.apply(emptyView());
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  // Bug #3 root-cause coverage: per-channel state captured in the view
  // is written via set_c. The apply-complete listener can read post-apply
  // state to push back into React; here we verify the WASM-side write
  // landed (the React-side mirror is covered in useSavedViewSync.test.ts).
  it("set_c includes the captured channel value (Bug #3 root cause)", async () => {
    const scene = createMockScene();
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.view.c = 2;
    await applier.apply(v);

    const setCCall = scene.calls.find((c) => c.includes('"type":"set_c"'));
    expect(setCCall).toBeDefined();
    expect(JSON.parse(setCCall!)).toMatchObject({ type: "set_c", c: 2 });
  });

  // --- one refused value must not take the rest of the restore with it ----
  //
  // Colormap / blend mode / render mode are closed enums on the wasm side, so a
  // link written by a NEWER build carries variants this build's deserializer
  // refuses, and the decoder passes unknown values straight through (encoder.ts
  // only fills in ABSENT keys). The refusal therefore lands at one command.
  // Version skew on a link that outlives a deploy is ordinary for a viewer, so
  // it must cost one setting — not the framing.

  it("restores the camera and Z/T/C when a channel colormap is refused", async () => {
    const scene = createMockScene({
      datasetIds: ["ds-volume"],
      // Only the unknown colormap is refused; the known one still applies —
      // the wasm side rejects on the VALUE, not on the command shape.
      rejectCommand: (cmd) =>
        cmd.type === "set_channel_colormap" && cmd.colormap === "spectral"
          ? "unknown variant `spectral`, expected one of `gray`, `magenta`, `green`, " +
            "`cyan` at line 1 column 63"
          : undefined,
    });
    // A 340-plane, multi-channel volume: the shape this viewer exists for, and
    // deep enough that the saved Z/T/C need no clamping.
    scene.setShape("ds-volume", new Uint32Array([340, 2048, 2048]));

    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.camera = { mode: "slice", center: [512, 384], zoom: 4.25, viewport: [1600, 1200] };
    v.view = { z_range: { start: 118, end: 121 }, t: 7, c: 2, multi_channel: true };
    v.dataset_order = ["ds-volume"];
    v.dataset_settings = {
      "ds-volume": {
        visible: true,
        opacity: 1,
        contrast_min: 120,
        contrast_max: 4096,
        gamma: 0.8,
        blend_mode: "additive",
        channel_settings: [
          // Two channels carry a colormap from a newer build. The cast is the
          // point: the TS union mirrors THIS build's enum, the wire does not.
          { visible: true, colormap: "spectral" as Colormap, contrast_min: 0, contrast_max: 4096, gamma: 1.0 },
          { visible: true, colormap: "spectral" as Colormap, contrast_min: 0, contrast_max: 4096, gamma: 1.2 },
          { visible: true, colormap: "green", contrast_min: 10, contrast_max: 3000, gamma: 1.0 },
        ],
      },
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applier.apply(v);
    warn.mockRestore();

    // The camera is the LAST step and the whole point of a share link.
    expect(JSON.parse(scene.export_presence()).camera).toEqual(v.camera);
    // The saved plane / timepoint / channel all landed.
    const applied = (type: string) =>
      JSON.parse(scene.calls.find((c) => c.includes(`"type":"${type}"`))!);
    expect(applied("set_z_range")).toMatchObject({ start: 118, end: 121 });
    expect(applied("set_t")).toMatchObject({ t: 7 });
    expect(applied("set_c")).toMatchObject({ c: 2 });
    expect(applied("set_multi_channel")).toMatchObject({ enabled: true });
    expect(applied("set_gamma")).toMatchObject({ gamma: v.display.gamma });
    // Commands that FOLLOW the refused one still apply — both the rest of the
    // refused channel's display and the channel with a colormap we know.
    expect(scene.calls.some((c) => c.includes('"set_channel_gamma"') && c.includes('"gamma":1.2'))).toBe(true);
    expect(scene.calls.some((c) => c.includes('"set_channel_colormap"') && c.includes('"green"'))).toBe(true);
    // Only the two unknown colormaps were lost.
    expect(scene.calls.some((c) => c.includes('"spectral"'))).toBe(false);

    // And the user is told exactly what did not apply — no silent success.
    const warnings = applier.getState().warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      "Could not apply 2 settings from this view: channel colormap (x2). " +
        "Everything else was restored.",
    );
    expect(applier.isInProgress()).toBe(false);
  });

  it("does not broadcast a layout its own engine refused, and still restores the camera", async () => {
    const scene = createMockScene({
      datasetIds: ["ds-volume"],
      availableLayouts: {
        "ds-volume": [
          { id: "L0", name: "default", active: true },
          { id: "L1", name: "alt" },
        ],
      },
      rejectCommand: (cmd) =>
        cmd.type === "set_active_layout"
          ? "unknown field `axis_order`, expected one of `dataset_id`, `layout_id` " +
            "at line 1 column 58"
          : undefined,
    });
    scene.setShape("ds-volume", new Uint32Array([340, 2048, 2048]));
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.camera = { mode: "slice", center: [40, 60], zoom: 3.5, viewport: [1600, 1200] };
    v.dataset_order = ["ds-volume"];
    v.active_layouts = { "ds-volume": "L1" };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applier.apply(v);
    warn.mockRestore();

    // Refused locally, so peers never see it: broadcasting a mutation this
    // session could not apply would put them on a different document.
    expect(docCmds.find((c) => c.includes('"set_active_layout"'))).toBeUndefined();
    expect(JSON.parse(scene.export_presence()).camera).toEqual(v.camera);
    expect(applier.getState().warnings).toEqual([
      "Could not apply 1 setting from this view: layout. Everything else was restored.",
    ]);
  });

  it("stops on a dead engine and reports the restore as unfinished", async () => {
    // A trapped/poisoned wasm instance cannot apply anything, so pressing on
    // would only collect skips and then claim a partial restore that never
    // happened. The apply aborts — but it still names what it had already lost.
    const scene = createMockScene({
      datasetIds: ["ds-volume"],
      rejectCommand: (cmd) => {
        if (cmd.type === "set_dataset_blend_mode") {
          return "unknown variant `screen`, expected one of `alpha`, `additive`, `max` " +
            "at line 1 column 71";
        }
        if (cmd.type === "set_t") return "null pointer passed to rust";
        return undefined;
      },
    });
    scene.setShape("ds-volume", new Uint32Array([340, 2048, 2048]));
    const applier = new SavedViewApplier(bridge, () => scene as never, fakeIdForUrl);
    const v = emptyView();
    v.camera = { mode: "slice", center: [7, 9], zoom: 2.5, viewport: [1600, 1200] };
    v.dataset_order = ["ds-volume"];
    v.dataset_settings = {
      "ds-volume": {
        visible: true,
        opacity: 1,
        contrast_min: 0,
        contrast_max: 65535,
        gamma: 1,
        blend_mode: "screen" as BlendMode,
      },
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(applier.apply(v)).rejects.toThrow(/null pointer passed to rust/);
    warn.mockRestore();

    expect(applier.getState().warnings).toEqual([
      "Could not apply 1 setting from this view: dataset blend mode. " +
        "The restore then stopped, so more may be missing.",
    ]);
    // The camera never got its chance — and the notice does not pretend it did.
    expect(JSON.parse(scene.export_presence()).camera).toMatchObject({ zoom: 1.0 });
    expect(applier.isInProgress()).toBe(false);
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

  it("does not crush a deep Z when a shallow 2D dataset is co-loaded (#814 restore)", () => {
    // Regression for the #814 restore path: a 340-plane volume co-loaded with a
    // 2D image (Z=1). The saved deep plane must survive — the clamp bound is the
    // DEEPEST visible volume (what the global Z slider navigates), not the
    // shallowest, so a co-visible 2D dataset can't collapse a valid Z to 0.
    const scene = {
      dataset_volume_shape: (id: string) =>
        new Uint32Array([id === "ds-vol" ? 340 : 1, 256, 256]),
    } as unknown as Parameters<typeof clampViewIndices>[0];
    const v = emptyView();
    v.view.z_range = { start: 119, end: 120 };
    const out = clampViewIndices(
      scene,
      [{ url: "", id: "ds-vol" }, { url: "", id: "ds-2d" }],
      v,
    );
    expect(out.zStart).toBe(119);
    expect(out.zEnd).toBe(120);
    expect(out.clamped).toBe(false);
  });
});
