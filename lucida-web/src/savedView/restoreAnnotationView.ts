// The light, in-session restore of an annotation's captured view: camera
// (including 2D/3D mode), z-slab/t, and display, scoped to the pin's dataset.
//
// This is separate from `SavedViewApplier.apply` on purpose. The heavy applier
// opens, hides, and reorders datasets and broadcasts layout changes, which suits
// a cold share-link open but would wreck the user's workspace on an in-session
// jump. This module issues only recipient-local ViewportCommands, so the
// destructive commands have no call site here.

import type { WasmScene } from "lucida-core";
import type { ViewportCommand } from "../commands.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import { clampViewIndices, clampNotice, datasetDisplayCommands } from "./applier.ts";
import type { DimensionExtentsResolver, LabelNamesResolver } from "./applier.ts";
import type { Camera, CameraSpace, DatasetId, SavedView } from "./types.ts";

/** Apply one command locally, never sent to peers. Inlined rather than importing
 * `applyViewportCommand` so the module is visibly local-only. */
function applyLocal(scene: WasmScene, cmd: ViewportCommand): void {
  guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
}

/** A `slice` camera means the 2D view; `arcball` or `fly` means 3D. */
export function viewModeForCamera(camera: Camera): "2d" | "3d" {
  return camera.mode === "slice" ? "2d" : "3d";
}

/** A 3D camera keeps its kind, so restoring a fly view doesn't downgrade it to
 * arcball. */
function sceneModeForCamera(camera: Camera): "slice" | "arcball" | "fly" {
  return camera.mode;
}

/** Switch the scene's camera mode to match the captured camera, locally, before
 * the camera shape is imported. The caller uses the result to mirror React
 * `viewMode` and to defer pin focus until the right overlay has mounted. No-op
 * when the mode already matches. */
export function switchCameraMode(
  scene: WasmScene,
  camera: Camera,
): { changed: boolean; viewMode: "2d" | "3d" } {
  const targetSceneMode = sceneModeForCamera(camera);
  const viewMode = viewModeForCamera(camera);
  let current: string | null = null;
  try {
    current = scene.camera_mode();
  } catch {
    // The scene can't report its mode (test stub, not ready): treat it as a
    // change so the mode command still fires.
    current = null;
  }
  if (current === targetSceneMode) {
    return { changed: false, viewMode };
  }
  applyLocal(scene, {
    type:
      targetSceneMode === "slice"
        ? "set_mode_slice"
        : targetSceneMode === "fly"
          ? "set_mode_fly"
          : "set_mode_arcball",
  });
  return { changed: true, viewMode };
}

/** The captured view narrowed to `datasetId`, so `clampViewIndices` scans only
 * the pin's dataset. The original view may address the author's other datasets,
 * and an empty view makes the clamp fall back to every loaded dataset. */
function singleDatasetView(view: SavedView, datasetId: DatasetId): SavedView {
  return {
    ...view,
    datasets: [],
    dataset_order: [datasetId],
    // No settings means `visibleAddressedDatasetIds` treats the dataset as visible.
    dataset_settings: {},
    active_layouts: {},
  };
}

export interface RestoreResult {
  cameraModeChanged: boolean;
  /** The caller mirrors this into React `viewMode` and uses it to pick which
   *  overlay to focus. */
  viewMode: "2d" | "3d";
  /** The z-slab/t actually applied, after clamping. */
  applied: { zStart: number; zEnd: number; t: number };
  /** A non-blocking notice when the captured z/t had to be clamped to fit the
   *  pin's dataset, naming the moved axes; null when nothing was adjusted. */
  notice: string | null;
}

export interface RestoreAnnotationViewParams {
  scene: WasmScene;
  /** The author's captured view, from `annotation.view`. */
  view: SavedView;
  /** The pin's dataset, whose extents z/t clamp against. Pass null when it
   *  can't be resolved: the clamp is then skipped, because
   *  `dataset_volume_shape("")` returns a `[1,1,1]` sentinel that would collapse
   *  the captured z/t. */
  datasetId?: DatasetId | null;
  /** The recipient's per-dataset T/C extents (Z comes from the scene's volume
   *  shape). Omit to leave t unclamped. */
  dimensionExtentsFor?: DimensionExtentsResolver;
  /** Restores per-label display by label name and occurrence instead of raw
   *  index. Omit for positional restore. */
  labelNamesFor?: LabelNamesResolver;
}

