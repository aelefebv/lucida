/**
 * Lane emission and priority. Turns the active set, the level selection and
 * minimap-pending coords into one {@link ChunkRequest} stream per lane.
 *
 * A request's priority is its lane's band plus an in-lane term under one.
 * Lane offsets and prefetch steps are whole numbers, so every reader of the
 * priority (admission, the fetch queue, the CPU store's protection and
 * eviction, delivery order) sees one lane wholly before the next. The level
 * selection's fetch order, or for the coarse lane importance and distance
 * from the view's focus, order requests only within their band.
 */

import { Axis } from "../../axes.ts";
import { compareIds } from "../compareIds.ts";
import { sliceLevelPlane, tczyx, type PoolCut, type SliceCut, type SpatialAxis } from "../../renderer/slicePlane.ts";
import {
  MINIMAP_SEED_BULK_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  type PlanningConfig,
} from "./config.ts";
import { enumerateChunks, type ChunkEnumeration, type LevelQuery } from "./enumerate.ts";
import type { LaneCarry } from "./laneMemory.ts";
import { cellKey } from "./laneMemory.ts";
import type {
  ActiveSetEntry,
  ChunkRequest,
  DatasetView,
  EntityLevelSelection,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanStats,
  SelectedCell,
  SelectionState,
  TileEntry,
} from "./types.ts";

/** Priority gap between consecutive prefetch steps. */
const PREFETCH_STEP = 100;

/**
 * Whether the selection stepped along its cut since the previous plan: moved
 * along the same axis by no more than `bandPlanes`, the planes the slice view
 * fetches on each side of the one it draws, as a key or a scrub moves it,
 * rather than jumped. After a step the slice view fetches the whole chunks
 * its plane lies in, once, so the steps after it cost nothing.
 */
export function isCutStep(previousCut: SliceCut | null, selection: SelectionState, bandPlanes: number): boolean {
  if (selection.renderMode !== "slice" || previousCut === null) return false;
  if (previousCut.axis !== selection.cut.axis) return false;
  const moved = Math.abs(selection.cut.index - previousCut.index);
  return moved > 0 && moved <= bandPlanes;
}

/** Where the slice view's plane falls in one level's chunks. */
export interface PlaneInChunks {
  /** The axis the view cuts. */
  axis: SpatialAxis;
  /** The chunk index along that axis that holds the plane. */
  chunk: number;
  /** The plane, within that chunk. */
  plane: number;
  /** The band around it a fetch asks for, within that chunk. */
  planes: [number, number];
}

/**
 * Where plane `levelPlane` of a level `levelPlanes` deep along the cut falls
 * in its chunks, which are `depth` planes deep, with the band of
 * `bandPlanes` on each side that a fetch asks for. Null where the band would
 * be the whole chunk, which is then fetched whole.
 */
export function slicePlaneIn(
  levelPlane: number,
  levelPlanes: number,
  depth: number,
  bandPlanes: number,
  axis: SpatialAxis = "z",
): PlaneInChunks | null {
  if (!(depth > 1)) return null;
  const chunk = Math.floor(levelPlane / depth);
  const plane = levelPlane - chunk * depth;
  // An edge chunk's planes past the level are padding, never drawn.
  const held = Math.min(depth, levelPlanes - chunk * depth);
  const planes: [number, number] = [Math.max(0, plane - bandPlanes), Math.min(held, plane + bandPlanes + 1)];
  if (planes[1] - planes[0] >= depth) return null;
  return { axis, chunk, plane, planes };
}

/**
 * Where the slice view's plane falls at `level`, or null where the view
 * fetches whole chunks: in the volume view, at a level the server generates,
 * which it serves whole, and where the band would be the whole chunk. The
 * plane is the one the upload cuts (`sliceLevelPlane`), so the two agree.
 */
export function slicePlaneAt(
  entity: EntitySnapshot,
  level: number,
  snapshot: Pick<DatasetView, "selection">,
  config: PlanningConfig,
): PlaneInChunks | null {
  if (snapshot.selection.renderMode !== "slice" || !entity.sourceLevels.includes(level)) return null;
  const full = entity.levels[0];
  const geo = entity.levels[level];
  if (full === undefined || geo === undefined) return null;
  const { axis, index } = snapshot.selection.cut;
  const a = tczyx(axis);
  const levelPlane = sliceLevelPlane(index, full.shape[a], geo.shape[a]);
  return slicePlaneIn(levelPlane, geo.shape[a], geo.chunk_shape[a], config.sliceBandPlanes, axis);
}

