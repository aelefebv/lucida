/**
 * Planning domain — lane emission helpers and priority computation.
 *
 * Translates active-set entries and minimap-pending coords into
 * {@link ChunkRequest} / {@link ProxyRequest} streams, one per planning
 * lane. The lane offsets and priority weights live on
 * {@link PlanningConfig} so they can be live-tuned. `computePriority`
 * is the shared formula every emitter consumes.
 *
 * PRD #578 / Slice 1 (ADR 0029): emission and priority helpers extracted
 * out of `./index.ts` into this dedicated file.
 */

import { Axis } from "../../axes.ts";
import type { VisibleRegion } from "../viewport.ts";
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

// ---------------------------------------------------------------------------
// computePriority()
// ---------------------------------------------------------------------------

/**
 * Compute a numeric priority for a chunk request.
 *
 * Lower values = more urgent.  The lane offset separates the lanes
 * (detail < proxy < prefetch < overview), while importance and distance
 * provide intra-lane ordering. Both coefficients live on
 * {@link PlanningConfig} so they can be twisted live.
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

// ---------------------------------------------------------------------------
// Lane emission helpers
// ---------------------------------------------------------------------------

/**
 * Minimap lane — promoted to its own dedicated highest-priority lane
 * by Slice 5 of PRD #545. For every {@link EntitySnapshot} in
 * `entities`, look up `minimapPending.get(entity.imageId)` and emit
 * one {@link ChunkRequest} per coord with `priority = config.minimapLaneOffset`
 * directly (no importance / distance terms — minimap chunks are
 * per-dataset, not per-entity-importance).
 *
 * Cited in ADR 0023. Mutates `out`.
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
      // Single proxy request per visible channel; no chunks.
      // `imageId: ""` matches the `well-as-proxy` convention from the
      // pre-discrimination shape — wells have no single owning image.
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

    // Invisible entries contribute neither chunks nor proxies.
    if (entry.kind === "invisible") continue;

    // Narrowed: entry is FieldEntry below this point.
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    // Field-mode entries: emit chunk requests at detail priority.
    const chunks = iterateChunks(
      entity,
      entry,
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "detail";
      req.priority = computePriority(
        config.detailLaneOffset,
        entity.importance,
        dist,
        config,
      );
      allRequests.push(req);
    }

    // Field proxy fallback (per visible channel).
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

    // Parent-well proxy (only for proxy-fallback mode, deduped per
    // (wellId, t, c)). At `fields-with-detail` zoom the chunk path is
    // expected to keep up — no extra parent fetch.
    //
    // PRD #563 / Slice 5: only `FieldSnapshot` carries a `parentId`.
    // Narrow on `kind === "Field"` before reading it; the post-narrow
    // access is non-null. Field-mode active entries map to Field
    // entities (image-mode datasets have no parent well to fall back
    // to), so a non-Field here is a producer invariant violation we
    // skip silently.
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
    // Only field entries get prefetch — well-as-proxy needs no chunks
    // and invisible entries contribute none.
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

      const chunks = iterateChunks(
        entity,
        entry,
        snapshot.visibleRegion,
        prefetchSelection,
        stats,
        datasetId,
      );
      for (const req of chunks) {
        const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
        req.lane = "prefetch";
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

// ---------------------------------------------------------------------------
// chunkDistanceFromCenter()
// ---------------------------------------------------------------------------

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

  // Compute chunk world size at this level via the shared helper.
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
