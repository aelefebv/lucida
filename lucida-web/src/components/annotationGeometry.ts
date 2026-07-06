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
import type { Annotation } from "./annotationDocument.ts";

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

/** A pair of opposite in-plane world corners of a box: `position` (the anchor)
 * and `end` (the opposite corner). The reshape command carries exactly these
 * two — the backend places them verbatim (no rigid translate). */
export interface BoxCorners {
  position: [number, number];
  end: [number, number];
}

/** A pair of in-plane world endpoints of a line: `position` (the anchor vertex)
 * and `end` (the far vertex). The same shape as {@link BoxCorners} so the
 * overlay can carry either through one reshape gesture; named separately for the
 * line's two-vertex semantics (a segment, not a rectangle). */
export interface LineEndpoints {
  position: [number, number];
  end: [number, number];
}

/** The two draggable endpoints of a line, in a stable order: the anchor
 * (`position`) vertex then the far (`end`) vertex. The analog of
 * {@link BOX_HANDLES} for a line — a line has exactly these two grips. */
export const LINE_HANDLES = ["start", "end"] as const;
export type LineHandle = (typeof LINE_HANDLES)[number];

/**
 * The in-plane world point a given line endpoint sits on. The line analog of
 * {@link boxHandlePoint}: `start` rides the anchor vertex (`position`), `end`
 * the far vertex (`end`). The overlay reprojects this every frame to place each
 * endpoint grip, exactly as it does each box handle.
 */
export function lineHandlePoint(endpoints: LineEndpoints, handle: LineHandle): ScreenPoint {
  return handle === "start"
    ? [endpoints.position[0], endpoints.position[1]]
    : [endpoints.end[0], endpoints.end[1]];
}

/**
 * Recompute a line's two endpoints after dragging `handle` to the world point
 * `world` — the geometry an endpoint drag emits as `move_annotation
 * {position, end}` (a reshape; the backend takes both verbatim). The two-case
 * analog of {@link reshapeBox}: the grabbed endpoint moves to `world`, the other
 * endpoint stays exactly where it was, so dragging one end never disturbs the
 * other.
 *  - `start` → set `position` to `world`, hold `end`.
 *  - `end`   → set `end` to `world`, hold `position`.
 *
 * The result is a pure value (the inputs are not mutated).
 */
export function reshapeLine(
  endpoints: LineEndpoints,
  handle: LineHandle,
  world: [number, number],
): LineEndpoints {
  // Copy so the inputs stay immutable.
  const position: [number, number] = [endpoints.position[0], endpoints.position[1]];
  const end: [number, number] = [endpoints.end[0], endpoints.end[1]];
  if (handle === "start") {
    position[0] = world[0];
    position[1] = world[1];
  } else {
    end[0] = world[0];
    end[1] = world[1];
  }
  return { position, end };
}

/** The eight resize handles of a box, in a stable order: four corners then the
 * four edge midpoints. */
export const BOX_HANDLES = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;
export type BoxHandle = (typeof BOX_HANDLES)[number];

/**
 * The in-plane world point a given resize handle sits on, for a box whose
 * opposite corners are `position` (the anchor) and `end`.
 *
 * Handle identity is tied to the two VERTEX ROLES, not to screen min/max, so
 * the resize semantics are stable however the box was drawn (any winding):
 *  - `nw` sits on the anchor corner (`position`); `se` on the opposite (`end`).
 *  - `ne` = (end.x, position.y); `sw` = (position.x, end.y) — the mixed corners.
 *  - edge midpoints `n`/`s` ride the position.y / end.y edges; `w`/`e` the
 *    position.x / end.x edges.
 *
 * This is the projection input the overlay reprojects every frame to place each
 * handle, and the same map {@link reshapeBox} uses to recompute the two corners.
 */
export function boxHandlePoint(corners: BoxCorners, handle: BoxHandle): ScreenPoint {
  const { position: p, end: e } = corners;
  const midX = (p[0] + e[0]) / 2;
  const midY = (p[1] + e[1]) / 2;
  switch (handle) {
    case "nw":
      return [p[0], p[1]];
    case "ne":
      return [e[0], p[1]];
    case "se":
      return [e[0], e[1]];
    case "sw":
      return [p[0], e[1]];
    case "n":
      return [midX, p[1]];
    case "s":
      return [midX, e[1]];
    case "w":
      return [p[0], midY];
    case "e":
      return [e[0], midY];
  }
}

/**
 * Recompute a box's two opposite corners after dragging `handle` to the world
 * point `world` — the geometry a corner/edge resize emits as
 * `move_annotation {position, end}` (a reshape; the backend takes both verbatim).
 *
 * Each handle moves only the coordinates it owns, leaving the rest put — so the
 * opposite corner/edge stays anchored:
 *  - corners set the two coordinates of their own vertex role (`nw` → both of
 *    `position`; `se` → both of `end`; `ne`/`sw` → one of each);
 *  - edges set a single coordinate (`n` → position.y, `s` → end.y, `w` →
 *    position.x, `e` → end.x).
 *
 * The result is a pure value (the inputs are not mutated). It is intentionally
 * NOT normalized (corners may cross, flipping the box) — `Annotation::vertices`
 * /{@link annotationVertices} derive the rectangle from whatever two corners
 * result, so a drag past the opposite side simply flips the box, matching how
 * every direct-manipulation rect editor behaves.
 */
export function reshapeBox(
  corners: BoxCorners,
  handle: BoxHandle,
  world: [number, number],
): BoxCorners {
  // Copy so the inputs stay immutable.
  const position: [number, number] = [corners.position[0], corners.position[1]];
  const end: [number, number] = [corners.end[0], corners.end[1]];
  switch (handle) {
    case "nw":
      position[0] = world[0];
      position[1] = world[1];
      break;
    case "se":
      end[0] = world[0];
      end[1] = world[1];
      break;
    case "ne":
      end[0] = world[0];
      position[1] = world[1];
      break;
    case "sw":
      position[0] = world[0];
      end[1] = world[1];
      break;
    case "n":
      position[1] = world[1];
      break;
    case "s":
      end[1] = world[1];
      break;
    case "w":
      position[0] = world[0];
      break;
    case "e":
      end[0] = world[0];
      break;
  }
  return { position, end };
}
