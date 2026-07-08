// The LIGHT, in-session restore of an annotation's captured view (slice 2 of
// the annotation-views feature). This is the explicit-navigation tier: clicking
// an @mention / a "go to annotation" / a pin thread's "Go to author's view"
// restores the view the author had when they dropped the pin — camera (incl.
// switching 2D<->3D camera MODE to match), z-slab/t/c, and display
// (contrast/gamma/colormap-bearing display state).
//
// WHY A SEPARATE PATH FROM `SavedViewApplier.apply` (the HEAVY tier):
//   The heavy applier OPENS datasets, HIDES every loaded dataset not in the
//   view (`set_dataset_visible(false)`), BROADCASTS a shared layout change
//   (`set_active_layout`), and reorders datasets. That is correct for a COLD
//   share-link open (the next slice), where the recipient's scene must be
//   rebuilt to match the link. It is WRONG for an in-session jump to a pin: the
//   user is already looking at their workspace and only wants the camera + slice
//   + contrast to match the author — yanking other datasets away or mutating the
//   shared document would be destructive and surprising.
//
//   So this module is deliberately NARROW. It issues ONLY recipient-local
//   ViewportCommands (the same seam the existing gentle navigate uses):
//   `set_z`/`set_t`/`set_c`/`set_z_range`, `set_contrast`/`set_gamma`/
//   `set_multi_channel`, the per-dataset/per-channel DISPLAY commands
//   (`set_dataset_contrast`/`set_channel_colormap`/… — recipient-local, reused
//   from the heavy applier via `datasetDisplayCommands`, NOT forked), the
//   camera-mode switch, and the camera itself (via `import_presence`). It NEVER
//   calls `bridge.sendCommand`, NEVER emits `set_dataset_visible`/
//   `set_dataset_opacity`/`set_active_layout`/`set_dataset_order`, and NEVER
//   opens a dataset. The light/heavy boundary is enforced HERE, by construction:
//   the destructive commands simply have no call site in this file.
//
// DISPLAY FIDELITY: lucida's headline data is multi-channel, so "go to the
// author's view" must reproduce the author's per-CHANNEL colors/contrast, not
// just the global contrast/gamma. We therefore replay the captured
// `dataset_settings` (per-channel colormap/contrast/gamma + per-dataset
// contrast/gamma/blend) for the datasets that are LOADED — but ONLY the display
// fields (no visibility/opacity/order/layout), so the recipient's workspace
// layout is never disturbed.
//
// GRACEFUL DEGRADE: the captured z/t/c is clamped to the pin's OWN dataset
// extents via the shared `clampViewIndices` (reused, not forked) so a view
// authored against deeper/multichannel data still lands on a valid plane; when
// the clamp moves an axis the caller surfaces a non-blocking notice. The pin's
// dataset ends up on-context regardless. When the pin's dataset id can't be
// resolved (the null-selection / inbox window), the clamp is SKIPPED — the
// captured z/t/c pass through unchanged rather than collapsing against the WASM
// `[1,1,1]` sentinel (the #814 regression class).

import type { WasmScene } from "lucida-core";
import type { ViewportCommand } from "../commands.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import { clampViewIndices, clampNotice, datasetDisplayCommands } from "./applier.ts";
import type { DimensionExtentsResolver } from "./applier.ts";
import type { Camera, DatasetId, SavedView } from "./types.ts";

/** Apply one viewport/display command locally (never sent to peers). Kept inline
 * (rather than importing `applyViewportCommand`) so this module's surface is
 * obviously local-only and self-contained; identical behavior. */
function applyLocal(scene: WasmScene, cmd: ViewportCommand): void {
  guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
}

/** The view-mode a captured camera implies: a `slice` camera is the 2D view;
 * an `arcball`/`fly` camera is the 3D view. */
export function viewModeForCamera(camera: Camera): "2d" | "3d" {
  return camera.mode === "slice" ? "2d" : "3d";
}

/** The scene camera-mode string (`scene.camera_mode()`) a captured camera
 * implies. `slice` stays slice; a 3D camera keeps its specific kind
 * (arcball/fly) so restoring an author's fly view doesn't silently downgrade to
 * arcball. */
function sceneModeForCamera(camera: Camera): "slice" | "arcball" | "fly" {
  return camera.mode;
}

/** Switch the live scene's camera MODE to match the captured camera, BEFORE the
 * camera shape is imported and before the caller focuses the pin. Returns the
 * outcome so the caller can (a) mirror React `viewMode` state and (b) defer the
 * overlay focus until the correct overlay (2D vs 3D) has mounted.
 *
 * Issued as a local ViewportCommand — the same `set_mode_*` the view-mode toggle
 * uses — never broadcast. A no-op when the live mode already matches. */
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
    // Scene can't report its mode (test stub / not ready): treat as a change so
    // the mode command still fires and the caller still re-targets the view.
    current = null;
  }
  if (current === targetSceneMode) {
    return { changed: false, viewMode };
  }
  // `set_mode_slice` / `set_mode_arcball` / `set_mode_fly` — the same commands
  // the view-mode + camera-mode toggles emit. Local only.
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

