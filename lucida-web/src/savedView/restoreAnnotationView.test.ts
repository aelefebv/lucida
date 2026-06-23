import { describe, it, expect } from "vitest";
import {
  restoreAnnotationView,
  switchCameraMode,
  viewModeForCamera,
} from "./restoreAnnotationView.ts";
import {
  SAVED_VIEW_VERSION,
  type Camera,
  type ChannelSettings,
  type DatasetDisplaySettings,
  type SavedView,
} from "./types.ts";

// A mock WasmScene exercising only the surface the LIGHT restore touches:
// camera_mode(), apply_command() (records every command), export/import_presence,
// dataset_ids() (the loaded set the per-dataset display restore reads), and
// dataset_volume_shape() (drives the Z clamp). Pre-seed the live camera mode and
// a per-dataset volume shape; every apply_command is recorded verbatim so a test
// can assert exactly which commands were (and were NOT) emitted.
//
// CRUCIAL: `dataset_volume_shape` mirrors REAL WASM — an UNKNOWN id returns the
// `[1,1,1]` sentinel (lucida-core/src/wasm.rs `unwrap_or_else(|| vec![1,1,1])`),
// NOT an empty array. The earlier stub returned empty for unknown ids, which
// masked the #814 clamp-collapse: clamping a deep captured Z against `""`
// silently collapsed it to plane 0. Seed shapes for every dataset a test means
// to be "deep"; anything unseeded is the shallow [1,1,1] sentinel.
function makeScene(opts: {
  cameraMode?: "slice" | "arcball" | "fly";
  volumeShapes?: Record<string, Uint32Array>;
  /** Loaded dataset ids (drives the per-dataset display restore). Defaults to
   *  the keys of `volumeShapes` so the common case "the deep dataset is loaded"
   *  needs no extra wiring. */
  loadedIds?: string[];
  /** Make `import_presence` throw, to exercise the bad-camera degrade (Fix 3). */
  importPresenceThrows?: boolean;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let cameraMode = opts.cameraMode ?? "slice";
  const shapes = { ...(opts.volumeShapes ?? {}) };
  const loadedIds = opts.loadedIds ?? Object.keys(shapes);
  const presence = {
    camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600] } as Camera,
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1 },
  };
  const scene = {
    camera_mode: () => cameraMode,
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      calls.push(cmd);
      if (cmd.type === "set_mode_slice") cameraMode = "slice";
      else if (cmd.type === "set_mode_arcball") cameraMode = "arcball";
      else if (cmd.type === "set_mode_fly") cameraMode = "fly";
    },
    // Mirrors real WASM: unknown id -> [1,1,1] sentinel, NOT empty.
    dataset_volume_shape: (id: string) => shapes[id] ?? new Uint32Array([1, 1, 1]),
    dataset_ids: () => JSON.stringify(loadedIds),
    export_presence: () => JSON.stringify(presence),
    import_presence: (json: string) => {
      if (opts.importPresenceThrows) throw new Error("invalid presence");
      Object.assign(presence, JSON.parse(json));
    },
  } as unknown as import("lucida-core").WasmScene;
  return {
    scene,
    calls,
    getMode: () => cameraMode,
    getPresenceCamera: () => presence.camera,
  };
}

function sliceCamera(center: [number, number] = [50, 60], zoom = 4): Camera {
  return { mode: "slice", center, zoom, viewport: [800, 600] };
}

function arcballCamera(): Camera {
  return {
    mode: "arcball",
    target: [10, 20, 30],
    theta: 0.5,
    phi: 1.1,
    distance: 200,
    fov: 45,
    viewport: [800, 600],
    near: 0.1,
    far: 1000,
  };
}

function viewWith(overrides: Partial<SavedView> = {}): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: sliceCamera(),
    view: { z_range: { start: 5, end: 6 }, t: 2, c: 1, multi_channel: false },
    display: { contrast_min: 100, contrast_max: 5000, gamma: 1.7 },
    dataset_order: [],
    dataset_settings: {},
    ...overrides,
  };
}

const DS = "wds-1";

const typesOf = (calls: Array<Record<string, unknown>>) => calls.map((c) => c.type);

