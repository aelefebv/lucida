/**
 * The boxes of what `ViewOverlays` lays over the top of `view` in the stage
 * that holds `inside`, its compare bar, its notices and its Home button, in
 * client coordinates, so a layer in the view can keep clear of them.
 */
export function viewOverlayBoxes(inside: Element, view: number): DOMRect[] {
  const stage = inside.closest(".lc-canvas-stage");
  if (!stage) return [];
  const overlay = `.lc-view-overlay[data-view="${view}"]`;
  const items = stage.querySelectorAll(`${overlay} .lc-view-overlay-top > *, ${overlay} .lc-view-home`);
  return Array.from(items, (item) => item.getBoundingClientRect());
}
