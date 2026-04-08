/** Shared utilities for the chunk rendering tick pipeline (slice + volume). */
import type { WasmScene } from "lucida-core";
import type { ChunkCoord, QualifiedChunkCoord, SharedChunkQueue } from "./zarr/chunkStore.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import type { SeedPendingInfo, UploadState } from "./uploadCommon.ts";
import type { DatasetInfo } from "./zarr/metadata.ts";

// --- Scene settings cache ---
let cachedSettings: SceneSettings | null = null;
let settingsGeneration = -1;
let currentGeneration = 0;

/** Bump this after any apply_command that changes dataset settings or order. */
export function bumpSettingsGeneration(): void {
  currentGeneration++;
}

/** Per-dataset settings parsed from the WASM scene. */
export interface DatasetSettings {
  visible: boolean;
  opacity: number;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  blend_mode: string;
  render_mode?: string;
}

/** Parsed scene-level settings: layer order + per-dataset settings map. */
export interface SceneSettings {
  layerOrder: string[];
  allSettings: Record<string, DatasetSettings>;
}

/**
 * Parse layer order and all dataset settings from the WASM scene.
 *
 * Both slice and volume paths call `scene.dataset_order()` and
 * `scene.all_dataset_settings()` then JSON.parse the results.
 */
export function getSceneSettings(scene: WasmScene): SceneSettings {
  if (cachedSettings && settingsGeneration === currentGeneration) {
    return cachedSettings;
  }
  const layerOrder: string[] = JSON.parse(scene.dataset_order());
  const allSettings: Record<string, DatasetSettings> = JSON.parse(scene.all_dataset_settings());
  cachedSettings = { layerOrder, allSettings };
  settingsGeneration = currentGeneration;
  return cachedSettings;
}

/**
 * Evaluate the chunk plan for a dataset and sort member plans by 2D distance
 * from a center point (nearest first).
 *
 * Both paths call `evaluateChunkPlanFor` then sort by squared 2D distance
 * from the camera/viewport center. Volume already ignores eye Z for this
 * sort, so a 2D distance is the shared pattern.
 *
 * Returns null if the plan evaluation fails.
 */
export function evaluateAndSortPlans(
  scene: WasmScene,
  dsId: string,
  centerX: number,
  centerY: number,
): MemberChunkPlan[] | null {
  const memberPlans = evaluateChunkPlanFor(scene, dsId);
  if (!memberPlans) return null;

  return [...memberPlans].sort((a, b) => {
    const dxA = a.position[0] - centerX;
    const dyA = a.position[1] - centerY;
    const dxB = b.position[0] - centerX;
    const dyB = b.position[1] - centerY;
    return (dxA * dxA + dyA * dyA) - (dxB * dxB + dyB * dyB);
  });
}

/**
 * Build a fetch list for a single member, prepending seed coords for priority.
 *
 * Both paths concatenate `needed + prefetch + minimapPending`, then prepend
 * any seed coords that haven't already been queued in the shared fetch queue.
 */
export function buildMemberFetchList(
  needed: ChunkCoord[],
  prefetch: ChunkCoord[],
  seedInfo: { coords: ChunkCoord[] } | undefined,
  sharedQueue: SharedChunkQueue,
  memberId: string,
  minimapPending: ChunkCoord[] | undefined,
): ChunkCoord[] {
  let fetchList: ChunkCoord[] = [...needed, ...prefetch, ...(minimapPending ?? [])];

  if (seedInfo) {
    const seedFetchCoords = seedInfo.coords.filter(
      sc => !sharedQueue.has(memberId, sc.key),
    );
    if (seedFetchCoords.length > 0) {
      fetchList = [...seedFetchCoords, ...fetchList];
    }
  }

  return fetchList;
}

/**
 * Interleave per-member fetch lists into a single unified QualifiedChunkCoord[]
 * using round-robin ordering by spatial priority.
 *
 * Both paths perform identical round-robin interleaving: iterate index 0 of
 * each member, then index 1, etc., so that spatially-closer members get their
 * chunks fetched first at each depth level.
 */