/**
 * Restore `view` against the live scene: camera mode, display, clamped z/t,
 * then camera shape. This mirrors the heavy applier's tail minus every document
 * step. Mode goes first so an arcball camera is never imported while the scene
 * is in slice mode. The caller focuses the pin afterward, since the author's
 * framing alone doesn't guarantee the pin is on screen.
 */
export function restoreAnnotationView({
  scene,
  view,
  datasetId,
  dimensionExtentsFor,
  labelNamesFor,
}: RestoreAnnotationViewParams): RestoreResult {
  const mode = switchCameraMode(scene, view.camera);

  applyLocal(scene, {
    type: "set_contrast",
    min: view.display.contrast_min,
    max: view.display.contrast_max,
  });
  applyLocal(scene, { type: "set_gamma", gamma: view.display.gamma });

  // Each layer's solo rides its display settings.
  restoreDatasetDisplay(scene, view, datasetId, labelNamesFor);

  // Without a resolved dataset the captured z/t pass through (see `datasetId`).
  const clamped = datasetId
    ? clampViewIndices(
        scene,
        [{ url: "", id: datasetId }],
        singleDatasetView(view, datasetId),
        dimensionExtentsFor,
      )
    : {
        t: view.view.t,
        zStart: view.view.z_range.start,
        zEnd: view.view.z_range.end,
        clamped: false,
        adjustedAxes: [] as readonly string[],
      };
  applyLocal(scene, { type: "set_t", t: clamped.t });
  applyLocal(scene, {
    type: "set_z_range",
    start: clamped.zStart,
    end: clamped.zEnd,
  });

  importCameraOnly(scene, view);

  return {
    cameraModeChanged: mode.changed,
    viewMode: mode.viewMode,
    applied: { zStart: clamped.zStart, zEnd: clamped.zEnd, t: clamped.t },
    notice: clamped.clamped ? clampNotice(clamped.adjustedAxes) : null,
  };
}

/** Replay the captured per-dataset and per-channel display for loaded datasets,
 * so multi-channel colors match the author's. `datasetDisplayCommands` excludes
 * visibility and opacity, so layer placement is untouched. Unloaded datasets are
 * skipped because the light path never opens one. The pin's dataset goes first
 * so its display wins. */
function restoreDatasetDisplay(
  scene: WasmScene,
  view: SavedView,
  pinDatasetId?: DatasetId | null,
  labelNamesFor?: LabelNamesResolver,
): void {
  const settings = view.dataset_settings;
  if (!settings || Object.keys(settings).length === 0) return;

  let loaded: Set<string>;
  try {
    loaded = new Set<string>(JSON.parse(scene.dataset_ids()) as string[]);
  } catch {
    // Unreadable (test stub, scene not ready): skip rather than throw on the
    // navigate path.
    return;
  }

  const seen = new Set<string>();
  const order: string[] = [];
  if (pinDatasetId && settings[pinDatasetId]) order.push(pinDatasetId);
  for (const id of Object.keys(settings)) order.push(id);

  for (const id of order) {
    if (seen.has(id) || !loaded.has(id)) continue;
    seen.add(id);
    for (const cmd of datasetDisplayCommands(id, settings[id], labelNamesFor?.(id))) {
      applyLocal(scene, cmd);
    }
  }
}

/** Import only the camera shape, with the spaces it was saved in, keeping the
 * live view and display in presence. Mirrors `importCameraView` in
 * `applier.ts` without needing an applier instance. A camera the WASM importer
 * rejects is skipped so the rest of the restore stands, instead of throwing out
 * of the navigate handler. */
function importCameraOnly(
  scene: WasmScene,
  { camera, camera_space }: Pick<SavedView, "camera" | "camera_space">,
): void {
  let presence: { camera: Camera; view: unknown; display: unknown; camera_space?: CameraSpace };
  try {
    presence = JSON.parse(scene.export_presence()) as {
      camera: Camera;
      view: unknown;
      display: unknown;
    };
  } catch {
    // No presence to merge into (test stub): skip the camera.
    return;
  }
  presence.camera = camera;
  presence.camera_space = camera_space;
  try {
    guardedSceneCall("import_presence", scene, () => scene.import_presence(JSON.stringify(presence)));
  } catch (e) {
    console.warn("[Annotation] camera restore skipped (invalid captured camera):", e);
  }
}
