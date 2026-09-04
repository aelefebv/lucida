/**
 * Lane emission helpers + priority computation. Translates active-set
 * entries and minimap-pending coords into {@link ChunkRequest} /
 * {@link ProxyRequest} streams, one per lane. See ADR 0029.
 */

import { Axis } from "../../axes.ts";
import type { VisibleRegion } from "../viewport.ts";
import { chunkWithinRenderRadius } from "../renderRadius.ts";
import {
  chunkWorldDims,
  compareChunkRequests,
  iterateChunks,
  iterateChunksAtLevels,
} from "./chunks.ts";
import {
  MINIMAP_SEED_BULK_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  type PlanningConfig,
} from "./config.ts";
import type {
  ActiveSetEntry,
  ChunkRequest,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
  PlanStats,
  ProxyRequest,
  SelectionState,
  TileEntry,
  ZoomDirection,
} from "./types.ts";

/**
 * Numeric priority for a chunk request. Lower = more urgent. Lane
 * offset separates lanes (minimap < detail < proxy < prefetch < coarse);
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

function stampRequest(
  req: ChunkRequest,
  entity: EntitySnapshot,
  snapshot: PlanningSnapshot,
  config: PlanningConfig,
  lane: ChunkRequest["lane"],
  tier: ChunkRequest["tier"],
  laneOffset: number,
  radiusView: number,
): boolean {
  if (!requestWithinRenderRadius(req, snapshot.visibleRegion, entity, radiusView)) return false;
  const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity, config.depthBiasView);
  req.lane = lane;
  req.tier = tier;
  req.priority = computePriority(laneOffset, entity.importance, dist, config);
  return true;
}

/**
 * Minimap lane (see ADR 0023). For every {@link EntitySnapshot} in
 * `entities`, look up `minimapPending.get(entity.imageId)` and emit one
 * {@link ChunkRequest} per coord (no importance / distance terms —
 * minimap chunks are per-dataset, not per-entity-importance).
 *
 * Priority is two-mode. The dedicated top lane
 * (`config.minimapLaneOffset`) is justified by the seed set being SMALL
 * — a bounded ~1 s starvation window for the view lanes. On a wide
 * collection the whole-collection seed set is tens of thousands of
 * chunks; at top priority it would hold every fetch slot for tens of
 * minutes while the visible band waits. Once the pending map's TOTAL
 * demand exceeds `config.minimapSeedFastMaxChunks` (module default when
 * the caller's config lacks the knob), everything emitted here rides
 * the bulk lane: `max(bulk offset, bulkPriorityFloor)`, strictly behind
 * every request the plan emitted before this call — a constant offset
 * alone cannot guarantee that, because the other lanes' distance terms
 * are unbounded. Bulk seeding then fills opportunistically as fetch
 * slots free up: the minimap can fill over minutes; the view cannot.
 *
 * `bulkPriorityFloor` — a priority strictly greater than every request
 * already emitted into this plan (the caller computes it; this emitter
 * must run after the view-serving lanes).
 *
 * Mutates `out`.
 */
export function emitMinimapLane(
  minimapPending: Map<string, MinimapChunkCoord[]>,
  entities: EntitySnapshot[],
  datasetId: string,
  config: PlanningConfig,
  bulkPriorityFloor: number,
  out: ChunkRequest[],
): void {
  if (minimapPending.size === 0) return;
  // The fast/bulk decision reads the WHOLE pending map, not the
  // entity-joined subset this call happens to emit: seeding producers
  // enumerate every dataset image (the map can cover members outside
  // this call's entity set) and the fetch queue the demand lands in is
  // shared, so the starvation cost is a property of the full demand.
  let pendingTotal = 0;
  for (const coords of minimapPending.values()) {
    pendingTotal += coords.length;
  }
  // Fall back to the module defaults when the caller's config predates
  // the seed knobs (structural typing admits such objects) — large
  // demand must never ride the fast lane because a knob is absent.
  const fastMax = config.minimapSeedFastMaxChunks ?? MINIMAP_SEED_FAST_MAX_CHUNKS;
  const bulkBase = config.minimapSeedBulkLaneOffset ?? MINIMAP_SEED_BULK_LANE_OFFSET;
  const priority =
    pendingTotal > fastMax
      ? Math.max(bulkBase, bulkPriorityFloor)
      : config.minimapLaneOffset;
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
        priority,
        chunkKey: coord.key,
      });
    }
  }
}

