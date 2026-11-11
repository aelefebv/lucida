/**
 * The plane a slice view cuts, and where a full-resolution plane lands at a
 * coarser level, in one place.
 *
 * The slice atlas keys chunks by each level's own chunk grid, so the planner,
 * which picks the chunk along the cut axis the worker wants, and the worker,
 * which cuts the plane from it and checks a slot still holds that plane, must
 * agree on the plane a full-resolution index names, or a delivery is refused
 * and re-sent forever. Both go through these functions, and
 * `lucida-core/src/slice_plane.rs` computes the same plane.
 */

import { Axis } from "../axes.ts";

/** The plane a slice view cuts, as the core names it. */
export type SlicePlane = "xy" | "xz" | "yz";

/** A spatial axis of an image. */
export type SpatialAxis = "x" | "y" | "z";

/**
 * The axis drawn across the screen, the one drawn down it, and the one cut.
 * Z is drawn down whenever it is on screen. The slice worker works in this
 * frame: its X, Y and Z are these three.
 */
export function planeAxes(plane: SlicePlane): [SpatialAxis, SpatialAxis, SpatialAxis] {
  switch (plane) {
    case "xz": return ["x", "z", "y"];
    case "yz": return ["y", "z", "x"];
    default: return ["x", "y", "z"];
  }
}

/** The axis a slice view of `plane` cuts, along which its axis position moves. */
export function cutAxis(plane: SlicePlane): SpatialAxis {
  return planeAxes(plane)[2];
}

/** The plane whose cut is `axis`. */
export function planeCutting(axis: SpatialAxis): SlicePlane {
  return axis === "y" ? "xz" : axis === "x" ? "yz" : "xy";
}

/** The index of `axis` in a `[T, C, Z, Y, X]` shape. */
export function tczyx(axis: SpatialAxis): number {
  return axis === "x" ? Axis.X : axis === "y" ? Axis.Y : Axis.Z;
}

/** The index of `axis` in an `[x, y, z]` triple. */
export function xyz(axis: SpatialAxis): number {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

/** Where a slice view cuts: the axis, and the full-resolution plane along it. */
export interface SliceCut {
  axis: SpatialAxis;
  index: number;
}

/**
 * One plane of a chunk as a slice pool holds it: the axis the pool cuts, and
 * the plane of the chunk's level along it. Views at different cuts of one
 * chunk need different planes of it, each in a slot of its own.
 */
export interface PoolCut {
  axis: SpatialAxis;
  plane: number;
}

/**
 * `[x, y, z]` values in the frame of the plane cutting `axis`: across the
 * screen, down it, and along the cut.
 */
export function toPlaneFrame<T>(values: readonly [T, T, T], axis: SpatialAxis): [T, T, T] {
  const [across, down, cut] = planeAxes(planeCutting(axis));
  return [values[xyz(across)], values[xyz(down)], values[xyz(cut)]];
}

/** {@link toPlaneFrame} undone: plane-frame values back to `[x, y, z]`. */
export function fromPlaneFrame<T>(values: readonly [T, T, T], axis: SpatialAxis): [T, T, T] {
  const out = [values[0], values[0], values[0]] as [T, T, T];
  planeAxes(planeCutting(axis)).forEach((a, i) => { out[xyz(a)] = values[i]; });
  return out;
}

/**
 * The plane index at a level `levelExtent` planes deep along the cut axis
 * that holds the center of the full-resolution plane `fullResIndex`, the
 * plane nearest-sample filtering would read. Integer arithmetic, so no plane
 * lands one short of an exact boundary.
 */
export function sliceLevelPlane(fullResIndex: number, fullResExtent: number, levelExtent: number): number {
  const last = Math.max(levelExtent - 1, 0);
  const index = Math.max(fullResIndex, 0);
  if (levelExtent === fullResExtent || fullResExtent <= 0) return Math.min(index, last);
  return Math.min(Math.floor(((2 * index + 1) * levelExtent) / (2 * fullResExtent)), last);
}

/** The chunk index along the cut axis holding that plane, for chunks `chunkExtent` planes deep. */
export function sliceChunkIndex(
  fullResIndex: number,
  fullResExtent: number,
  levelExtent: number,
  chunkExtent: number,
): number {
  return Math.floor(sliceLevelPlane(fullResIndex, fullResExtent, levelExtent) / Math.max(chunkExtent, 1));
}

/**
 * The half-open chunk range along the cut axis that a 2-D view of the
 * full-resolution planes `[start, end)` samples: from the chunk holding the
 * first plane to the one holding the last. One chunk for the single plane a
 * slice view shows.
 */
export function sliceChunkRange(
  start: number,
  end: number,
  fullResExtent: number,
  levelExtent: number,
  chunkExtent: number,
): [number, number] {
  const first = Math.floor(start);
  const last = Math.ceil(end) - 1;
  if (last < first) return [0, 0];
  return [
    sliceChunkIndex(first, fullResExtent, levelExtent, chunkExtent),
    sliceChunkIndex(last, fullResExtent, levelExtent, chunkExtent) + 1,
  ];
}
