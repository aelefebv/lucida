/**
 * Shared annotation gesture mechanics: the ONE click-vs-drag slop threshold,
 * the tolerant pointer-capture helpers, and the single construction site for
 * the `move_annotation` command every move/reshape gesture emits.
 *
 * Every annotation gesture in every view answers "did the pointer really
 * travel?" against the SAME threshold: dropping a pin (SliceViewer /
 * VolumeViewer), moving one, and reshaping a box corner or line endpoint
 * (AnnotationOverlay / AnnotationOverlay3D). Keeping the threshold and its
 * comparison here means a press that reads as a click in one view can never
 * read as a drag in another.
 */
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { MoveAnnotationCommand } from "../commands.ts";

/** Max pointer travel (CSS px) for a press+release to count as a click, not a
 * drag. Shared by every annotation gesture — pin drop, pin move, shape draw,
 * and handle reshape — in both the 2D and 3D views. */
export const PIN_CLICK_SLOP = 4;

/** Whether pointer travel from `(startX, startY)` to `(x, y)` (CSS px) has
 * crossed {@link PIN_CLICK_SLOP} — i.e. the press is a real drag, no longer a
 * click. Travel exactly AT the slop is still a click (the comparison is
 * strictly greater), so the boundary is identical at every call site. */
export function exceedsClickSlop(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) > PIN_CLICK_SLOP;
}

/** Bind `pointerId` to `target` so the rest of the gesture (move/up) lands
 * there even if the pointer slides off. Pointer capture is a progressive
 * enhancement — happy-dom may lack it, and a real browser can throw on an
 * already-released pointer — so failures are swallowed: moves/ups still arrive
 * on the target in the environments that lack capture. */
export function capturePointer(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture?.(pointerId);
  } catch {
    // capture unsupported (e.g. test env) — moves/ups still arrive on target
  }
}

/** Release a capture taken by {@link capturePointer}, tolerating environments
 * where it was never taken (or the API is missing). */
export function releasePointer(target: Element, pointerId: number): void {
  try {
    target.releasePointerCapture?.(pointerId);
  } catch {
    // ignore — capture may not have been taken
  }
}

/**
 * Apply-locally-and-send exactly one `move_annotation` — the terminal emit of
 * every move/reshape gesture (2D Shift+drag move, 2D corner/edge/endpoint
 * reshape, 3D Shift+drag move). `end` present → a reshape placing BOTH
 * vertices; `end` absent → a rigid whole-shape translate (the backend
 * distinguishes exactly this way).
 *
 * Field order in the constructed literal is load-bearing: `JSON.stringify`
 * preserves it, and the wire goldens byte-lock the envelope — keep
 * `type, dataset_id, id, position, (end,) z`.
 */
export function emitMoveAnnotation(
  scene: WasmScene,
  args: {
    datasetId: string;
    id: string;
    position: [number, number];
    end?: [number, number];
    z: number;
  },
  sendCommand: (json: string) => void,
): void {
  const cmd: MoveAnnotationCommand = args.end
    ? {
        type: "move_annotation",
        dataset_id: args.datasetId,
        id: args.id,
        position: args.position,
        end: args.end,
        z: args.z,
      }
    : {
        type: "move_annotation",
        dataset_id: args.datasetId,
        id: args.id,
        position: args.position,
        z: args.z,
      };
  applyDocumentCommand(scene, cmd, sendCommand);
}
