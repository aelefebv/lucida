/**
 * The volume overlay's draw list, asserted with a camera of the test's own:
 * the boxes go through the shared draw-list function, each box's edges and
 * silhouette follow its projected corners, a chunk is one color as a cell
 * and as a box, and the pointer picks the box in front. No browser, no
 * cache, no recorder.
 */

import { describe, expect, it } from "vitest";

import { PHASE_COLORS, ROW_STATE_COLORS, withAlpha } from "../monitor/timelinePalette.ts";
import { lookupChunk } from "../trace/diagnose/chunkLookup.ts";
import { chunkIdentity, deriveChunkStates, type ChunkStates } from "../trace/diagnose/chunkStates.ts";
import { selectChunks } from "../trace/diagnose/chunkSelection.ts";
import { healthyLocalOpen, lateStallOpen, refetchLoopSteadyState, saturatedReopen } from "../trace/diagnose/fixtures.ts";
import type { TraceRun } from "../trace/types.ts";
import {
  buildChunkDrawList,
  CELL_BORDER,
  churnBand,
  describeHoverInspector,
  NO_ROW_FILL,
  overlayAbsence,
  PHASE_FILL_ALPHA,
  type ChunkCell,
  type ChunkDrawItem,
  type OverlayModes,
  type ScreenPoint,
} from "./overlayDrawList.ts";
import {
  BOX_EDGES,
  boxHull,
  boxPath,
  buildVolumeDrawList,
  hitTestBox,
  hullContains,
  isVolumeDrawItem,
  NO_ROW_DASH,
  NO_ROW_STROKE,
  projectChunkBox,
  WIREFRAME_ALPHA,
  wireframeStyle,
  type Projector,
  type Vec3,
} from "./volumeWireframe.ts";

const OFF: OverlayModes = {
  chunkTier: false,
  cachedTier: false,
  plannedRank: false,
  phaseColor: false,
  churnTint: false,
};

/**
 * A pinhole camera on the z axis, `distance` in front of the origin and
 * looking along +z, turned about the y axis by `yaw` so a box's silhouette
 * is not its screen rectangle. A point at or behind the camera is null.
 */
function perspective(opts: { yaw?: number; distance?: number; focal?: number } = {}): Projector {
  const yaw = opts.yaw ?? 0;
  const distance = opts.distance ?? 200;
  const focal = opts.focal ?? 400;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return (vx, vy, vz) => {
    const x = vx * cos + vz * sin;
    const z = -vx * sin + vz * cos + distance;
    if (z <= 0) return null;
    return [400 + (focal * x) / z, 300 + (focal * vy) / z];
  };
}

function squaredDistanceFromCamera(min: Vec3, max: Vec3, distance = 200): number {
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2 + distance;
  return cx * cx + cy * cy + cz * cz;
}

/** A cell for one of the fixture's rows, with its box projected through `project`. */
function box(
  project: Projector,
  y: number,
  min: Vec3,
  max: Vec3,
  overrides: Partial<ChunkCell> = {},
): ChunkCell {
  const projected = projectChunkBox(project, min, max);
  if (!projected) throw new Error("box is behind the camera");
  return {
    key: `ds/member-${y % 8}/detail/1/0/0/0/${y}/0`,
    datasetId: "ds",
    entityId: `member-${y % 8}`,
    chunkKey: `1/0/0/0/${y}/0`,
    level: 1,
    t: 0,
    c: 0,
    z: 0,
    y,
    x: 0,
    left: projected.left,
    top: projected.top,
    width: projected.width,
    height: projected.height,
    corners: projected.corners,
    depth: squaredDistanceFromCamera(min, max),
    status: "cached",
    sourceTier: "detail",
    ...overrides,
  };
}

function readerOver(states: ChunkStates) {
  return (c: ChunkCell) => states.byIdentity.get(chunkIdentity(c.datasetId, c.entityId, c.chunkKey)) ?? null;
}

function inputOver(run: TraceRun, cells: ChunkCell[], modes: Partial<OverlayModes>) {
  const states = deriveChunkStates(run);
  return {
    states,
    input: { cells, modes: { ...OFF, ...modes }, readingOf: readerOver(states), windowMs: states.windowMs },
  };
}

