/**
 * Shared annotation geometry — the TS mirror of `Annotation::vertices()` /
 * `Annotation::is_closed()` in lucida-core.
 *
 * Both overlays (2D {@link AnnotationOverlay} and 3D {@link AnnotationOverlay3D})
 * render every kind through ONE path: ask {@link annotationVertices} for a pin's
 * in-plane world vertices, project each vertex with that view's own per-vertex
 * marker projection (the 2D camera inverse, or `scene.project_annotation` in
 * 3D), then draw a dot (one vertex), a stroked segment (a line), or a closed
 * polygon (a box). Keeping the per-kind vertex layout in one helper — matching
 * the Rust source of truth — means a line/box renders identically in both views
 * and a future kind only extends this file plus its Rust twin.
 */
import type { Annotation } from "./AnnotationOverlay.tsx";

/** A screen-space point in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * The in-plane world vertices of a pin's shape, in draw order — mirrors
 * `Annotation::vertices()`:
 *
 * - point → `[position]`
 * - line  → `[position, end]`
 * - box   → the four rectangle corners for opposite corners `position`/`end`,
 *           wound `position → (end.x, position.y) → end → (position.x, end.y)`
 *
 * A line/box whose `end` is missing collapses to its single anchor `position`,
 * so the geometry always has at least one vertex (never empty, never throws).
 */
export function annotationVertices(pin: Annotation): ScreenPoint[] {
  const p = pin.position;
  const end = pin.end ?? null;
  if (end && pin.kind === "line") {
    return [p, end];
  }
  if (end && pin.kind === "box") {
    return [
      [p[0], p[1]],
      [end[0], p[1]],
      [end[0], end[1]],
      [p[0], end[1]],
    ];
  }
  return [p];
}

/** Whether the drawn shape is a closed ring (a box) vs. an open run
 * (a point or line). Mirrors `Annotation::is_closed()`. */
export function isClosedShape(pin: Annotation): boolean {
  return pin.kind === "box" && (pin.end ?? null) !== null;
}
