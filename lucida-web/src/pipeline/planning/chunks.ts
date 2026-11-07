/**
 * Chunk enumeration + frustum culling primitives. Pure (only mutates
 * the caller-supplied `stats` accumulator).
 */

import { Axis } from "../../axes.ts";
import type { LevelGeometry } from "../../manifestTypes.ts";
import type { VisibleRegion } from "../viewport.ts";
import type {
  ActiveSetEntry,
  ChunkRequest,
  EntitySnapshot,
  PlanStats,
  SelectionState,
} from "./types.ts";

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
 * Test whether a chunk AABB is fully outside any frustum half-plane.
 *
 * Uses the p-vertex method: for each plane [a, b, c, d], test the AABB corner
 * most aligned with the plane normal.  If that corner is on the negative side,
 * the entire chunk is outside.
 */
export function chunkOutsideFrustum(
  cmin: [number, number, number],
  cmax: [number, number, number],
  planes: [number, number, number, number][],
): boolean {
  for (const plane of planes) {
    const px = plane[0] >= 0 ? cmax[0] : cmin[0];
    const py = plane[1] >= 0 ? cmax[1] : cmin[1];
    const pz = plane[2] >= 0 ? cmax[2] : cmin[2];
    if (plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0) {
      return true;
    }
  }
  return false;
}

/**
 * Per-axis world size of a chunk at a given level, expressed in level-0
 * voxel units. Returns `[x, y, z]`. Used by both spatial enumeration
 * (`iterateGridCells`) and distance scoring (`chunkDistanceFromCenter`)
 * so they agree on the same conversion.
 */
export function chunkWorldDims(
  geo: LevelGeometry,
  level0: LevelGeometry,
): [number, number, number] {
  const scaleX = level0.shape[Axis.X] / geo.shape[Axis.X];
  const scaleY = level0.shape[Axis.Y] / geo.shape[Axis.Y];
  const scaleZ = level0.shape[Axis.Z] / geo.shape[Axis.Z];
  return [
    geo.chunk_shape[Axis.X] * scaleX,
    geo.chunk_shape[Axis.Y] * scaleY,
    geo.chunk_shape[Axis.Z] * scaleZ,
  ];
}

/**
 * Enumerate culled chunk grid cells for a tile entry's detail-tier levels.
 * Non-tile entries return `[]`: a `group-as-proxy` is served by one proxy
 * asset, and `invisible` has no chunks. Returned requests are placeholders
 * (`priority` 0, `lane` `"detail"`) that `plan()` stamps per lane.
 * `datasetId` defaults to empty for synthetic test snapshots.
 */
export function iterateChunks(
  entity: EntitySnapshot,
  entry: ActiveSetEntry,
  visibleRegion: VisibleRegion,
  selection: SelectionState,
  stats: PlanStats | null = null,
  datasetId = "",
): ChunkRequest[] {
  if (entry.kind !== "tile") return [];
  return iterateChunksAtLevels(
    entity,
    entry.detailLevels,
    visibleRegion,
    selection,
    stats,
    datasetId,
  );
}

/**
 * Spatial enumeration primitive. Iterates the given levels in order, all
 * visible channels, and pushes one {@link ChunkRequest} per surviving
 * grid cell. It skips levels the entity's pyramid lacks.
 *
 * The coarse lane calls this with the entry's coarse level. The detail
 * and prefetch lanes call {@link iterateChunks}, which forwards the
 * entry's detail-tier levels.
 */
export function iterateChunksAtLevels(
  entity: EntitySnapshot,
  levels: readonly number[],
  visibleRegion: VisibleRegion,
  selection: SelectionState,
  stats: PlanStats | null = null,
  datasetId = "",
): ChunkRequest[] {
  const requests: ChunkRequest[] = [];

  const level0 = entity.levels[0];
  if (level0 === undefined) {
    return requests;
  }

  for (const level of levels) {
    const levelGeo = entity.levels[level];
    if (levelGeo === undefined) continue;

    iterateGridCells(
      entity,
      visibleRegion,
      selection,
      levelGeo,
      level0,
      level,
      selection.visibleChannels,
      requests,
      stats,
      datasetId,
    );
  }

  return requests;
}

/**
 * Iterate the spatial grid cells for one level, pushing matching
 * ChunkRequests for every visible channel into `out`.
 *
 * Channel is the innermost loop so equal-priority multi-channel chunks
 * are spatially interleaved. That lets upload budget reach all channels
 * for the focal cells before walking farther cells.
 */
