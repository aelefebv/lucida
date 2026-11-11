/**
 * The boxes of what `ViewOverlays` lays over `view` in the stage that holds
 * `inside`, in client coordinates, so a layer in the view can keep clear of
 * them: everything in the column at its top, and anything else over the view
 * marked `data-keep-clear`.
 */
export function viewOverlayBoxes(inside: Element, view: number): DOMRect[] {
  const stage = inside.closest(".lc-canvas-stage");
  if (!stage) return [];
  const overlay = `.lc-view-overlay[data-view="${view}"]`;
  const items = stage.querySelectorAll(`${overlay} .lc-view-overlay-top > *, ${overlay} [data-keep-clear]`);
  return Array.from(items, (item) => item.getBoundingClientRect());
}
