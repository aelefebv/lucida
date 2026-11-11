/**
 * The boxes of what `ViewOverlays` lays over the top of `view` in the stage
 * that holds `inside`, its compare bar and its notices, the list of them
 * too while it is open, in client coordinates, so a layer in the view can
 * keep clear of them.
 */
export function viewOverlayBoxes(inside: Element, view: number): DOMRect[] {
  const stage = inside.closest(".lc-canvas-stage");
  if (!stage) return [];
  const column = `.lc-view-overlay[data-view="${view}"] .lc-view-overlay-top`;
  const items = stage.querySelectorAll(`${column} > *, ${column} .lc-view-notices-list`);
  return Array.from(items, (item) => item.getBoundingClientRect());
}
