/**
 * Lane emission and priority. Turns the active set and minimap-pending
 * coords into one {@link ChunkRequest} stream per lane, from the chunks the
 * core enumerated for the plan.
 *
 * A request's priority is its lane's band plus an in-lane term under one.
 * Lane offsets and prefetch steps are whole numbers, so every reader of the
 * priority (admission, the fetch queue, the CPU store's protection and
 * eviction, delivery order) sees one lane wholly before the next.
 * Importance and distance from the view's focus order requests only within
 * their band.
 */

import { Axis } from "../../axes.ts";
import { sliceLevelPlane, tczyx, type SliceCut, type SpatialAxis } from "../../renderer/slicePlane.ts";
import {
  MINIMAP_SEED_BULK_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  type PlanningConfig,
} from "./config.ts";
import { enumerateChunks, type ChunkEnumeration, type LevelQuery } from "./enumerate.ts";
import type {
  ActiveSetEntry,
  ChunkRequest,
  DatasetView,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanStats,
  SelectionState,
  TileEntry,
  ZoomDirection,
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
function slicePlaneAt(
  entity: EntitySnapshot,
  level: number,
  snapshot: DatasetView,
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

  const image = a.imageId.localeCompare(b.imageId);
  if (image !== 0) return image;

  return (
    a.level - b.level ||
    a.t - b.t ||
    a.z - b.z ||
    a.y - b.y ||
    a.x - b.x ||
    a.c - b.c ||
    a.chunkKey.localeCompare(b.chunkKey)
  );
}

/**
 * Requests as the lanes emit them. `priority` holds the lane's band until
 * {@link LaneRequests.finish} adds each request's in-lane term, which needs
 * every key in the band.
 */
export class LaneRequests {
  private readonly requests: ChunkRequest[] = [];
  /** Each request's in-lane key, lower first. */
  private readonly keys: number[] = [];
  private highestBand = -Infinity;

  push(req: ChunkRequest, key: number): void {
    this.requests.push(req);
    this.keys.push(key);
    if (req.priority > this.highestBand) this.highestBand = req.priority;
  }

  /** The highest band emitted so far, or -Infinity. */
  get topBand(): number {
    return this.highestBand;
  }

  /**
   * Place each request within its band by where its key falls between the
   * band's least and greatest, then sort into the planner's request order.
   * Equal keys get equal priorities, so the identity tiebreak still applies.
   */
  finish(): ChunkRequest[] {
    const range = new Map<number, [number, number]>();
    for (let i = 0; i < this.requests.length; i++) {
      const band = this.requests[i].priority;
      const key = this.keys[i];
      const seen = range.get(band);
      if (seen === undefined) range.set(band, [key, key]);
      else if (key < seen[0]) seen[0] = key;
      else if (key > seen[1]) seen[1] = key;
    }
    for (let i = 0; i < this.requests.length; i++) {
      const req = this.requests[i];
      const [least, greatest] = range.get(req.priority)!;
      if (greatest > least) req.priority += (IN_LANE_SPAN * (this.keys[i] - least)) / (greatest - least);
    }
    return this.requests.sort(compareChunkRequests);
  }
}

/**
 * A request's place within its lane: more important entities first, then
 * chunks nearer the view's focus.
 */
function inLaneKey(entity: EntitySnapshot, distance: number, config: PlanningConfig): number {
  return (1.0 - entity.importance) * config.importanceWeight + distance * config.distanceWeight;
}

/** One visible tile and the queries its lanes read from the plan's enumeration. */
export interface TileQueries {
  entry: TileEntry;
  entity: EntitySnapshot;
  /** One query per detail-tier level, in `entry.detailLevels` order. */
  detail: number[];
  coarse: number | null;
  /** Future timepoints the prefetch lane steps through, nearest first. */
  timepointSteps: number;
  /** The prefetch lane's level step, when the lane has steps left for it. */
  levelStep: LevelStep | null;
}

interface LevelStep {
  level: number;
  query: number;
  /** Prefetch steps it takes, each the size of the visible target-level set. */
  steps: number;
}

/** What one plan's lanes draw on: the enumeration and how its queries map to tiles. */
export interface PlanChunks {
  tiles: TileQueries[];
  found: ChunkEnumeration;
}

/**
 * Enumerate, in one call into the core, every chunk the plan's lanes can
 * ask for: each visible tile's detail levels, its coarse level, and the
 * prefetch lane's level step. Timepoint prefetch reuses the detail chunks,
 * since only `t` differs.
 */
export function enumeratePlanChunks(
  activeSet: readonly ActiveSetEntry[],
  snapshot: DatasetView,
  entityById: ReadonlyMap<string, EntitySnapshot>,
  config: PlanningConfig,
  zoomDirection: ZoomDirection | null,
): PlanChunks {
  const queries: LevelQuery[] = [];
  const ask = (entity: EntitySnapshot, level: number, radiusView: number): number =>
    queries.push({ entity, level, radiusView }) - 1;
  const tiles: TileQueries[] = [];
  for (const entry of activeSet) {
    if (entry.kind !== "tile") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    const detail = entry.detailLevels.map((level) => ask(entity, level, config.detailRenderRadiusView));
    const coarse = entry.coarseLevel === null
      ? null
      : ask(entity, entry.coarseLevel, config.coarseRenderRadiusView);

    // The prefetch lane's budget is `prefetchDepth` steps. A level in the
    // zoom direction takes the last step, and any step the timepoints
    // cannot fill.
    let timepointSteps = 0;
    let levelStep: LevelStep | null = null;
    const level0 = entity.levels[0];
    if (level0 !== undefined) {
      const level = levelInZoomDirection(entity, zoomDirection);
      const allowed = level === null ? config.prefetchDepth : config.prefetchDepth - 1;
      const timepoints = level0.grid_shape[Axis.T] ?? 0;
      timepointSteps = Math.max(0, Math.min(allowed, timepoints - 1 - snapshot.selection.t));
      const steps = config.prefetchDepth - timepointSteps;
      if (level !== null && steps > 0) {
        levelStep = { level, query: ask(entity, level, config.detailRenderRadiusView), steps };
      }
    }
    tiles.push({ entry, entity, detail, coarse, timepointSteps, levelStep });
  }
  const found = enumerateChunks(snapshot.visibleRegion, config.depthBiasView, queries);
  return { tiles, found };
}

/** A lane's sink for requests and their in-lane keys. */
type Push = (req: ChunkRequest, key: number) => void;

/**
 * Push one request per channel for each chunk `query` found at `level`, at
 * timepoint `t`, in `lane`'s `band`. Channels are innermost so
 * equal-priority multi-channel chunks interleave by cell.
 *
 * With `slice`, a chunk that holds the slice view's plane asks for that
 * plane and fetches the band around it. `whole` keeps only those chunks and
 * asks for each whole.
 */
function emitQuery(
  chunks: PlanChunks,
  entity: EntitySnapshot,
  query: number,
  level: number,
  snapshot: DatasetView,
  config: PlanningConfig,
  t: number,
  lane: ChunkRequest["lane"],
  tier: ChunkRequest["tier"],
  band: number,
  push: Push,
  slice: PlaneInChunks | null = null,
  whole = false,
): void {
  const channels = snapshot.selection.visibleChannels;
  chunks.found.forEach(query, (x, y, z, distance) => {
    const holdsPlane = slice !== null && chunkAlong(slice.axis, x, y, z) === slice.chunk;
    if (whole && !holdsPlane) return;
    const key = inLaneKey(entity, distance, config);
    for (const c of channels) {
      const req: ChunkRequest = {
        datasetId: snapshot.datasetId,
        entityId: entity.entityId,
        imageId: entity.imageId,
        level,
        t,
        c,
        z,
        y,
        x,
        lane,
        tier,
        priority: band,
        chunkKey: chunkKey(level, t, c, z, y, x),
      };
      if (holdsPlane && !whole) {
        req.plane = slice.plane;
        req.planes = slice.planes;
        if (slice.axis !== "z") req.planeAxis = slice.axis;
      }
      push(req, key);
    }
  });
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
          priority: band,
          chunkKey: coord.key,
        },
        0,
      );
    }
  }
}

