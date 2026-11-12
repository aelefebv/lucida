/** The drag data a layer carries when dragged from the panel onto a view: its dataset id. */
export const DATASET_DRAG_TYPE = "application/x-lucida-dataset";

/** Whether `target` is a view's own pane (`ViewPanes`), rather than something drawn over it. */
export function isViewPane(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.viewPane !== undefined;
}

/** `view`'s pane among those under `root`. */
export function paneOf(root: ParentNode, view: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-view-pane="${view}"]`);
}

/**
 * Hand a wheel over something drawn over a view on to the view's `pane`, as
 * if the pointer were over the pane, where the viewers listen and a wheel
 * makes the view active. The original's default, a page scroll or with Ctrl
 * a browser zoom, goes when the pane's handlers prevent the copy's.
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