/**
 * The plane of `level` the slice view cuts, which a slice pool holds of each
 * of its chunks there, or undefined in the volume view. Every level has one,
 * generated levels too, since the upload cuts the same plane from a whole
 * chunk (`sliceLevelPlane`).
 */
function poolCutAt(entity: EntitySnapshot, level: number, snapshot: DatasetView): PoolCut | undefined {
  if (snapshot.selection.renderMode !== "slice") return undefined;
  const full = entity.levels[0];
  const geo = entity.levels[level];
  if (full === undefined || geo === undefined) return undefined;
  const { axis, index } = snapshot.selection.cut;
  const a = tczyx(axis);
  return { axis, plane: sliceLevelPlane(index, full.shape[a], geo.shape[a]) };
}

/** A chunk's index along `axis`. */
function chunkAlong(axis: SpatialAxis, x: number, y: number, z: number): number {
  return axis === "x" ? x : axis === "y" ? y : z;
}

/**
 * The share of its band a lane's in-lane terms spread over. Under one, so a
 * lane never reaches the next whole-number band.
 */
const IN_LANE_SPAN = 0.5;

/** Canonical chunk key: "level/t/c/z/y/x". */
export function chunkKey(
  level: number,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): string {
  return `${level}/${t}/${c}/${z}/${y}/${x}`;
}

/**
 * The planner's request order: ascending priority (lower is more urgent),
 * then a spatial-first, channel-second tiebreak so equal-priority
 * multi-channel chunks interleave by cell instead of by channel.
 */
export function compareChunkRequests(a: ChunkRequest, b: ChunkRequest): number {
  const priority = a.priority - b.priority;
  if (priority !== 0) return priority;

  const image = compareIds(a.imageId, b.imageId);
  if (image !== 0) return image;

  return (
    a.level - b.level ||
    a.t - b.t ||
    a.z - b.z ||
    a.y - b.y ||
    a.x - b.x ||
    a.c - b.c ||
    compareIds(a.chunkKey, b.chunkKey)
  );
}

/**
 * Requests as the lanes emit them. `priority` holds the lane's band until
 * {@link LaneRequests.finish} adds each request's in-lane term, which needs
 * every key in the band.
 *
 * With a {@link LaneCarry}, a request the previous plan made alike is kept
 * as that plan made it ({@link keep}): its key still counts toward its
 * band's spread, so the requests emitted anew spread over the same range as
 * a plan emitting every request would, and it keeps its priority.
 */
export class LaneRequests {
  private readonly requests: ChunkRequest[] = [];
  /** Each request's in-lane key, lower first. */
  private readonly keys: number[] = [];
  /** Whether each request leads its band: see {@link lead}. */
  private readonly leading: boolean[] = [];
  private highestBand = -Infinity;
  /** The least and greatest key of each band's kept requests. */
  private readonly keptRange = new Map<number, [number, number]>();
  private readonly carry: LaneCarry | undefined;

  constructor(carry?: LaneCarry) {
    this.carry = carry;
  }

  /**
   * A request of `req.priority`'s band. Outside the detail lane, which keeps
   * by cell itself, one the previous plan made alike is kept in its place.
   */
  push(req: ChunkRequest, key: number): void {
    if (this.carry !== undefined && req.lane !== "detail" && this.carry.takeOther(req, req.priority) !== undefined) {
      this.keep(req.priority, key);
      return;
    }
    this.requests.push(req);
    this.keys.push(key);
    this.leading.push(false);
    if (req.priority > this.highestBand) this.highestBand = req.priority;
  }

  /** Requests of `band` the previous plan made, kept with their priorities, whose in-lane key is `key`. */
  keep(band: number, key: number): void {
    const range = this.keptRange.get(band);
    if (range === undefined) this.keptRange.set(band, [key, key]);
    else if (key < range[0]) range[0] = key;
    else if (key > range[1]) range[1] = key;
    if (band > this.highestBand) this.highestBand = band;
  }