/** Detail lane: each visible tile's chunks at its detail-tier levels. */
export function emitDetailLane(
  chunks: PlanChunks,
  snapshot: DatasetView,
  stats: PlanStats,
  out: LaneRequests,
  config: PlanningConfig,
): void {
  const push: Push = (req, key) => out.push(req, key);
  for (const { entity, entry, detail } of chunks.tiles) {
    detail.forEach((query, i) => {
      count(chunks, query, snapshot, stats);
      const level = entry.detailLevels[i];
      emitQuery(
        chunks, entity, query, level, snapshot, config, snapshot.selection.t,
        "detail", "detail", config.detailLaneOffset, push, slicePlaneAt(entity, level, snapshot, config),
      );
    });
  }
}

/**
 * The target's neighbor among the source levels in the zoom direction. A
 * pinned target never moves with the zoom, so it gets none. Generated coarse
 * levels are absent from `sourceLevels`, so they are never returned.
 */
function levelInZoomDirection(
  entity: EntitySnapshot,
  zoomDirection: ZoomDirection | null,
): number | null {
  if (zoomDirection === null || entity.levelPinned) return null;
  const at = entity.sourceLevels.indexOf(entity.targetLevel);
  if (at < 0) return null;
  return entity.sourceLevels[zoomDirection === "in" ? at - 1 : at + 1] ?? null;
}

