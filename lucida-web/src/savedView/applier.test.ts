import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";
import { SavedViewApplier, type ApplierBridge, clampViewIndices } from "./applier.ts";
import { buildCapture } from "./captureBuilder.ts";
import { SAVED_VIEW_VERSION, type SavedView, type UserTransform } from "./types.ts";
import {
  FIXTURES,
  PIXEL_RATIOS,
  PropertyReport,
  VIEWPORTS,
  cssSize,
  cssSizesDiffer,
  datasetId,
  fixture,
  joinedScene,
  loadWasm,
  notFramed,
  openIn,
  openedScene,
  renamed,
  type DatasetOpenedJson,
} from "../viewProperties.ts";

beforeAll(loadWasm);

const PAGE = VIEWPORTS[0];

/** The volume fixture as dataset `id`, optionally with two source layouts,
 *  `L0` (the default) and `L1`. */
function dataset(id: string, layouts = false): DatasetOpenedJson {
  const opened = renamed(fixture("volume"), id);
  if (!layouts) return opened;
  return {
    ...opened,
    manifest: {
      ...opened.manifest,
      source_layouts: [
        { id: "L0", name: "default", placements: [] },
        { id: "L1", name: "alt", placements: [] },
      ],
      default_layout_id: "L0",
    },
  };
}

/** A real scene holding datasets `ids`, recording every `apply_command` so a
 *  test can read what the applier wrote and in what order. */
function createScene(ids: string[] = [], opts: { layouts?: string[] } = {}) {
  const scene = joinedScene(
    PAGE,
    1,
    ids.map((id) => dataset(id, opts.layouts?.includes(id))),
  );
  const calls: string[] = [];
  const applyCommand = scene.apply_command.bind(scene);
  scene.apply_command = (json: string) => {
    calls.push(json);
    applyCommand(json);
  };
  return {
    scene,
    calls,
    /** The server's `dataset_opened` for `id` arriving. */
    addDataset(id: string) {
      openIn(scene, dataset(id));
    },
  };
}

/** The volume fixture as dataset `id`, its samples a quarter the size. */
function quarterSamples(id: string): DatasetOpenedJson {
  const opened = structuredClone(dataset(id));
  for (const image of opened.manifest.images) {
    if (!image.multiscale) throw new Error("expected an inline multiscale");
    for (const level of image.multiscale.levels) {
      level.scale = level.scale.map((s, axis) => (axis >= 2 ? s / 4 : s));
    }
  }
  return opened;
}

/** Where `id`'s bounding box corners land on the canvas. */
function onScreen(scene: WasmScene, id: string): number[] {
  const b = scene.dataset_fit_bounds(id);
  return [...scene.project_to_screen(b[0], b[1], b[2]), ...scene.project_to_screen(b[3], b[4], b[5])];
}

function settingsOf(scene: WasmScene, id: string): { visible: boolean; opacity: number } {
  return JSON.parse(scene.dataset_display_settings(id));
}

function emptyView(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0 },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

