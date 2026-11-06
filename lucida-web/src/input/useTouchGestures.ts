import { useEffect, useRef } from "react";
import { capturePointer } from "../components/annotationInteraction.ts";
import type { ClientPoint } from "../components/cameraProjection.ts";
import { GestureRecognizer, type Gesture, type PointerSample } from "./gestures.ts";

/** A gesture's position as the client point it was fed as. */
export function clientPoint(g: { x: number; y: number }): ClientPoint {
  return { clientX: g.x, clientY: g.y };
}

export interface TouchGestureHandlers {
  /** Whether a fresh one-finger gesture is the caller's to draw with, asked as
   * the finger lands. A claimed finger arrives as press gestures. */
  claimsPress: () => boolean;
  onGesture: (gesture: Gesture) => void;
}

/**
 * Feeds the element's touch pointers to a {@link GestureRecognizer} and hands
 * back its gestures. Mouse and pen events pass by untouched, so the viewer's
 * own pointer handlers keep them, and those handlers skip touch.
 */
export function useTouchGestures(element: HTMLElement, enabled: boolean, handlers: TouchGestureHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const recognizer = new GestureRecognizer();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const emit = (gestures: readonly Gesture[]) => {
      for (const gesture of gestures) handlersRef.current.onGesture(gesture);
      clearTimeout(timer);
      const deadline = recognizer.nextDeadline();
      if (deadline === null) return;
      // Every input reschedules, so a timer that runs found nothing changed
      // since it was set, and its deadline holds even if it ran a little early.
      timer = setTimeout(() => emit(recognizer.tick(Math.max(performance.now(), deadline))), deadline - performance.now());
    };
    const sample = (e: PointerEvent): PointerSample => ({ id: e.pointerId, x: e.clientX, y: e.clientY, time: performance.now() });

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      capturePointer(element, e.pointerId);
      emit(recognizer.down(sample(e), { press: handlersRef.current.claimsPress() }));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") emit(recognizer.move(sample(e)));
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") emit(recognizer.up(sample(e)));
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerType === "touch") emit(recognizer.cancel(sample(e)));
    };
    // A long press on a touch screen also opens the browser's own menu.
    const onContextMenu = (e: MouseEvent) => {
      if ((e as PointerEvent).pointerType === "touch" || recognizer.active) e.preventDefault();
    };

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onCancel);
    element.addEventListener("contextmenu", onContextMenu);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onCancel);
      element.removeEventListener("contextmenu", onContextMenu);
    };
  }, [element, enabled]);
}
