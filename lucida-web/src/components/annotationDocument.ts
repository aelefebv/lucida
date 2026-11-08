/**
 * The TS shape of a pin and its comment thread, mirroring `Annotation` and
 * `Comment` in `lucida-core/src/scene/types.rs`.
 *
 * Authoritative state lives in the WASM scene. {@link readAnnotations} is the
 * one snapshot read; no consumer keeps a parallel copy.
 */
import type { WasmScene } from "lucida-core";
import type { SavedView } from "../savedView/types.ts";

/** One comment in a pin's thread. */
export interface Comment {
  id: string;
  author: string;
  text: string;
}

/** One pin. The full world point is `(position[0], position[1], z)`. Optional
 * fields may be absent on older documents and default on read. */
export interface Annotation {
  id: string;
  position: [number, number];
  /** A line's far endpoint or a box's opposite corner; absent for a point. */
  end?: [number, number] | null;
  /** Additive depth; defaults to 0. */
  z?: number;
  /** Timepoint the pin was placed on; defaults to 0. Drives off-context
   * rendering. */
  t?: number;
  /** A channel the pin's layer showed at placement; defaults to 0. Read only
   * for a pin without `channels`. */
  c?: number;
  /** Every channel the pin's layer showed at placement, as the scene derives
   * them from the pin's view. Drives off-context rendering. Added by
   * `scene.annotations()`, never on the document wire. */
  channels?: number[];
  author: string;
  /** "point" | "line" | "box"; absent reads as "point". */
  kind: string;
  /** Flat, insertion-ordered thread; defaults to empty. */
  comments?: Comment[];
  /** The author's view at creation, in workspace-dataset-id form (empty
   * `datasets`, no source URLs). Omitted on the wire when unset. */
  view?: SavedView | null;
}

/**
 * Lets a host open a pin's thread from outside an overlay, since `openPinId` is
 * internal overlay state. Both overlays expose it; `focusPin` opens the thread
 * and recenters. The 3D overlay recenters with `arcball_center_on_voxel`
 * because `set_center` is a no-op on the 3D camera.
 */
export interface AnnotationOverlayHandle {
  /** Open `pinId`'s thread and recenter on it. A safe no-op if the pin isn't in
   * the set, the overlay is hidden, or the scene isn't ready. */
  focusPin: (pinId: string) => void;
  /** Open the canvas menu at a client point, as a long press on the canvas
   * does. */
  openContextMenu: (at: { clientX: number; clientY: number }) => void;
}

/**
 * Read a dataset's pins from the WASM scene. An unready scene or bad JSON reads
 * as no pins, so overlays render through bootstrap and teardown unguarded.
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
