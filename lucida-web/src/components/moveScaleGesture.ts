/**
 * What a Move, scale and rotate drag does, worked out in the slice view's
 * plane: across the screen, down it, and the cut. A move or a scale is a map
 * of the scene frame and a turn is an angle, which lucida-core turns into the
 * dataset's transform, so this never reads a placement.
 */
import { fromPlaneFrame, type SpatialAxis } from "../renderer/slicePlane.ts";
import { moveBy, scaleAbout, thenMap, type SceneMap } from "../userTransform.ts";

/** A corner of the outline, by compass point, as the dataset's own axes name it unturned; Y points down. */
export type Corner = "nw" | "ne" | "se" | "sw";

export const CORNERS: readonly Corner[] = ["nw", "ne", "se", "sw"];

type Point = readonly [number, number];

/**
 * A dataset's footprint on the plane: the corner where its first sample
 * starts, then its edges along its own across and down axes, which a turn in
 * the plane turns with it.
 */
export interface PlaneQuad {
  origin: Point;
  across: Point;
  down: Point;
}

/** Where `corner` of `quad` is. */
export function cornerPoint(quad: PlaneQuad, corner: Corner): [number, number] {
  const a = corner === "ne" || corner === "se" ? 1 : 0;
  const d = corner === "se" || corner === "sw" ? 1 : 0;
  return [
    quad.origin[0] + a * quad.across[0] + d * quad.down[0],
    quad.origin[1] + a * quad.across[1] + d * quad.down[1],
  ];
}

/** The middle of `quad`, which a turn holds still. */
export function quadCenter(quad: PlaneQuad): [number, number] {
  return [
    quad.origin[0] + (quad.across[0] + quad.down[0]) / 2,
    quad.origin[1] + (quad.across[1] + quad.down[1]) / 2,
  ];
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

/** The scene-frame map of a drag of the outline from `start` to `now`. */
export function moveMap(start: Point, now: Point, cut: SpatialAxis): SceneMap {
  return moveBy(fromPlaneFrame([now[0] - start[0], now[1] - start[1], 0], cut));
}

/**
 * The scene-frame map of a drag of `corner` from `start` to `now`, the
 * opposite corner held still, along the dataset's own axes however the plane
 * turns them. The corner travels as the pointer does, so a press a little off
 * the corner doesn't jump the outline to the pointer. `uniform` scales every
 * axis by one factor, the cut's too so the dataset keeps its shape, about
 * `cutOrigin`, where it starts along the cut; otherwise each on-screen axis
 * follows the pointer and the cut keeps its size. Neither side shrinks below
 * `minExtent` or turns over.
 */
export function scaleMap(
  quad: PlaneQuad,
  corner: Corner,
  start: Point,
  now: Point,
  options: { uniform: boolean; cut: SpatialAxis; cutOrigin: number; minExtent: number },
): SceneMap {
  const anchor = cornerPoint(quad, OPPOSITE[corner]);
  const reach = cornerPoint(quad, corner);
  const turn = Math.atan2(quad.across[1], quad.across[0]);
  if (turn === 0) return scaleFrom(anchor, reach, start, now, options);
  // Unturned about the middle, the dataset's axes lie along the plane's, so
  // the drag scales there and the map turns back.
  const center = quadCenter(quad);
  const unturn = (p: Point) => turnPoint(p, center, -turn);
  const unturned = scaleFrom(unturn(anchor), unturn(reach), unturn(start), unturn(now), options);
  return thenMap(thenMap(turnAbout(center, -turn, options.cut), unturned), turnAbout(center, turn, options.cut));
}

/** {@link scaleMap} where the dataset's axes lie along the plane's, from `anchor` toward `reach`. */
function scaleFrom(
  anchor: Point,
  reach: Point,
  start: Point,
  now: Point,
  { uniform, cut, cutOrigin, minExtent }: { uniform: boolean; cut: SpatialAxis; cutOrigin: number; minExtent: number },
): SceneMap {
  const span: Point = [reach[0] - anchor[0], reach[1] - anchor[1]];
  const pull: Point = [span[0] + now[0] - start[0], span[1] + now[1] - start[1]];
  const floor = (extent: number) => (extent > 0 ? minExtent / extent : 1);
  const across = Math.abs(span[0]);
  const down = Math.abs(span[1]);
  let factor: [number, number, number];
  if (uniform) {
    // How far the pointer reaches along the outline's diagonal.
    const length2 = span[0] * span[0] + span[1] * span[1];
    const f = length2 > 0 ? (pull[0] * span[0] + pull[1] * span[1]) / length2 : 1;
    const clamped = Math.max(f, floor(Math.min(across, down)));
    factor = [clamped, clamped, clamped];
  } else {
    const along = (i: 0 | 1, extent: number) =>
      Math.max(span[i] !== 0 ? pull[i] / span[i] : 1, floor(extent));
    factor = [along(0, across), along(1, down), 1];
  }
  return scaleAbout(
    fromPlaneFrame([anchor[0], anchor[1], cutOrigin], cut),
    fromPlaneFrame(factor, cut),
  );
}

/**
 * The angle, in radians from the plane's across axis toward its down axis,
 * that a drag from `start` to `now` sweeps about `center`: how far a turn
 * handle dragged around the dataset turns it.
 */
export function turnAngle(center: Point, start: Point, now: Point): number {
  const from = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const to = Math.atan2(now[1] - center[1], now[0] - center[0]);
  // Across the angle's wrap the sweep is the short way round.
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** `p` turned by `angle` about `center`, from the plane's across axis toward its down axis. */
function turnPoint(p: Point, center: Point, angle: number): [number, number] {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const [x, y] = [p[0] - center[0], p[1] - center[1]];
  return [center[0] + cos * x - sin * y, center[1] + sin * x + cos * y];
}

/** The scene-frame map that turns the plane by `angle` about `center`, holding the cut. */
function turnAbout(center: Point, angle: number, cut: SpatialAxis): SceneMap {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const onPlane = [[cos, -sin, 0], [sin, cos, 0], [0, 0, 1]];
  // Each plane axis as an `[x, y, z]` direction.
  const axes = [0, 1, 2].map((k) => fromPlaneFrame([k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0], cut));
  const entry = (r: number, c: number) =>
    [0, 1, 2].reduce((sum, k) => sum + [0, 1, 2].reduce((s, l) => s + axes[k][r] * onPlane[k][l] * axes[l][c], 0), 0);
  const row = (r: number) => [entry(r, 0), entry(r, 1), entry(r, 2)] as [number, number, number];
  const linear = [row(0), row(1), row(2)] as const;
  const middle = fromPlaneFrame([center[0], center[1], 0], cut);
  const offset = [0, 1, 2].map((r) =>
    middle[r] - [0, 1, 2].reduce((sum, c) => sum + linear[r][c] * middle[c], 0)) as [number, number, number];
  return { linear, offset };
}
