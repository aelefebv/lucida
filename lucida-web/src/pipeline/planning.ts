/**
 * Planning domain — types and runtime functions for the chunk planning pipeline.
 *
 * This module defines the full input/output contract for the planning step:
 *   PlanningSnapshot  ->  RequestPlan
 *
 * Currently implements:
 *   - promote()  — promotion/demotion + LOD range assignment
 *   - createSyntheticSnapshot() / createSyntheticEntity() — test helpers
 */

import type { LevelGeometry } from "../contentTypes.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Projected diagonal (px) at which an overview entity promotes to detail. */
export const PROMOTE_THRESHOLD_PX = 80;

/** Projected diagonal (px) below which a detail entity demotes to overview. */
export const DEMOTE_THRESHOLD_PX = 40;

/** Priority lane offset for overview requests (lowest urgency). */
export const OVERVIEW_LANE_OFFSET = 2000;

/** Priority lane offset for runway (prefetch) requests. */
export const RUNWAY_LANE_OFFSET = 1000;

/** Priority lane offset for detail requests (highest urgency). */
export const DETAIL_LANE_OFFSET = 0;

/** Number of future timepoints to prefetch in the runway lane. */
export const RUNWAY_DEPTH = 2;

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

export interface PlanningEpochs {
  content: number;
  layout: number;
  view: number;
  selection: number;
  /** Placeholder — always 0 until Asset Catalog (step 6). */
  asset: number;
  /** Placeholder — always 0 initially. */
  request: number;
}

// ---------------------------------------------------------------------------
// VisibleRegion
// ---------------------------------------------------------------------------

export interface VisibleRegion {
  /** [minX, minY, maxX, maxY] in voxel coordinates. */
  xyBounds: [number, number, number, number];
  /** [start, end) voxel Z range. */
  zRange: [number, number];
  /** Screen pixels per voxel. */
  effectiveZoom: number;
  sortCenter: [number, number, number] | null;
  /** Six frustum half-planes, or null for 2-D views. */
  frustumPlanes: [number, number, number, number][] | null;
}

// ---------------------------------------------------------------------------
// EntitySnapshot
// ---------------------------------------------------------------------------

export interface EntitySnapshot {
  entityId: string;
  imageId: string;
  kind: "Image" | "Well" | "Field";
  visible: boolean;
  projectedDiagonalPx: number;
  projectedAreaPx2: number;
  centroidWorld: [number, number, number];
  idealTargetLod: number;
  importance: number;
  numLevels: number;
  levels: LevelGeometry[];
  /** Layout placement position. */
  position: [number, number];
}

// ---------------------------------------------------------------------------
// SelectionState
// ---------------------------------------------------------------------------

export interface SelectionState {
  t: number;
  c: number;
  z: number;
  visibleChannels: number[];
  renderMode: "slice" | "volume";
  interactionState: "idle" | "panning" | "zooming" | "scrubbing";
}

// ---------------------------------------------------------------------------
// Cache / worker snapshots
// ---------------------------------------------------------------------------

export interface CacheStateSnapshot {
  /** entityId -> set of chunk keys currently cached. */
  cached: Map<string, Set<string>>;
  /** entityId -> set of chunk keys currently being fetched. */
  inFlight: Map<string, Set<string>>;
}

