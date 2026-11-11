import { describe, it, expect } from "vitest";
import {
  restoreAnnotationView,
  switchCameraMode,
  viewModeForCamera,
} from "./restoreAnnotationView.ts";
import {
  SAVED_VIEW_VERSION,
  type Camera,
  type CameraSpace,
  type ChannelSettings,
  type DatasetDisplaySettings,
  type SavedView,
} from "./types.ts";

// A mock WasmScene covering only what the light restore touches. Every
// apply_command is recorded verbatim so a test can assert exactly which
// commands were and were not emitted.
//
// `dataset_volume_shape` matches real WASM: an unknown id returns the
// `[1,1,1]` sentinel, not an empty array. An empty stub hides the bug where a
// deep captured Z clamped against `""` collapses to plane 0. Seed shapes for
// every dataset a test means to be deep.
function makeScene(opts: {
  cameraMode?: "slice" | "arcball" | "fly";
  volumeShapes?: Record<string, Uint32Array>;
  /** Loaded dataset ids. Defaults to the keys of `volumeShapes`. */
  loadedIds?: string[];
  /** Make `import_presence` throw, to exercise the bad-camera degrade. */
  importPresenceThrows?: boolean;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let cameraMode = opts.cameraMode ?? "slice";
  const shapes = { ...(opts.volumeShapes ?? {}) };
  const loadedIds = opts.loadedIds ?? Object.keys(shapes);
  const presence = {
    camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600] } as Camera,
    view: { t: 0 } as Record<string, unknown>,
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
    // Matches real WASM: unknown id -> [1,1,1] sentinel, not empty.
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
    getPresenceView: () => presence.view as Record<string, unknown>,
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
    view: { z: { start: 5, end: 6 }, t: 2 },
    display: { contrast_min: 100, contrast_max: 5000, gamma: 1.7 },
    dataset_order: [],
    dataset_settings: {},
    ...overrides,
  };
}

const DS = "wds-1";

const typesOf = (calls: Array<Record<string, unknown>>) => calls.map((c) => c.type);

