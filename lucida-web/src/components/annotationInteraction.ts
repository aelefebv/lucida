/**
 * Annotation gesture mechanics: the click-vs-drag slop, tolerant pointer
 * capture, and the one place `move_annotation` is built.
 *
 * Every gesture in every view tests travel against the same threshold, so a
 * press that reads as a click in one view can't read as a drag in another.
 */
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { MoveAnnotationCommand } from "../commands.ts";

/** Max pointer travel (CSS px) for a press and release to count as a click. */
export const PIN_CLICK_SLOP = 4;

/** Whether travel has crossed {@link PIN_CLICK_SLOP}. Travel exactly at the slop
 * is still a click. */
export function exceedsClickSlop(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) > PIN_CLICK_SLOP;
}

/** Capture `pointerId` on `target` so moves and ups land there. Failures are
 * swallowed: happy-dom may lack capture, and a browser can throw on a released
 * pointer. */
export function capturePointer(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture?.(pointerId);
  } catch {
    // capture unsupported; moves and ups still arrive on target
  }
}

/** Release a capture taken by {@link capturePointer}, tolerating one that was
 * never taken. */
export function releasePointer(target: Element, pointerId: number): void {
  try {
    target.releasePointerCapture?.(pointerId);
  } catch {
    // capture may not have been taken
  }
}

/**
 * Apply locally and send one `move_annotation`. With `end` it is a reshape
 * placing both vertices; without, a rigid translate. The backend tells them
 * apart by `end`'s presence.
 *
 * The wire goldens lock field presence and values, not key order.
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
