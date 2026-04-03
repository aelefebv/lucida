/** Shared utilities for the chunk rendering tick pipeline (slice + volume). */
import type { WasmScene } from "lucida-core";
import type { ChunkCoord, QualifiedChunkCoord, SharedChunkQueue } from "./zarr/chunkStore.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";

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
  const layerOrder: string[] = JSON.parse(scene.dataset_order());
  const allSettings: Record<string, DatasetSettings> = JSON.parse(scene.all_dataset_settings());
  return { layerOrder, allSettings };
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

/** Flip Y between unit space (Y-up: 0=bottom) and image space (Y-down: 0=top). */
export function flipY(p: [number, number, number]): [number, number, number] {
  return [p[0], 1.0 - p[1], p[2]];
}
