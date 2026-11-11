/**
 * Cold-state ingestion orchestrator: rebuilds what the worker keeps of one
 * view's draw of one dataset from a cold-state message: its routes, its
 * indirection over each pool it draws from, and its descriptor buffer. The
 * pools themselves are the dataset's, shared by every view of their mode, so
 * a cold state creates the ones it needs and frees only those no view draws
 * from any more.
 *
 * The descriptor build reads the sections this cold state produced rather
 * than the pools, so it never picks up stale offsets from sections an earlier
 * cold state laid out with different levels.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateMessage, PoolMode } from "../workerProtocol.ts";
import { destroyDescriptorBuffer, iterateColdMembers, rebuildDescriptorBuffer } from "../descriptorBuffer.ts";
import { targetLevelOf, type EntitySource } from "../entitySources.ts";
import { syncLabelPools } from "../labelPools.ts";
import {
  getOrCreateVolumePool,
  remapIndirection,
  type AtlasState,
  type LodIndirectionMeta,
} from "../volume/index.ts";
import {
  getOrCreateSlicePool,
  remapSliceIndirection,
  type SliceAtlasState,
} from "../slice/index.ts";
import { destroyAtlas } from "../volume/atlas.ts";
import { destroySliceAtlas } from "../slice/atlas.ts";
import { groupEntriesByPool, type PoolGroup } from "./groupEntries.ts";
import { computeEntityTierMeta } from "./entityMetas.ts";
import { chunkPoolTier, datasetViewKey, sourceKey } from "../poolKeys.ts";
import { postSlotsLost } from "../chunkUploadFeedback.ts";
import { indexWantedChunks, wantedEntryKey, type WantedChunkIndex } from "../wantedChunks.ts";
import { renderRadiusEnabled } from "../../pipeline/renderRadius.ts";
import type { RemapInputs, ViewDraw } from "../worker/state.ts";
import { drawsOf } from "../worker/draws.ts";
import {
  createViewIndirection,
  destroyViewIndirection,
  resizeViewIndirection,
  type SharedChunkPool,
  type ViewIndirection,
} from "../viewIndirection.ts";

/**
 * The failed chunks a pool's members want in its tier, by member. Only wanted
 * ones are marked: the detail tier wants its target level and the coarse tier
 * its coarse level, so a failed chunk at a coarser stand-in level stays a
 * miss and the chain falls through it. The wanted set is this cold state's,
 * so a list from before a scrub never marks the new plane.
 */
function failedInGroup(
  state: WorkerCtx["state"],
  datasetId: string,
  wanted: WantedChunkIndex,
  group: PoolGroup,
): Map<string, Set<string>> | undefined {
  const failedByImage = state.failedByDataset.get(datasetId);
  if (!failedByImage) return undefined;
  const out = new Map<string, Set<string>>();
  for (const { entry, memberId } of group.entries) {
    if (out.has(memberId)) continue;
    const failed = failedByImage.get(entry.imageId);
    const want = wanted.get(wantedEntryKey(group.tier, memberId));
    if (!failed || !want) continue;
    const keys = new Set<string>();
    for (const key of failed) if (want.has(key)) keys.add(key);
    if (keys.size > 0) out.set(memberId, keys);
  }
  return out;
}

