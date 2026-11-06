/** How long a finger rests on a control before its tooltip shows. */
export const LONG_PRESS_MS = 500;
/** How long the tooltip stays after the finger lifts. */
export const REVEAL_LINGER_MS = 1500;
/** A finger that moves further than this is scrolling, not pressing. */
const MOVE_TOLERANCE_PX = 10;

/**
 * Calls `reveal` when a finger rests on `element`, and `hide` a moment after
 * it lifts. The press that would have activated the control is cancelled, so
 * a long press only shows the name. Mouse and pen are ignored: they hover.
 * Returns a function that stops watching.
 */
export function watchLongPress(element: HTMLElement, reveal: () => void, hide: () => void): () => void {
  let press: { id: number; x: number; y: number } | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  let revealed = false;
  let cancelling = false;

  // Lifting the finger still sends a click, which would activate the control.
  // Stopping it here, at the target, keeps it from React's root listener.
  const swallowClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const noContextMenu = (event: Event) => event.preventDefault();

  const endPress = () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
    press = null;
    element.removeEventListener("contextmenu", noContextMenu);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    endPress();
    clearTimeout(lingerTimer);
    if (revealed) {
      revealed = false;
      hide();
    }
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    // Android opens a context menu on a long press.
    element.addEventListener("contextmenu", noContextMenu);
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      revealed = true;
      element.addEventListener("click", swallowClick, { capture: true });
      // React Aria tracks the press from pointerdown and activates on
      // pointerup; a pointercancel ends it, as React Aria's own long press does.
      cancelling = true;
      element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch" }));
      cancelling = false;
      reveal();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id || pressTimer === undefined) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE_PX) endPress();
  };

  const onPointerEnd = (event: PointerEvent) => {
    // The pointercancel dispatched above reaches this listener too.
    if (cancelling || !press || event.pointerId !== press.id) return;
    endPress();
    if (!revealed) return;
    // The click, if any, follows pointerup at once.
    setTimeout(() => element.removeEventListener("click", swallowClick, { capture: true }), 100);
    lingerTimer = setTimeout(() => {
      revealed = false;
      hide();
    }, REVEAL_LINGER_MS);
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  return () => {
    endPress();
    clearTimeout(lingerTimer);
    element.removeEventListener("click", swallowClick, { capture: true });
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerEnd);
    element.removeEventListener("pointercancel", onPointerEnd);
  };
}
