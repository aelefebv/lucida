/** Types and math for the live draw preview ({@link AnnotationDraftOverlay}).
 * Kept out of the `.tsx` so that file only exports a component (react-refresh). */

/** In-progress draw in canvas CSS px: `(x0,y0)` is the press point, `(x1,y1)`
 * the current pointer. */
export interface AnnotationDraft {
  kind: "line" | "box";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Normalize a press-to-cursor box to a non-negative SVG rect, so a drag in any
 * direction yields a valid rectangle. */
export function draftBoxRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}
