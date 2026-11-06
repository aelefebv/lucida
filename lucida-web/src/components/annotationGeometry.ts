/**
 * Annotation geometry, the TS mirror of `Annotation::vertices()` and
 * `Annotation::is_closed()` in lucida-core.
 *
 * Both overlays get a pin's in-plane world vertices from here, project each with
 * their own camera, then draw a dot, a segment, or a closed polygon. Keep the
 * per-kind vertex layout in step with the Rust twin so a shape renders the same
 * in both views.
 */
import type { Annotation } from "./annotationDocument.ts";

/** A screen-space point in CSS pixels. */
export type ScreenPoint = [number, number];

/**
 * The in-plane world vertices of a pin's shape, in draw order. A line or box
 * with no `end` collapses to its anchor `position`, so the result is never
 * empty.
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

/** Whether the drawn shape is a closed ring (a box with an `end`). */
export function isClosedShape(pin: Annotation): boolean {
  return pin.kind === "box" && (pin.end ?? null) !== null;
}

/** Opposite in-plane world corners of a box. The reshape command carries both
 * and the backend places them verbatim. */
export interface BoxCorners {
  position: [number, number];
  end: [number, number];
}

/** In-plane world endpoints of a line. Same shape as {@link BoxCorners} so one
 * reshape gesture can carry either. */
export interface LineEndpoints {
  position: [number, number];
  end: [number, number];
}

/** A line's two grips: `start` on `position`, `end` on `end`. */
export const LINE_HANDLES = ["start", "end"] as const;
export type LineHandle = (typeof LINE_HANDLES)[number];

/** The in-plane world point a line grip sits on. */
export function lineHandlePoint(endpoints: LineEndpoints, handle: LineHandle): ScreenPoint {
  return handle === "start"
    ? [endpoints.position[0], endpoints.position[1]]
    : [endpoints.end[0], endpoints.end[1]];
}

/**
 * A line's endpoints after dragging `handle` to `world`: the grabbed endpoint
 * moves, the other stays put. Emitted as `move_annotation {position, end}`.
 */
export function reshapeLine(
  endpoints: LineEndpoints,
  handle: LineHandle,
  world: [number, number],
): LineEndpoints {
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
 * The in-plane world point a box resize handle sits on.
 *
 * Handles are tied to vertex roles, not screen min/max, so resize behaves the
 * same however the box was drawn: `nw` is `position`, `se` is `end`, `ne` and
 * `sw` are the mixed corners, and the edge midpoints ride the matching edges.
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
 * A box's corners after dragging `handle` to `world`. Each handle moves only
 * the coordinates it owns, so the opposite corner or edge stays anchored.
 * Emitted as `move_annotation {position, end}`.
 *
 * Intentionally not normalized: a drag past the opposite side flips the box,
 * and {@link annotationVertices} derives the rectangle from whatever corners
 * result.
 */
export function reshapeBox(
  corners: BoxCorners,
  handle: BoxHandle,
  world: [number, number],
): BoxCorners {
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

/** A box's corners or a line's endpoints moved together by `delta`, as dragging
 * a whole shape previews it. */
export function translateShape(
  vertices: BoxCorners & LineEndpoints,
  delta: [number, number],
): BoxCorners & LineEndpoints {
  return {
    position: [vertices.position[0] + delta[0], vertices.position[1] + delta[1]],
    end: [vertices.end[0] + delta[0], vertices.end[1] + delta[1]],
  };
}

/** A shape as drawn on screen, for {@link hitTestShapes}. */
export interface ShapeOnScreen {
  id: string;
  /** Screen vertices in draw order. */
  points: ScreenPoint[];
  /** A closed ring, whose inside counts as a hit. */
  closed: boolean;
}

function distanceToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function insidePolygon(p: ScreenPoint, points: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The shape a press at `p` lands on, or null: one within `tolerance` CSS px of
 * its stroke, or anywhere inside a closed one. The nearest stroke wins, so a
 * line drawn inside a box, or a box inside another, stays reachable.
 */
export function hitTestShapes(
  p: ScreenPoint,
  shapes: readonly ShapeOnScreen[],
  tolerance: number,
): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const shape of shapes) {
    const { points, closed } = shape;
    if (points.length < 2) continue;
    let distance = Infinity;
    const segments = closed ? points.length : points.length - 1;
    for (let i = 0; i < segments; i++) {
      distance = Math.min(distance, distanceToSegment(p, points[i], points[(i + 1) % points.length]));
    }
    if (distance > tolerance && !(closed && insidePolygon(p, points))) continue;
    if (!best || distance < best.distance) best = { id: shape.id, distance };
  }
  return best?.id ?? null;
}