describe("SavedViewApplier", () => {
  let openCalls: string[];
  let docCmds: string[];
  let bridge: ApplierBridge;

  // Deterministic stand-in for the wasm `dataset_id_for_url`, which has its
  // own Rust tests.
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
    const { scene, calls } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    const v = emptyView();
    v.view.t = 5;
    v.display.gamma = 1.5;
    await applier.apply(v);

    // No dataset opens needed.
    expect(openCalls).toEqual([]);
    // SetT, SetZRange, SetContrast, SetGamma called.
    expect(calls.some((c) => c.includes('"type":"set_t"'))).toBe(true);
    expect(calls.some((c) => c.includes('"type":"set_gamma"'))).toBe(true);
    expect([scene.t(), scene.gamma()]).toEqual([5, 1.5]);
    expect(applier.isInProgress()).toBe(false);
  });

  it("opens missing datasets and waits for DatasetOpened notification", async () => {
    const { scene, addDataset } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl, 1000);
    const v = emptyView();
    v.datasets = ["gs://bucket/a.zarr"];
    const expectedId = fakeIdForUrl("gs://bucket/a.zarr");

    const promise = applier.apply(v);
    // Tick the event loop so the open dispatch fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls).toEqual(["gs://bucket/a.zarr"]);
    expect(applier.isInProgress()).toBe(true);

    // The bridge calls notifyDatasetOpened once the server's response lands.
    addDataset(expectedId);
    applier.notifyDatasetOpened(expectedId);
    await promise;
    expect(applier.isInProgress()).toBe(false);
    expect(applier.getState().okOpened).toBe(1);
  });

  it("partial-failure: marks one URL as error but keeps applying", async () => {
    const { scene, addDataset } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl, 1000);
    const v = emptyView();
    v.datasets = ["gs://good.zarr", "gs://bad.zarr"];

    const promise = applier.apply(v);
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls.length).toBe(2);

    const goodId = fakeIdForUrl("gs://good.zarr");
    addDataset(goodId);
    applier.notifyDatasetOpened(goodId);
    applier.notifyOpenFailed("gs://bad.zarr", "404 not found");
    await promise;

    const state = applier.getState();
    expect(state.anyOpenFailed).toBe(true);
    expect(state.openStatuses.find((s) => s.url === "gs://bad.zarr")?.state).toBe("error");
    expect(state.openStatuses.find((s) => s.url === "gs://good.zarr")?.state).toBe("ok");
  });

  it("clamps out-of-range z silently", async () => {
    const { scene, calls } = createScene(["ds-x"]); // 128 planes
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    const v = emptyView();
    v.datasets = []; // already loaded
    v.view.z_range = { start: 500, end: 600 }; // out of range
    await applier.apply(v);

    const setZRangeCall = calls.find((c) => c.includes('"type":"set_z_range"'));
    expect(setZRangeCall).toBeDefined();
    const parsed = JSON.parse(setZRangeCall!);
    expect(parsed.start).toBeLessThan(128);
    expect(parsed.end).toBeLessThanOrEqual(128);
    expect(scene.z()).toBeLessThan(128);
  });

  it("missing-layout fallback: warns and skips", async () => {
    const { scene } = createScene(["ds-x"], { layouts: ["ds-x"] });
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
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
    const { scene, calls } = createScene(["ds-loaded", "ds-extra"], { layouts: ["ds-loaded"] });
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);

    const v = emptyView();
    v.datasets = []; // ds-loaded is already loaded; ds-extra is in scene but NOT in link
    v.active_layouts = { "ds-loaded": "L1" };
    v.dataset_order = ["ds-loaded"];

    await applier.apply(v);

    const orderHide = calls.findIndex((c) => c.includes('"set_dataset_visible"') && c.includes('"ds-extra"'));
    const orderSetActive = docCmds.findIndex((c) => c.includes('"set_active_layout"'));
    const orderSetOrder = calls.findIndex((c) => c.includes('"set_dataset_order"'));
    expect(orderHide).toBeGreaterThanOrEqual(0);
    expect(orderSetActive).toBeGreaterThanOrEqual(0); // sent via doc bridge
    expect(orderSetOrder).toBeGreaterThanOrEqual(0);
    // hide before set_dataset_order
    expect(orderHide).toBeLessThan(orderSetOrder);
  });

  it("hides loaded-but-not-in-link datasets via ViewportCommand", async () => {
    const { scene, calls } = createScene(["ds-stale"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    const v = emptyView(); // empty datasets list
    await applier.apply(v);

    const hideCall = calls.find(
      (c) => c.includes('"set_dataset_visible"') && c.includes('"ds-stale"'),
    );
    expect(hideCall).toBeDefined();
    expect(JSON.parse(hideCall!)).toMatchObject({
      type: "set_dataset_visible",
      dataset_id: "ds-stale",
      visible: false,
    });
    expect(settingsOf(scene, "ds-stale").visible).toBe(false);
    // Not sent as a document command (recipient-only).
    expect(docCmds.find((c) => c.includes("ds-stale"))).toBeUndefined();
  });

  it("workspace viewer mode applies workspace-local ids without opening source URLs or document commands", async () => {
    const { scene, calls } = createScene(["wds-a", "wds-extra"], { layouts: ["wds-a"] });
    const applier = new SavedViewApplier(
      bridge,
      () => scene,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
      "refuse",
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
    const hideExtra = calls.find(
      (c) => c.includes('"set_dataset_visible"') && c.includes('"wds-extra"'),
    );
    expect(JSON.parse(hideExtra!)).toMatchObject({
      type: "set_dataset_visible",
      dataset_id: "wds-extra",
      visible: false,
    });
  });

  it("workspace editor mode can apply active-layout document commands", async () => {
    const { scene } = createScene(["wds-a"], { layouts: ["wds-a"] });
    const applier = new SavedViewApplier(
      bridge,
      () => scene,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
      "broadcast",
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

  it("shows a view's region in a document whose first dataset differs", async () => {
    // The first dataset fixes the camera's spaces. B covers A's region in
    // samples a quarter the size, so without A they differ by four.
    const saved = joinedScene(PAGE, 1, [dataset("wds-a"), quarterSamples("wds-b")]);
    saved.apply_command(JSON.stringify({ type: "set_zoom", value: 3 }));
    saved.apply_command(JSON.stringify({ type: "pan", dx: 150, dy: -60 }));
    const view = buildCapture({
      scene: saved,
      urlByDatasetId: new Map(),
      datasetReferenceMode: "workspace-dataset-id",
    });
    expect(view.camera_space).toBeDefined();
    const shown = onScreen(saved, "wds-b");

    const restored = async (v: SavedView) => {
      const scene = joinedScene(PAGE, 1, [quarterSamples("wds-b")]);
      const applier = new SavedViewApplier(
        bridge,
        () => scene,
        fakeIdForUrl,
        // The view names A, which this document no longer holds.
        50,
        "workspace-dataset-id",
        "refuse",
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await applier.apply(v);
      vi.restoreAllMocks();
      return onScreen(scene, "wds-b");
    };
    const carried = await restored(view);
    shown.forEach((n, i) => expect(carried[i]).toBeCloseTo(n, 6));
    // A view saved before the record existed reads in B's spaces as if they
    // were A's, so it lands elsewhere.
    const legacy = await restored({ ...view, camera_space: undefined });
    expect(legacy.some((n, i) => Math.abs(n - shown[i]) > 10)).toBe(true);
  });

  describe("placement by hand", () => {
    const moved: UserTransform = { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] };
    const placeB = (scene: WasmScene) =>
      scene.apply_command(JSON.stringify({ type: "set_user_transform", dataset_id: "wds-b", transform: moved }));
    const applierFor = (scene: WasmScene, mode: "broadcast" | "local" | "refuse") =>
      new SavedViewApplier(bridge, () => scene, fakeIdForUrl, 30_000, "workspace-dataset-id", mode);
    const transformOf = (scene: WasmScene, id: string) => JSON.parse(scene.dataset_user_transform(id));
    const viewOf = (record: SavedView["user_transforms"]): SavedView => ({
      ...emptyView(),
      dataset_order: ["wds-a", "wds-b"],
      user_transforms: record,
    });

    it("puts each dataset where the view recorded it and sends the change", async () => {
      const { scene } = createScene(["wds-a", "wds-b"]);
      await applierFor(scene, "broadcast").apply(viewOf({ "wds-b": moved }));
      expect(transformOf(scene, "wds-b")).toEqual(moved);
      expect(transformOf(scene, "wds-a")).toBeNull();
      const sent = docCmds.filter((c) => c.includes('"set_user_transform"')).map((c) => JSON.parse(c));
      expect(sent).toEqual([{ type: "set_user_transform", dataset_id: "wds-b", transform: moved }]);
    });

    it("puts back a dataset moved since the view, which recorded it where it declares", async () => {
      const { scene } = createScene(["wds-a", "wds-b"]);
      placeB(scene);
      await applierFor(scene, "broadcast").apply(viewOf({}));
      expect(transformOf(scene, "wds-b")).toBeNull();
    });

    it("leaves placement alone for a view that records none", async () => {
      const { scene, calls } = createScene(["wds-a", "wds-b"]);
      placeB(scene);
      await applierFor(scene, "broadcast").apply(viewOf(undefined));
      expect(transformOf(scene, "wds-b")).toEqual(moved);
      expect(calls.filter((c) => c.includes('"set_user_transform"'))).toHaveLength(1);
      expect(docCmds.find((c) => c.includes('"set_user_transform"'))).toBeUndefined();
    });

    it("places locally on the capture surface and refuses for a viewer, saying so", async () => {
      const local = createScene(["wds-a", "wds-b"]);
      await applierFor(local.scene, "local").apply(viewOf({ "wds-b": moved }));
      expect(transformOf(local.scene, "wds-b")).toEqual(moved);
      expect(docCmds).toEqual([]);

      const viewer = createScene(["wds-a", "wds-b"]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const applier = applierFor(viewer.scene, "refuse");
      await applier.apply(viewOf({ "wds-b": moved }));
      warn.mockRestore();
      expect(transformOf(viewer.scene, "wds-b")).toBeNull();
      expect(applier.getState().warnings.some((w) => w.includes("leaving the shared placement unchanged"))).toBe(true);
    });

    it("round-trips through a capture of the moved scene", async () => {
      const saved = createScene(["wds-a", "wds-b"]);
      placeB(saved.scene);
      const view = buildCapture({
        scene: saved.scene,
        urlByDatasetId: new Map(),
        datasetReferenceMode: "workspace-dataset-id",
      });
      expect(view.user_transforms).toEqual({ "wds-b": moved });
      const { scene } = createScene(["wds-a", "wds-b"]);
      await applierFor(scene, "broadcast").apply(view);
      expect(scene.dataset_placement("wds-b")).toEqual(saved.scene.dataset_placement("wds-b"));
    });
  });

  it.each(["refuse", "broadcast", "local"] as const)(
    "leaves the layout alone when the view asks for the one shown (%s)",
    async (layoutMutation) => {
      const { scene, calls } = createScene(["wds-a"], { layouts: ["wds-a"] });
      const applier = new SavedViewApplier(
        bridge,
        () => scene,
        fakeIdForUrl,
        30_000,
        "workspace-dataset-id",
        layoutMutation,
      );
      const v = emptyView();
      v.dataset_order = ["wds-a"];
      v.active_layouts = { "wds-a": "L0" };

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await applier.apply(v);

      expect(calls.find((c) => c.includes('"set_active_layout"'))).toBeUndefined();
      expect(docCmds.find((c) => c.includes('"set_active_layout"'))).toBeUndefined();
      expect(applier.getState().warnings).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it("local layout mutation switches this scene's layout without broadcasting it", async () => {
    const { scene, calls } = createScene(["wds-a"], { layouts: ["wds-a"] });
    const applier = new SavedViewApplier(
      bridge,
      () => scene,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
      "local",
    );
    const v = emptyView();
    v.dataset_order = ["wds-a"];
    v.active_layouts = { "wds-a": "L1" };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applier.apply(v);

    // The capture renders the layout the view asked for...
    const localSetActive = calls.find((c) => c.includes('"set_active_layout"'));
    expect(JSON.parse(localSetActive!)).toMatchObject({
      type: "set_active_layout",
      dataset_id: "wds-a",
      layout_id: "L1",
    });
    // ...and the shared document never hears about it. A capture has nothing
    // to warn a user about, so no warning either.
    expect(docCmds.find((c) => c.includes('"set_active_layout"'))).toBeUndefined();
    expect(applier.getState().warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("workspace mode warns and partially applies when a view references missing workspace datasets", async () => {
    const { scene, calls } = createScene(["wds-a"]);
    const applier = new SavedViewApplier(
      bridge,
      () => scene,
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
    expect(calls.some((c) => c.includes('"wds-a"') && c.includes('"set_dataset_opacity"'))).toBe(true);
    expect(settingsOf(scene, "wds-a").opacity).toBe(0.5);
    expect(calls.some((c) => c.includes('"wds-missing"'))).toBe(false);
    warn.mockRestore();
  });

  it("workspace mode does not hide every loaded dataset for camera-only hashes", async () => {
    const { scene, calls } = createScene(["wds-a"]);
    const applier = new SavedViewApplier(
      bridge,
      () => scene,
      fakeIdForUrl,
      30_000,
      "workspace-dataset-id",
    );

    await applier.apply(emptyView());

    expect(calls.find((c) => c.includes('"set_dataset_visible"'))).toBeUndefined();
    expect(settingsOf(scene, "wds-a").visible).toBe(true);
  });

  it("applies explicit dataset detail level override", async () => {
    const { scene, calls } = createScene(["ds-a"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
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

    const detailCall = calls.find((c) => c.includes('"set_dataset_detail_level_override"'));
    expect(JSON.parse(detailCall!)).toMatchObject({
      type: "set_dataset_detail_level_override",
      dataset_id: "ds-a",
      level: 2,
    });
  });

  it("resets missing dataset detail level override to default", async () => {
    const { scene, calls } = createScene(["ds-a"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
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

    const detailCall = calls.find((c) => c.includes('"set_dataset_detail_level_override"'));
    expect(JSON.parse(detailCall!)).toMatchObject({
      type: "set_dataset_detail_level_override",
      dataset_id: "ds-a",
      level: null,
    });
  });

  it("applyInProgress flag is true between start and resolution", async () => {
    const { scene, addDataset } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl, 1000);

    const v = emptyView();
    v.datasets = ["gs://x.zarr"];

    expect(applier.isInProgress()).toBe(false);
    const promise = applier.apply(v);
    await new Promise((r) => setTimeout(r, 0));
    expect(applier.isInProgress()).toBe(true);

    const id = fakeIdForUrl("gs://x.zarr");
    addDataset(id);
    applier.notifyDatasetOpened(id);
    await promise;
    expect(applier.isInProgress()).toBe(false);
  });

  it("subscriber notified on state changes", async () => {
    const { scene } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    const events: boolean[] = [];
    const unsub = applier.subscribe((s) => { events.push(s.inProgress); });
    await applier.apply(emptyView());
    unsub();
    // Should have seen at least one true and one false.
    expect(events).toContain(true);
    expect(events).toContain(false);
  });

  it("rejects re-entry while another apply is in progress", async () => {
    const { scene, addDataset } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl, 1000);
    const v = emptyView();
    v.datasets = ["gs://x.zarr"];
    const p = applier.apply(v);
    await new Promise((r) => setTimeout(r, 0));
    await expect(applier.apply(v)).rejects.toThrow(/in progress/);
    // Resolve the open so the first apply finishes.
    const id = fakeIdForUrl("gs://x.zarr");
    addDataset(id);
    applier.notifyDatasetOpened(id);
    await p;
  });

  it("emits ApplyResult with the first visible dataset after apply", async () => {
    const { scene } = createScene(["ds-a", "ds-b"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);

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
    const { scene } = createScene(["ds-a", "ds-b", "ds-c"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    const results: Array<string | null> = [];
    applier.subscribeApplyResult((r) => results.push(r.firstVisibleDatasetId));

    const v = emptyView();
    v.dataset_order = ["ds-c", "ds-a", "ds-b"];
    // No per-dataset settings means visible.
    await applier.apply(v);
    expect(results[0]).toBe("ds-c");
  });

  it("ApplyResult emits null when nothing is visible", async () => {
    const { scene } = createScene(["ds-a"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
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
    const { scene } = createScene(["ds-a"]);
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    let count = 0;
    const unsub = applier.subscribeApplyResult(() => { count++; });
    await applier.apply(emptyView());
    expect(count).toBe(1);
    unsub();
    await applier.apply(emptyView());
    expect(count).toBe(1);
  });

  it("subscribeApplyComplete fires exactly once per apply", async () => {
    const { scene } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    let count = 0;
    applier.subscribeApplyComplete(() => { count++; });

    await applier.apply(emptyView());
    expect(count).toBe(1);

    await applier.apply(emptyView());
    expect(count).toBe(2);
  });

  it("subscribeApplyComplete fires AFTER the WASM mutations (post-apply state visible)", async () => {
    // Subscribers read post-apply state from the live scene, so t/z must be
    // written before the callback fires.
    const { scene } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    let seen: number[] = [];
    applier.subscribeApplyComplete(() => {
      seen = [scene.t(), scene.z()];
    });
    const v = emptyView();
    v.view.t = 5;
    v.view.z_range = { start: 3, end: 4 };
    await applier.apply(v);
    expect(seen).toEqual([5, 3]);
  });

  it("subscribeApplyComplete fires while inProgress is still true", async () => {
    // Keeps urlSync suppressed while the handler syncs render and React
    // state.
    const { scene } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    let inProgressDuringCallback = false;
    applier.subscribeApplyComplete(() => {
      inProgressDuringCallback = applier.isInProgress();
    });
    await applier.apply(emptyView());
    expect(inProgressDuringCallback).toBe(true);
    expect(applier.isInProgress()).toBe(false);
  });

  it("subscribeApplyComplete unsubscribe stops further callbacks", async () => {
    const { scene } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    let count = 0;
    const unsub = applier.subscribeApplyComplete(() => { count++; });
    await applier.apply(emptyView());
    expect(count).toBe(1);
    unsub();
    await applier.apply(emptyView());
    expect(count).toBe(1);
  });

  it("subscribeApplyComplete supports multiple subscribers", async () => {
    const { scene } = createScene();
    const applier = new SavedViewApplier(bridge, () => scene, fakeIdForUrl);
    let a = 0;
    let b = 0;
    applier.subscribeApplyComplete(() => { a++; });
    applier.subscribeApplyComplete(() => { b++; });
    await applier.apply(emptyView());
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  /** A scene with a three-channel layer `a` and a two-channel layer `b`, and a
   *  workspace view of both whose captured settings list every channel. */
  function channelScene(view: SavedView["view"], v: number, solos: { a?: number; b?: number } = {}) {
    const { scene } = createScene(["a"]);
    openIn(scene, renamed(fixture("image"), "b"));
    const channel = { visible: true, colormap: "gray" as const, contrast_min: 0, contrast_max: 1, gamma: 1 };
    const settings = (count: number, solo?: number) => ({
      ...JSON.parse(scene.dataset_display_settings("a")),
      channel_settings: Array.from({ length: count }, () => channel),
      ...(solo === undefined ? {} : { solo }),
    });
    const saved: SavedView = {
      ...emptyView(),
      v,
      view,
      dataset_order: ["a", "b"],
      dataset_settings: { a: settings(3, solos.a), b: settings(2, solos.b) },
    };
    const applier = new SavedViewApplier(
      bridge, () => scene, fakeIdForUrl, 1000, "workspace-dataset-id", "local",
    );
    const shown = () => {
      const layers = JSON.parse(scene.resolved_layers(scene.active_view())) as {
        dataset_id: string;
        channels: { channel: number }[];
      }[];
      return Object.fromEntries(layers.map((l) => [l.dataset_id, l.channels.map((c) => c.channel)]));
    };
    return { applier, saved, shown };
  }

  it("restores each layer's solo from a current view", async () => {
    const { applier, saved, shown } = channelScene({ z_range: { start: 0, end: 1 }, t: 0 }, 2, { a: 1 });
    await applier.apply(saved);
    expect(shown()).toEqual({ a: [1], b: [0, 1] });
  });

  it("restores a view recorded with a scene-wide solo as a solo of each layer that has the channel", async () => {
    const legacy = { z_range: { start: 0, end: 1 }, t: 0, c: 2, multi_channel: false };
    const { applier, saved, shown } = channelScene(legacy, 1);
    await applier.apply(saved);
    // The two-channel layer has no channel 2 and stays visible in its composite.
    expect(shown()).toEqual({ a: [2], b: [0, 1] });
  });

  it("restores a view recorded in the scene-wide composite as the composite", async () => {
    const legacy = { z_range: { start: 0, end: 1 }, t: 0, c: 1, multi_channel: true };
    const { applier, saved, shown } = channelScene(legacy, 1, { a: 2 });
    await applier.apply(saved);
    expect(shown()).toEqual({ a: [0, 1, 2], b: [0, 1] });
  });
});

describe("SavedViewApplier restores a view at the size it was saved", () => {
  const bridge: ApplierBridge = { sendOpenRemoteDataset: () => {}, sendCommand: () => {} };

  /** Every fixture's view, fitted in `mode` on a page at one pixel ratio and
   *  applied on a page of the same CSS size at the other: framed, and at the
   *  CSS size it was saved at. */
  async function restoreAtTheOtherRatio(mode: "slice" | "arcball"): Promise<void> {
    const framed = new PropertyReport();
    const sized = new PropertyReport();
    for (const f of FIXTURES) {
      const id = datasetId(f);
      for (const vp of VIEWPORTS) {
        for (const savedAt of PIXEL_RATIOS) {
          const shownAt = savedAt === 1 ? 2 : 1;
          const source = openedScene(f, vp, savedAt, mode);
          const view = buildCapture({
            scene: source,
            urlByDatasetId: new Map(),
            datasetReferenceMode: "workspace-dataset-id",
          });
          const page = joinedScene(vp, shownAt, [f.opened]);
          const applier = new SavedViewApplier(
            bridge,
            () => page,
            (url) => url,
            1000,
            "workspace-dataset-id",
            "local",
          );
          await applier.apply(view);
          const label = `${f.name} on ${vp.name}, saved at ${savedAt}x, shown at ${shownAt}x`;
          framed.check(label, notFramed(page, id));
          sized.check(label, cssSizesDiffer(cssSize(source, id, savedAt), cssSize(page, id, shownAt)));
        }
      }
    }
    framed.assertHolds();
    sized.assertHolds();
  }

  it("keeps an arcball view framed and at its CSS size", async () => {
    await restoreAtTheOtherRatio("arcball");
  });

  it("keeps a slice view framed and at its CSS size", async () => {
    await restoreAtTheOtherRatio("slice");
  });
});

describe("clampViewIndices", () => {
  it("clamps z when out of range", () => {
    const { scene } = createScene(["ds-x"]); // 128 planes
    const v = emptyView();
    v.view.z_range = { start: 500, end: 600 };
    const out = clampViewIndices(scene, [{ url: "u", id: "ds-x" }], v);
    expect(out.zStart).toBeLessThan(128);
    expect(out.zEnd).toBeLessThanOrEqual(128);
  });

  it("does not clamp when in range", () => {
    const { scene } = createScene(["ds-x"]);
    const v = emptyView();
    v.view.z_range = { start: 5, end: 10 };
    const out = clampViewIndices(scene, [{ url: "u", id: "ds-x" }], v);
    expect(out.zStart).toBe(5);
    expect(out.zEnd).toBe(10);
  });

  it("does not crush a deep Z when a shallow 2D dataset is co-loaded", () => {
    // A 128-plane volume co-loaded with a 2D image (Z=1). The bound is the
    // deepest visible volume, so the 2D dataset can't collapse a valid Z to 0.
    const scene = joinedScene(PAGE, 1, [dataset("ds-vol"), renamed(fixture("image"), "ds-2d")]);
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
