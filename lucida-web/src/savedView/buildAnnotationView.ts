// Snapshots the author's CURRENT view at the moment they create an
// annotation, so a later slice can restore it on navigation (slice 1 of the
// annotation-views feature captures + stores this; restore is a later slice).
//
// This is a thin, unit-testable seam over the existing `buildCapture`
// (`./captureBuilder.ts`). It pins the two policy choices a pin's captured
// view requires:
//
//   1. `datasetReferenceMode: "workspace-dataset-id"` — the view is embedded
//      in broadcast/persisted DOCUMENT state (it rides on the annotation), so
//      it must NOT carry dataset source URLs. In this mode `buildCapture`
//      leaves `SavedView.datasets` empty (membership is owned by the workspace
//      document already), so no source URL ever lands on the pin. We therefore
//      also pass an EMPTY `urlByDatasetId` map — it is only consulted on the
//      `source-url` path, which this mode skips.
//   2. the author's live Z/T/C is captured verbatim via `liveView`, so the
//      embedded view's slice/timepoint/channel match the pin's own `z`/`t`/`c`
//      rather than whatever stale value the scene's presence export reports.
//
// Keeping this here (rather than inline in each viewer) means the 2D and 3D
// create paths share ONE capture policy and it can be tested on a mock scene.

import type { WasmScene } from "lucida-core";
import { buildCapture } from "./captureBuilder.ts";
import type { SavedView, ViewState } from "./types.ts";

/**
 * Build the `SavedView` to attach to a freshly-created annotation: a snapshot
 * of how the author is looking at the data right now, in workspace-dataset-id
 * form (no source URLs).
 *
 * @param scene    the live WASM scene (read-only here).
 * @param liveView the author's authoritative live Z/T/C. When provided it is
 *                 captured verbatim (matching the pin's own z/t/c); when
 *                 omitted, `buildCapture` falls back to the scene's presence
 *                 view (still a valid capture — used by the 3D path, whose z
 *                 comes from the picked voxel rather than a React slider).
 * @returns the captured view, or `null` if capture fails (so a create can
 *          still proceed without a view — the field is optional/additive).
 */
export function buildAnnotationView(
  scene: WasmScene,
  liveView?: ViewState,
): SavedView | null {
  try {
    return buildCapture({
      scene,
      // Empty by design: workspace-dataset-id mode never reads it, and a pin's
      // view must not embed source URLs.
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
 * Build a `liveView` for the 3D create path: take the scene's presence z-slab
 * (and `multi_channel`) — which 3D drives directly — but override `t`/`c` with
 * the author's live React values, so the embedded view's timepoint/channel
 * match the pin's own `t`/`c`.
 *
 * Returns `undefined` (so {@link buildAnnotationView} falls back to the raw
 * presence view) if presence can't be read — a best-effort capture, never a
 * throw on the create path.
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
 * Build a `liveView` for the **2D create path**, matching the canonical
 * `getLiveView` shape used by "Save view" (`App.tsx`): the React slider is the
 * source of truth for `z`/`t`/`c`, but the slab THICKNESS and `multi_channel`
 * come from the scene's presence (a 2D slider only tracks `z_range.start`, so a
 * naive `{start: z, end: z + 1}` would silently drop a multi-plane slab and
 * multi-channel mode). We take the presence view, then override
 * `z_range = {start: z, end: z + thickness}`, `t`, `c` — so a 2D pin captured
 * with multi-channel on, or with a multi-plane slab, records them faithfully.
 *
 * Returns `undefined` (so {@link buildAnnotationView} falls back to the raw
 * presence view) if presence can't be read — a best-effort capture, never a
 * throw on the create path.
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
    // Preserve the presence slab thickness; fall back to a single plane if the
    // presence range is missing/degenerate (mirrors `getLiveView`).
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