describe("restoreAnnotationView (light tier)", () => {
  it("restores the captured camera, z/t/c, and display", () => {
    const { scene, calls, getPresenceCamera } = makeScene({
      // Deep enough that the captured z-slab (5..6) fits without clamping.
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    const view = viewWith({ camera: sliceCamera([123, 456], 8) });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    // Display restored.
    const contrast = calls.find((c) => c.type === "set_contrast");
    expect(contrast).toMatchObject({ min: 100, max: 5000 });
    expect(calls.find((c) => c.type === "set_gamma")).toMatchObject({ gamma: 1.7 });
    // z/t/c restored (unclamped — the slab fits).
    expect(calls.find((c) => c.type === "set_t")).toMatchObject({ t: 2 });
    expect(calls.find((c) => c.type === "set_c")).toMatchObject({ c: 1 });
    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 5, end: 6 });
    // Camera restored via import_presence (the merged presence carries it).
    expect(getPresenceCamera()).toMatchObject({ mode: "slice", center: [123, 456], zoom: 8 });
    expect(result.applied).toEqual({ zStart: 5, zEnd: 6, t: 2, c: 1 });
    expect(result.notice).toBeNull();
  });

  it("switches camera MODE (2D->3D) before importing the camera", () => {
    // Live scene is in 2D (slice); the captured camera is 3D (arcball).
    const { scene, calls } = makeScene({
      cameraMode: "slice",
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    const view = viewWith({
      camera: arcballCamera(),
      view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    expect(result.cameraModeChanged).toBe(true);
    expect(result.viewMode).toBe("3d");
    const order = typesOf(calls);
    // The mode switch must precede the display/z/t/c writes (so the arcball
    // camera is never applied while the scene is still in slice mode).
    expect(order.indexOf("set_mode_arcball")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("set_mode_arcball")).toBeLessThan(order.indexOf("set_contrast"));
    expect(order.indexOf("set_mode_arcball")).toBeLessThan(order.indexOf("set_z_range"));
  });

  it("switches 3D->2D (arcball live, captured slice) and reports viewMode 2d", () => {
    const { scene, calls } = makeScene({
      cameraMode: "arcball",
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    const view = viewWith({ camera: sliceCamera() });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    expect(result.cameraModeChanged).toBe(true);
    expect(result.viewMode).toBe("2d");
    expect(typesOf(calls)).toContain("set_mode_slice");
  });

  it("does NOT switch mode when the live camera mode already matches", () => {
    const { scene, calls } = makeScene({
      cameraMode: "slice",
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    const view = viewWith({ camera: sliceCamera() });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    expect(result.cameraModeChanged).toBe(false);
    expect(typesOf(calls)).not.toContain("set_mode_slice");
    expect(typesOf(calls)).not.toContain("set_mode_arcball");
  });

  it("emits NO dataset-hiding and NO shared-layout/order commands (light boundary)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    // A view whose author had other datasets + per-dataset settings + layouts —
    // the heavy applier would hide/reorder/relayout these; the light path must not.
    const view = viewWith({
      camera: arcballCamera(),
      dataset_order: ["wds-other", DS],
      dataset_settings: {
        "wds-other": {
          visible: false,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 1,
          gamma: 1,
          blend_mode: "alpha",
        },
      },
      active_layouts: { [DS]: "layout-xyz" },
    });

    restoreAnnotationView({ scene, view, datasetId: DS });

    const emitted = typesOf(calls);
    expect(emitted).not.toContain("set_dataset_visible");
    expect(emitted).not.toContain("set_active_layout");
    expect(emitted).not.toContain("set_dataset_order");
    expect(emitted).not.toContain("set_dataset_opacity");
    expect(emitted).not.toContain("set_dataset_contrast");
  });

  it("clamps the captured z/t/c to the pin's dataset extents + reports a notice", () => {
    // The pin's dataset is shallow (Z=4) but the captured slab is deep (z 50..52)
    // and t/c are out of range — all must clamp to fit, with a notice naming them.
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([4, 256, 256]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 50, end: 52 }, t: 99, c: 7 },
    });

    const result = restoreAnnotationView({
      scene,
      view,
      datasetId: DS,
      // T/C extents for the pin's dataset: 3 timepoints, 2 channels.
      dimensionExtentsFor: (id) => (id === DS ? { t: 3, c: 2 } : {}),
    });

    const zr = calls.find((c) => c.type === "set_z_range") as { start: number; end: number };
    expect(zr.end).toBeLessThanOrEqual(4);
    expect(zr.start).toBeLessThan(zr.end);
    expect(calls.find((c) => c.type === "set_t")).toMatchObject({ t: 2 }); // clamped to 3-1
    expect(calls.find((c) => c.type === "set_c")).toMatchObject({ c: 1 }); // clamped to 2-1
    expect(result.notice).toBeTruthy();
    // Names every adjusted axis.
    expect(result.notice).toContain("Z");
    expect(result.notice).toContain("T");
    expect(result.notice).toContain("C");
    expect(result.applied.t).toBe(2);
    expect(result.applied.c).toBe(1);
  });

  it("clamps against the PIN's dataset only — a co-loaded shallow neighbor can't crush it", () => {
    // Even though another (shallow) dataset is loaded, the clamp must scan ONLY
    // the pin's dataset (we never pass the neighbor's id), so a valid deep slab
    // survives.
    const { scene, calls } = makeScene({
      volumeShapes: {
        [DS]: new Uint32Array([340, 512, 512]),
        "wds-shallow": new Uint32Array([1, 512, 512]),
      },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 200, end: 205 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 200, end: 205 });
    expect(result.notice).toBeNull();
  });

  it("viewModeForCamera maps slice->2d and arcball/fly->3d", () => {
    expect(viewModeForCamera(sliceCamera())).toBe("2d");
    expect(viewModeForCamera(arcballCamera())).toBe("3d");
    expect(
      viewModeForCamera({
        mode: "fly",
        position: [0, 0, 0],
        orientation: [0, 0, 0, 1],
        fov: 45,
        viewport: [800, 600],
        near: 0.1,
        far: 1000,
        speed_multiplier: 1,
      }),
    ).toBe("3d");
  });

  it("switchCameraMode keeps a 3D fly camera as fly (no silent arcball downgrade)", () => {
    const { scene, calls } = makeScene({ cameraMode: "arcball" });
    const flyCam: Camera = {
      mode: "fly",
      position: [1, 2, 3],
      orientation: [0, 0, 0, 1],
      fov: 45,
      viewport: [800, 600],
      near: 0.1,
      far: 1000,
      speed_multiplier: 1,
    };
    const out = switchCameraMode(scene, flyCam);
    expect(out.changed).toBe(true);
    expect(out.viewMode).toBe("3d");
    expect(typesOf(calls)).toContain("set_mode_fly");
  });
});

// Regression family for the #814 clamp-collapse reintroduced through the
// null-selection / Mentions-inbox path (red-team `restore_clamp_family.json`).
// The trigger: a deep captured Z restored while the pin's dataset can't be
// resolved (selectedDatasetId === null in the multi-/zero-dataset window). The
// caller passes `datasetId: undefined`, and restore MUST pass the captured z/t/c
// through — NOT clamp against the WASM `[1,1,1]` sentinel that
// `dataset_volume_shape("")` returns. Folds the red-team cases (avc-empty-z,
// avc-empty-slab, avc-empty-tc, avc-control-correct-id, avc-coloaded-ok) into
// permanent tests; the throwaway `_redteam_repro.test.ts` is removed.
describe("restoreAnnotationView — null-selection / inbox path (no clamp-collapse, #814 class)", () => {
  it("avc-empty-z: a deep single-plane capture passes through (no datasetId, no collapse)", () => {
    // A deep dataset is loaded, but the pin's dataset is UNRESOLVED (inbox path).
    const { scene, calls } = makeScene({
      volumeShapes: { "wds-deep": new Uint32Array([340, 512, 512]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 119, end: 120 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: undefined });

    // The captured deep plane survives — NOT collapsed to [0,1].
    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 119, end: 120 });
    expect(result.applied).toMatchObject({ zStart: 119, zEnd: 120 });
    // No spurious "Z adjusted" notice.
    expect(result.notice).toBeNull();
  });

  it("avc-empty-slab: a thick deep slab passes through unclamped (no datasetId)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { "wds-deep": new Uint32Array([340, 512, 512]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 50, end: 80 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: undefined });

    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 50, end: 80 });
    expect(result.notice).toBeNull();
  });

  it("avc-empty-tc: Z passes through and t/c pass through (no datasetId, no resolver)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { "wds-deep": new Uint32Array([340, 4, 6]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 200, end: 210 }, t: 3, c: 2 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: undefined });

    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 200, end: 210 });
    expect(calls.find((c) => c.type === "set_t")).toMatchObject({ t: 3 });
    expect(calls.find((c) => c.type === "set_c")).toMatchObject({ c: 2 });
    expect(result.notice).toBeNull();
  });

  it("treats explicit null datasetId the same as undefined (no clamp)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { "wds-deep": new Uint32Array([340, 512, 512]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 119, end: 120 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: null });

    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 119, end: 120 });
    expect(result.notice).toBeNull();
  });

  it("avc-control-correct-id: a resolved pin dataset still preserves a deep slab (fix keeps the happy path)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { "wds-deep": new Uint32Array([340, 512, 512]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 119, end: 120 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: "wds-deep" });

    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 119, end: 120 });
    expect(result.notice).toBeNull();
  });

  it("avc-coloaded-ok: a co-loaded shallow neighbor can't crush the pin's deep slab (invariant 2 holds)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: {
        "wds-deep": new Uint32Array([340, 512, 512]),
        "wds-2d": new Uint32Array([1, 1024, 1024]),
      },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 119, end: 120 }, t: 0, c: 0 },
    });

    // Clamp targets ONLY the pin's dataset, never the shallow neighbor.
    const result = restoreAnnotationView({ scene, view, datasetId: "wds-deep" });

    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 119, end: 120 });
    expect(result.notice).toBeNull();
  });

  it("a RESOLVED but genuinely shallow pin dataset still clamps + notices (clamp not lost)", () => {
    // Sanity: skipping-when-unresolved must NOT also skip when the dataset IS
    // resolved and the capture genuinely overshoots it.
    const { scene, calls } = makeScene({
      volumeShapes: { "wds-shallow": new Uint32Array([4, 256, 256]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 50, end: 52 }, t: 0, c: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: "wds-shallow" });

    const zr = calls.find((c) => c.type === "set_z_range") as { start: number; end: number };
    expect(zr.end).toBeLessThanOrEqual(4);
    expect(result.notice).toContain("Z");
  });
});