  /**
   * The requests pushed since there were `count` go before the rest of their
   * bands, whatever their keys: the view under a gesture's.
   */
  lead(count: number): void {
    for (let i = count; i < this.leading.length; i++) this.leading[i] = true;
  }

  /** How many requests have been pushed. */
  get count(): number {
    return this.requests.length;
  }

  /** The requests pushed since there were `count`. */
  since(count: number): ChunkRequest[] {
    return this.requests.slice(count);
  }

  /** The highest band emitted so far, or -Infinity. */
  get topBand(): number {
    return this.highestBand;
  }

  /**
   * Place each request within its band by where its key falls between the
   * band's least and greatest, then sort into the planner's request order.
   * Equal keys get equal priorities, so the identity tiebreak still applies.
   * A band that holds leading requests gives them the first part of its
   * span, under half, and the rest the second half, each spread by its keys.
   */
  finish(): ChunkRequest[] {
    const range = new Map<string, [number, number]>();
    const split = new Map<number, number>();
    const group = (i: number): string => `${this.requests[i].priority}|${this.leading[i] ? 1 : 0}`;
    // Kept requests never lead: a view that leads plans beside another, and
    // such a plan keeps nothing.
    for (const [band, keys] of this.keptRange) {
      range.set(`${band}|0`, [keys[0], keys[1]]);
      split.set(band, 2);
    }
    for (let i = 0; i < this.requests.length; i++) {
      const band = this.requests[i].priority;
      split.set(band, (split.get(band) ?? 0) | (this.leading[i] ? 1 : 2));
      const key = this.keys[i];
      const seen = range.get(group(i));
      if (seen === undefined) range.set(group(i), [key, key]);
      else if (key < seen[0]) seen[0] = key;
      else if (key > seen[1]) seen[1] = key;
    }
    for (let i = 0; i < this.requests.length; i++) {
      const req = this.requests[i];
      const [least, greatest] = range.get(group(i))!;
      const halves = split.get(req.priority) === 3;
      const start = halves && !this.leading[i] ? IN_LANE_SPAN / 2 : 0;
      const width = halves ? (this.leading[i] ? 0.99 : 1) * (IN_LANE_SPAN / 2) : IN_LANE_SPAN;
      req.priority += start;
      if (greatest > least) req.priority += (width * (this.keys[i] - least)) / (greatest - least);
    }
    return this.requests.sort(compareChunkRequests);
  }
}

/**
 * A coarse request's place within its lane: more important entities first,
 * then chunks nearer the view's focus. The detail and prefetch lanes rank by
 * the level selection's fetch order instead.
 */
function inLaneKey(entity: EntitySnapshot, distance: number, config: PlanningConfig): number {
  return (1.0 - entity.importance) * config.importanceWeight + distance * config.distanceWeight;
}

/** One visible tile: what the level selection chose for it, and its coarse query into the plan's enumeration. */
export interface TileChunks {
  entry: TileEntry;
  entity: EntitySnapshot;
  /** The level selection's cells for the tile, or undefined when it chose none. */
  chosen: EntityLevelSelection | undefined;
  coarse: number | null;
  /** Future timepoints the prefetch lane steps through, nearest first. */
  timepointSteps: number;
}

/** What one plan's lanes draw on: the selection per tile and the coarse lane's enumeration. */
export interface PlanChunks {
  tiles: TileChunks[];
  found: ChunkEnumeration;
}

/**
 * Enumerate, in one call into the core, the coarse level of every visible
 * tile. The detail and prefetch lanes take their chunks from the level
 * selection, which already enumerated them within the budget.
 */
export function enumeratePlanChunks(
  activeSet: readonly ActiveSetEntry[],
  snapshot: DatasetView,
  entityById: ReadonlyMap<string, EntitySnapshot>,
  config: PlanningConfig,
): PlanChunks {
  const queries: LevelQuery[] = [];
  const tiles: TileChunks[] = [];
  for (const entry of activeSet) {
    if (entry.kind !== "tile") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;
    const chosen = snapshot.levelSelection.entities.get(entry.entityId);
    const coarse = entry.coarseLevel === null
      ? null
      : queries.push({ entity, level: entry.coarseLevel, radiusView: config.coarseRenderRadiusView }) - 1;

    // The prefetch lane's budget is `prefetchDepth` steps. The selection's
    // lookahead takes the last step when it has one.
    const allowed = (chosen?.lookahead.length ?? 0) > 0 ? config.prefetchDepth - 1 : config.prefetchDepth;
    const timepoints = entity.levels[0]?.grid_shape[Axis.T] ?? 0;
    const timepointSteps = Math.max(0, Math.min(allowed, timepoints - 1 - snapshot.selection.t));
    tiles.push({ entry, entity, chosen, coarse, timepointSteps });
  }
  const found = enumerateChunks(snapshot.visibleRegion, config.depthBiasView, queries);
  return { tiles, found };
}

