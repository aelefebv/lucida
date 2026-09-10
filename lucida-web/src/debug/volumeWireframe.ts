/**
 * The overlay in volume mode: chunk boxes as wireframes, colored by the same
 * states as the slice overlay's cells.
 *
 * The draw list is the slice overlay's. {@link buildVolumeDrawList} calls the
 * same function over cells that carry their eight projected corners, so a
 * box wears the fill, the border, the tooltip and the reading the same chunk
 * would wear as a cell, and the hover inspector reads the item as it is.
 * What this module adds is the geometry a box needs that a rectangle does
 * not: the path through its twelve edges, the silhouette the pointer is
 * tested against, and a stroke derived from the cell's fill and border, so
 * a chunk in the wire phase is one color as a cell and as a box.
 *
 * Everything here is pure. The component projects each box through the
 * camera with {@link projectChunkBox} and hands the cells in; a test hands
 * in a camera of its own.
 */

import {
  buildChunkDrawList,
  CELL_BORDER,
  NO_ROW_FILL,
  type BoxCorners,
  type ChunkDrawItem,
  type ChunkDrawList,
  type DrawListInput,
  type ScreenPoint,
} from "./overlayDrawList.ts";

export type Vec3 = readonly [number, number, number];

/** Tile-local voxel coordinates to CSS pixels on the canvas, or null behind the camera. */
export type Projector = (vx: number, vy: number, vz: number) => ScreenPoint | null;