// Per-dataset / per-channel DISPLAY fidelity (Fix 2): "go to the author's view"
// must reproduce the author's CHANNEL colors/contrast for multi-channel data,
// not just global contrast/gamma — while staying strictly inside the LIGHT
// boundary (no visibility/opacity/order/layout, no open, no broadcast).
function channel(overrides: Partial<ChannelSettings> = {}): ChannelSettings {
  return {
    visible: true,
    colormap: "gray",
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    ...overrides,
  };
}

function datasetSettings(
  overrides: Partial<DatasetDisplaySettings> = {},
): DatasetDisplaySettings {
  return {
    visible: true,
    opacity: 1,
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    blend_mode: "alpha",
    ...overrides,
  };
}

describe("restoreAnnotationView — per-channel/per-dataset display fidelity (Fix 2)", () => {
  it("restores the author's per-channel colormap + per-dataset contrast/gamma for the pin's dataset", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
      loadedIds: [DS],
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 5, end: 6 }, t: 0, c: 0, multi_channel: true },
      dataset_order: [DS],
      dataset_settings: {
        [DS]: datasetSettings({
          contrast_min: 200,
          contrast_max: 9000,
          gamma: 0.8,
          channel_settings: [
            channel({ colormap: "magenta", contrast_min: 10, contrast_max: 1000, gamma: 1.2 }),
            channel({ colormap: "green", contrast_min: 20, contrast_max: 2000, gamma: 0.9 }),
          ],
        }),
      },
    });

    restoreAnnotationView({ scene, view, datasetId: DS });

    // Per-dataset display.
    expect(
      calls.find((c) => c.type === "set_dataset_contrast" && c.dataset_id === DS),
    ).toMatchObject({ min: 200, max: 9000 });
    expect(
      calls.find((c) => c.type === "set_dataset_gamma" && c.dataset_id === DS),
    ).toMatchObject({ gamma: 0.8 });
    // Per-channel colormaps (the headline multi-channel fidelity).
    const colormaps = calls.filter((c) => c.type === "set_channel_colormap" && c.dataset_id === DS);
    expect(colormaps).toContainEqual(
      expect.objectContaining({ channel: 0, colormap: "magenta" }),
    );
    expect(colormaps).toContainEqual(
      expect.objectContaining({ channel: 1, colormap: "green" }),
    );
    // Per-channel contrast restored too.
    expect(
      calls.find((c) => c.type === "set_channel_contrast" && c.channel === 1),
    ).toMatchObject({ min: 20, max: 2000 });
  });

  it("restores display for OTHER loaded captured datasets, but SKIPS captured datasets that aren't loaded", () => {
    const { scene, calls } = makeScene({
      volumeShapes: {
        [DS]: new Uint32Array([100, 512, 512]),
        "wds-loaded-2": new Uint32Array([10, 64, 64]),
      },
      // The capture references a third dataset that is NOT loaded here.
      loadedIds: [DS, "wds-loaded-2"],
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z_range: { start: 5, end: 6 }, t: 0, c: 0 },
      dataset_order: [DS, "wds-loaded-2", "wds-not-loaded"],
      dataset_settings: {
        [DS]: datasetSettings({ channel_settings: [channel({ colormap: "red" })] }),
        "wds-loaded-2": datasetSettings({ channel_settings: [channel({ colormap: "cyan" })] }),
        "wds-not-loaded": datasetSettings({ channel_settings: [channel({ colormap: "yellow" })] }),
      },
    });

    restoreAnnotationView({ scene, view, datasetId: DS });

    const colormaps = calls.filter((c) => c.type === "set_channel_colormap");
    expect(colormaps.map((c) => c.colormap)).toContain("red");
    expect(colormaps.map((c) => c.colormap)).toContain("cyan");
    // The unloaded dataset's display is NOT applied (light path never opens it).
    expect(colormaps.map((c) => c.colormap)).not.toContain("yellow");
    // And no dataset-contrast for the unloaded id leaked through.
    expect(
      calls.some((c) => c.type === "set_dataset_contrast" && c.dataset_id === "wds-not-loaded"),
    ).toBe(false);
  });

  it("display restore stays inside the LIGHT boundary: NO visibility/opacity/order/layout/open/broadcast", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]), "wds-other": new Uint32Array([2, 8, 8]) },
      loadedIds: [DS, "wds-other"],
    });
    // A capture whose author hid + reordered + relaid-out datasets. The light
    // restore must reproduce the DISPLAY but none of the layer-placement.
    const view = viewWith({
      camera: arcballCamera(),
      dataset_order: ["wds-other", DS],
      active_layouts: { [DS]: "layout-xyz" },
      dataset_settings: {
        [DS]: datasetSettings({
          channel_settings: [channel({ colormap: "inferno" })],
        }),
        "wds-other": datasetSettings({
          visible: false,
          opacity: 0.25,
          channel_settings: [channel({ colormap: "viridis" })],
        }),
      },
    });

    restoreAnnotationView({ scene, view, datasetId: DS });

    const emitted = typesOf(calls);
    // Display DID happen (colormaps for both loaded datasets).
    expect(emitted).toContain("set_channel_colormap");
    expect(emitted).toContain("set_dataset_contrast");
    // Layer-placement / document mutation did NOT.
    expect(emitted).not.toContain("set_dataset_visible");
    expect(emitted).not.toContain("set_dataset_opacity");
    expect(emitted).not.toContain("set_dataset_order");
    expect(emitted).not.toContain("set_active_layout");
    // And no channel-VISIBILITY toggle smuggled a dataset off? (channel_visible
    // is display-scoped and IS expected; assert it targets a channel, never the
    // dataset-level visible.) The dataset-level hide must be absent — checked
    // above. Confirm the captured "visible: false" for wds-other did NOT become
    // a set_dataset_visible.
    expect(
      calls.some((c) => c.type === "set_dataset_visible" && c.dataset_id === "wds-other"),
    ).toBe(false);
  });

  it("no per-dataset display in the capture => only global display (back-compat)", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
      loadedIds: [DS],
    });
    const view = viewWith({ camera: sliceCamera(), dataset_settings: {} });

    restoreAnnotationView({ scene, view, datasetId: DS });

    expect(typesOf(calls)).toContain("set_contrast"); // global still applied
    expect(typesOf(calls)).not.toContain("set_dataset_contrast");
    expect(typesOf(calls)).not.toContain("set_channel_colormap");
  });
});

describe("restoreAnnotationView — hardening (Fix 3): a bad captured camera degrades gracefully", () => {
  it("does not throw when import_presence rejects the camera; the rest of the restore stands", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
      loadedIds: [DS],
      importPresenceThrows: true,
    });
    const view = viewWith({
      camera: sliceCamera([1, 2], 3),
      view: { z_range: { start: 5, end: 6 }, t: 1, c: 0 },
    });

    // Must NOT throw out of the navigate handler.
    let result!: ReturnType<typeof restoreAnnotationView>;
    expect(() => {
      result = restoreAnnotationView({ scene, view, datasetId: DS });
    }).not.toThrow();

    // The non-camera restore still happened (display + z/t/c applied).
    expect(typesOf(calls)).toContain("set_contrast");
    expect(calls.find((c) => c.type === "set_z_range")).toMatchObject({ start: 5, end: 6 });
    expect(calls.find((c) => c.type === "set_t")).toMatchObject({ t: 1 });
    expect(result.applied).toMatchObject({ zStart: 5, zEnd: 6, t: 1 });
  });
});