/** A lane's sink for requests and their in-lane keys. */
type Push = (req: ChunkRequest, key: number) => void;

/** Where one lane's requests go: its lane, tier and band, and the slice view's plane at the level. */
interface LaneTarget {
  lane: ChunkRequest["lane"];
  tier: ChunkRequest["tier"];
  band: number;
  t: number;
  /** With it, a chunk that holds the slice view's plane asks for that plane and fetches the band around it. */
  slice: PlaneInChunks | null;
  /** Keep only the chunks that hold the plane, and ask for each whole. */
  whole: boolean;
  /** The plane of the level the slice view cuts, which its pools hold ({@link poolCutAt}). */
  cut: PoolCut | undefined;
}

/**
 * Push one request per channel for the chunk at `level`, `[x, y, z]`.
 * Channels are innermost so equal-priority multi-channel chunks interleave
 * by cell.
 */
function emitChunk(
  entity: EntitySnapshot,
  level: number,
  x: number,
  y: number,
  z: number,
  key: number,
  snapshot: DatasetView,
  target: LaneTarget,
  push: Push,
): void {
  const { slice, whole, cut } = target;
  const holdsPlane = slice !== null && chunkAlong(slice.axis, x, y, z) === slice.chunk;
  if (whole && !holdsPlane) return;
  for (const c of snapshot.selection.visibleChannels) {
    const req: ChunkRequest = {
      datasetId: snapshot.datasetId,
      entityId: entity.entityId,
      imageId: entity.imageId,
      level,
      t: target.t,
      c,
      z,
      y,
      x,
      lane: target.lane,
      tier: target.tier,
      mode: snapshot.selection.renderMode,
      priority: target.band,
      chunkKey: chunkKey(level, target.t, c, z, y, x),
    };
    if (holdsPlane && !whole) {
      req.plane = slice.plane;
      req.planes = slice.planes;
      if (slice.axis !== "z") req.planeAxis = slice.axis;
    }
    if (cut) req.cut = cut;
    push(req, key);
  }
}

/**
 * The level selection's `cells` of one tile into `target`, each ranked by
 * its place in the view's fetch order.
 */
function emitCells(
  entity: EntitySnapshot,
  cells: readonly SelectedCell[],
  snapshot: DatasetView,
  config: PlanningConfig,
  lane: Omit<LaneTarget, "slice" | "whole" | "cut">,
  push: Push,
  whole = false,
): void {
  // Cells come grouped by level, so each level's target is made once.
  const targets = new Map<number, LaneTarget>();
  for (const cell of cells) {
    let target = targets.get(cell.level);
    if (target === undefined) {
      target = laneTarget(entity, cell.level, snapshot, config, lane, whole);
      targets.set(cell.level, target);
    }
    emitChunk(entity, cell.level, cell.x, cell.y, cell.z, cell.rank, snapshot, target, push);
  }
}

/** Where one lane's requests for `entity`'s chunks at `level` go. */
function laneTarget(
  entity: EntitySnapshot,
  level: number,
  snapshot: DatasetView,
  config: PlanningConfig,
  lane: Omit<LaneTarget, "slice" | "whole" | "cut">,
  whole: boolean,
): LaneTarget {
  return { ...lane, slice: slicePlaneAt(entity, level, snapshot, config), whole, cut: poolCutAt(entity, level, snapshot) };
}

/** Add a query's culling counts once per channel. */
function count(chunks: PlanChunks, query: number, snapshot: DatasetView, stats: PlanStats): void {
  chunks.found.addCounts(query, stats.culling, snapshot.selection.visibleChannels.length);
}