/**
 * Prefetch lane: for each visible tile, the detail chunks at future
 * timepoints, and chunks at the next level in the direction of the last
 * zoom change so that level is partly resident when the target crosses to
 * it. After a step along Z (`cutStep`), the detail chunks the slice view's
 * plane lies in come first, whole, so the steps after it find every plane
 * of them resident.
 *
 * The lane's budget per entity is `prefetchDepth` steps, each the visible
 * target-level set. With no level to prefetch, every step is a future
 * timepoint. With one, the level step takes the lane's last step and the
 * timepoint steps keep the ones before it. The level step also takes any
 * step the timepoints cannot fill, nearest the view's focus first. Each
 * step is its own band, nearest first, so a later step never outranks an
 * earlier one.
 */
export function emitPrefetchLane(
  chunks: PlanChunks,
  snapshot: DatasetView,
  stats: PlanStats,
  out: LaneRequests,
  config: PlanningConfig,
  cutStep = false,
): void {
  const push: Push = (req, key) => out.push(req, key);
  for (const { entity, entry, detail, timepointSteps, levelStep } of chunks.tiles) {
    if (cutStep) {
      detail.forEach((query, i) => {
        const level = entry.detailLevels[i];
        const slice = slicePlaneAt(entity, level, snapshot, config);
        if (slice === null) return;
        emitQuery(
          chunks, entity, query, level, snapshot, config, snapshot.selection.t,
          "prefetch", "detail", config.prefetchLaneOffset, push, slice, true,
        );
      });
    }
    for (let dt = 1; dt <= timepointSteps; dt++) {
      detail.forEach((query, i) => {
        count(chunks, query, snapshot, stats);
        const level = entry.detailLevels[i];
        emitQuery(
          chunks, entity, query, level, snapshot, config, snapshot.selection.t + dt,
          "prefetch", "detail", config.prefetchLaneOffset + dt * PREFETCH_STEP, push,
          slicePlaneAt(entity, level, snapshot, config),
        );
      });
    }
    if (levelStep === null) continue;
    let stepSize = 0;
    for (const query of detail) stepSize += chunks.found.size(query);
    stepSize *= snapshot.selection.visibleChannels.length;
    emitLevelStep(chunks, entity, levelStep, snapshot, stats, config, levelStep.steps * stepSize, out);
  }
}

/**
 * The prefetch lane's level step: the `allowance` requests at the level
 * nearest the view's focus, in the lane's last step band.
 */
function emitLevelStep(
  chunks: PlanChunks,
  entity: EntitySnapshot,
  step: LevelStep,
  snapshot: DatasetView,
  stats: PlanStats,
  config: PlanningConfig,
  allowance: number,
  out: LaneRequests,
): void {
  if (allowance <= 0) return;
  count(chunks, step.query, snapshot, stats);
  const band = config.prefetchLaneOffset + config.prefetchDepth * PREFETCH_STEP;
  const candidates: { req: ChunkRequest; key: number }[] = [];
  emitQuery(
    chunks, entity, step.query, step.level, snapshot, config, snapshot.selection.t,
    "prefetch", "detail", band, (req, key) => candidates.push({ req, key }),
    slicePlaneAt(entity, step.level, snapshot, config),
  );
  candidates.sort((a, b) => a.key - b.key || compareChunkRequests(a.req, b.req));
  for (const { req, key } of candidates.slice(0, allowance)) out.push(req, key);
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
    count(chunks, coarse, snapshot, stats);
    emitQuery(
      chunks, entity, coarse, entry.coarseLevel, snapshot, config, snapshot.selection.t,
      "coarse", "coarse", config.coarseLaneOffset, push,
    );
  }
}