function rgb(color: string): string {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(color);
  if (!m) throw new Error(`not a color: ${color}`);
  return `${m[1]},${m[2]},${m[3]}`;
}

function alpha(color: string): number {
  const m = /, ([\d.]+)\)$/.exec(color);
  if (!m) throw new Error(`no alpha: ${color}`);
  return Number.parseFloat(m[1]);
}

function segments(path: string): number {
  return path.split("M").length - 1;
}

const shared = (item: ChunkDrawItem) => ({
  key: item.key,
  left: item.left,
  top: item.top,
  width: item.width,
  height: item.height,
  fill: item.fill,
  border: item.border,
  status: item.status,
  tooltip: item.tooltip,
  reading: item.reading,
  cell: item.cell,
});

describe("projecting a chunk box", () => {
  it("projects the eight corners through the camera and bounds them", () => {
    const project = perspective();
    const projected = projectChunkBox(project, [0, 0, 0], [10, 20, 30])!;

    expect(projected.corners).toHaveLength(8);
    expect(projected.corners[0]).toEqual(project(0, 0, 0));
    expect(projected.corners[1]).toEqual(project(10, 0, 0));
    expect(projected.corners[2]).toEqual(project(0, 20, 0));
    expect(projected.corners[4]).toEqual(project(0, 0, 30));
    expect(projected.corners[7]).toEqual(project(10, 20, 30));

    const xs = projected.corners.map((c) => c![0]);
    const ys = projected.corners.map((c) => c![1]);
    expect(projected.left).toBe(Math.min(...xs));
    expect(projected.top).toBe(Math.min(...ys));
    expect(projected.left + projected.width).toBe(Math.max(...xs));
    expect(projected.top + projected.height).toBe(Math.max(...ys));
    // Perspective: the near face is the larger one.
    expect(project(10, 20, 0)![0] - project(0, 0, 0)![0]).toBeGreaterThan(project(10, 20, 30)![0] - project(0, 0, 30)![0]);
  });

  it("leaves a corner behind the camera null and drops a box wholly behind it", () => {
    const project = perspective({ distance: 5 });
    const straddling = projectChunkBox(project, [0, 0, -10], [10, 10, 10])!;
    expect(straddling.corners.slice(0, 4)).toEqual([null, null, null, null]);
    expect(straddling.corners.slice(4).every((c) => c !== null)).toBe(true);
    expect(segments(boxPath(straddling.corners))).toBe(4);

    expect(projectChunkBox(project, [0, 0, -30], [10, 10, -20])).toBeNull();
  });
});