function iterateGridCells(
  entity: EntitySnapshot,
  region: VisibleRegion,
  selection: SelectionState,
  levelGeo: LevelGeometry,
  level0: LevelGeometry,
  level: number,
  channels: readonly number[],
  out: ChunkRequest[],
  stats: PlanStats | null = null,
  datasetId = "",
): void {
  const [chunkWorldX, chunkWorldY, chunkWorldZ] = chunkWorldDims(
    levelGeo,
    level0,
  );

  const clip = clipGridCellsToRegion(
    entity,
    region,
    levelGeo,
    level0,
    chunkWorldX,
    chunkWorldY,
    chunkWorldZ,
    stats,
    channels.length,
  );
  if (clip === null) return;

  const { colStart, colEnd, rowStart, rowEnd, zStart, zEnd } = clip;

  for (let iz = zStart; iz < zEnd; iz++) {
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        if (
          !cellSurvivesFrustum(
            entity,
            region,
            col,
            row,
            iz,
            chunkWorldX,
            chunkWorldY,
            chunkWorldZ,
          )
        ) {
          continue;
        }
        for (const c of channels) {
          if (stats) stats.culling.afterFrustum++;
          out.push(
            makeChunkRequest(entity, datasetId, level, selection.t, c, iz, row, col),
          );
        }
      }
    }
  }
}

interface ClippedGridRange {
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
  zStart: number;
  zEnd: number;
}

/**
 * Clip the level's full chunk grid to the visible region, returning the
 * index-space range to iterate, or `null` if there is no overlap.
 *
 * Side effect: increments `stats.culling.considered`,
 * `stats.culling.afterXyBounds`, and `stats.culling.afterZRange`.
 */
function clipGridCellsToRegion(
  entity: EntitySnapshot,
  region: VisibleRegion,
  levelGeo: LevelGeometry,
  level0: LevelGeometry,
  chunkWorldX: number,
  chunkWorldY: number,
  chunkWorldZ: number,
  stats: PlanStats | null,
  channelCount = 1,
): ClippedGridRange | null {
  const fullX = level0.shape[Axis.X];
  const fullY = level0.shape[Axis.Y];

  // Max grid index (exclusive).
  const maxCol = levelGeo.grid_shape[Axis.X];
  const maxRow = levelGeo.grid_shape[Axis.Y];
  const maxZ = levelGeo.grid_shape[Axis.Z];

  // Whole-grid count is "considered" — every cell at this
  // (level, channel) that could have been emitted before culling.
  const totalCells = maxCol * maxRow * maxZ;
  if (stats) stats.culling.considered += totalCells * channelCount;

  // Offset visible region by entity position to get local coords.
  const localMinX = region.xyBoundsVox[0] - entity.layoutPositionVox[0];
  const localMinY = region.xyBoundsVox[1] - entity.layoutPositionVox[1];
  const localMaxX = region.xyBoundsVox[2] - entity.layoutPositionVox[0];
  const localMaxY = region.xyBoundsVox[3] - entity.layoutPositionVox[1];

  // Early-out: no overlap at all.
  if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) {
    return null;
  }

  const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
  const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
  const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
  const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));

  const zStart = Math.max(0, Math.floor(region.zRangeVox[0] / chunkWorldZ));
  const zEnd = Math.min(maxZ, Math.max(0, Math.ceil(region.zRangeVox[1] / chunkWorldZ)));

  if (stats) {
    const colsKept = Math.max(0, colEnd - colStart);
    const rowsKept = Math.max(0, rowEnd - rowStart);
    const zsKept = Math.max(0, zEnd - zStart);
    stats.culling.afterXyBounds += colsKept * rowsKept * maxZ * channelCount;
    stats.culling.afterZRange += colsKept * rowsKept * zsKept * channelCount;
  }

  return { colStart, colEnd, rowStart, rowEnd, zStart, zEnd };
}

/**
 * Per-cell frustum test. Returns `true` if the cell should be emitted.
 *
 * Frustum planes are in the first member's coordinate system, so we
 * offset chunk coords by entity position before testing.
 */
function cellSurvivesFrustum(
  entity: EntitySnapshot,
  region: VisibleRegion,
  col: number,
  row: number,
  iz: number,
  chunkWorldX: number,
  chunkWorldY: number,
  chunkWorldZ: number,
): boolean {
  if (region.frustumPlanes === null) return true;
  const cmin: [number, number, number] = [
    col * chunkWorldX + entity.layoutPositionVox[0],
    row * chunkWorldY + entity.layoutPositionVox[1],
    iz * chunkWorldZ,
  ];
  const cmax: [number, number, number] = [
    (col + 1) * chunkWorldX + entity.layoutPositionVox[0],
    (row + 1) * chunkWorldY + entity.layoutPositionVox[1],
    (iz + 1) * chunkWorldZ,
  ];
  return !chunkOutsideFrustum(cmin, cmax, region.frustumPlanes);
}

/**
 * Build a placeholder {@link ChunkRequest} for a surviving cell. The caller
 * stamps `priority` and `lane` per lane.
 *
 * Cached chunks are not filtered here. They flow through `submit()` so the
 * cache refreshes their priority and lastSeenTick, which eviction uses to
 * spare still-wanted chunks. `CpuCache.submit` dedups against the cache.
 */
function makeChunkRequest(
  entity: EntitySnapshot,
  datasetId: string,
  level: number,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): ChunkRequest {
  return {
    datasetId,
    entityId: entity.entityId,
    imageId: entity.imageId,
    level,
    t,
    c,
    z,
    y,
    x,
    lane: "detail",
    tier: "detail",
    priority: 0,
    chunkKey: chunkKey(level, t, c, z, y, x),
  };
}