/** A minimal single-dataset SavedView addressing `datasetId` with the captured
 * view's z/t/c, used to drive `clampViewIndices` against the PIN'S OWN dataset
 * extents. Building this (rather than passing the original captured view, whose
 * `dataset_order` may reference the author's other datasets, or an empty view,
 * which makes the clamp fall back to "all loaded") keeps the clamp scoped to the
 * one volume the pin lives on. */
function singleDatasetView(view: SavedView, datasetId: DatasetId): SavedView {
  return {
    ...view,
    datasets: [],
    dataset_order: [datasetId],
    // No per-dataset settings → `visibleAddressedDatasetIds` treats it visible,
    // so the clamp scans exactly this dataset's extents.
    dataset_settings: {},
    active_layouts: {},
  };
}

export interface RestoreResult {
  /** Whether the camera MODE was switched (2D<->3D) as part of the restore. */
  cameraModeChanged: boolean;
  /** The view-mode the restored camera implies — the caller mirrors this into
   *  React `viewMode` (and uses it to pick which overlay to focus). */
  viewMode: "2d" | "3d";
  /** The clamped z-slab/t/c actually applied (post-clamp). */
  applied: { zStart: number; zEnd: number; t: number; c: number };
  /** A non-blocking notice when the captured z/t/c had to be clamped to fit the
   *  pin's dataset, naming the moved axes; null when nothing was adjusted. */
  notice: string | null;
}

export interface RestoreAnnotationViewParams {
  scene: WasmScene;
  /** The author's captured view (from `annotation.view`). */
  view: SavedView;
  /** The pin's OWN dataset id — the extents the captured z/t/c clamp against,
   *  and the dataset that must end up on-context. Pass `undefined`/`null` when
   *  the pin's dataset can't be resolved (the null-selection / inbox window);
   *  the clamp is then SKIPPED and the captured z/t/c pass through unchanged,
   *  rather than collapsing against the WASM `[1,1,1]` sentinel that
   *  `dataset_volume_shape("")` returns (the #814 regression class). */
  datasetId?: DatasetId | null;
  /** Resolves the recipient's per-dataset T/C extents (Z comes from the scene's
   *  volume shape). Optional — omit to leave t/c unclamped (as the heavy applier
   *  does without it). */
  dimensionExtentsFor?: DimensionExtentsResolver;
}

/**
 * Perform the LIGHT restore of `view` against the live scene, scoped to the
 * pin's own dataset. Order mirrors the heavy applier's tail (display, then
 * z/t/c, then camera) MINUS every destructive/document step:
 *
 *   1. Switch camera MODE (2D<->3D) to match the captured camera. (Done first so
 *      a later `import_presence` of, say, an arcball camera isn't applied while
 *      the scene is still in slice mode.)
 *   2. Display: global contrast + gamma (+ multi_channel when captured), THEN
 *      the captured per-dataset / per-channel display (colormap/contrast/gamma)
 *      for the datasets that are LOADED — display fields only, no
 *      visibility/opacity/order/layout.
 *   3. z-slab / t / c, clamped to the pin's dataset extents (graceful degrade).
 *      The clamp is SKIPPED when `datasetId` is absent (see below).
 *   4. Camera shape, via `import_presence` (the same one-mutator path the heavy
 *      applier uses) so the camera is restored atomically with the live view.
 *
 * Returns the applied indices, whether the mode flipped, the resolved view-mode,
 * and a clamp notice (or null). The caller owns recentering on the pin (via the
 * overlay's `focusPin`) AFTER this — restore positions the camera at the
 * author's framing; focus then guarantees the pin itself is centered/on-screen.
 */