describe("the volume draw list", () => {
  it("is the shared draw list over the projected cells, with each box's edges and silhouette added", () => {
    const project = perspective({ yaw: 0.5 });
    const cells = [
      box(project, 0, [0, 0, 0], [10, 10, 10]),
      box(project, 300, [10, 0, 0], [20, 10, 10], { status: "planned" }),
    ];
    const { input } = inputOver(saturatedReopen(), cells, { phaseColor: true });

    const volume = buildVolumeDrawList(input);
    const flat = buildChunkDrawList(input);

    expect(volume.items.map(shared)).toEqual(flat.items.map(shared));
    expect(volume.withRow).toBe(flat.withRow);
    expect(volume.churned).toBe(flat.churned);
    // Row 0 completed; row 300 is still in the queue.
    expect(volume.items[0].fill).toBe(withAlpha(ROW_STATE_COLORS.complete, PHASE_FILL_ALPHA));
    expect(volume.items[1].fill).toBe(withAlpha(PHASE_COLORS.queue, PHASE_FILL_ALPHA));

    for (const item of volume.items) {
      expect(isVolumeDrawItem(item)).toBe(true);
      const corners = item.cell.corners!;
      expect(item.path).toBe(boxPath(corners));
      expect(segments(item.path)).toBe(BOX_EDGES.length);
      for (const [a, b] of BOX_EDGES) {
        const p = corners[a]!;
        const q = corners[b]!;
        expect(item.path).toContain(`M${p[0].toFixed(1)} ${p[1].toFixed(1)} L${q[0].toFixed(1)} ${q[1].toFixed(1)}`);
      }
      expect(item.hull).toEqual(boxHull(corners));
      for (const c of corners) expect(hullContains(item.hull, c![0], c![1])).toBe(true);
    }
  });

  it("batches the boxes by style, so the layer draws a path per style rather than per box", () => {
    const project = perspective();
    const run = refetchLoopSteadyState(healthyLocalOpen());
    const cells = [
      box(project, 0, [0, 0, 0], [10, 10, 10], { key: "loop-0", entityId: "member-1", chunkKey: "1/0/0/0/0/0" }),
      box(project, 5, [10, 0, 0], [20, 10, 10], { key: "loop-5", entityId: "member-1", chunkKey: "1/0/0/0/5/0" }),
      box(project, 999, [20, 0, 0], [30, 10, 10], { key: "none" }),
      box(project, 1, [30, 0, 0], [40, 10, 10], { key: "loop-1", entityId: "member-1", chunkKey: "1/0/0/0/1/0" }),
    ];
    const { batches, items } = buildVolumeDrawList(inputOver(run, cells, { phaseColor: true, churnTint: true }).input);

    expect(batches.map((b) => b.count)).toEqual([3, 1]);
    expect(batches[0].style).toEqual(items[0].style);
    expect(batches[0].d).toBe([items[0].path, items[1].path, items[3].path].join(" "));
    expect(batches[1].style.stroke).toBe(NO_ROW_STROKE);
    expect(batches[1].d).toBe(items[2].path);
  });

  it("batches the brushed selection apart, with the selection's border as a white halo on every box in it", () => {
    // The late-stall run: rows 0 to 59 in the first second, 60 to 99 after 1.1 s.
    const project = perspective();
    const run = lateStallOpen();
    const cells = [
      box(project, 0, [0, 0, 0], [10, 10, 10]),
      box(project, 70, [10, 0, 0], [20, 10, 10]),
      box(project, 71, [20, 0, 0], [30, 10, 10]),
    ];
    const { input } = inputOver(run, cells, { phaseColor: true });
    const selection = selectChunks(run, { startMs: 1_100, endMs: 2_000 });

    const list = buildVolumeDrawList({ ...input, selection });

    expect(list.selected).toBe(2);
    expect(list.items.map((item) => item.selected)).toEqual([false, true, true]);
    expect(list.batches.map((b) => [b.selected, b.count])).toEqual([
      [false, 1],
      [true, 2],
    ]);
    // The phase color stays on the edge; the selection rides under it as the halo.
    expect(list.batches[1].style.stroke).toBe(list.items[1].style.stroke);
    expect(list.batches[1].style.halo).toEqual({ stroke: "rgba(255, 255, 255, 0.95)", strokeWidth: 2 + 2 });
    expect(list.batches[0].style.halo).toBeNull();
    expect(list.batches[1].d).toBe([list.items[1].path, list.items[2].path].join(" "));
  });

  it("draws a cell without corners as its rectangle, so the list is total", () => {
    const flatCell: ChunkCell = { ...box(perspective(), 0, [0, 0, 0], [10, 10, 10]), corners: undefined, depth: undefined };
    flatCell.left = 10;
    flatCell.top = 20;
    flatCell.width = 30;
    flatCell.height = 40;
    const { input } = inputOver(healthyLocalOpen(), [flatCell], {});
    const [item] = buildVolumeDrawList(input).items;
    expect(segments(item.path)).toBe(4);
    expect(item.hull).toEqual([[10, 20], [40, 20], [40, 60], [10, 60]]);
    expect(hitTestBox([item], 25, 40)).toBe(item);
  });
});

