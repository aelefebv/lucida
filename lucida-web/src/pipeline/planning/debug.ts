/**
 * Per-dataset planning telemetry derived from a {@link RequestPlan}.
 * Feeds the DebugPanel "Planning" tab. Pure; cheap enough to call on
 * every cold-state rebuild.
 */

import type { CpuCache } from "../fetch/index.ts";
import type { PlanningDatasetDebug } from "../../debug/debugStats.ts";
import type {
  EntitySnapshot,
  RequestPlan,
} from "./index.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { PlanningConfig } from "./config.ts";

/**
 * Translate a focal entity's projected diagonal into a human-readable
 * mode-band classification. Mirrors {@link chooseEntityMode}; both
 * read the same {@link PlanningConfig} so they cannot drift.
 */
export function modeReason(diagPx: number, config: PlanningConfig): string {
  const farUpper = config.farThresholdPx + config.hysteresisPx;
  const farLower = config.farThresholdPx - config.hysteresisPx;
  const medUpper = config.detailThresholdPx + config.hysteresisPx;
  const medLower = config.detailThresholdPx - config.hysteresisPx;

  if (diagPx < farLower) return `${diagPx.toFixed(0)}px < ${farLower} → clearly proxy`;
  if (diagPx > medUpper) return `${diagPx.toFixed(0)}px > ${medUpper} → clearly detail`;
  if (diagPx >= farUpper && diagPx <= medLower) {
    return `${diagPx.toFixed(0)}px ∈ [${farUpper}, ${medLower}] → clearly fallback`;
  }
  if (diagPx < farUpper) {
    return `${diagPx.toFixed(0)}px ∈ [${farLower}, ${farUpper}] hysteresis band`;
  }
  return `${diagPx.toFixed(0)}px ∈ [${medLower}, ${medUpper}] hysteresis band`;
}

/**
 * Build the per-dataset planning debug snapshot. Pure function —
 * derives everything from the plan, the entity list, and the current
 * cache snapshot. No internal state.
 *
 * Cross-references `plan.requests` with `cpuCache.snapshot()` to
 * compute cached / in-flight counts per LOD; consumes `plan.stats` for
 * catalog degradations and culling counters; picks a focal entity
 * from the visible entities by viewport-center proximity.
 *
 * `config` is forwarded to {@link modeReason} so the focal-entity
 * explanation matches whatever thresholds {@link plan} was running
 * with this tick.
 */
export function buildPlanningDatasetDebug(
  dsId: string,
  result: RequestPlan,
  entities: EntitySnapshot[],
  entityById: Map<string, EntitySnapshot>,
  visibleRegion: VisibleRegion,
  cpuCache: CpuCache,
  config: PlanningConfig,
): PlanningDatasetDebug {
  const lanes = { minimap: 0, detail: 0, coarse: 0, proxy: 0, prefetch: 0, overview: 0 };
  const chunksByLevel: Record<number, number> = {};
  for (const r of result.requests) {
    lanes[r.lane]++;
    chunksByLevel[r.level] = (chunksByLevel[r.level] ?? 0) + 1;
  }

  // Per-LOD breakdown: planned (from plan), cached + in-flight (from cache).
  const cacheSnap = cpuCache.snapshot();
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

  // Wells by mode. Field-mode entries are deduped by parent well so
  // counts represent *wells* in each mode, not active-set entries.
  // Image-only datasets fall through with each image as its own "well"
  // (no parent edge → wellId == entityId), so a single dataset shows
  // up as one count without special-casing. Invisible entries are
  // excluded — they have no promotion mode.
  //
  // ActiveSetEntry and EntitySnapshot are both discriminated unions:
  // narrow on `kind` before classifying entries, and on
  // `ent.kind === "Field"` before reading `parentId` (Image and Well
  // entities have no parent and fall back to their own entityId as
  // the wellId).
  const wellsByMode = {
    wellAsProxy: 0,
    fieldsWithProxyFallback: 0,
    fieldsWithDetail: 0,
  };
  const wellsSeen = new Set<string>();
  for (const e of result.activeSet) {
    if (e.kind === "well-as-proxy") {
      wellsByMode.wellAsProxy++;
      continue;
    }
    if (e.kind === "invisible") continue;
    // Narrowed: e is FieldEntry.
    const ent = entityById.get(e.entityId);
    const wellId =
      ent !== undefined && ent.kind === "Field" ? ent.parentId : e.entityId;
    if (wellsSeen.has(wellId)) continue;
    wellsSeen.add(wellId);
    if (e.mode === "fields-with-proxy-fallback") wellsByMode.fieldsWithProxyFallback++;
    else if (e.mode === "fields-with-detail") wellsByMode.fieldsWithDetail++;
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
    // Derive `mode` and `detailOwnedRange` per variant: only field
    // entries carry a real LOD range. Well-as-proxy and invisibles
    // synthesise a defensible placeholder so the panel doesn't render
    // `unknown`.
    let displayMode: string;
    let detailOwnedRange: [number, number];
    if (entry === undefined) {
      displayMode = "unknown";
      detailOwnedRange = [0, 0];
    } else if (entry.kind === "well-as-proxy") {
      displayMode = "well-as-proxy";
      detailOwnedRange = [0, 0];
    } else if (entry.kind === "invisible") {
      displayMode = "invisible";
      detailOwnedRange = [entry.coarsestLod, entry.coarsestLod];
    } else {
      displayMode = entry.mode;
      detailOwnedRange = entry.detailOwnedLodRange;
    }
    // Only `FieldSnapshot` carries a `parentId`; narrow before
    // reading. `Image` and `Well` focal entities surface as having no
    // parent well.
    const parentWellId = focal.kind === "Field" ? focal.parentId : null;
    focalEntity = {
      entityId: focal.entityId,
      parentWellId,
      kind: focal.kind,
      projectedDiagonalPx: focal.projectedDiagonalPx,
      projectedAreaPx2: focal.projectedAreaPx2,
      importance: focal.importance,
      idealTargetLod: focal.idealTargetLod,
      detailOwnedRange,
      mode: displayMode,
      modeReason: modeReason(focal.projectedDiagonalPx, config),
      topPriority,
      chunkCount,
    };
  }

  return {
    datasetId: dsId,
    lanes,
    proxyCount: result.proxyRequests.length,
    totalChunks: result.requests.length,
    chunksByLevel,
    lodBreakdown,
    culling: result.stats.culling,
    catalogDegradations: result.stats.catalogDegradations,
    wellsByMode,
    focalEntity,
  };
}
