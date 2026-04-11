/** Shared utilities for the chunk rendering tick pipeline (slice + volume). */
import type { WasmScene } from "lucida-core";
import type { ChunkCoord, QualifiedChunkCoord, SharedChunkQueue } from "./zarr/chunkStore.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import type { UploadState } from "./uploadCommon.ts";
import type { ContentGraph } from "./contentTypes.ts";
import { debugStats } from "./debug/debugStats.ts";

// --- Scene settings cache ---
let cachedSettings: SceneSettings | null = null;
let settingsGeneration = -1;
let currentGeneration = 0;

/** Bump this after any apply_command that changes dataset settings or order. */
export function bumpSettingsGeneration(): void {
  currentGeneration++;
}

/** Per-channel display settings parsed from the WASM scene. */
export interface ChannelSettingsJS {
  visible: boolean;
  colormap: string;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
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
  channel_settings: ChannelSettingsJS[];
  channel_blend_mode: string;
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
 * Build a fetch list for a single member.
 *
 * Concatenates `needed + prefetch + minimapPending`.
 */
export function buildMemberFetchList(
  needed: ChunkCoord[],
  prefetch: ChunkCoord[],
  minimapPending: ChunkCoord[] | undefined,
): ChunkCoord[] {
  return [...needed, ...prefetch, ...(minimapPending ?? [])];
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
  shouldSkipDataset(dsShape: number[]): boolean;
  planCacheKey(dsId: string): string;
  onMemberProcessed?(memberId: string, mp: MemberChunkPlan, dsId: string): void;
  /**
   * Multi-channel variants: when multiChannel is true, these are called
   * per-channel with the channel index. The base versions above are used
   * for the channel that scene.c() is set to at that moment.
   */
  shouldSkipChannel?(dsShape: number[], ch: number): boolean;
  planCacheKeyForChannel?(dsId: string, ch: number): string;
}

/**
 * Shared plan+fetch skeleton used by both slice and volume paths.
 *
 * For each dataset: evaluate chunk plans, build per-member fetch lists,
 * interleave them, and submit to ensureFetched.
 *
 * When `multiChannel` is true, iterates visible channels for each dataset,
 * temporarily setting `scene.set_c(ch)` for each and using composite keys
 * `${memberId}:ch${ch}` in state maps and plan cache.
 */
export function planAndFetchForDatasets(
  scene: WasmScene,
  datasets: Map<string, { sharedQueue: SharedChunkQueue; content: ContentGraph }>,
  state: UploadState,
  actions: PlanFetchActions,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
  sortCenterX: number,
  sortCenterY: number,
  multiChannel: boolean = false,
): { memberPlanCache: Map<string, MemberChunkPlan[]>; settings: SceneSettings } | null {
  if (datasets.size === 0) return null;

  const settings = getSceneSettings(scene);
  const memberPlanCache = new Map<string, MemberChunkPlan[]>();
  const originalC = scene.c();

  for (const [dsId, ds] of datasets) {
    const dsShape = ds.content.images[0].multiscale.levels[0].shape;

    // Determine which channels to iterate
    const channels = multiChannel
      ? getActiveChannels(settings.allSettings[dsId])
      : [originalC]; // single-channel: use the current scene C (no composite key)

    const perMemberFetchLists: { memberId: string; list: ChunkCoord[] }[] = [];

    for (const ch of channels) {
      // In multi-channel mode, set the scene's C for plan evaluation
      if (multiChannel) {
        scene.set_c(ch);
      }

      // Channel-specific skip: in multi-channel mode check per-channel,
      // in single-channel mode use the base shouldSkipDataset.
      if (multiChannel) {
        if (actions.shouldSkipChannel
          ? actions.shouldSkipChannel(dsShape, ch)
          : ch >= dsShape[1]) {
          continue;
        }
      } else {
        if (actions.shouldSkipDataset(dsShape)) continue;
      }

      const planCacheId = multiChannel ? `${dsId}:ch${ch}` : dsId;
      const planKey = multiChannel && actions.planCacheKeyForChannel
        ? actions.planCacheKeyForChannel(dsId, ch)
        : actions.planCacheKey(dsId);

      const cached = state.planCache.get(planCacheId);
      let sortedPlans: MemberChunkPlan[];
      if (cached && cached.key === planKey) {
        sortedPlans = cached.plans;
        if (debugStats.enabled) debugStats.planCacheHits++;
      } else {
        const evaluated = evaluateAndSortPlans(scene, dsId, sortCenterX, sortCenterY);
        if (!evaluated) continue;
        sortedPlans = evaluated;
        state.planCache.set(planCacheId, { key: planKey, plans: sortedPlans });
        if (debugStats.enabled) debugStats.planCacheMisses++;
      }

      // Store plans in memberPlanCache with composite key when multi-channel
      if (multiChannel) {
        memberPlanCache.set(`${dsId}:ch${ch}`, sortedPlans);
      } else {
        memberPlanCache.set(dsId, sortedPlans);
      }

      if (debugStats.enabled) {
        debugStats.totalMembers += sortedPlans.length;
        debugStats.visibleMembers += sortedPlans.length;
        for (const mp of sortedPlans) {
          const tl = mp.needed[0]?.level ?? -1;
          debugStats.memberStats.push({
            id: multiChannel ? compositeKey(mp.image_id, ch) : mp.image_id,
            level: tl,
            numLevels: ds.content.images[0].multiscale.levels.length,
            chunksNeeded: mp.needed.length,
            chunksSent: state.sentToWorker.get(
              multiChannel ? compositeKey(mp.image_id, ch) : mp.image_id
            )?.size ?? 0,
          });
          if (tl >= 0) {
            debugStats.selectedLevel = tl;
            debugStats.numLevels = ds.content.images[0].multiscale.levels.length;
          }
        }
      }

      for (const mp of sortedPlans) {
        const rawMemberId = mp.image_id;
        const memberId = multiChannel ? compositeKey(rawMemberId, ch) : rawMemberId;

        const mmPending = minimapPendingFetch.get(rawMemberId);
        // Use rawMemberId for both sharedQueue lookups and fetch list qualification.
        // The chunk store's fetchers are keyed by raw member ID, not composite.
        // Chunks are distinguished by their key (which includes level/t/c/z/y/x).
        const fetchList = buildMemberFetchList(mp.needed, mp.prefetch, mmPending);
        if (fetchList.length > 0) {
          perMemberFetchLists.push({ memberId: rawMemberId, list: fetchList });
        }

        if (actions.onMemberProcessed) {
          actions.onMemberProcessed(memberId, mp, dsId);
        }
      }
    }

    // Scale fetch concurrency by active channel count so multi-channel
    // mode gets comparable throughput to separate datasets.
    ds.sharedQueue.setConcurrency(Math.min(12 * channels.length, 48));

    if (perMemberFetchLists.length > 0) {
      const unified = interleaveFetchLists(perMemberFetchLists);
      ds.sharedQueue.ensureFetched(unified);
    }
  }

  // Restore original C after multi-channel iteration
  if (multiChannel) {
    scene.set_c(originalC);
  }

  return { memberPlanCache, settings };
}

// ---------------------------------------------------------------------------
// Multi-channel helpers
// ---------------------------------------------------------------------------

/**
 * Return the list of visible channel indices from a dataset's settings.
 * Falls back to [0] when there are no channel settings or none are visible.
 */
export function getActiveChannels(dsSettings: DatasetSettings): number[] {
  if (!dsSettings.channel_settings || dsSettings.channel_settings.length === 0) return [0];
  const channels: number[] = [];
  for (let i = 0; i < dsSettings.channel_settings.length; i++) {
    if (dsSettings.channel_settings[i].visible) channels.push(i);
  }
  return channels.length > 0 ? channels : [0];
}

/**
 * Build a composite key for a (member, channel) pair in multi-channel mode.
 */
export function compositeKey(memberId: string, channel: number): string {
  return `${memberId}:ch${channel}`;
}

/**
 * Parse the channel index from a composite member key.
 * Returns undefined for non-composite keys.
 */
export function parseChannel(key: string): number | undefined {
  const match = key.match(/:ch(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Strip the channel suffix from a composite key to recover the original member ID.
 */
export function stripChannelSuffix(key: string): string {
  return key.replace(/:ch\d+$/, "");
}

/** Flip Y between unit space (Y-up: 0=bottom) and image space (Y-down: 0=top). */
export function flipY(p: [number, number, number]): [number, number, number] {
  return [p[0], 1.0 - p[1], p[2]];
}