export function restoreAnnotationView({
  scene,
  view,
  datasetId,
  dimensionExtentsFor,
}: RestoreAnnotationViewParams): RestoreResult {
  // 1. Camera MODE first (2D<->3D), before anything reads/writes the camera.
  const mode = switchCameraMode(scene, view.camera);

  // 2a. Display — global contrast/gamma. multi_channel only when the capture
  // recorded it.
  applyLocal(scene, {
    type: "set_contrast",
    min: view.display.contrast_min,
    max: view.display.contrast_max,
  });
  applyLocal(scene, { type: "set_gamma", gamma: view.display.gamma });
  if (view.view.multi_channel !== undefined) {
    applyLocal(scene, { type: "set_multi_channel", enabled: view.view.multi_channel });
  }

  // 2b. Per-dataset / per-channel display — reproduce the author's channel
  // colors/contrast for multi-channel data (lucida's headline type). Replay the
  // captured `dataset_settings` DISPLAY fields (via the shared
  // `datasetDisplayCommands`, never `set_dataset_visible`/`set_dataset_opacity`)
  // for the datasets that are LOADED. The pin's own dataset goes first so its
  // channel display always wins even when other captured datasets are clean too.
  restoreDatasetDisplay(scene, view, datasetId);

  // 3. z/t/c — clamp to the PIN'S dataset extents. When `datasetId` is absent
  // (the pin's dataset couldn't be resolved — the null-selection / inbox
  // window), SKIP the clamp entirely: pass the captured z/t/c through unchanged
  // rather than collapsing them against the WASM `[1,1,1]` sentinel that
  // `dataset_volume_shape("")` returns. Otherwise build a minimal single-dataset
  // view so the clamp scans exactly this dataset (never the empty-view "all
  // loaded" fallback, and never the author's other datasets).
  const clamped = datasetId
    ? clampViewIndices(
        scene,
        [{ url: "", id: datasetId }],
        singleDatasetView(view, datasetId),
        dimensionExtentsFor,
      )
    : {
        t: view.view.t,
        c: view.view.c,
        zStart: view.view.z_range.start,
        zEnd: view.view.z_range.end,
        clamped: false,
        adjustedAxes: [] as readonly string[],
      };
  applyLocal(scene, { type: "set_t", t: clamped.t });
  applyLocal(scene, { type: "set_c", c: clamped.c });
  applyLocal(scene, {
    type: "set_z_range",
    start: clamped.zStart,
    end: clamped.zEnd,
  });

  // 4. Camera shape last, via import_presence (read live presence, overwrite
  // only the camera, write back) — exactly the heavy applier's `importCameraView`
  // approach, so the WASM side reapplies camera atomically and keeps the local
  // viewport. View + display were already applied step-by-step above.
  importCameraOnly(scene, view.camera);

  return {
    cameraModeChanged: mode.changed,
    viewMode: mode.viewMode,
    applied: { zStart: clamped.zStart, zEnd: clamped.zEnd, t: clamped.t, c: clamped.c },
    notice: clamped.clamped ? clampNotice(clamped.adjustedAxes) : null,
  };
}

/** Replay the captured per-dataset / per-channel DISPLAY (colormap, contrast,
 * gamma, blend, render mode, detail level) for the LOADED datasets — the
 * fidelity half of "go to the author's view" for multi-channel data. Strictly
 * local + display-only: it emits the shared `datasetDisplayCommands`, which
 * EXCLUDE `set_dataset_visible`/`set_dataset_opacity`, so layer placement is
 * untouched. The pin's own dataset (when resolved + captured) is applied first
 * so its channel display is authoritative; other captured datasets follow only
 * if they're loaded. Datasets in the capture that aren't loaded are skipped (we
 * never open one on the light path). Best-effort: an unreadable loaded-set
 * leaves display alone rather than throwing on the navigate path. */
function restoreDatasetDisplay(
  scene: WasmScene,
  view: SavedView,
  pinDatasetId?: DatasetId | null,
): void {
  const settings = view.dataset_settings;
  if (!settings || Object.keys(settings).length === 0) return;

  // Which captured datasets are actually loaded right now? We only restore
  // display for loaded datasets (the light path never opens one).
  let loaded: Set<string>;
  try {
    loaded = new Set<string>(JSON.parse(scene.dataset_ids()) as string[]);
  } catch {
    // Loaded set unreadable (test stub / scene not ready): skip display restore
    // rather than throw on the navigate path.
    return;
  }

  // Apply the pin's own dataset first (authoritative), then any other captured
  // datasets that are loaded — each at most once, display fields only.
  const seen = new Set<string>();
  const order: string[] = [];
  if (pinDatasetId && settings[pinDatasetId]) order.push(pinDatasetId);
  for (const id of Object.keys(settings)) order.push(id);

  for (const id of order) {
    if (seen.has(id) || !loaded.has(id)) continue;
    seen.add(id);
    for (const cmd of datasetDisplayCommands(id, settings[id])) {
      applyLocal(scene, cmd);
    }
  }
}

/** Import only the camera shape, preserving the live view/display in presence.
 * Mirrors `SavedViewApplier.importCameraView`; kept local so the light path has
 * no dependency on the heavy applier instance.
 *
 * Hardened: BOTH the presence read AND the write-back are guarded, so a
 * malformed captured camera (an `import_presence` the WASM side rejects, e.g. a
 * 3D camera with NaN/missing fields) degrades gracefully — the camera is
 * skipped, the rest of the restore (mode/display/z/t/c, already applied) stands
 * — rather than throwing out of the navigate handler. */
function importCameraOnly(scene: WasmScene, camera: Camera): void {
  let presence: { camera: Camera; view: unknown; display: unknown };
  try {
    presence = JSON.parse(scene.export_presence()) as {
      camera: Camera;
      view: unknown;
      display: unknown;
    };
  } catch {
    // Presence unreadable (test stub without export_presence): nothing to merge
    // into; skip the camera import rather than throw on the navigate path.
    return;
  }
  presence.camera = camera;
  try {
    guardedSceneCall("import_presence", scene, () => scene.import_presence(JSON.stringify(presence)));
  } catch (e) {
    // A bad captured camera (rejected by the WASM presence importer): keep the
    // already-applied mode/display/z/t/c and skip the camera, instead of
    // throwing out of the navigate handler.
    console.warn("[Annotation] camera restore skipped (invalid captured camera):", e);
  }
}
