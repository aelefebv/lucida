/**
 * Lane emission helpers + priority computation. Translates active-set
 * entries and minimap-pending coords into {@link ChunkRequest} /
 * {@link ProxyRequest} streams, one per lane. See ADR 0029.
 */

import { Axis } from "../../axes.ts";
import type { VisibleRegion } from "../viewport.ts";
import { chunkWithinRenderRadius } from "../renderRadius.ts";
import { chunkWorldDims, iterateChunks, iterateChunksAtLodRange } from "./chunks.ts";
import type { PlanningConfig } from "./config.ts";
import type {
  ActiveSetEntry,
  ChunkRequest,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
  PlanStats,
  ProxyRequest,
  SelectionState,
} from "./types.ts";

/**
 * Numeric priority for a chunk request. Lower = more urgent. Lane
 * offset separates lanes (detail < proxy < prefetch < overview);
 * importance and distance order within a lane.
 */
function computePriority(
  laneOffset: number,
  importance: number,
  distanceFromCenter: number,
  config: PlanningConfig,
): number {
  return (
    laneOffset +
    (1.0 - importance) * config.importanceWeight +
    distanceFromCenter * config.distanceWeight
  );
}

/**
 * Minimap lane — its own dedicated highest-priority lane (see ADR
 * 0023). For every {@link EntitySnapshot} in `entities`, look up
 * `minimapPending.get(entity.imageId)` and emit one
 * {@link ChunkRequest} per coord with `priority = config.minimapLaneOffset`
 * directly (no importance / distance terms — minimap chunks are
 * per-dataset, not per-entity-importance).
 *
 * Mutates `out`.
 */
export function emitMinimapLane(
  minimapPending: Map<string, MinimapChunkCoord[]>,
  entities: EntitySnapshot[],
  datasetId: string,
  config: PlanningConfig,
  out: ChunkRequest[],
): void {
  if (minimapPending.size === 0) return;
  for (const entity of entities) {
    const pending = minimapPending.get(entity.imageId);
    if (!pending) continue;
    for (const coord of pending) {
      out.push({
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
        priority: config.minimapLaneOffset,
        chunkKey: coord.key,
      });
    }
  }
}

/**
 * Detail lane — for each active entry, push detail chunks (field modes)
 * or a single proxy request per visible channel (`well-as-proxy`).
 *
 * Also emits the per-field FieldProxy3D fallback for field-mode entries
 * whose proxy is advertised, and a parent `WellProxy3D` (deduped per
 * `(wellId, t, c)`) when the entry is in `fields-with-proxy-fallback`
 * and the parent well's proxy is advertised.
 *
 * Mutates `allRequests`, `proxyRequests`, and `wellProxyEmitted`.
 */
export function emitDetailLane(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  entityById: Map<string, EntitySnapshot>,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  proxyRequests: ProxyRequest[],
  wellProxyEmitted: Set<string>,
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    if (entry.kind === "well-as-proxy") {
      // `imageId: ""` matches the pre-discrimination convention — wells
      // have no single owning image.
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId,
          entityId: entry.entityId,
          imageId: "",
          kind: "WellProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + 0,
        });
      }
      continue;
    }

    if (entry.kind === "invisible") continue;

    // Narrowed: entry is FieldEntry below this point.
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    const chunks = entry.detailLevel !== undefined
      ? iterateChunksAtLodRange(
          entity,
          [entry.detailLevel, entry.detailLevel],
          snapshot.visibleRegion,
          snapshot.selection,
          stats,
          datasetId,
        )
      : iterateChunks(
          entity,
          entry,
          snapshot.visibleRegion,
          snapshot.selection,
          stats,
          datasetId,
        );
    for (const req of chunks) {
      if (!requestWithinRenderRadius(req, snapshot.visibleRegion, entity, config.detailRenderRadiusView)) {
        continue;
      }
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "detail";
      req.tier = "detail";
      req.priority = computePriority(
        config.detailLaneOffset,
        entity.importance,
        dist,
        config,
      );
      allRequests.push(req);
    }

    if (entry.proxyAvailable && entry.proxyKind === "FieldProxy3D") {
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId,
          entityId: entry.entityId,
          imageId: entry.imageId,
          kind: "FieldProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + 1,
        });
      }
    }

    // Parent-well proxy (only for proxy-fallback mode; at
    // `fields-with-detail` zoom the chunk path keeps up). Dedup per
    // (wellId, t, c). Narrow on `kind === "Field"` because only
    // `FieldSnapshot` carries a `parentId`; a non-Field here is a
    // producer invariant violation we skip silently.
    if (
      entry.mode === "fields-with-proxy-fallback" &&
      entry.wellProxyAvailable &&
      entity.kind === "Field"
    ) {
      const wellId = entity.parentId;
      for (const c of snapshot.selection.visibleChannels) {
        const dedupKey = `${wellId}|${snapshot.selection.t}|${c}`;
        if (wellProxyEmitted.has(dedupKey)) continue;
        wellProxyEmitted.add(dedupKey);
        proxyRequests.push({
          datasetId,
          entityId: wellId,
          imageId: "",
          kind: "WellProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + config.wellProxyPriorityBump,
        });
      }
    }
  }
}

/**
 * Prefetch lane — for each field-mode active entry, emit chunks for the
 * next `config.prefetchDepth` timepoints (bounded by the entity's max T).
 *
 * Mutates `allRequests`.
 */