/**
 * Detail lane — for each active entry, push detail chunks (tile modes)
 * or a single proxy request per visible channel (`group-as-proxy`).
 *
 * Also emits the per-tile TileProxy3D fallback for tile-mode entries
 * whose proxy is advertised, and a parent `GroupProxy3D` (deduped per
 * `(groupId, t, c)`) when the entry is in `tiles-with-proxy-fallback`
 * and the parent group's proxy is advertised.
 *
 * Mutates `allRequests`, `proxyRequests`, and `groupProxyEmitted`.
 */
export function emitDetailLane(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  entityById: Map<string, EntitySnapshot>,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  proxyRequests: ProxyRequest[],
  groupProxyEmitted: Set<string>,
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    if (entry.kind === "group-as-proxy") {
      // `imageId: ""` matches the pre-discrimination convention — groups
      // have no single owning image.
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId,
          entityId: entry.entityId,
          imageId: "",
          kind: "GroupProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + 0,
        });
      }
      continue;
    }

    if (entry.kind === "invisible") continue;

    // Narrowed: entry is TileEntry below this point.
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    const chunks = iterateChunks(
      entity,
      entry,
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      const kept = stampRequest(
        req, entity, snapshot, config,
        "detail", "detail", config.detailLaneOffset, config.detailRenderRadiusView,
      );
      if (kept) allRequests.push(req);
    }

    if (entry.proxyAvailable && entry.proxyKind === "TileProxy3D") {
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId,
          entityId: entry.entityId,
          imageId: entry.imageId,
          kind: "TileProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + 1,
        });
      }
    }

    // Parent-group proxy (only for proxy-fallback mode; at
    // `tiles-with-detail` zoom the chunk path keeps up). Dedup per
    // (groupId, t, c). Narrow on `kind === "Tile"` because only
    // `TileSnapshot` carries a `parentId`; a non-Tile here is a
    // producer invariant violation we skip silently.
    if (
      entry.mode === "tiles-with-proxy-fallback" &&
      entry.groupProxyAvailable &&
      entity.kind === "Tile"
    ) {
      const groupId = entity.parentId;
      for (const c of snapshot.selection.visibleChannels) {
        const dedupKey = `${groupId}|${snapshot.selection.t}|${c}`;
        if (groupProxyEmitted.has(dedupKey)) continue;
        groupProxyEmitted.add(dedupKey);
        proxyRequests.push({
          datasetId,
          entityId: groupId,
          imageId: "",
          kind: "GroupProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + config.groupProxyPriorityBump,
        });
      }
    }
  }
}

/**
 * The target's neighbor among the source levels in the zoom direction. A
 * pinned target never moves with the zoom, so it gets none. Generated coarse
 * levels are absent from `sourceLevels`, so they are never returned (ADR 0040).
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
 * Prefetch lane — for each tile-mode active entry, chunks at future
 * timepoints, and chunks at the next level in the direction of the last
 * zoom change so that level is partly resident when the target crosses
 * to it.
 *
 * The lane's budget per entity is `prefetchDepth` steps, each the visible
 * target-level set. With no level to prefetch, every step is a future
 * timepoint, as before. With one, the level step takes the lane's last
 * step and the timepoint steps keep the ones before it. The level step
 * also takes any step the timepoints cannot fill, nearest the view center
 * first. The lane never exceeds the budget either way.
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
  zoomDirection: ZoomDirection | null,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    if (entry.kind !== "tile") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;
    if (entity.levels.length === 0) continue;

    const level = levelInZoomDirection(entity, zoomDirection);
    const timepointStepsAllowed = level === null ? config.prefetchDepth : config.prefetchDepth - 1;
    let timepointSteps = 0;
    const maxT = entity.levels[0]?.grid_shape[Axis.T] ?? 0;
    for (let dt = 1; dt <= timepointStepsAllowed; dt++) {
      const nextT = snapshot.selection.t + dt;
      if (nextT >= maxT) break;
      const prefetchSelection: SelectionState = {
        ...snapshot.selection,
        t: nextT,
      };

      const chunks = iterateChunks(
        entity,
        entry,
        snapshot.visibleRegion,
        prefetchSelection,
        stats,
        datasetId,
      );
      for (const req of chunks) {
        const kept = stampRequest(
          req, entity, snapshot, config,
          "prefetch", "detail", config.prefetchLaneOffset + dt * 100, config.detailRenderRadiusView,
        );
        if (kept) allRequests.push(req);
      }
      timepointSteps++;
    }

    if (level === null) continue;
    const stepsLeft = config.prefetchDepth - timepointSteps;
    if (stepsLeft <= 0) continue;
    const stepSize = countTargetLevelRequests(entity, entry, snapshot, config);
    emitLevelPrefetch(entity, level, snapshot, stats, allRequests, config, stepsLeft * stepSize);
  }
}

/** The size of one prefetch step: what the detail lane emits for the entry. */
function countTargetLevelRequests(
  entity: EntitySnapshot,
  entry: TileEntry,
  snapshot: PlanningSnapshot,
  config: PlanningConfig,
): number {
  let count = 0;
  for (const req of iterateChunks(entity, entry, snapshot.visibleRegion, snapshot.selection)) {
    if (requestWithinRenderRadius(req, snapshot.visibleRegion, entity, config.detailRenderRadiusView)) {
      count++;
    }
  }
  return count;
}