/** Whether two layouts give every member the same sections at the same offsets. */
function sameSections(
  held: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
  next: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
): boolean {
  if (held.size !== next.size) return false;
  for (const [memberId, metas] of next) {
    const was = held.get(memberId);
    if (!was || was.length !== metas.length) return false;
    for (let i = 0; i < metas.length; i++) {
      const a = was[i];
      const b = metas[i];
      if (
        a.level !== b.level || a.offset !== b.offset ||
        a.gridDims[0] !== b.gridDims[0] || a.gridDims[1] !== b.gridDims[1] || a.gridDims[2] !== b.gridDims[2]
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether a view's indirection already says what a remap would write. A remap
 * walks every resident slot, and uploads and evictions keep each view's
 * indirection current between cold states, so one whose sections, T and plane
 * are the ones it was last remapped for, with no render radius or failed
 * marks either time, would only rebuild what it holds. On a view move that is
 * every pool whose members stayed put, such as a collection's coarse pools.
 */
function remapHolds(
  state: WorkerCtx["state"],
  view: ViewIndirection,
  metas: Map<string, LodIndirectionMeta[]>,
  totalEntries: number,
  inputs: RemapInputs,
): boolean {
  const last = state.remappedFor.get(view);
  return last !== undefined &&
    !last.viewDependent && !inputs.viewDependent &&
    last.t === inputs.t && last.z === inputs.z &&
    view.indirectionData.length === totalEntries &&
    sameSections(view.entityMetas, metas);
}

/** The view's draw of the cold state's dataset, created on its first cold state. */
function drawFor(ctx: WorkerCtx, msg: ColdStateMessage, wanted: WantedChunkIndex): ViewDraw {
  const key = datasetViewKey(msg.datasetId, msg.view);
  let draw = ctx.state.draws.get(key);
  if (!draw) {
    draw = {
      datasetId: msg.datasetId,
      view: msg.view,
      mode: msg.viewMode,
      cold: msg,
      wanted,
      routes: new Map(),
      targetLevels: new Map(),
      sources: new Map(),
      descriptor: null,
    };
    ctx.state.draws.set(key, draw);
  }
  draw.mode = msg.viewMode;
  draw.cold = msg;
  draw.wanted = wanted;
  return draw;
}

/** The view's indirection over `pool`, added on the first cold state that draws from it. */
function viewOver(ctx: WorkerCtx, pool: SharedChunkPool, draw: ViewDraw): ViewIndirection {
  let view = pool.views.get(draw.view);
  if (!view) {
    view = createViewIndirection(ctx.device, draw, pool.totalSlots);
    pool.views.set(draw.view, view);
  }
  view.draw = draw;
  return view;
}

/** Apply a cold-state message. The caller posts the wanted-set afterward. */
export function applyColdState(ctx: WorkerCtx, msg: ColdStateMessage): void {
  const state = ctx.state;
  const mode = msg.viewMode;

  const wanted = indexWantedChunks(msg.wantedChunks);
  const draw = drawFor(ctx, msg, wanted);
  draw.routes.clear();
  draw.targetLevels.clear();

  // 1. Register member→dataset mappings and target levels. Canonical
  // iteration produces the same memberId scheme as the rest of the pipeline.
  for (const { entry, memberId } of iterateColdMembers(msg)) {
    state.memberToDataset.set(memberId, msg.datasetId);
    const target = targetLevelOf(entry);
    if (target !== undefined) draw.targetLevels.set(memberId, target);
  }

  // 2. Partition activeSet by (tier, channel, chunkDims). Entries with no
  // chunk levels are skipped here but stay in memberToDataset from step 1.
  const dimArity: 2 | 3 = mode === "volume" ? 3 : 2;
  const groups = groupEntriesByPool(msg, mode);

  const currentSources = new Map<string, EntitySource[]>();

  // 3. Per group: get the pool, lay out one section per (member, level) at
  // sequential offsets in the view's indirection over it, resize and remap.
  for (const group of groups.values()) {
    const [pcZ, pcY, pcX] = group.chunkDims;
    const newEntityMetas = new Map<string, LodIndirectionMeta[]>();
    const entryByMember = new Map<string, {
      layoutPositionVox?: [number, number];
      levels: Array<{
        level: number;
        chunkShape: [number, number, number];
        levelDims: [number, number, number];
      }>;
    }>();
    let offset = 0;

    for (const { entry, memberId, tier, level } of group.entries) {
      entryByMember.set(memberId, {
        layoutPositionVox: entry.layoutPositionVox,
        levels: entry.levels,
      });
      const { meta, nextOffset } = computeEntityTierMeta(
        entry,
        level,
        group.chunkDims,
        offset,
        dimArity,
      );
      if (meta) {
        let pools = draw.routes.get(memberId);
        if (!pools) {
          pools = new Map();
          draw.routes.set(memberId, pools);
        }
        pools.set(sourceKey(tier, level), group.poolKey);
        const metas = newEntityMetas.get(memberId);
        if (metas) metas.push(meta);
        else newEntityMetas.set(memberId, [meta]);
        const sources = currentSources.get(memberId);
        const source: EntitySource = { tier, poolKey: group.poolKey, meta };
        if (sources) sources.push(source);
        else currentSources.set(memberId, [source]);
      }
      offset = nextOffset;
    }

    const failed = failedInGroup(state, msg.datasetId, wanted, group);
    const radius = msg.renderRadiusView?.[group.tier];
    const viewDependent = (radius !== undefined && renderRadiusEnabled(radius)) || (failed?.size ?? 0) > 0;
    const remapOptions = { visibleRegion: msg.visibleRegion, renderRadiusView: radius, entryByMember, failed };
    if (mode === "volume") {
      const atlas = getOrCreateVolumePool(ctx, group.poolKey, msg.datasetId, pcX, pcY, pcZ, group.channel, msg.sampleFormat);
      const view = viewOver(ctx, atlas, draw);
      const inputs: RemapInputs = { t: msg.currentT, z: 0, viewDependent };
      const holds = remapHolds(state, view, newEntityMetas, offset, inputs);
      view.entityMetas = newEntityMetas;
      if (!holds) {
        resizeViewIndirection(ctx.device, view, offset);
        remapIndirection(atlas, view, msg.currentT, group.channel, remapOptions);
        state.remappedFor.set(view, inputs);
      }
    } else {
      const atlas = getOrCreateSlicePool(ctx, group.poolKey, msg.datasetId, pcX, pcY, group.channel, msg.sampleFormat);
      atlas.axis = msg.sliceAxis ?? "z";
      const view = viewOver(ctx, atlas, draw);
      const inputs: RemapInputs = { t: msg.currentT, z: msg.currentZ, viewDependent };
      const holds = remapHolds(state, view, newEntityMetas, offset, inputs);
      view.entityMetas = newEntityMetas;
      if (!holds) {
        resizeViewIndirection(ctx.device, view, offset);
        remapSliceIndirection(atlas, view, msg.currentT, group.channel, msg.currentZ, remapOptions);
        state.remappedFor.set(view, inputs);
      }
    }
  }

  // 4. The view stops drawing from the dataset's pools no group above names:
  // a hidden channel, another slice axis, a chunk shape no resident level
  // uses, or the other mode's after a switch. A pool no view draws from then
  // goes, its chunks reported lost so the page resends what a recreated one
  // needs.
  detachView(ctx, msg.datasetId, msg.view, new Set(groups.keys()));
  syncLabelPools(ctx, msg.datasetId);

  draw.sources = currentSources;

  // 5. Rebuild the descriptor buffer's contents from scratch, like the sections.
  draw.descriptor = rebuildDescriptorBuffer(ctx.device, draw.descriptor ?? undefined, msg, currentSources);
}

/**
 * Take `view`'s indirection off each of the dataset's pools outside `keep`,
 * and free each pool that no view draws from after that.
 */
function detachView(ctx: WorkerCtx, datasetId: string, view: number, keep: ReadonlySet<string>): void {
  detachFrom(ctx, ctx.state.sliceAtlases, "slice", datasetId, view, keep, destroySliceAtlas);
  detachFrom(ctx, ctx.state.volumeAtlases, "volume", datasetId, view, keep, destroyAtlas);
}

function detachFrom<A extends SliceAtlasState | AtlasState>(
  ctx: WorkerCtx,
  atlases: Map<string, A>,
  mode: PoolMode,
  datasetId: string,
  view: number,
  keep: ReadonlySet<string>,
  destroy: (atlas: A) => void,
): void {
  for (const [poolKey, atlas] of atlases) {
    if (atlas.datasetId !== datasetId || keep.has(poolKey)) continue;
    const held = atlas.views.get(view);
    if (held) {
      destroyViewIndirection(held);
      atlas.views.delete(view);
    }
    if (atlas.views.size > 0) continue;
    postSlotsLost(ctx, mode, chunkPoolTier(poolKey), atlas.slots.keys(), "freed", "axis" in atlas ? atlas.axis : undefined);
    destroy(atlas);
    atlases.delete(poolKey);
  }
}

/**
 * Want none of the dataset's chunks in any view, keeping its layout and its
 * slots: no view plans it. Its retained cold states want nothing either, so
 * a re-ingest, as a failed-chunk list makes, does not want them back.
 */
export function wantNothingOf(ctx: WorkerCtx, datasetId: string): void {
  for (const draw of drawsOf(ctx.state, datasetId)) {
    draw.cold.wantedChunks = [];
    draw.wanted = indexWantedChunks([]);
  }
}

/**
 * Drop what the worker kept of the dataset for each view that no longer draws
 * it, and free what only those views drew from, as {@link releaseDraw} does.
 * A cold state names every view that draws its dataset, so a page that starts
 * over still frees what an earlier view left.
 */
export function releaseUndrawnViews(ctx: WorkerCtx, datasetId: string, drawn: readonly number[]): void {
  for (const draw of drawsOf(ctx.state, datasetId)) {
    if (!drawn.includes(draw.view)) releaseDraw(ctx, draw);
  }
}

/**
 * Release one view's draw of a dataset: its indirection over each pool, the
 * pools only it drew from, its descriptors, and the label pools of its mode
 * once no view draws the dataset in that mode. Freed chunks are reported
 * lost, so a view that draws from them again has them sent again.
 */
export function releaseDraw(ctx: WorkerCtx, draw: ViewDraw): void {
  const state = ctx.state;
  detachView(ctx, draw.datasetId, draw.view, new Set());
  // The page's level readout for this view would outlive the draw otherwise.
  ctx.post({ type: "entityLevels", datasetId: draw.datasetId, view: draw.view, entities: [] });
  if (draw.descriptor) destroyDescriptorBuffer(draw.descriptor);
  state.draws.delete(datasetViewKey(draw.datasetId, draw.view));
  for (const [memberId, owner] of state.memberToDataset) {
    if (owner !== draw.datasetId) continue;
    state.cameraUVs.get(draw.view)?.delete(memberId);
    state.rayHits.get(draw.view)?.delete(memberId);
  }
  syncLabelPools(ctx, draw.datasetId);
  if (state.currentColdState === draw.cold) state.currentColdState = null;
}