/**
 * Minimap lane. Emits one {@link ChunkRequest} per pending coord
 * of each entity's image, with no importance or distance terms.
 *
 * The top lane (`config.minimapLaneOffset`) is safe only while the seed set
 * is small. On a wide collection it is tens of thousands of chunks and would
 * hold every fetch slot for minutes while the view waits. Past
 * `minimapSeedFastMaxChunks` of total demand, everything here rides the bulk
 * lane at `max(bulk offset, bulkBandFloor)`. The floor is above every band
 * already in the plan, which the bulk offset alone cannot promise because
 * the lane offsets are knobs, so this must run after the view lanes.
 */
export function emitMinimapLane(
  minimapPending: Map<string, MinimapChunkCoord[]>,
  entities: EntitySnapshot[],
  datasetId: string,
  config: PlanningConfig,
  bulkBandFloor: number,
  out: LaneRequests,
  mode: ChunkRequest["mode"] = "slice",
): void {
  if (minimapPending.size === 0) return;
  // The fast/bulk decision reads the whole pending map, not this call's
  // entity subset: seeding covers every dataset image and the fetch queue is
  // shared, so starvation depends on the full demand.
  let pendingTotal = 0;
  for (const coords of minimapPending.values()) {
    pendingTotal += coords.length;
  }
  // Defaults cover configs without the seed knobs, so large demand never
  // rides the fast lane because a knob is absent.
  const fastMax = config.minimapSeedFastMaxChunks ?? MINIMAP_SEED_FAST_MAX_CHUNKS;
  const bulkBase = config.minimapSeedBulkLaneOffset ?? MINIMAP_SEED_BULK_LANE_OFFSET;
  const band =
    pendingTotal > fastMax
      ? Math.max(bulkBase, bulkBandFloor)
      : config.minimapLaneOffset;
  for (const entity of entities) {
    const pending = minimapPending.get(entity.imageId);
    if (!pending) continue;
    for (const coord of pending) {
      out.push(
        {
          datasetId,
          entityId: entity.entityId,
          imageId: entity.imageId,
          level: coord.level,
          t: coord.t,
          c: coord.c,
          z: coord.z,
          y: coord.y,
          x: coord.x,
          lane: "minimap",
          tier: "coarse",
          // Minimap chunks go to no pools; the view's mode only fills the field.
          mode,
          priority: band,
          chunkKey: coord.key,
        },
        0,
      );
    }
  }
}

/**
 * Detail lane: the chunks the level selection chose for each visible tile,
 * in the selection's fetch order: coarser levels first, so a slow link fills
 * the whole view before it sharpens, then larger on screen, then nearer the
 * focus. With `carry`, a cell the previous plan asked for keeps its requests.
 */
export function emitDetailLane(
  chunks: PlanChunks,
  snapshot: DatasetView,
  out: LaneRequests,
  config: PlanningConfig,
  carry?: LaneCarry,
): void {
  const lane = { lane: "detail", tier: "detail", band: config.detailLaneOffset, t: snapshot.selection.t } as const;
  const push: Push = (req, key) => out.push(req, key);
  for (const { entity, chosen } of chunks.tiles) {
    if (chosen === undefined) continue;
    if (carry === undefined) {
      emitCells(entity, chosen.detail, snapshot, config, lane, push);
      continue;
    }
    const previous = carry.detailOf(entity);
    // An entity whose cells all held keeps its requests whole, as the last
    // plan recorded them; most entities of a wide collection do.
    if (previous !== undefined && previous.size === chosen.detail.length && keepsEvery(previous, chosen.detail, lane.band, out)) {
      carry.setDetail(entity, previous);
      continue;
    }
    const cells = new Map<number, readonly ChunkRequest[]>();
    const targets = new Map<number, LaneTarget>();
    let emitted: ChunkRequest[] = [];
    const collect: Push = (req, rank) => {
      emitted.push(req);
      out.push(req, rank);
    };
    for (const cell of chosen.detail) {
      const key = cellKey(cell.level, cell.x, cell.y, cell.z);
      const kept = previous?.get(key);
      if (kept !== undefined) {
        out.keep(lane.band, cell.rank);
        cells.set(key, kept);
        continue;
      }
      let target = targets.get(cell.level);
      if (target === undefined) {
        target = laneTarget(entity, cell.level, snapshot, config, lane, false);
        targets.set(cell.level, target);
      }
      emitted = [];
      emitChunk(entity, cell.level, cell.x, cell.y, cell.z, cell.rank, snapshot, target, collect);
      cells.set(key, emitted);
    }
    carry.setDetail(entity, cells);
  }
}

