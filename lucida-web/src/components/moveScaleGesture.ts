/**
 * What a Move and scale drag does to the scene frame, worked out in the slice
 * view's plane: across the screen, down it, and the cut. lucida-core turns
 * the map into the dataset's transform, so this never reads a placement.
 */
import { fromPlaneFrame, type SpatialAxis } from "../renderer/slicePlane.ts";
import { moveBy, scaleAbout, type SceneMap } from "../userTransform.ts";

/** A corner of the outline, by compass point; Y points down the screen. */
export type Corner = "nw" | "ne" | "se" | "sw";

export const CORNERS: readonly Corner[] = ["nw", "ne", "se", "sw"];

/** An outline in the plane, `[min across, min down, max across, max down]`. */
export type PlaneRect = readonly [number, number, number, number];

type Point = readonly [number, number];

/** Where `corner` of `rect` is. */
export function cornerPoint(rect: PlaneRect, corner: Corner): [number, number] {
  return [corner.endsWith("w") ? rect[0] : rect[2], corner.startsWith("n") ? rect[1] : rect[3]];
}

const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

/** The scene-frame map of a drag of the outline from `start` to `now`. */
export function moveMap(start: Point, now: Point, cut: SpatialAxis): SceneMap {
  return moveBy(fromPlaneFrame([now[0] - start[0], now[1] - start[1], 0], cut));
}

/**
 * The scene-frame map of a drag of `corner` from `start` to `now`, the
 * opposite corner held still. The corner travels as the pointer does, so a
 * press a little off the corner doesn't jump the outline to the pointer.
 * `uniform` scales every axis by one factor, the cut's too so the dataset
 * keeps its shape, about `cutOrigin`, where it starts along the cut;
 * otherwise each on-screen axis follows the pointer and the cut keeps its
 * size. Neither side shrinks below `minExtent` or turns over.
 */
export function scaleMap(
  rect: PlaneRect,
  corner: Corner,
  start: Point,
  now: Point,
  { uniform, cut, cutOrigin, minExtent }: {
    uniform: boolean;
    cut: SpatialAxis;
    cutOrigin: number;
    minExtent: number;
  },
): SceneMap {
  const anchor = cornerPoint(rect, OPPOSITE[corner]);
  const reach = cornerPoint(rect, corner);
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