export interface WorkerWantedSetSnapshot {
  /** entityId -> set of chunk keys resident on the GPU worker. */
  resident: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// AssetCatalogSnapshot (placeholder)
// ---------------------------------------------------------------------------

export interface AssetCatalogSnapshot {
  // No fields until step 6.
}

// ---------------------------------------------------------------------------
// PlanningSnapshot  (full input)
// ---------------------------------------------------------------------------

export interface PlanningSnapshot {
  epochs: PlanningEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  cacheState: CacheStateSnapshot;
  workerWantedSet: WorkerWantedSetSnapshot;
  previousActiveSet: ActiveSetEntry[];
  /** null until step 6 (Asset Catalog). */
  assetCatalog: AssetCatalogSnapshot | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface RequestPlan {
  requests: ChunkRequest[];
  activeSet: ActiveSetEntry[];
  epochs: PlanningEpochs;
}

export interface ChunkRequest {
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  lane: "overview" | "detail" | "runway";
  priority: number;
  /** Canonical key: "level/t/c/z/y/x" */
  chunkKey: string;
}

export type Representation = "overview" | "proxy" | "detail";

export interface ActiveSetEntry {
  entityId: string;
  imageId: string;
  representation: Representation;
  targetLod: number;
  seedDetailLod: number;
  /** [finest, coarsest] inclusive. */
  detailOwnedLodRange: [number, number];
}

// ---------------------------------------------------------------------------
// promote()
// ---------------------------------------------------------------------------

/**
 * Decide each entity's representation (overview vs detail) and compute its
 * LOD range.  Uses hysteresis: entities between the promote and demote
 * thresholds keep their previous representation.
 */
export function promote(
  entities: EntitySnapshot[],
  previousActiveSet: ActiveSetEntry[],
): ActiveSetEntry[] {
  // Build O(1) lookup from previous active set.
  const previousByEntity = new Map<string, ActiveSetEntry>();
  for (const entry of previousActiveSet) {
    previousByEntity.set(entry.entityId, entry);
  }

  return entities.map((entity) => {
    // Invisible entities are always overview.
    if (!entity.visible) {
      return makeOverviewEntry(entity);
    }

    let representation: Representation;

    if (entity.projectedDiagonalPx >= PROMOTE_THRESHOLD_PX) {
      representation = "detail";
    } else if (entity.projectedDiagonalPx < DEMOTE_THRESHOLD_PX) {
      representation = "overview";
    } else {
      // Hysteresis band — keep previous representation (default to overview).
      const prev = previousByEntity.get(entity.entityId);
      representation =
        prev !== undefined && prev.representation === "detail"
          ? "detail"
          : "overview";
    }

    if (representation === "detail") {
      return makeDetailEntry(entity);
    }
    return makeOverviewEntry(entity);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeOverviewEntry(entity: EntitySnapshot): ActiveSetEntry {
  const coarsest = Math.max(entity.numLevels - 1, 0);
  return {
    entityId: entity.entityId,
    imageId: entity.imageId,
    representation: "overview",
    targetLod: coarsest,
    seedDetailLod: coarsest,
    detailOwnedLodRange: [coarsest, coarsest],
  };
}

function makeDetailEntry(entity: EntitySnapshot): ActiveSetEntry {
  const targetLod = entity.idealTargetLod;
  const seedDetailLod = Math.min(targetLod + 2, entity.numLevels - 1);
  return {
    entityId: entity.entityId,
    imageId: entity.imageId,
    representation: "detail",
    targetLod,
    seedDetailLod,
    detailOwnedLodRange: [targetLod, seedDetailLod],
  };
}

// ---------------------------------------------------------------------------
// Synthetic test helpers
// ---------------------------------------------------------------------------

/** Create a valid {@link EntitySnapshot} with sensible defaults, merged with overrides. */
export function createSyntheticEntity(
  overrides?: Partial<EntitySnapshot>,
): EntitySnapshot {
  return {
    entityId: "entity-0",
    imageId: "image-0",
    kind: "Image",
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    importance: 1,
    numLevels: 5,
    levels: [],
    position: [0, 0],
    ...overrides,
  };
}

/** Create a valid {@link PlanningSnapshot} with sensible defaults, merged with overrides. */
export function createSyntheticSnapshot(
  overrides?: Partial<PlanningSnapshot>,
): PlanningSnapshot {
  return {
    epochs: {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
      asset: 0,
      request: 0,
    },
    entities: [],
    visibleRegion: {
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 1],
      effectiveZoom: 1,
      sortCenter: null,
      frustumPlanes: null,
    },
    selection: {
      t: 0,
      c: 0,
      z: 0,
      visibleChannels: [0],
      renderMode: "slice",
      interactionState: "idle",
    },
    cacheState: { cached: new Map(), inFlight: new Map() },
    workerWantedSet: { resident: new Map() },
    previousActiveSet: [],
    assetCatalog: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// chunkKey()
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// chunkOutsideFrustum()
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// iterateChunks()
// ---------------------------------------------------------------------------

/**
 * Enumerate chunk grid cells for a promoted entity, applying spatial culling
 * and cache filtering.  Iterates all LOD levels in the entry's owned range,
 * all visible channels, and the spatial grid cells that overlap the visible
 * region.
 *
 * Ported from Rust `visible_chunks()` in lucida-core/src/chunk.rs.
 */
export function iterateChunks(
  entity: EntitySnapshot,
  entry: ActiveSetEntry,
  visibleRegion: VisibleRegion,
  selection: SelectionState,
  cacheState: CacheStateSnapshot,
): ChunkRequest[] {
  const requests: ChunkRequest[] = [];

  if (entity.levels.length === 0) {
    return requests;
  }

  const [finest, coarsest] = entry.detailOwnedLodRange;
  const cachedSet = cacheState.cached.get(entity.entityId);

  // Iterate from coarsest (seed) down to finest (target).
  for (let level = coarsest; level >= finest; level--) {
    const levelGeo = entity.levels[level];
    if (levelGeo === undefined) continue;

    const level0 = entity.levels[0];
    if (level0 === undefined) continue;

    for (const c of selection.visibleChannels) {
      iterateGridCells(
        entity,
        visibleRegion,
        selection,
        levelGeo,
        level0,
        level,
        c,
        cachedSet,
        requests,
      );
    }
  }

  return requests;
}

/**
 * Iterate the spatial grid cells for one (level, channel) pair, pushing
 * matching ChunkRequests into `out`.
 */
function iterateGridCells(
  entity: EntitySnapshot,
  region: VisibleRegion,
  selection: SelectionState,
  levelGeo: LevelGeometry,
  level0: LevelGeometry,
  level: number,
  c: number,
  cachedSet: Set<string> | undefined,
  out: ChunkRequest[],
): void {
  // 5D indices: [T=0, C=1, Z=2, Y=3, X=4]
  const levelX = levelGeo.shape[4];
  const levelY = levelGeo.shape[3];
  const levelZ = levelGeo.shape[2];

  const chunkX = levelGeo.chunk_shape[4];
  const chunkY = levelGeo.chunk_shape[3];
  const chunkZ = levelGeo.chunk_shape[2];

  const fullX = level0.shape[4];
  const fullY = level0.shape[3];
  const fullZ = level0.shape[2];

  // Per-axis scale: how many full-res voxels per level voxel.
  const scaleX = fullX / levelX;
  const scaleY = fullY / levelY;
  const scaleZ = fullZ / levelZ;

  const chunkWorldX = chunkX * scaleX;
  const chunkWorldY = chunkY * scaleY;
  const chunkWorldZ = chunkZ * scaleZ;

  // Max grid index (exclusive).
  const maxCol = levelGeo.grid_shape[4];
  const maxRow = levelGeo.grid_shape[3];
  const maxZ = levelGeo.grid_shape[2];

  // Offset visible region by entity position to get local coords.
  const localMinX = region.xyBounds[0] - entity.position[0];
  const localMinY = region.xyBounds[1] - entity.position[1];
  const localMaxX = region.xyBounds[2] - entity.position[0];
  const localMaxY = region.xyBounds[3] - entity.position[1];

  // Early-out: no overlap at all.
  if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) {
    return;
  }

  const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
  const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
  const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
  const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));

  const zStart = Math.max(0, Math.floor(region.zRange[0] / chunkWorldZ));
  const zEnd = Math.min(maxZ, Math.max(0, Math.ceil(region.zRange[1] / chunkWorldZ)));

  for (let iz = zStart; iz < zEnd; iz++) {
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        // Frustum culling in global voxel space.
        // Frustum planes are in the first member's coordinate system, so
        // we must offset chunk coords by entity position before testing.
        if (region.frustumPlanes !== null) {
          const cmin: [number, number, number] = [
            col * chunkWorldX + entity.position[0],
            row * chunkWorldY + entity.position[1],
            iz * chunkWorldZ,
          ];
          const cmax: [number, number, number] = [
            (col + 1) * chunkWorldX + entity.position[0],
            (row + 1) * chunkWorldY + entity.position[1],
            (iz + 1) * chunkWorldZ,
          ];
          if (chunkOutsideFrustum(cmin, cmax, region.frustumPlanes)) {
            continue;
          }
        }

        const key = chunkKey(level, selection.t, c, iz, row, col);

        // Skip already-cached chunks.
        if (cachedSet !== undefined && cachedSet.has(key)) {
          continue;
        }

        out.push({
          entityId: entity.entityId,
          imageId: entity.imageId,
          level,
          t: selection.t,
          c,
          z: iz,
          y: row,
          x: col,
          lane: "detail",
          priority: 0,
          chunkKey: key,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// computePriority()
// ---------------------------------------------------------------------------

/**
 * Compute a numeric priority for a chunk request.
 *
 * Lower values = more urgent.  The lane offset separates the three lanes
 * (detail < runway < overview), while importance and distance provide
 * intra-lane ordering.
 */
function computePriority(
  laneOffset: number,
  importance: number,
  distanceFromCenter: number,
): number {
  return laneOffset + (1.0 - importance) * 500 + distanceFromCenter * 10;
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

/**
 * Top-level pure planning function.
 *
 * Composes promotion, chunk iteration, and three-lane scheduling into a
 * single {@link RequestPlan}.
 */
export function plan(snapshot: PlanningSnapshot): RequestPlan {
  // Step 1: Promote.
  const activeSet = promote(snapshot.entities, snapshot.previousActiveSet);

  // Step 2: Build entity lookup.
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const allRequests: ChunkRequest[] = [];

  // Step 3: Detail lane.
  for (const entry of activeSet) {
    if (entry.representation !== "detail") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    const chunks = iterateChunks(
      entity,
      entry,
      snapshot.visibleRegion,
      snapshot.selection,
      snapshot.cacheState,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "detail";
      req.priority = computePriority(DETAIL_LANE_OFFSET, entity.importance, dist);
      allRequests.push(req);
    }
  }

  // Step 4: Runway lane.
  for (const entry of activeSet) {
    if (entry.representation !== "detail") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    for (let dt = 1; dt <= RUNWAY_DEPTH; dt++) {
      const runwaySelection: SelectionState = {
        ...snapshot.selection,
        t: snapshot.selection.t + dt,
      };

      const chunks = iterateChunks(
        entity,
        entry,
        snapshot.visibleRegion,
        runwaySelection,
        snapshot.cacheState,
      );
      for (const req of chunks) {
        const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
        req.lane = "runway";
        req.priority = computePriority(
          RUNWAY_LANE_OFFSET + dt * 100,
          entity.importance,
          dist,
        );
        allRequests.push(req);
      }
    }
  }

  // Step 5: Overview lane.
  for (const entity of snapshot.entities) {
    if (entity.levels.length === 0) continue;

    const coarsest = Math.max(entity.numLevels - 1, 0);
    const overviewEntry: ActiveSetEntry = {
      entityId: entity.entityId,
      imageId: entity.imageId,
      representation: "overview",
      targetLod: coarsest,
      seedDetailLod: coarsest,
      detailOwnedLodRange: [coarsest, coarsest],
    };

    const chunks = iterateChunks(
      entity,
      overviewEntry,
      snapshot.visibleRegion,
      snapshot.selection,
      snapshot.cacheState,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "overview";
      req.priority = computePriority(OVERVIEW_LANE_OFFSET, entity.importance, dist);
      allRequests.push(req);
    }
  }

  // Step 6: Merge and sort by priority (ascending — lower = more urgent).
  allRequests.sort((a, b) => a.priority - b.priority);

  // Step 7: Epoch propagation.
  const epochs: PlanningEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  // Step 8: Return.
  return { requests: allRequests, activeSet, epochs };
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

  if (region.sortCenter !== null) {
    centerX = region.sortCenter[0] - entity.position[0];
    centerY = region.sortCenter[1] - entity.position[1];
    centerZ = region.sortCenter[2];
  } else {
    centerX =
      (region.xyBounds[0] + region.xyBounds[2]) / 2 - entity.position[0];
    centerY =
      (region.xyBounds[1] + region.xyBounds[3]) / 2 - entity.position[1];
    centerZ = (region.zRange[0] + region.zRange[1]) / 2;
  }

  // Compute chunk world size at this level.
  const level0 = entity.levels[0];
  const geo = entity.levels[req.level];
  let cwX = 1;
  let cwY = 1;
  let cwZ = 1;
  if (geo !== undefined && level0 !== undefined) {
    cwX = geo.chunk_shape[4] * (level0.shape[4] / geo.shape[4]);
    cwY = geo.chunk_shape[3] * (level0.shape[3] / geo.shape[3]);
    cwZ = geo.chunk_shape[2] * (level0.shape[2] / geo.shape[2]);
  }

  const dx = (req.x + 0.5) * cwX - centerX;
  const dy = (req.y + 0.5) * cwY - centerY;
  const dz = (req.z + 0.5) * cwZ - centerZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
