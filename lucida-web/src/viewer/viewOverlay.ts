/**
 * The boxes of what `ViewOverlays` lays over the top of `view` in the stage
 * that holds `inside`, its compare bar and its notice, in client
 * coordinates, so a layer in the view can keep clear of them.
 */
export function viewOverlayBoxes(inside: Element, view: number): DOMRect[] {
  const stage = inside.closest(".lc-canvas-stage");
  if (!stage) return [];
  const column = stage.querySelectorAll(`.lc-view-overlay[data-view="${view}"] .lc-view-overlay-top > *`);
  return Array.from(column, (item) => item.getBoundingClientRect());
}
