/** The drag data a layer carries when dragged from the panel onto a view: its dataset id. */
export const DATASET_DRAG_TYPE = "application/x-lucida-dataset";

/** Whether `target` is a view's own pane (`ViewPanes`), rather than something drawn over it. */
export function isViewPane(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.viewPane !== undefined;
}

/** The pane under the client point `(x, y)` among those under `root`. */
export function paneAt(root: ParentNode, x: number, y: number): HTMLElement | null {
  for (const pane of root.querySelectorAll<HTMLElement>("[data-view-pane]")) {
    const rect = pane.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return pane;
  }
  return null;
}

/**
 * Hand every wheel over `stage` that nothing took on to the view under the
 * pointer, among the panes under `panes`. A control floating over a view
 * takes the pointer from the view's pane, where the viewers listen, so
 * without this a wheel over a line's grip, a view's Home button or the tool
 * palette zooms nothing. A wheel in a pane has reached it already, one a
 * control used for itself, as the minimap does, is prevented, and one over
 * a control that scrolls stays to scroll it. Returns what stops it.
 */
export function forwardStrayWheels(stage: HTMLElement, panes: ParentNode): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented || !(e.target instanceof Element)) return;
    if (e.target.closest("[data-view-pane]") || scrollsWithin(e.target, stage)) return;
    const pane = paneAt(panes, e.clientX, e.clientY);
    if (pane) forwardWheel(e, pane);
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  return () => stage.removeEventListener("wheel", onWheel);
}

/** Whether `target`, or what holds it short of `stage`, scrolls content that overflows it. */
function scrollsWithin(target: Element, stage: Element): boolean {
  const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
  for (let at: Element | null = target; at && at !== stage; at = at.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(at);
    if (scrolls(overflowY) && at.scrollHeight > at.clientHeight) return true;
    if (scrolls(overflowX) && at.scrollWidth > at.clientWidth) return true;
  }
  return false;
}

/**
 * Hand a wheel on to a view's `pane`, as if the pointer were over the pane,
 * where the viewers listen and a wheel makes the view active. The
 * original's default, a page scroll or with Ctrl a browser zoom, goes when
 * the pane's handlers prevent the copy's.
 */
export function forwardWheel(e: WheelEvent, pane: EventTarget): void {
  const copy = new WheelEvent(e.type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    buttons: e.buttons,
  });
  if (!pane.dispatchEvent(copy)) e.preventDefault();
}