describe("a chunk is one color as a cell and as a box", () => {
  const modes: Partial<OverlayModes>[] = [
    {},
    { chunkTier: true },
    { cachedTier: true },
    { plannedRank: true },
    { phaseColor: true },
    { churnTint: true },
    { phaseColor: true, churnTint: true },
  ];

  it.each(modes)("in mode %o the edge is the cell's fill at the wireframe alpha", (mode) => {
    const project = perspective();
    const run = refetchLoopSteadyState(healthyLocalOpen());
    const cells = [
      box(project, 0, [0, 0, 0], [10, 10, 10], { status: "cached", tier: "prefetch" }),
      box(project, 1, [10, 0, 0], [20, 10, 10], { status: "in-flight", entityId: "member-1", chunkKey: "1/0/0/0/1/0" }),
      box(project, 2, [20, 0, 0], [30, 10, 10], { status: "planned", priorityRank: 3, sourceTier: "coarse" }),
      box(project, 3, [30, 0, 0], [40, 10, 10], { sourceTier: "missing" }),
    ];
    const { input } = inputOver(run, cells, mode);
    const volume = buildVolumeDrawList(input);
    const flat = buildChunkDrawList(input);

    for (let i = 0; i < flat.items.length; i++) {
      const cell = flat.items[i];
      const item = volume.items[i];
      expect(item.style.dash).toBe(cell.border.includes("dashed") ? NO_ROW_DASH : null);
      if (cell.fill === NO_ROW_FILL) {
        expect(item.style.stroke).toBe(NO_ROW_STROKE);
        continue;
      }
      expect(rgb(item.style.stroke)).toBe(rgb(cell.fill));
      expect(alpha(item.style.stroke)).toBe(WIREFRAME_ALPHA);
    }
  });

  it("keeps a chunk the window never fetched apart from a chunk with no row, as the cell's border does", () => {
    const project = perspective();
    // Row 300 of the saturated reopen is in the queue: a row, and no fetch.
    const queued = box(project, 300, [0, 0, 0], [10, 10, 10]);
    const absent = box(project, 999, [10, 0, 0], [20, 10, 10]);
    const { input } = inputOver(saturatedReopen(), [queued, absent], { churnTint: true });
    const [queuedItem, absentItem] = buildVolumeDrawList(input).items;

    expect(queuedItem.reading?.fetches).toBe(0);
    expect(queuedItem.fill).toBe(NO_ROW_FILL);
    expect(queuedItem.style).toEqual({ stroke: NO_ROW_STROKE, strokeWidth: 1, dash: null, halo: null });
    expect(queuedItem.tooltip).toContain("fetched 0×");

    expect(absentItem.reading).toBeNull();
    expect(absentItem.style).toEqual({ stroke: NO_ROW_STROKE, strokeWidth: 1, dash: NO_ROW_DASH, halo: null });
    expect(absentItem.tooltip).toContain("no row in the open interval");
  });

  it("draws a churn band as a halo under the edge, so churn survives beside a phase color", () => {
    const project = perspective();
    const run = refetchLoopSteadyState(healthyLocalOpen());
    const looped = box(project, 0, [0, 0, 0], [10, 10, 10], {
      key: "loop-0",
      entityId: "member-1",
      chunkKey: "1/0/0/0/0/0",
    });
    const three = churnBand(3)!;

    const both = buildVolumeDrawList(inputOver(run, [looped], { phaseColor: true, churnTint: true }).input).items[0];
    expect(rgb(both.style.stroke)).toBe(rgb(withAlpha(ROW_STATE_COLORS.complete, 1)));
    expect(both.style.strokeWidth).toBe(2);
    expect(both.style.halo).toEqual({ stroke: "rgba(255, 140, 70, 0.9)", strokeWidth: 4 });
    expect(three.border).toContain(both.style.halo!.stroke);

    // Churn alone carries the band in the fill, with the default border, so the edge is the band and there is no halo.
    const churnOnly = buildVolumeDrawList(inputOver(run, [looped], { churnTint: true }).input).items[0];
    expect(rgb(churnOnly.style.stroke)).toBe(rgb(three.fill));
    expect(churnOnly.style.halo).toBeNull();

    expect(wireframeStyle({ fill: "rgba(1, 2, 3, 0.3)", border: CELL_BORDER })).toEqual({
      stroke: "rgba(1, 2, 3, 0.9)",
      strokeWidth: 1,
      dash: null,
      halo: null,
    });
  });
});

