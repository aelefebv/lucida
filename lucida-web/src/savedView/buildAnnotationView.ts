// Snapshots the author's view when they create an annotation, so opening the
// annotation can restore it. The 2D and 3D create paths share this one policy.
//
// The view rides on the annotation in broadcast and persisted document state,
// so it uses `workspace-dataset-id` mode and must never carry source URLs.

import type { WasmScene } from "lucida-core";
import { buildCapture } from "./captureBuilder.ts";
import type { SavedView } from "./types.ts";

/**
 * The `SavedView` to attach to a new annotation, with no source URLs.
 *
 * @param scene the live WASM scene (read-only here), which holds the author's
 *              z, t, and c as they see them.
 * @returns the captured view, or `null` if capture fails, so the create can
 *          still proceed without a view.
 */
export function buildAnnotationView(scene: WasmScene): SavedView | null {
  try {
    // A pin restores how its author looked, never where datasets sit, which
    // the document holds; a view without the record leaves placement alone.
    // Opening a pin steers the active view and leaves the layout, so its
    // view keeps the active view's camera alone.
    const { user_transforms: _placement, views: _views, ...view } = buildCapture({
      scene,
      // Empty on purpose: this mode never reads it, and a pin's view must not
      // embed source URLs.
      urlByDatasetId: new Map(),
      datasetReferenceMode: "workspace-dataset-id",
    });
    return view;
  } catch (e) {
    console.warn("[Annotation] view capture failed:", e);
    return null;
  }
}
