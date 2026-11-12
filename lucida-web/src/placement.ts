/**
 * Where a dataset's frame sits in the scene frame the slice camera views. A
 * dataset's frame is its level-0 samples, with a collection's members at their
 * layout positions; lucida-core places it by the dataset's declared scale,
 * origin and units, and by any move, scale or turn a person gave it. The web
 * only applies a placement, never derives one.
 */
import type { WasmScene } from "lucida-core";
import type { SliceQuad } from "./renderer/sliceQuad.ts";
import type { SpatialAxis } from "./renderer/slicePlane.ts";

type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];

/**
 * A frame point `p` lands at `linear · p + offset` in the scene frame, with
 * `linear` by rows, so `linear[r][c]` is how far scene axis `r` moves per
 * sample along frame axis `c`. A placement can turn a dataset as well as
 * stretch and move it.
 */
export interface Placement {
  offset: Vec3;
  linear: readonly [Vec3, Vec3, Vec3];
}

export const IDENTITY_PLACEMENT: Placement = {
  offset: [0, 0, 0],
  linear: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
};

/** `datasetId`'s placement, or the identity for a dataset the scene doesn't hold. */
export function readPlacement(
  scene: Pick<WasmScene, "dataset_placement">,
  datasetId: string,
): Placement {
  const v = scene.dataset_placement(datasetId);
  if (v.length < 12) return IDENTITY_PLACEMENT;
  return {
    offset: [v[0], v[1], v[2]],
    linear: [[v[3], v[4], v[5]], [v[6], v[7], v[8]], [v[9], v[10], v[11]]],
  };
}

/** A frame point where `p` places it in the scene frame. */
export function placePoint(p: Placement, point: Vec3): [number, number, number] {
  const row = (r: number) => p.offset[r] + p.linear[r][0] * point[0] + p.linear[r][1] * point[1] + p.linear[r][2] * point[2];
  return [row(0), row(1), row(2)];
}

/** Below this an entry off the diagonal counts as none, as lucida-core counts it. */
const ALIGNED_EPSILON = 1e-12;

/** The frame axes of the slice plane cutting `axis`: across the screen, down it, and the cut. */
function planeIndices(axis: SpatialAxis): [number, number, number] {
  return axis === "z" ? [0, 1, 2] : axis === "y" ? [0, 2, 1] : [1, 2, 0];
}

/**
 * Whether `p` keeps `axis`, so a plane across it maps to a plane across it.
 * Only then does a slice view cutting `axis` cut the dataset along its own
 * planes. A turn about the axis keeps it; a turn about any other tilts it.
 */
export function keepsCut(p: Placement, axis: SpatialAxis): boolean {
  const cut = planeIndices(axis)[2];
  for (let j = 0; j < 3; j++) {
    if (j === cut) continue;
    if (Math.abs(p.linear[cut][j]) >= ALIGNED_EPSILON || Math.abs(p.linear[j][cut]) >= ALIGNED_EPSILON) return false;
  }
  return true;
}

/**
 * A placement on one slice plane: frame `[across, down]` to scene
 * `[across, down]`, `linear` by rows.
 */
export interface PlaneMap {
  offset: Vec2;
  linear: readonly [Vec2, Vec2];
}

/**
 * `p` on the plane cutting `axis`, so a side view places a frame as an XY
 * view does. Exact for a placement that keeps the axis ({@link keepsCut});
 * one that tilts it has no such map.
 */
export function placementInPlane(p: Placement, axis: SpatialAxis): PlaneMap {
  const [a, d] = planeIndices(axis);
  return {
    offset: [p.offset[a], p.offset[d]],
    linear: [[p.linear[a][a], p.linear[a][d]], [p.linear[d][a], p.linear[d][d]]],
  };
}

export const IDENTITY_PLANE_MAP: PlaneMap = { offset: [0, 0], linear: [[1, 0], [0, 1]] };

/** `datasetId`'s placement on the plane cutting `axis`, XY unless named. */
export function readPlaneMap(
  scene: Pick<WasmScene, "dataset_placement">,
  datasetId: string,
  axis: SpatialAxis = "z",
): PlaneMap {
  return placementInPlane(readPlacement(scene, datasetId), axis);
}

/** A frame point in the scene frame. */
export function frameToScene(m: PlaneMap, point: Vec2): [number, number] {
  return [
    m.offset[0] + m.linear[0][0] * point[0] + m.linear[0][1] * point[1],
    m.offset[1] + m.linear[1][0] * point[0] + m.linear[1][1] * point[1],
  ];
}

/** A scene-frame point in the dataset's frame. */
export function sceneToFrame(m: PlaneMap, point: Vec2): [number, number] {
  const [[a, b], [c, d]] = m.linear;
  const x = point[0] - m.offset[0];
  const y = point[1] - m.offset[1];
  if (b === 0 && c === 0) return [x / a, y / d];
  const det = a * d - b * c;
  return [(d * x - b * y) / det, (a * y - c * x) / det];
}

/** A frame rect at `x, y` spanning `w × h`, as the quad it covers in the scene frame. */
export function rectToQuad(m: PlaneMap, x: number, y: number, w: number, h: number): SliceQuad {
  return {
    origin: frameToScene(m, [x, y]),
    across: [m.linear[0][0] * w, m.linear[1][0] * w],
    down: [m.linear[0][1] * h, m.linear[1][1] * h],
  };
}