export function interleaveFetchLists(
  lists: { memberId: string; list: ChunkCoord[] }[],
): QualifiedChunkCoord[] {
  const unified: QualifiedChunkCoord[] = [];
  const maxLen = Math.max(...lists.map(p => p.list.length));
  for (let i = 0; i < maxLen; i++) {
    for (const { memberId, list } of lists) {
      if (i < list.length) {
        unified.push({ ...list[i], memberId });
      }
    }
  }
  return unified;
}

// ---------------------------------------------------------------------------
// Shared plan+fetch interface + function
// ---------------------------------------------------------------------------

/** Callback interface for render-path-specific plan+fetch logic. */
export interface PlanFetchActions {
  seedChangeKey: string;
  shouldSkipDataset(dsShape: number[]): boolean;
  planCacheKey(dsId: string): string;
  computeSeeds(dsInfo: DatasetInfo, targetLevel: number): SeedPendingInfo | null;
  onMemberProcessed?(memberId: string, mp: MemberChunkPlan, dsId: string): void;
}

/**
 * Shared plan+fetch skeleton used by both slice and volume paths.
 *
 * For each dataset: evaluate chunk plans, compute seeds on T/C/(Z) change,
 * build per-member fetch lists, interleave them, and submit to ensureFetched.
 */
export function planAndFetchForDatasets(
  scene: WasmScene,
  datasets: Map<string, { sharedQueue: SharedChunkQueue; info: DatasetInfo }>,
  state: UploadState,
  actions: PlanFetchActions,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
  sortCenterX: number,
  sortCenterY: number,
): { memberPlanCache: Map<string, MemberChunkPlan[]>; settings: SceneSettings } | null {
  if (datasets.size === 0) return null;

  const settings = getSceneSettings(scene);
  const memberPlanCache = new Map<string, MemberChunkPlan[]>();

  for (const [dsId, ds] of datasets) {
    const dsShape = ds.info.levels[0].shape;
    if (actions.shouldSkipDataset(dsShape)) continue;

    const planKey = actions.planCacheKey(dsId);
    const cached = state.planCache.get(dsId);
    let sortedPlans: MemberChunkPlan[];
    if (cached && cached.key === planKey) {
      sortedPlans = cached.plans;
    } else {
      const evaluated = evaluateAndSortPlans(scene, dsId, sortCenterX, sortCenterY);
      if (!evaluated) continue;
      sortedPlans = evaluated;
      state.planCache.set(dsId, { key: planKey, plans: sortedPlans });
    }
    memberPlanCache.set(dsId, sortedPlans);

    const perMemberFetchLists: { memberId: string; list: ChunkCoord[] }[] = [];

    for (const mp of sortedPlans) {
      const memberId = mp.member_id;
      const targetLevel = mp.needed[0]?.level;

      const prevStateKeyVal = state.prevStateKey.get(memberId);
      const prevChangeKey = prevStateKeyVal?.substring(0, prevStateKeyVal.lastIndexOf("/"));
      const needsSeed = prevChangeKey === undefined || prevChangeKey !== actions.seedChangeKey;

      if (needsSeed && targetLevel !== undefined) {
        const seedInfo = actions.computeSeeds(ds.info, targetLevel);
        if (seedInfo) {
          state.seedPending.set(memberId, seedInfo);
        } else {
          state.seedPending.delete(memberId);
        }
      }

      const seedInfo = state.seedPending.get(memberId);
      const mmPending = minimapPendingFetch.get(memberId);
      const fetchList = buildMemberFetchList(mp.needed, mp.prefetch, seedInfo, ds.sharedQueue, memberId, mmPending);
      if (fetchList.length > 0) {
        perMemberFetchLists.push({ memberId, list: fetchList });
      }

      if (actions.onMemberProcessed) {
        actions.onMemberProcessed(memberId, mp, dsId);
      }
    }

    if (perMemberFetchLists.length > 0) {
      const unified = interleaveFetchLists(perMemberFetchLists);
      ds.sharedQueue.ensureFetched(unified);
    }
  }

  return { memberPlanCache, settings };
}

/** Flip Y between unit space (Y-up: 0=bottom) and image space (Y-down: 0=top). */
export function flipY(p: [number, number, number]): [number, number, number] {
  return [p[0], 1.0 - p[1], p[2]];
}
