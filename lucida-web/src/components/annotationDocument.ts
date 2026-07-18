/**
 * The annotation document model as the overlays consume it — the TS shape of
 * one pin (with its nested comment thread) as returned by
 * `WasmScene.annotations(datasetId)`, plus the one authoritative read.
 *
 * Both overlays ({@link AnnotationOverlay} 2D and {@link AnnotationOverlay3D}
 * 3D) — and every module that reasons about a pin (geometry, off-context,
 * participants, mentions inbox) — import the model from here, so "what a pin
 * is" has a single TS definition mirroring `Annotation`/`Comment` in
 * `lucida-core/src/scene/types.rs`. Authoritative state always lives in the
 * WASM scene (populated by `load_document` on snapshot and `apply_command` on
 * broadcast); {@link readAnnotations} is the one snapshot read, and no consumer
 * ever owns a parallel copy.
 */
import type { WasmScene } from "lucida-core";
import type { SavedView } from "../savedView/types.ts";

/** One comment in a pin's thread (as returned nested in `annotations()`). */
export interface Comment {
  id: string;
  author: string;
  text: string;
}

/** One pin, as returned by `WasmScene.annotations()`. `position` is the
 * in-plane world point; `z` is the additive depth, so the pin's full world
 * point is `(position[0], position[1], z)`. */
export interface Annotation {
  id: string;
  position: [number, number];
  /** The second in-plane world vertex: a line's far endpoint or a box's
   * opposite corner. Absent/`null` for a point (and for any slice-1..4 pin). */
  end?: [number, number] | null;
  /** Additive depth. Absent on a slice-1/2 pin → defaulted to 0 on read. */
  z?: number;
  /** The timepoint (T) the pin was placed on. Absent on a pre-slice-14 pin →
   * defaulted to 0 on read. Drives off-context rendering vs the current view. */
  t?: number;
  /** The channel (C) the pin was placed on. Absent on a pre-slice-14 pin →
   * defaulted to 0 on read. Drives off-context rendering vs the current view. */
  c?: number;
  author: string;
  /** "point" | "line" | "box". Absent on a slice-1 pin → treated as "point". */
  kind: string;
  /** Flat, insertion-ordered comment thread. Absent on a slice-1 pin →
   * defaulted to an empty array on read. */
  comments?: Comment[];
  /** The author's captured view at creation — a {@link SavedView} snapshot
   * (camera + slice/timepoint/channel + per-dataset display) in
   * workspace-dataset-id form (empty `datasets`, no source URLs), so a later
   * slice can restore that view on navigation. Absent on any pin created
   * before this slice (and on the wire it is omitted when unset). */
  view?: SavedView | null;
}

/**
 * Imperative seam for opening a pin's thread FROM OUTSIDE an overlay (issue
 * #526, "mentions of me"): `openPinId` is internal overlay state, so a host that
 * wants to jump to a pin (e.g. clicking a "mentions of me" item) needs a clean
 * handle to drive it. The host holds a ref to the overlay and calls
 * `focusPin(pinId)`, which opens that pin's thread AND recenters the view on it.
 *
 * The SAME handle shape is exposed by both the 2D ({@link AnnotationOverlay}) and
 * 3D ({@link AnnotationOverlay3D}) overlays, so the host wires navigation
 * identically for either view — only the recenter MECHANICS differ inside: the
 * 2D overlay moves the slice camera with `set_center`, while the 3D overlay
 * issues `arcball_center_on_voxel` to make the pin's world point the arcball
 * target (a `set_center` would be a no-op on the 3D camera). Either way the host
 * brings the pin on-context first (its Z/T/C) and marks the loop dirty, so the
 * pin is actually visible after the jump in BOTH views.
 */
export interface AnnotationOverlayHandle {
  /** Open `pinId`'s comment thread and recenter the view on it. A no-op (but
   * safe) if the pin isn't in the current set, the overlay is hidden, or the
   * scene isn't ready — so a stale id can never throw or wedge the UI. Resolves
   * only after the pin is available and its scene mutation completes; `false`
   * means the overlay unmounted or a newer request superseded it. */
  focusPin: (pinId: string) => Promise<boolean>;
}

/**
 * The one authoritative snapshot read of a dataset's pin set (with threads)
 * from the WASM scene. Tolerant by design — an unready scene, a scene without
 * the method, or malformed JSON all read as "no pins" rather than throwing, so
 * the overlays can render during bootstrap and teardown without guards at every
 * call site.
 */
export function readAnnotations(scene: WasmScene | null, datasetId: string): Annotation[] {
  if (!scene) return [];
  try {
    const json = scene.annotations(datasetId);
    const parsed = JSON.parse(json) as Annotation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
