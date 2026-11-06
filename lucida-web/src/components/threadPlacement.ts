/** Gap (CSS px) between a pin and its open thread. */
const GAP = 12;
/** Space (CSS px) the thread keeps from the canvas edges. */
const MARGIN = 8;

/** Where one axis of the thread goes: past the pin, else before it, else as
 * far along as keeps it inside. */
function axisOffset(anchor: number, size: number, bound: number): number {
  if (anchor + GAP + size <= bound - MARGIN) return GAP;
  if (anchor - GAP - size >= MARGIN) return -GAP - size;
  return Math.max(MARGIN - anchor, bound - MARGIN - size - anchor);
}

/**
 * The offset from a pin to the top-left of its open thread that keeps the
 * thread on the canvas: below and to the right where it fits, flipped to the
 * other side where it doesn't, shifted along where neither side has room, as
 * on a phone.
 */
export function threadOffset(
  anchor: readonly [number, number],
  size: { width: number; height: number },
  bounds: { width: number; height: number },
): [number, number] {
  return [axisOffset(anchor[0], size.width, bounds.width), axisOffset(anchor[1], size.height, bounds.height)];
}

/** Move an open thread inside `wrapper`, the pin's anchor at `anchor`, onto
 * the canvas. Called per frame, since the pin moves. */
export function keepThreadOnCanvas(wrapper: HTMLElement, anchor: readonly [number, number], canvas: HTMLCanvasElement): void {
  const thread = wrapper.querySelector<HTMLElement>(".lc-thread");
  if (!thread) return;
  const [x, y] = threadOffset(
    anchor,
    { width: thread.offsetWidth, height: thread.offsetHeight },
    { width: canvas.clientWidth, height: canvas.clientHeight },
  );
  thread.style.left = `${x}px`;
  thread.style.top = `${y}px`;
}