describe("restoreAnnotationView (light tier)", () => {
  it("restores the captured camera, axis positions, t and display", () => {
    const { scene, calls, getPresenceCamera, getPresenceView } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    const view = viewWith({ camera: sliceCamera([123, 456], 8) });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    // Display restored.
    const contrast = calls.find((c) => c.type === "set_contrast");
    expect(contrast).toMatchObject({ min: 100, max: 5000 });
    expect(calls.find((c) => c.type === "set_gamma")).toMatchObject({ gamma: 1.7 });
    // Camera and positions go to the scene together, the places as captured.
    expect(getPresenceCamera()).toMatchObject({ mode: "slice", center: [123, 456], zoom: 8 });
    expect(getPresenceView()).toEqual({ z: { start: 5, end: 6 }, t: 2 });
    expect(calls.find((c) => c.type === "set_z_range")).toBeUndefined();
    expect(result.applied).toEqual({ t: 2 });
    expect(result.notice).toBeNull();
  });

  it("hands the scene the spaces the camera was saved in", () => {
    const { scene } = makeScene({ volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) } });
    const imported: string[] = [];
    const importPresence = scene.import_presence.bind(scene);
    scene.import_presence = (json: string) => {
      imported.push(json);
      importPresence(json);
    };
    const camera_space: CameraSpace = {
      frame: { spacing: [1, 1, 1], origin: [0, 0, 0] },
      world: { extent: 64, top: 64 },
    };

    restoreAnnotationView({ scene, view: viewWith({ camera_space }), datasetId: DS });

    expect(imported).toHaveLength(1);
    expect((JSON.parse(imported[0]) as { camera_space: unknown }).camera_space).toEqual(camera_space);
  });

  it("switches camera MODE (2D->3D) before importing the camera", () => {
    // Live scene is in 2D (slice); the captured camera is 3D (arcball).
    const { scene, calls } = makeScene({
      cameraMode: "slice",
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) },
    });
    const view = viewWith({
      camera: arcballCamera(),
      view: { z: { start: 0, end: 1 }, t: 0 },
    });

    const result = restoreAnnotationView({ scene, view, datasetId: DS });

    expect(result.cameraModeChanged).toBe(true);
    expect(result.viewMode).toBe("3d");
    const order = typesOf(calls);
    // The mode switch must precede the display/z/t/c writes (so the arcball
    // camera is never applied while the scene is still in slice mode).
    expect(order.indexOf("set_mode_arcball")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("set_mode_arcball")).toBeLessThan(order.indexOf("set_contrast"));
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
    // The heavy applier would hide, reorder, and relayout these; the light path
    // must not.
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

  it("clamps the captured t to the pin's dataset and says so, leaving places as they are", () => {
    // A place past a shallow dataset stays: the dataset says it is outside the cut.
    const { scene, getPresenceView } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([4, 256, 256]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z: { start: 50, end: 52 }, t: 99 },
    });

    const result = restoreAnnotationView({
      scene,
      view,
      datasetId: DS,
      dimensionExtentsFor: (id) => (id === DS ? { t: 3 } : {}),
    });

    expect(getPresenceView()).toEqual({ z: { start: 50, end: 52 }, t: 2 });
    expect(result.applied.t).toBe(2);
    expect(result.notice).toBe("T adjusted to fit this dataset");
  });

  it("hands the scene a view written before positions were places with its version", () => {
    const { scene } = makeScene({ volumeShapes: { [DS]: new Uint32Array([100, 512, 512]) } });
    const imported: string[] = [];
    const importPresence = scene.import_presence.bind(scene);
    scene.import_presence = (json: string) => {
      imported.push(json);
      importPresence(json);
    };
    const view = viewWith({ v: 2, view: { z_range: { start: 7, end: 8 }, t: 0, y: 3 } });

    restoreAnnotationView({ scene, view, datasetId: DS });

    const sent = JSON.parse(imported[0]) as { v: number; view: Record<string, unknown> };
    expect(sent.v).toBe(2);
    expect(sent.view).toEqual({ z_range: { start: 7, end: 8 }, t: 0, y: 3 });
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

// When the pin's dataset can't be resolved (no selection, as from the Mentions
// inbox), the caller passes `datasetId: undefined` and restore passes the
// captured t through rather than clamp it against an unknown dataset.
describe("restoreAnnotationView — null-selection / inbox path", () => {
  it("passes the captured places and t through without a datasetId", () => {
    const { scene, getPresenceView } = makeScene({
      volumeShapes: { "wds-deep": new Uint32Array([340, 4, 6]) },
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z: { start: 200, end: 210 }, t: 3 },
    });

    for (const datasetId of [undefined, null]) {
      const result = restoreAnnotationView({ scene, view, datasetId });
      expect(getPresenceView()).toEqual({ z: { start: 200, end: 210 }, t: 3 });
      expect(result.notice).toBeNull();
    }
  });
});

// "Go to the author's view" must reproduce the author's channel colors and
// contrast, not just global contrast and gamma, while staying inside the light
// boundary: no visibility, opacity, order, layout, open, or broadcast.
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
      view: { z: { start: 5, end: 6 }, t: 0 },
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

    expect(
      calls.find((c) => c.type === "set_dataset_contrast" && c.dataset_id === DS),
    ).toMatchObject({ min: 200, max: 9000 });
    expect(
      calls.find((c) => c.type === "set_dataset_gamma" && c.dataset_id === DS),
    ).toMatchObject({ gamma: 0.8 });
    const colormaps = calls.filter((c) => c.type === "set_channel_colormap" && c.dataset_id === DS);
    expect(colormaps).toContainEqual(
      expect.objectContaining({ channel: 0, colormap: "magenta" }),
    );
    expect(colormaps).toContainEqual(
      expect.objectContaining({ channel: 1, colormap: "green" }),
    );
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
      // The capture references a third dataset that is not loaded here.
      loadedIds: [DS, "wds-loaded-2"],
    });
    const view = viewWith({
      camera: sliceCamera(),
      view: { z: { start: 5, end: 6 }, t: 0 },
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
    // The light path never opens the unloaded dataset.
    expect(colormaps.map((c) => c.colormap)).not.toContain("yellow");
    expect(
      calls.some((c) => c.type === "set_dataset_contrast" && c.dataset_id === "wds-not-loaded"),
    ).toBe(false);
  });

  it("display restore stays inside the LIGHT boundary: NO visibility/opacity/order/layout/open/broadcast", () => {
    const { scene, calls } = makeScene({
      volumeShapes: { [DS]: new Uint32Array([100, 512, 512]), "wds-other": new Uint32Array([2, 8, 8]) },
      loadedIds: [DS, "wds-other"],
    });
    // The author hid, reordered, and relaid out datasets. The light restore
    // reproduces the display but none of the layer placement.
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
    expect(emitted).toContain("set_channel_colormap");
    expect(emitted).toContain("set_dataset_contrast");
    expect(emitted).not.toContain("set_dataset_visible");
    expect(emitted).not.toContain("set_dataset_opacity");
    expect(emitted).not.toContain("set_dataset_order");
    expect(emitted).not.toContain("set_active_layout");
    // The captured `visible: false` for wds-other must not become a
    // dataset-level hide.
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
      view: { z: { start: 5, end: 6 }, t: 1 },
    });

    // Must not throw out of the navigate handler.
    let result!: ReturnType<typeof restoreAnnotationView>;
    expect(() => {
      result = restoreAnnotationView({ scene, view, datasetId: DS });
    }).not.toThrow();

    // The display still applied; positions went with the rejected camera.
    expect(typesOf(calls)).toContain("set_contrast");
    expect(result.applied).toEqual({ t: 1 });
  });
});
