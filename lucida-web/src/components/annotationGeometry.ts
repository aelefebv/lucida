/**
 * Annotation geometry, the TS mirror of `Annotation::vertices()`,
 * `Annotation::is_closed()` and `box_plane` in lucida-core.
 *
 * A mark's vertices are points of its dataset's frame on all three axes. Both
 * overlays project each one with their own view's camera, then draw a dot, a
 * segment, or a closed polygon. A slice view edits a mark through its place on
 * the view's plane, across and down, which the 2D helpers below work in. Keep
 * the per-kind vertex layout in step with the Rust twin so a shape renders the
 * same in every view.
 */
import type { Annotation } from "./annotationDocument.ts";
import { cutAxis, fromPlaneFrame, toPlaneFrame, type SlicePlane } from "../renderer/slicePlane.ts";

/** A screen-space point in CSS pixels. */
export type ScreenPoint = [number, number];

/** A point of a dataset's frame, `[x, y, z]` in continuous samples. */
export type FramePoint = [number, number, number];

/** A pin's anchor vertex, `(position, z)`. */
export function pinStart(pin: Annotation): FramePoint {
  return [pin.position[0], pin.position[1], pin.z ?? 0];
}

/** A mark, as what says which tile a side view of a collection draws it on:
 * the tile it is glued to, or for one with none yet, such as a shape still
 * being drawn, the tile its first vertex lies on. Mirrors
 * `lucida_core::scene::MarkOn`. */
export interface MarkOn {
  start: FramePoint;
  anchor?: string | null;
}

/** `pin` as a {@link MarkOn}. */
export function markOn(pin: Annotation): MarkOn {
  return { start: pinStart(pin), anchor: pin.anchor ?? null };
}

/** A pin's second vertex, at its own depth or else the anchor's; null for a point. */
export function pinEnd(pin: Annotation): FramePoint | null {
  const end = pin.end ?? null;
  return end ? [end[0], end[1], pin.end_z ?? pin.z ?? 0] : null;
}

/** The plane a box with these corners lies in: the one across the axis both
 * share, XY when they share their depth. Mirrors `box_plane` in lucida-core. */
export function boxPlane(start: FramePoint, end: FramePoint): SlicePlane {
  if (start[2] === end[2]) return "xy";
  if (start[1] === end[1]) return "xz";
  return start[0] === end[0] ? "yz" : "xy";
}

/**
 * The frame vertices of a pin's shape, in draw order: a point's anchor, a
 * line's two ends, or a box's four corners in the plane it lies in. A line or
 * box with no `end` collapses to its anchor, so the result is never empty.
 */
export function annotationVertices(pin: Annotation): FramePoint[] {
  const start = pinStart(pin);
  const end = pinEnd(pin);
  if (end && pin.kind === "line") return [start, end];
  if (end && pin.kind === "box") {
    const plane = boxPlane(start, end);
    const [s0, s1] = onPlane(start, plane);
    const [e0, e1] = onPlane(end, plane);
    return [start, withOnPlane(start, [e0, s1], plane), end, withOnPlane(end, [s0, e1], plane)];
  }
  return [start];
}

/** `pin` with every vertex moved by `shift`, as a view that draws it moved,
 * into its tile's cell in a side view of a collection, reads its planes. */
export function shiftPin(pin: Annotation, shift: FramePoint): Annotation {
  const [dx, dy, dz] = shift;
  if (dx === 0 && dy === 0 && dz === 0) return pin;
  const [x, y, z] = pinStart(pin);
  const end = pinEnd(pin);
  return {
    ...pin,
    position: [x + dx, y + dy],
    z: z + dz,
    ...(end && { end: [end[0] + dx, end[1] + dy], end_z: end[2] + dz }),
  };
}

/** Whether the drawn shape is a closed ring (a box with an `end`). */
export function isClosedShape(pin: Annotation): boolean {
  return pin.kind === "box" && (pin.end ?? null) !== null;
}

/** A frame point's place on `plane`, `[across, down]`. */
export function onPlane(point: FramePoint, plane: SlicePlane): [number, number] {
  const [across, down] = toPlaneFrame(point, cutAxis(plane));
  return [across, down];
}

/** `point` moved to `at` across and down `plane`, its place along the cut kept. */
export function withOnPlane(point: FramePoint, at: readonly [number, number], plane: SlicePlane): FramePoint {
  const axis = cutAxis(plane);
  return fromPlaneFrame([at[0], at[1], toPlaneFrame(point, axis)[2]], axis);
}

/** Whether a shape from `start` to `end` lies on one plane of `plane`'s kind,
 * the one it was drawn on, where its handles can reshape it. */
export function liesOnPlane(start: FramePoint, end: FramePoint, plane: SlicePlane): boolean {
  const axis = cutAxis(plane);
  return toPlaneFrame(start, axis)[2] === toPlaneFrame(end, axis)[2];
}

/** A shape's two frame vertices, a box's opposite corners or a line's ends. */
export interface FrameVertices {
  position: FramePoint;
  end: FramePoint;
}

/** Both vertices moved `delta` across and down `plane`, as dragging a whole
 * shape moves it there; each keeps its own place along the cut. */
export function translateOnPlane(vertices: FrameVertices, delta: readonly [number, number], plane: SlicePlane): FrameVertices {
  const move = (p: FramePoint) => {
    const [across, down] = onPlane(p, plane);
    return withOnPlane(p, [across + delta[0], down + delta[1]], plane);
  };
  return { position: move(vertices.position), end: move(vertices.end) };
}

/** Opposite corners of a box, as places across and down the plane it lies
 * on ({@link onPlane}). */
export interface BoxCorners {
  position: [number, number];
  end: [number, number];
}

/** A line's endpoints across and down the plane it lies on. Same shape as
 * {@link BoxCorners} so one reshape gesture can carry either. */
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