/**
 * Whether `previous` holds requests for every one of `cells`, keeping them
 * in `out` when it does; with as many cells as `previous` holds, the two are
 * the same cells. Only the band's least and greatest key matter to a kept
 * request, so the cells' extremes are kept for them all.
 */
function keepsEvery(
  previous: ReadonlyMap<number, readonly ChunkRequest[]>,
  cells: readonly SelectedCell[],
  band: number,
  out: LaneRequests,
): boolean {
  let least = Infinity;
  let greatest = -Infinity;
  for (const cell of cells) {
    if (!previous.has(cellKey(cell.level, cell.x, cell.y, cell.z))) return false;
    if (cell.rank < least) least = cell.rank;
    if (cell.rank > greatest) greatest = cell.rank;
  }
  if (cells.length > 0) {
    out.keep(band, least);
    out.keep(band, greatest);
  }
  return true;
}

/**
 * Prefetch lane: for each visible tile, the selected chunks at future
 * timepoints, and the selection's lookahead, the chunks it would draw next in
 * the direction of the last zoom change, so they are partly resident when the
 * selection moves to them. After a step along Z (`cutStep`), the selected
 * chunks the slice view's plane lies in come first, whole, so the steps after
 * it find every plane of them resident.
 *
 * The lane's budget per entity is `prefetchDepth` steps. Each timepoint step
 * is the selection at that timepoint, and the lookahead takes the last step.
 * Each step is its own band, nearest first, so a later step never outranks
 * an earlier one. The lookahead is bounded by the room the selection leaves
 * in the budget, never by the chunks of a level in view.
 */
export function emitPrefetchLane(
  chunks: PlanChunks,
  snapshot: DatasetView,
  out: LaneRequests,
  config: PlanningConfig,
  cutStep = false,
): void {
  const push: Push = (req, key) => out.push(req, key);
  const t = snapshot.selection.t;
  for (const { entity, chosen, timepointSteps } of chunks.tiles) {
    if (chosen === undefined) continue;
    if (cutStep) {
      emitCells(entity, chosen.detail, snapshot, config, {
        lane: "prefetch", tier: "detail", band: config.prefetchLaneOffset, t,
      }, push, true);
    }
    for (let dt = 1; dt <= timepointSteps; dt++) {
      emitCells(entity, chosen.detail, snapshot, config, {
        lane: "prefetch", tier: "detail", band: config.prefetchLaneOffset + dt * PREFETCH_STEP, t: t + dt,
      }, push);
    }
    if (config.prefetchDepth > 0) {
      emitCells(entity, chosen.lookahead, snapshot, config, {
        lane: "prefetch", tier: "detail", band: config.prefetchLaneOffset + config.prefetchDepth * PREFETCH_STEP, t,
      }, push);
    }
  }
}

/**
 * The coarse lane is the source-backed floor under the detail tier. It
 * emits exactly the coarse level on each tile entry, independent of the
 * detail lane, and skips the levels between. Its chunks are fetched whole in
 * either view: the coarsest level is small, and auto-contrast and the
 * minimap read its chunks whole.
 */
export function emitCoarseLane(
  chunks: PlanChunks,
  snapshot: DatasetView,
  stats: PlanStats,
  out: LaneRequests,
  config: PlanningConfig,
): void {
  const push: Push = (req, key) => out.push(req, key);
  for (const { entity, entry, coarse } of chunks.tiles) {
    if (coarse === null || entry.coarseLevel === null) continue;
    const level = entry.coarseLevel;
    const target: LaneTarget = {
      lane: "coarse", tier: "coarse", band: config.coarseLaneOffset, t: snapshot.selection.t, slice: null, whole: false,
      cut: poolCutAt(entity, level, snapshot),
    };
    count(chunks, coarse, snapshot, stats);
    chunks.found.forEach(coarse, (x, y, z, distance) => {
      emitChunk(entity, level, x, y, z, inLaneKey(entity, distance, config), snapshot, target, push);
    });
  }
}