describe("the box under the pointer", () => {
  it("tests the silhouette, not the screen rectangle", () => {
    const project = perspective({ yaw: 0.9 });
    const [item] = buildVolumeDrawList(
      inputOver(healthyLocalOpen(), [box(project, 0, [-20, -20, -20], [20, 20, 20])], {}).input,
    ).items;
    // A turned box's silhouette is a hexagon inside its rectangle: the
    // rectangle's corners are outside it.
    expect(item.hull.length).toBeGreaterThanOrEqual(6);
    expect(hitTestBox([item], item.left + 0.5, item.top + 0.5)).toBeNull();
    const center = project(0, 0, 0)!;
    expect(hitTestBox([item], center[0], center[1])).toBe(item);
  });

  it("picks the box nearest the camera along a line of sight, and the finest level over a coarser one behind it", () => {
    const project = perspective();
    const near = box(project, 0, [-5, -5, 0], [5, 5, 10], { key: "near" });
    const far = box(project, 1, [-5, -5, 40], [5, 5, 50], { key: "far" });
    const coarse = box(project, 2, [-40, -40, -20], [40, 40, 60], { key: "coarse", level: 2, sourceTier: "coarse" });
    const proxy = box(project, 3, [-80, -80, -20], [80, 80, 60], { key: "proxy", level: -1, proxyAsset: true });
    expect(near.depth!).toBeLessThan(far.depth!);

    const items = buildVolumeDrawList(inputOver(healthyLocalOpen(), [far, coarse, proxy, near], {}).input).items;
    expect(hitTestBox(items, 400, 300)?.key).toBe("near");
    expect(hitTestBox([...items].reverse(), 400, 300)?.key).toBe("near");
    // Off the two detail boxes but inside the coarse one: the coarse box, never the proxy rectangle.
    const edge = project(-30, 0, 20)!;
    expect(hitTestBox(items, edge[0], edge[1])?.key).toBe("coarse");
    const outside = project(-70, 0, 20)!;
    expect(hitTestBox(items, outside[0], outside[1])).toBeNull();
  });

  it("opens the same inspector a cell opens, from the same item", () => {
    const project = perspective();
    const run = healthyLocalOpen();
    const cells = [box(project, 119, [0, 0, 0], [10, 10, 10])];
    const { input, states } = inputOver(run, cells, { phaseColor: true, churnTint: true });
    const lookup = lookupChunk(run, "member-7/1/0/0/0/119/0", "under the pointer");

    const fromBox = describeHoverInspector(buildVolumeDrawList(input).items[0], lookup, states.windowMs);
    const fromCell = describeHoverInspector(buildChunkDrawList(input).items[0], lookup, states.windowMs);
    expect(fromBox).toEqual(fromCell);
    expect(fromBox.title).toBe("member-7 · 1/0/0/0/119/0");
    expect(fromBox.lines[1]).toBe("phase: complete · present took 2 ms");
  });

  it("captions an empty picture the same way", () => {
    const project = perspective();
    const modes = { ...OFF, phaseColor: true };
    const { input, states } = inputOver(healthyLocalOpen(), [box(project, 999, [0, 0, 0], [10, 10, 10])], modes);
    const volume = buildVolumeDrawList(input);
    expect(overlayAbsence(modes, volume, states.windowMs)).toBe(
      overlayAbsence(modes, buildChunkDrawList(input), states.windowMs),
    );
    expect(overlayAbsence(modes, volume, states.windowMs)).toContain("no chunk on screen has a row");
  });
});

describe("the hull", () => {
  it("is the convex hull of the corners that projected, and contains its own points", () => {
    const corners: (ScreenPoint | null)[] = [[0, 0], [10, 0], [0, 10], [10, 10], [5, 5], null, [2, 8], [12, 5]];
    const hull = boxHull(corners);
    expect(hull).toHaveLength(5);
    for (const c of corners) if (c) expect(hullContains(hull, c[0], c[1])).toBe(true);
    expect(hullContains(hull, 11.5, 0.5)).toBe(false);
    expect(hullContains([[0, 0], [1, 1]], 0.5, 0.5)).toBe(false);
  });
});
