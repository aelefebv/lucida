import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SavedViewApplier,
  type ApplierBridge,
  clampViewIndices,
  labelDisplayCommands,
} from "./applier.ts";
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

  // --- Per-label restore addressing ---------------------------------------
  //
  // A label setting captured WITH its label's name restores via `label_name`
  // (resolved scene-side against the CURRENT label list, so it survives a
  // re-import that reordered/added/removed labels); a name-less legacy setting
  // restores positionally via `label: <index>`, exactly as before.

  it("restores NAMED label settings via label_name (never a positional index)", async () => {
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
        label_settings: [
          { visible: false, opacity: 0.9, name: "nuclei" },
          { visible: true, opacity: 0.25, name: "mitochondria" },
        ],
      },
    };
    await applier.apply(v);

    const labelCmds = scene.calls
      .filter((c) => c.includes('"set_label_'))
      .map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(labelCmds).toHaveLength(4); // visible + opacity per entry
    // Every command addresses its label by NAME — no positional index that a
    // reordered label list would misroute.
    for (const cmd of labelCmds) {
      expect(cmd.label).toBeUndefined();
    }
    expect(labelCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label_name: "nuclei", visible: false,
    });
    expect(labelCmds).toContainEqual({
      type: "set_label_opacity", dataset_id: "ds-a", label_name: "nuclei", opacity: 0.9,
    });
    expect(labelCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label_name: "mitochondria", visible: true,
    });
    expect(labelCmds).toContainEqual({
      type: "set_label_opacity", dataset_id: "ds-a", label_name: "mitochondria", opacity: 0.25,
    });
  });

  it("restores REPEATED saved names positionally (ambiguous as a per-command key)", async () => {
    // A plate's fields commonly each carry a same-named label group, so the
    // captured vec can repeat a name. The scene resolves `label_name` to the
    // FIRST occurrence, which would pile every repeated entry onto one label —
    // so repeated-name entries fall back to positional addressing, while a
    // uniquely-named sibling in the same vec still restores by name.
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
        label_settings: [
          { visible: false, opacity: 0.9, name: "cells" },
          { visible: true, opacity: 0.25, name: "cells" },
          { visible: true, opacity: 0.5, name: "nuclei" },
        ],
      },
    };
    await applier.apply(v);

    const visibleCmds = scene.calls
      .filter((c) => c.includes('"set_label_visible"'))
      .map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(visibleCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label: 0, visible: false,
    });
    expect(visibleCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label: 1, visible: true,
    });
    expect(visibleCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label_name: "nuclei", visible: true,
    });
  });

  it("restores an explicit null-named entry positionally (null is not a name)", async () => {
    // A hand-authored or normalized stored view can spell "no name" as an
    // explicit `name: null` (serde deserializes it to None). It must restore
    // exactly like an absent name — positionally — never as
    // `label_name: null`, which the scene resolves to no label, silently
    // losing the entry's visible/opacity.
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
        label_settings: [
          { visible: false, opacity: 0.9, name: null },
        ],
      },
    };
    await applier.apply(v);

    const labelCmds = scene.calls
      .filter((c) => c.includes('"set_label_'))
      .map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(labelCmds).toHaveLength(2);
    for (const cmd of labelCmds) {
      expect("label_name" in cmd).toBe(false);
    }
    expect(labelCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label: 0, visible: false,
    });
    expect(labelCmds).toContainEqual({
      type: "set_label_opacity", dataset_id: "ds-a", label: 0, opacity: 0.9,
    });
  });

  it("restores name-less legacy label settings positionally (exact old behavior)", async () => {
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
        label_settings: [
          { visible: false, opacity: 0.9 },
          { visible: true, opacity: 0.25 },
        ],
      },
    };
    await applier.apply(v);

    const labelCmds = scene.calls
      .filter((c) => c.includes('"set_label_'))
      .map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(labelCmds).toHaveLength(4);
    for (const cmd of labelCmds) {
      expect(cmd.label_name).toBeUndefined();
    }
    expect(labelCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label: 0, visible: false,
    });
    expect(labelCmds).toContainEqual({
      type: "set_label_visible", dataset_id: "ds-a", label: 1, visible: true,
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
});

describe("labelDisplayCommands", () => {
  it("addresses a NAMED setting by label_name (no index key)", () => {
    const cmds = labelDisplayCommands("ds-a", 3, {
      visible: true,
      opacity: 0.4,
      name: "mitochondria",
    });
    expect(cmds).toEqual([
      { type: "set_label_visible", dataset_id: "ds-a", label_name: "mitochondria", visible: true },
      { type: "set_label_opacity", dataset_id: "ds-a", label_name: "mitochondria", opacity: 0.4 },
    ]);
  });

  it("addresses a name-less setting by positional index (no label_name key)", () => {
    const cmds = labelDisplayCommands("ds-a", 3, { visible: false, opacity: 0.9 });
    expect(cmds).toEqual([
      { type: "set_label_visible", dataset_id: "ds-a", label: 3, visible: false },
      { type: "set_label_opacity", dataset_id: "ds-a", label: 3, opacity: 0.9 },
    ]);
  });

  it("addresses an explicit-null name by positional index (never label_name: null)", () => {
    const cmds = labelDisplayCommands("ds-a", 2, { visible: true, opacity: 0.7, name: null });
    expect(cmds).toEqual([
      { type: "set_label_visible", dataset_id: "ds-a", label: 2, visible: true },
      { type: "set_label_opacity", dataset_id: "ds-a", label: 2, opacity: 0.7 },
    ]);
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
