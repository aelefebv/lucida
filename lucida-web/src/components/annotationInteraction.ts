/**
 * Annotation gesture mechanics: the click-vs-drag slop, tolerant pointer
 * capture, handing a press to the canvas, canvas taps, and the one place
 * `move_annotation` is built.
 *
 * Every gesture in every view tests travel against the same threshold, so a
 * press that reads as a click in one view can't read as a drag in another.
 */
import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { MoveAnnotationCommand } from "../commands.ts";
import { LONG_PRESS_MS, TOUCH_SLOP } from "../input/gestures.ts";
import type { ClientPoint } from "./cameraProjection.ts";

/** Max pointer travel (CSS px) for a press and release to count as a click. */
export const PIN_CLICK_SLOP = 4;

/** Whether travel has crossed {@link PIN_CLICK_SLOP}. Travel exactly at the slop
 * is still a click. */
export function exceedsClickSlop(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) > PIN_CLICK_SLOP;
}

/** {@link exceedsClickSlop}, but a finger gets the canvas's wider touch slop,
 * since a fingertip wobbles more than a mouse. */
export function exceedsPressSlop(
  pointerType: string,
  startX: number,
  startY: number,
  x: number,
  y: number,
): boolean {
  const slop = pointerType === "touch" ? TOUCH_SLOP : PIN_CLICK_SLOP;
  return Math.hypot(x - startX, y - startY) > slop;
}

/** Runs `onFire` once a touch press has been held for a long press; the
 * returned function cancels it. */
export function startLongPress(onFire: () => void): () => void {
  const timer = setTimeout(onFire, LONG_PRESS_MS);
  return () => clearTimeout(timer);
}

/**
 * Hand a press that began on a marker to the canvas beneath: move the capture
 * and replay the pointerdown from the press point, so the canvas's own
 * navigation, or for a finger its gesture recognizer, takes the drag from where
 * it started.
 */
export function forwardPressToCanvas(
  from: Element,
  canvas: HTMLCanvasElement,
  press: { pointerId: number; pointerType: string; startX: number; startY: number },
  buttons: number,
): void {
  releasePointer(from, press.pointerId);
  // Without capture support (test env), the canvas listeners still get the
  // dispatched event below.
  capturePointer(canvas, press.pointerId);
  try {
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: press.pointerId,
        pointerType: press.pointerType,
        isPrimary: true,
        button: 0,
        buttons,
        clientX: press.startX,
        clientY: press.startY,
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      }),
    );
  } catch {
    // No PointerEvent constructor (non-browser env): the drag won't navigate.
  }
}

/** A press and release on the canvas that neither travelled nor held long. */
export interface CanvasTap extends ClientPoint {
  pointerType: string;
  shiftKey: boolean;
}

/**
 * Calls `onTap` for each tap or primary click on the canvas. A second pointer
 * spoils it, so a pinch or a two-finger tap never counts, and so does a touch
 * held into a long press.
 */
export function useCanvasTaps(canvas: HTMLElement, onTap: (tap: CanvasTap) => void): void {
  const onTapRef = useRef(onTap);
  useEffect(() => {
    onTapRef.current = onTap;
  });
  useEffect(() => {
    const down = new Set<number>();
    let press: (CanvasTap & { pointerId: number; time: number }) | null = null;
    const onDown = (e: PointerEvent) => {
      down.add(e.pointerId);
      press =
        down.size === 1 && e.button === 0
          ? {
              pointerId: e.pointerId,
              clientX: e.clientX,
              clientY: e.clientY,
              pointerType: e.pointerType,
              shiftKey: e.shiftKey,
              time: performance.now(),
            }
          : null;
    };
    const onUp = (e: PointerEvent) => {
      down.delete(e.pointerId);
      const tap = press;
      if (!tap || tap.pointerId !== e.pointerId) return;
      press = null;
      if (exceedsPressSlop(tap.pointerType, tap.clientX, tap.clientY, e.clientX, e.clientY)) return;
      if (tap.pointerType === "touch" && performance.now() - tap.time >= LONG_PRESS_MS) return;
      onTapRef.current({ clientX: tap.clientX, clientY: tap.clientY, pointerType: tap.pointerType, shiftKey: tap.shiftKey });
    };
    const onCancel = (e: PointerEvent) => {
      down.delete(e.pointerId);
      press = null;
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
    };
  }, [canvas]);
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