/**
 * The prefetch lane's level step: the `allowance` chunks at `level` nearest
 * the view center. Within one entity and offset, priority order is distance
 * order, so the sort picks them. The offset is the lane's last step slot, so
 * the step ranks behind every timepoint step.
 *
 * Mutates `allRequests`.
 */
function emitLevelPrefetch(
  entity: EntitySnapshot,
  level: number,
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  config: PlanningConfig,
  allowance: number,
): void {
  if (allowance <= 0) return;
  const candidates: ChunkRequest[] = [];
  const chunks = iterateChunksAtLevels(
    entity,
    [level],
    snapshot.visibleRegion,
    snapshot.selection,
    stats,
    snapshot.datasetId,
  );
  for (const req of chunks) {
    const kept = stampRequest(
      req, entity, snapshot, config,
      "prefetch", "detail",
      config.prefetchLaneOffset + config.prefetchDepth * 100,
      config.detailRenderRadiusView,
    );
    if (kept) candidates.push(req);
  }
  candidates.sort(compareChunkRequests);
  for (const req of candidates.slice(0, allowance)) allRequests.push(req);
}

/**
 * The coarse lane is the source-backed floor under the detail tier. It
 * emits exactly the coarse level on each tile entry, independent of the
 * detail lane, and skips the levels between.
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
    if (entry.kind !== "tile") continue;
    if (entry.coarseLevel === null) continue;

    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    const chunks = iterateChunksAtLevels(
      entity,
      [entry.coarseLevel],
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      const kept = stampRequest(
        req, entity, snapshot, config,
        "coarse", "coarse", config.coarseLaneOffset, config.coarseRenderRadiusView,
      );
      if (kept) allRequests.push(req);
    }
  }
}

/**
 * Compute distance from a chunk's world-space center to the view center.
 *
 * Uses the visible region's sortCenter if available, otherwise the visible
 * region midpoint — offset by entity position to get local coordinates.
 * Converts grid indices to world-voxel positions using per-level chunk
 * world sizes so that distance is comparable across levels.
 *
 * `depthBiasView` (issue #532) shifts the focal Z — the center-out
 * spawn origin along the near↔far axis — by a fraction of the visible
 * region's half-depth. It is `0` by default, which adds exactly nothing
 * to `centerZ`, so the distance (and thus priority) is byte-identical to
 * the unbiased computation. See {@link applyDepthBias}.
 */
function chunkDistanceFromCenter(
  req: ChunkRequest,
  region: VisibleRegion,
  entity: EntitySnapshot,
  depthBiasView = 0,
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

  centerZ = applyDepthBias(centerZ, region, depthBiasView);

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

/**
 * Shift the focal Z (the center-out spawn origin along the near↔far
 * axis) by `depthBiasView`, a fraction of the visible region's
 * half-depth (issue #532).
 *
 * The bias is clamped to `[-1, 1]`; `-1` lands the focal Z on the near
 * plane (`zRangeVox[0]`), `+1` on the far plane (`zRangeVox[1]`). The
 * shifted value is clamped to the visible Z range.
 *
 * **Safety property:** when `depthBiasView === 0` this returns `centerZ`
 * unchanged — no arithmetic, no clamp — so the caller's distance and
 * priority are byte-identical to the unbiased path. Only a non-zero
 * bias ever moves the focal Z.
 */
function applyDepthBias(
  centerZ: number,
  region: VisibleRegion,
  depthBiasView: number,
): number {
  if (depthBiasView === 0) return centerZ;
  const bias = Math.min(1, Math.max(-1, depthBiasView));
  const zMin = region.zRangeVox[0];
  const zMax = region.zRangeVox[1];
  const halfDepth = (zMax - zMin) / 2;
  const shifted = centerZ + bias * halfDepth;
  return Math.min(zMax, Math.max(zMin, shifted));
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