/** The twelve edges of a box, as pairs of corner indices that differ in one bit. */
export const BOX_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export interface ProjectedBox {
  corners: BoxCorners;
  /** The bounds of the corners that projected: the rectangle the cell carries. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A chunk box through the camera: each corner projected, and the bounds of
 * the ones in front of it. Null when no corner is, so the box is not drawn.
 */
export function projectChunkBox(project: Projector, min: Vec3, max: Vec3): ProjectedBox | null {
  const corners: (ScreenPoint | null)[] = new Array(8);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let any = false;
  for (let i = 0; i < 8; i++) {
    const p = project(i & 1 ? max[0] : min[0], (i >> 1) & 1 ? max[1] : min[1], (i >> 2) & 1 ? max[2] : min[2]);
    corners[i] = p;
    if (!p) continue;
    any = true;
    if (p[0] < left) left = p[0];
    if (p[0] > right) right = p[0];
    if (p[1] < top) top = p[1];
    if (p[1] > bottom) bottom = p[1];
  }
  if (!any) return null;
  return { corners, left, top, width: right - left, height: bottom - top };
}

/** How opaque a box's edges are. A cell's fill is painted over pixels at a third of this; an edge has no area to spare. */
export const WIREFRAME_ALPHA = 0.9;
/**
 * The edge of a box a trace-reading mode leaves uncolored: dim white, and
 * dashed when the cell's border is, which is when the chunk has no row.
 * A chunk with a row the window never fetched keeps a solid edge, as its
 * cell keeps a solid border.
 */
export const NO_ROW_STROKE = "rgba(255, 255, 255, 0.45)";
export const NO_ROW_DASH = "3 3";
const HALO_EXTRA_WIDTH = 2;

export interface WireframeStyle {
  /** The edge color: the cell's fill at {@link WIREFRAME_ALPHA}. */
  stroke: string;
  strokeWidth: number;
  /** A dash pattern for a box with no row, or null for a solid edge. */
  dash: string | null;
  /**
   * A wider stroke drawn under the edges in the border's own color, when
   * the border carries a state the fill does not: a churn band under a
   * phase color. Null when the border is the default.
   */
  halo: { stroke: string; strokeWidth: number } | null;
}

const RGBA = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/;
const BORDER = /^([\d.]+)px (solid|dashed) (.+)$/;

/** A cell's fill and border as a box's edges: one stroke, dashed when the cell has no row, with a halo when the border says something the fill does not. */
export function wireframeStyle(item: Pick<ChunkDrawItem, "fill" | "border">): WireframeStyle {
  const border = BORDER.exec(item.border);
  const width = border ? Number.parseFloat(border[1]) : 1;
  const dashed = border ? border[2] === "dashed" : false;
  const dash = dashed ? NO_ROW_DASH : null;
  if (item.fill === NO_ROW_FILL) {
    return { stroke: NO_ROW_STROKE, strokeWidth: 1, dash, halo: null };
  }
  const banded = border !== null && !dashed && item.border !== CELL_BORDER;
  return {
    stroke: strokeOf(item.fill),
    strokeWidth: width,
    dash,
    halo: banded && border ? { stroke: border[3], strokeWidth: width + HALO_EXTRA_WIDTH } : null,
  };
}

function strokeOf(fill: string): string {
  const m = RGBA.exec(fill);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${WIREFRAME_ALPHA})` : fill;
}

/**
 * SVG path data through the edges whose two corners both projected. Each
 * corner is written out once and shared by its three edges: turning a
 * number into text is most of what a poll's paths cost, and a box has
 * sixteen numbers, not forty-eight. An edge whose two corners write the
 * same text has no length and is left out.
 */
export function boxPath(corners: BoxCorners): string {
  const labels: (string | null)[] = new Array(8);
  for (let i = 0; i < 8; i++) {
    const c = corners[i];
    labels[i] = c ? `${c[0].toFixed(1)} ${c[1].toFixed(1)}` : null;
  }
  let d = "";
  for (const [a, b] of BOX_EDGES) {
    const p = labels[a];
    const q = labels[b];
    if (!p || !q || p === q) continue;
    d += `${d ? " M" : "M"}${p} L${q}`;
  }
  return d;
}

/**
 * The box's silhouette on screen: the convex hull of the corners that
 * projected. A projected box is convex, so its silhouette is exactly this,
 * and a point inside it is over the box where a point inside the box's
 * screen rectangle need not be.
 */
export function boxHull(corners: BoxCorners): ScreenPoint[] {
  // At most eight points, so an insertion sort beats a comparator sort.
  const points: ScreenPoint[] = [];
  for (const c of corners) {
    if (!c) continue;
    let i = points.length;
    while (i > 0 && (points[i - 1][0] > c[0] || (points[i - 1][0] === c[0] && points[i - 1][1] > c[1]))) {
      points[i] = points[i - 1];
      i--;
    }
    points[i] = c;
  }
  const n = points.length;
  if (n < 3) return points;
  const hull: ScreenPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  const lowerEnd = hull.length + 1;
  for (let i = n - 2; i >= 0; i--) {
    const p = points[i];
    while (hull.length >= lowerEnd && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
    hull.push(p);
  }
  hull.pop();
  return hull;
}

function cross(o: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Whether a point is inside or on a convex polygon. False for a hull of fewer than three points. */
export function hullContains(hull: readonly ScreenPoint[], x: number, y: number): boolean {
  const n = hull.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const side = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (side === 0) continue;
    const s = side > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface VolumeDrawItem extends ChunkDrawItem {
  /** The box's visible edges, as SVG path data. */
  path: string;
  /** The box's silhouette, for the hit test. */
  hull: readonly ScreenPoint[];
  style: WireframeStyle;
}

/**
 * The boxes that share one style, as one path. A poll can hold six hundred
 * boxes and a handful of styles, so the layer draws a path per style
 * rather than a path per box, and the box the inspector describes is the
 * one drawn on its own.
 */
export interface WireframeBatch {
  style: WireframeStyle;
  /**
   * True when the batch's boxes are in the published selection. A selected
   * cell wears the selection's border, so its boxes never share a style,
   * and so a batch, with an unselected one; the layer fades the batches
   * that are not selected while a window is brushed, as it fades the cells.
   */
  selected: boolean;
  /** The path data of every box in the batch, one after another. */
  d: string;
  /** How many boxes the batch holds. */
  count: number;
}

export interface VolumeDrawList extends ChunkDrawList {
  items: VolumeDrawItem[];
  /** The items batched by style, in the order each style first appears. */
  batches: WireframeBatch[];
}

export function isVolumeDrawItem(item: ChunkDrawItem): item is VolumeDrawItem {
  return "hull" in item;
}

export function isVolumeDrawList(list: ChunkDrawList): list is VolumeDrawList {
  return "batches" in list;
}

/**
 * The volume overlay's draw list: the shared draw list over cells that
 * carry their projected corners, with each item's edges, silhouette and
 * stroke added, and the items batched by style. A cell without corners is
 * drawn as its rectangle, so the list is total over whatever the caller
 * projected.
 */
export function buildVolumeDrawList(input: DrawListInput): VolumeDrawList {
  const list = buildChunkDrawList(input);
  const items: VolumeDrawItem[] = new Array(list.items.length);
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    const corners = item.cell.corners ?? rectangleCorners(item);
    items[i] = { ...item, path: boxPath(corners), hull: boxHull(corners), style: wireframeStyle(item) };
  }
  return {
    items,
    batches: batchWireframes(items),
    withRow: list.withRow,
    churned: list.churned,
    selected: list.selected,
  };
}

/** Items with one style, in the order the style first appears, each batch's path being its items' paths joined. */
export function batchWireframes(items: readonly VolumeDrawItem[]): WireframeBatch[] {
  const byStyle = new Map<string, { style: WireframeStyle; selected: boolean; paths: string[] }>();
  for (const item of items) {
    if (!item.path) continue;
    const { style, selected } = item;
    const key = `${selected}|${style.stroke}|${style.strokeWidth}|${style.dash}|${style.halo?.stroke}|${style.halo?.strokeWidth}`;
    let batch = byStyle.get(key);
    if (!batch) {
      batch = { style, selected, paths: [] };
      byStyle.set(key, batch);
    }
    batch.paths.push(item.path);
  }
  const out: WireframeBatch[] = [];
  for (const { style, selected, paths } of byStyle.values()) {
    out.push({ style, selected, d: paths.join(" "), count: paths.length });
  }
  return out;
}

/** A rectangle as the near face of a box with no far face, so only its four edges draw. */
function rectangleCorners(rect: { left: number; top: number; width: number; height: number }): BoxCorners {
  const l = rect.left;
  const t = rect.top;
  const r = rect.left + rect.width;
  const b = rect.top + rect.height;
  return [[l, t], [r, t], [l, b], [r, b], null, null, null, null];
}

/**
 * The box under a point, or null. Boxes overlap far more than cells do: a
 * volume is a stack of them along every line of sight, and a coarse box
 * sits behind the detail boxes it covers. The finest level wins, because it
 * is the most specific thing the pointer is over, and among boxes at one
 * level the one nearest the camera wins, because it is the one in front.
 * Proxy-asset rectangles are not chunks and are passed over. An item
 * without a silhouette is tested as its rectangle.
 */
export function hitTestBox<T extends ChunkDrawItem>(items: readonly T[], x: number, y: number): T | null {
  let best: T | null = null;
  let bestLevel = Number.POSITIVE_INFINITY;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.cell.proxyAsset) continue;
    const inside =
      isVolumeDrawItem(item) && item.hull.length >= 3
        ? hullContains(item.hull, x, y)
        : x >= item.left && y >= item.top && x <= item.left + item.width && y <= item.top + item.height;
    if (!inside) continue;
    const level = item.cell.level;
    const depth = item.cell.depth ?? Number.POSITIVE_INFINITY;
    if (level < bestLevel || (level === bestLevel && depth < bestDepth)) {
      best = item;
      bestLevel = level;
      bestDepth = depth;
    }
  }
  return best;
}
