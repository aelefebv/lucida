/**
 * Per-dataset planning telemetry derived from a {@link RequestPlan}.
 * Feeds the DebugPanel "Planning" tab. Pure; cheap enough to call on
 * every cold-state rebuild.
 */

import type { PlanningDatasetDebug } from "../../debug/debugStats.ts";
import type {
  CacheStateSnapshot,
  EntitySnapshot,
  RequestPlan,
} from "./index.ts";
import type { VisibleRegion } from "../viewport.ts";

/**
 * Build the per-dataset planning debug snapshot. Pure function —
 * derives everything from the plan, the entity list, and the current
 * cache snapshot. No internal state.
 *
 * Cross-references `plan.requests` with `cacheSnap` to compute cached /
 * in-flight counts per LOD; consumes `plan.stats` for catalog
 * degradations and culling counters; picks a focal entity from the
 * visible entities by viewport-center proximity.
 *
 * `cacheSnap` is the caller's per-rebuild {@link CacheStateSnapshot} —
 * taking one is O(resident entities), so the coordinator captures it
 * once per rebuild and shares it across every dataset rather than
 * letting this function re-snapshot per call.
 *
 */
export function buildPlanningDatasetDebug(
  dsId: string,
  result: RequestPlan,
  entities: EntitySnapshot[],
  entityById: Map<string, EntitySnapshot>,
  visibleRegion: VisibleRegion,
  cacheSnap: CacheStateSnapshot,
): PlanningDatasetDebug {
  const lanes = { minimap: 0, detail: 0, coarse: 0, prefetch: 0 };
  const chunksByLevel: Record<number, number> = {};
  for (const r of result.requests) {
    lanes[r.lane]++;
    chunksByLevel[r.level] = (chunksByLevel[r.level] ?? 0) + 1;
  }

  // Per-LOD breakdown: planned (from plan), cached + in-flight (from cache).
  const cached: Record<number, number> = {};
  const inFlight: Record<number, number> = {};
  const activeEntityIds = new Set(result.activeSet.map(e => e.entityId));
  for (const eid of activeEntityIds) {
    const cs = cacheSnap.cached.get(eid);
    if (cs) {
      for (const k of cs) {
        const lvl = parseInt(k, 10);
        if (Number.isFinite(lvl)) cached[lvl] = (cached[lvl] ?? 0) + 1;
      }
    }
    const fs = cacheSnap.inFlight.get(eid);
    if (fs) {
      for (const k of fs) {
        const lvl = parseInt(k, 10);
        if (Number.isFinite(lvl)) inFlight[lvl] = (inFlight[lvl] ?? 0) + 1;
      }
    }
  }
  const allLevels = new Set<number>([
    ...Object.keys(chunksByLevel).map(Number),
    ...Object.keys(cached).map(Number),
    ...Object.keys(inFlight).map(Number),
  ]);
  const lodBreakdown = [...allLevels]
    .sort((a, b) => a - b)
    .map(level => ({
      level,
      planned: chunksByLevel[level] ?? 0,
      cached: cached[level] ?? 0,
      inFlight: inFlight[level] ?? 0,
    }));

  // Groups by mode. Tile-mode entries are deduped by parent group so
  // counts represent *groups* in each mode, not active-set entries.
  // Image-only datasets fall through with each image as its own "group"
  // (no parent edge → groupId == entityId), so a single dataset shows
  // up as one count without special-casing. Invisible entries are
  // excluded — they have no promotion mode.
  //
  // ActiveSetEntry and EntitySnapshot are both discriminated unions:
  // narrow on `kind` before classifying entries, and on
  // `ent.kind === "Tile"` before reading `parentId` (Image and Group
  // entities have no parent and fall back to their own entityId as
  // the groupId).
  const groupsByMode = { tilesWithDetail: 0, invisible: 0 };
  const groupsSeen = new Set<string>();
  for (const e of result.activeSet) {
    if (e.kind === "invisible") {
      groupsByMode.invisible++;
      continue;
    }
    // Narrowed: e is TileEntry.
    const ent = entityById.get(e.entityId);
    const groupId =
      ent !== undefined && ent.kind === "Tile" ? ent.parentId : e.entityId;
    if (groupsSeen.has(groupId)) continue;
    groupsSeen.add(groupId);
    groupsByMode.tilesWithDetail++;
  }

  // Focal entity: visible entity with centroid nearest viewport-center
  // (xy midpoint of the visible region — z ignored since the focal
  // inspector is mostly used for slice-mode navigation).
  const cx = (visibleRegion.xyBoundsVox[0] + visibleRegion.xyBoundsVox[2]) / 2;
  const cy = (visibleRegion.xyBoundsVox[1] + visibleRegion.xyBoundsVox[3]) / 2;
  let focal: EntitySnapshot | null = null;
  let bestDist = Infinity;
  for (const e of entities) {
    if (!e.visible) continue;
    const dx = e.centroidWorld[0] - cx;
    const dy = e.centroidWorld[1] - cy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      focal = e;
    }
  }
  let focalEntity: PlanningDatasetDebug["focalEntity"] = null;
  if (focal) {
    const focalId = focal.entityId;
    const entry = result.activeSet.find(e => e.entityId === focalId);
    let topPriority: number | null = null;
    let chunkCount = 0;
    for (const r of result.requests) {
      if (r.entityId !== focalId) continue;
      chunkCount++;
      if (topPriority === null || r.priority < topPriority) topPriority = r.priority;
    }
    // Derive `mode` and `detailOwnedRange` per variant: only tile
    // entries carry a real LOD range.
    let displayMode: string;
    let detailOwnedRange: [number, number];
    if (entry === undefined) {
      displayMode = "unknown";
      detailOwnedRange = [0, 0];
    } else if (entry.kind === "invisible") {
      displayMode = "invisible";
      detailOwnedRange = [entry.coarsestLod, entry.coarsestLod];
    } else {
      displayMode = entry.mode;
      detailOwnedRange = entry.detailOwnedLodRange;
    }
    // Only `TileSnapshot` carries a `parentId`; narrow before
    // reading. `Image` and `Group` focal entities surface as having no
    // parent group.
    const parentGroupId = focal.kind === "Tile" ? focal.parentId : null;
    focalEntity = {
      entityId: focal.entityId,
      parentGroupId,
      kind: focal.kind,
      projectedDiagonalPx: focal.projectedDiagonalPx,
      projectedAreaPx2: focal.projectedAreaPx2,
      importance: focal.importance,
      idealTargetLod: focal.idealTargetLod,
      detailOwnedRange,
      mode: displayMode,
      modeReason:
        entry?.kind === "tile"
          ? `detail L${entry.detailLevel}${entry.coarseLevel === null ? "" : ` → coarse L${entry.coarseLevel}`}`
          : "outside the active chunk set",
      topPriority,
      chunkCount,
    };
  }

  return {
    datasetId: dsId,
    lanes,
    totalChunks: result.requests.length,
    chunksByLevel,
    lodBreakdown,
    culling: result.stats.culling,
    groupsByMode,
    focalEntity,
  };
}