export function emitPrefetchLane(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  entityById: Map<string, EntitySnapshot>,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    if (entry.kind !== "field") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;
    if (entity.levels.length === 0) continue;

    const maxT = entity.levels[0]?.grid_shape[Axis.T] ?? 0;
    for (let dt = 1; dt <= config.prefetchDepth; dt++) {
      const nextT = snapshot.selection.t + dt;
      if (nextT >= maxT) break;
      const prefetchSelection: SelectionState = {
        ...snapshot.selection,
        t: nextT,
      };

      const chunks = entry.detailLevel !== undefined
        ? iterateChunksAtLodRange(
            entity,
            [entry.detailLevel, entry.detailLevel],
            snapshot.visibleRegion,
            prefetchSelection,
            stats,
            datasetId,
          )
        : iterateChunks(
            entity,
            entry,
            snapshot.visibleRegion,
            prefetchSelection,
            stats,
            datasetId,
          );
      for (const req of chunks) {
        if (!requestWithinRenderRadius(req, snapshot.visibleRegion, entity, config.detailRenderRadiusView)) {
          continue;
        }
        const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
        req.lane = "prefetch";
        req.tier = "detail";
        req.priority = computePriority(
          config.prefetchLaneOffset + dt * 100,
          entity.importance,
          dist,
          config,
        );
        allRequests.push(req);
      }
    }
  }
}

/**
 * Coarse lane — source-backed chunk-only fallback. Emits exactly the
 * coarse level selected on each field entry, independent of the detail
 * lane. Intermediate pyramid levels are intentionally skipped.
 */
export function emitCoarseLane(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  entityById: Map<string, EntitySnapshot>,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    if (entry.kind !== "field") continue;
    if (entry.coarseLevel === undefined || entry.coarseLevel === null) continue;

    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    const chunks = iterateChunksAtLodRange(
      entity,
      [entry.coarseLevel, entry.coarseLevel],
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      if (!requestWithinRenderRadius(req, snapshot.visibleRegion, entity, config.coarseRenderRadiusView)) {
        continue;
      }
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "coarse";
      req.tier = "coarse";
      req.priority = computePriority(
        config.coarseLaneOffset,
        entity.importance,
        dist,
        config,
      );
      allRequests.push(req);
    }
  }
}

/**
 * Overview lane — for every entity in the snapshot (visible or not),
 * iterate the coarsest LOD's chunks via {@link iterateChunksAtLodRange}.
 * No active-set entry needed; the overview range is always
 * `[coarsest, coarsest]`. Removes the previous synthetic-entry
 * workaround that was in step 5 of `plan()`.
 *
 * Mutates `allRequests`.
 */
export function emitOverviewLane(
  entities: EntitySnapshot[],
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entity of entities) {
    if (entity.levels.length === 0) continue;

    const coarsest = Math.max(entity.levels.length - 1, 0);
    const chunks = iterateChunksAtLodRange(
      entity,
      [coarsest, coarsest],
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "overview";
      req.tier = "coarse";
      req.priority = computePriority(
        config.overviewLaneOffset,
        entity.importance,
        dist,
        config,
      );
      allRequests.push(req);
    }
  }
}

/**
 * Compute distance from a chunk's world-space center to the view center.
 *
 * Uses the visible region's sortCenter if available, otherwise the visible
 * region midpoint — offset by entity position to get local coordinates.
 * Converts grid indices to world-voxel positions using per-level chunk
 * world sizes so that distance is comparable across LODs.
 */
function chunkDistanceFromCenter(
  req: ChunkRequest,
  region: VisibleRegion,
  entity: EntitySnapshot,
): number {
  // View center in local (entity-relative) voxel coords.
  let centerX: number;
  let centerY: number;
  let centerZ: number;

  if (region.sortCenterVox !== null) {
    centerX = region.sortCenterVox[0] - entity.layoutPositionVox[0];
    centerY = region.sortCenterVox[1] - entity.layoutPositionVox[1];
    centerZ = region.sortCenterVox[2];
  } else {
    centerX =
      (region.xyBoundsVox[0] + region.xyBoundsVox[2]) / 2 -
      entity.layoutPositionVox[0];
    centerY =
      (region.xyBoundsVox[1] + region.xyBoundsVox[3]) / 2 -
      entity.layoutPositionVox[1];
    centerZ = (region.zRangeVox[0] + region.zRangeVox[1]) / 2;
  }

  const level0 = entity.levels[0];
  const geo = entity.levels[req.level];
  let cwX = 1;
  let cwY = 1;
  let cwZ = 1;
  if (geo !== undefined && level0 !== undefined) {
    [cwX, cwY, cwZ] = chunkWorldDims(geo, level0);
  }

  const dx = (req.x + 0.5) * cwX - centerX;
  const dy = (req.y + 0.5) * cwY - centerY;
  const dz = (req.z + 0.5) * cwZ - centerZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function requestWithinRenderRadius(
  req: ChunkRequest,
  region: VisibleRegion,
  entity: EntitySnapshot,
  radiusView: number,
): boolean {
  const level0 = entity.levels[0];
  const level = entity.levels[req.level];
  if (!level0 || !level) return true;
  return chunkWithinRenderRadius({
    region,
    radiusView,
    layoutPositionVox: entity.layoutPositionVox,
    geometry: {
      fullDims: [
        level0.shape[Axis.X],
        level0.shape[Axis.Y],
        level0.shape[Axis.Z],
      ],
      levelDims: [
        level.shape[Axis.X],
        level.shape[Axis.Y],
        level.shape[Axis.Z],
      ],
      chunkDims: [
        level.chunk_shape[Axis.X],
        level.chunk_shape[Axis.Y],
        level.chunk_shape[Axis.Z],
      ],
    },
    chunk: { x: req.x, y: req.y, z: req.z },
  });
}
