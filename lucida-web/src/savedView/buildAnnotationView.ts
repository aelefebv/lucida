// Snapshots the author's view when they create an annotation, so opening the
// annotation can restore it. The 2D and 3D create paths share this one policy.
//
// The view rides on the annotation in broadcast and persisted document state,
// so it uses `workspace-dataset-id` mode and must never carry source URLs.
// The author's live Z/T/C goes in verbatim through `liveView`, so the view
// matches the pin's own z/t/c rather than a stale presence export.

import type { WasmScene } from "lucida-core";
import { buildCapture } from "./captureBuilder.ts";
import type { SavedView, ViewState } from "./types.ts";

/**
 * The `SavedView` to attach to a new annotation, with no source URLs.
 *
 * @param scene    the live WASM scene (read-only here).
 * @param liveView the author's live Z/T/C, captured verbatim. When omitted,
 *                 `buildCapture` falls back to the scene's presence view.
 * @returns the captured view, or `null` if capture fails, so the create can
 *          still proceed without a view.
 */
export function buildAnnotationView(
  scene: WasmScene,
  liveView?: ViewState,
): SavedView | null {
  try {
    return buildCapture({
      scene,
      // Empty on purpose: this mode never reads it, and a pin's view must not
      // embed source URLs.
      urlByDatasetId: new Map(),
      datasetReferenceMode: "workspace-dataset-id",
      liveView,
    });
  } catch (e) {
    console.warn("[Annotation] view capture failed:", e);
    return null;
  }
}

/**
 * `liveView` for the 3D create path: the presence z slab and `multi_channel`,
 * which 3D drives directly, with the author's live `t`/`c`. Returns `undefined`
 * if presence can't be read, so the create path never throws.
 */
export function liveViewWithLiveTC(
  scene: WasmScene,
  t: number,
  c: number,
): ViewState | undefined {
  try {
    const presence = JSON.parse(scene.export_presence()) as { view: ViewState };
    return { ...presence.view, t, c };
  } catch {
    return undefined;
  }
}

/**
 * `liveView` for the 2D create path, matching `getLiveView` in `App.tsx`: the
 * React slider owns `z`/`t`/`c`, but slab thickness and `multi_channel` come
 * from presence. The slider tracks only `z_range.start`, so `{start: z, end:
 * z + 1}` would drop a multi-plane slab. Returns `undefined` if presence can't
 * be read, so the create path never throws.
 */
export function liveViewWithLiveZTC(
  scene: WasmScene,
  z: number,
  t: number,
  c: number,
): ViewState | undefined {
  try {
    const presence = JSON.parse(scene.export_presence()) as { view: ViewState };
    const r = presence.view?.z_range;
    // A missing or degenerate range falls back to one plane, as in `getLiveView`.
    const thickness = r && r.end > r.start ? r.end - r.start : 1;
    return {
      ...presence.view,
      z_range: { start: z, end: z + thickness },
      t,
      c,
    };
  } catch {
    return undefined;
  }
}
