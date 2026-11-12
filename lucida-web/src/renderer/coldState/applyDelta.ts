/**
 * View-move cold-state delta: patch the view's retained cold state in place
 * (remove, upsert, reorder to `activeSetOrder`) and re-ingest it through
 * {@link applyColdState}, so departed entities release exactly as in a full
 * rebuild. A delta that kept the order and the selection lays out again only
 * the members it replaced, and one that replaced none re-ingests nothing:
 * only the wanted chunks moved, and nothing laid out reads them unless a
 * render radius or failed chunks are in play.
 *
 * The reorder keeps descriptor-buffer entity indices in agreement with the main
 * thread, which computes them from the same order. No-op when no cold state
 * has landed for the view's draw of the dataset yet; a full one will follow.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ColdStateActiveEntry,
  ColdStateDeltaMessage,
} from "../workerProtocol.ts";
import { applyColdState, remappedFor } from "./apply.ts";
import { patchWantedChunks, patchWantedIndex } from "../wantedChunks.ts";
import { renderRadiusEnabled } from "../../pipeline/renderRadius.ts";
import { drawOf } from "../worker/draws.ts";
import { syncLabelPools } from "../labelPools.ts";
import type { ViewDraw } from "../worker/state.ts";
import type { EntitySource } from "../entitySources.ts";
import { targetLevelOf } from "../entitySources.ts";
import { entryPoolSources } from "./groupEntries.ts";
import { computeEntityTierMeta } from "./entityMetas.ts";
import { relayMember, wantsRepack } from "./sectionLayout.ts";
import { displayStateForChannel, memberIdForColdEntry, rewriteDescriptorEntries } from "../descriptorBuffer.ts";
import { sourceKey } from "../poolKeys.ts";
import { clearSections, growViewIndirection, type ViewIndirection } from "../viewIndirection.ts";
import { remapIndirection, type AtlasState, type LodIndirectionMeta } from "../volume/index.ts";
import { remapSliceIndirection, type SliceAtlasState } from "../slice/index.ts";

/** Whether either tier draws only the chunks inside a render radius, which moves with the view. */
function radiusInPlay(radius: ColdStateDeltaMessage["renderRadiusView"]): boolean {
  return radius !== undefined && (renderRadiusEnabled(radius.detail) || renderRadiusEnabled(radius.coarse));
}

export function applyColdStateDelta(
  ctx: WorkerCtx,
  msg: ColdStateDeltaMessage,
): void {
  const draw = drawOf(ctx.state, msg.datasetId, msg.view);
  if (!draw) return;
  const cold = draw.cold;

  // The entries keep their order, so every member keeps its descriptor
  // index, and nothing laid out depends on where the view is.
  const inPlace =
    msg.removedEntityIds.length === 0 &&
    msg.activeSetOrder.length === cold.activeSet.length &&
    msg.activeSetOrder.every((entityId, i) => cold.activeSet[i].entityId === entityId) &&
    msg.currentT === cold.currentT &&
    msg.currentZ === cold.currentZ &&
    !radiusInPlay(cold.renderRadiusView) &&
    !radiusInPlay(msg.renderRadiusView) &&
    !ctx.state.failedByDataset.has(msg.datasetId);

  const removed = new Set(msg.removedEntityIds);
  const byEntity = new Map<string, ColdStateActiveEntry>();
  for (const entry of cold.activeSet) {
    if (!removed.has(entry.entityId)) byEntity.set(entry.entityId, entry);
  }
  for (const entry of msg.upserts) {
    byEntity.set(entry.entityId, entry);
  }

  const nextActiveSet: ColdStateActiveEntry[] = [];
  for (const entityId of msg.activeSetOrder) {
    const entry = byEntity.get(entityId);
    // `buildColdStateDelta` guarantees every id is retained or upserted.
    // Skipping a miss would shift every later descriptor index and draw the
    // wrong tiles silently, so fail loudly.
    if (!entry) {
      throw new Error(
        `applyColdStateDelta: activeSetOrder id ${entityId} missing from ` +
          `retained+upserts (producer invariant violation)`,
      );
    }
    nextActiveSet.push(entry);
  }

  cold.activeSet = nextActiveSet;
  cold.visibleRegion = msg.visibleRegion;
  cold.wantedChunks = patchWantedChunks(cold.wantedChunks, msg.wantedChunks);
  cold.currentT = msg.currentT;
  cold.currentZ = msg.currentZ;
  cold.renderRadiusView = msg.renderRadiusView;
  cold.labels = msg.labels;
  cold.epochs = msg.epochs;

  ctx.state.currentColdState = cold;
  ctx.state.currentEpochs = msg.epochs;
  if (inPlace && relayChangedMembers(ctx, draw, msg.upserts)) {
    patchWantedIndex(draw.wanted, msg.wantedChunks);
    syncLabelPools(ctx, msg.datasetId);
    return;
  }
  applyColdState(ctx, cold);
}

/**
 * Lay out again only the members whose entries the delta replaced: move
 * their sections, map their slots and write their descriptor entries,
 * touching nothing of any other member. False when the delta needs the whole
 * cold state ingested again: a changed member needs a pool the view does not
 * draw from yet or a descriptor slot it has none for, a pool is left with no
 * section, or the gaps left call for a fresh layout. Those last two are known
 * only once the members have moved, and a re-ingest then lays everything out
 * afresh or detaches the pool.
 */
function relayChangedMembers(ctx: WorkerCtx, draw: ViewDraw, changed: readonly ColdStateActiveEntry[]): boolean {
  const { cold, descriptor } = draw;
  if (changed.length === 0) return true;
  if (!descriptor) return false;
  const mode = cold.viewMode;
  const dimArity: 2 | 3 = mode === "volume" ? 3 : 2;
  const atlases: Map<string, AtlasState | SliceAtlasState> = mode === "volume" ? ctx.state.volumeAtlases : ctx.state.sliceAtlases;
  const inputs = { t: cold.currentT, z: mode === "volume" ? 0 : cold.currentZ, viewDependent: false };

  // What each changed member asks of each pool, before anything moves.
  const plans: MemberPlan[] = [];
  for (const entry of changed) {
    for (const channel of cold.visibleChannels) {
      const memberId = memberIdForColdEntry(entry, channel);
      if (!descriptor.indexByMember.has(memberId)) return false;
      if (!descriptor.colormapLutIndices.has(displayStateForChannel(entry, channel).colormapName)) return false;
      const wanted = new Map<string, SectionAsk[]>();
      for (const { poolKey, tier, level, chunkDims } of entryPoolSources(cold, mode, entry, channel)) {
        const { meta, nextOffset } = computeEntityTierMeta(entry, level, chunkDims, 0, dimArity);
        if (!meta) continue;
        const list = wanted.get(poolKey) ?? [];
        list.push({ tier, meta, size: nextOffset });
        wanted.set(poolKey, list);
      }
      const views = new Map<string, ViewIndirection>();
      for (const poolKey of new Set([...wanted.keys(), ...(draw.routes.get(memberId)?.values() ?? [])])) {
        const view = atlases.get(poolKey)?.views.get(draw.view);
        if (!view || !remappedFor(ctx.state, view, inputs)) return false;
        views.set(poolKey, view);
      }
      plans.push({ entry, channel, memberId, wanted, views });
    }
  }

  const added = new Map<string, Map<string, LodIndirectionMeta[]>>();
  const moved = new Set<ViewIndirection>();
  for (const { entry, memberId, wanted, views } of plans) {
    const sources: EntitySource[] = [];
    const routes = new Map<string, string>();
    for (const [poolKey, view] of views) {
      const asks = wanted.get(poolKey) ?? [];
      const layout = relayMember(view.entityMetas.get(memberId) ?? [], asks, view.space, dimArity);
      moved.add(view);
      if (layout.metas.length > 0) view.entityMetas.set(memberId, layout.metas);
      else view.entityMetas.delete(memberId);
      clearSections(view, layout.removed, dimArity);
      growViewIndirection(ctx.device, view, view.space.end);
      if (layout.added.length > 0) {
        let byMember = added.get(poolKey);
        if (!byMember) added.set(poolKey, (byMember = new Map()));
        byMember.set(memberId, layout.added);
      }
      layout.metas.forEach((meta, i) => {
        sources.push({ tier: asks[i].tier, poolKey, meta });
        routes.set(sourceKey(asks[i].tier, meta.level), poolKey);
      });
    }
    draw.sources.set(memberId, sources);
    draw.routes.set(memberId, routes);
    const target = targetLevelOf(entry);
    if (target === undefined) draw.targetLevels.delete(memberId);
    else draw.targetLevels.set(memberId, target);
    ctx.state.memberToDataset.set(memberId, cold.datasetId);
  }
  for (const view of moved) if (view.entityMetas.size === 0 || wantsRepack(view.space)) return false;

  for (const [poolKey, only] of added) {
    const atlas = atlases.get(poolKey)!;
    const view = atlas.views.get(draw.view)!;
    if ("axis" in atlas) remapSliceIndirection(atlas, view, cold.currentT, atlas.c, cold.currentZ, { only });
    else remapIndirection(atlas, view, cold.currentT, atlas.c, { only });
  }
  rewriteDescriptorEntries(ctx.device, descriptor, plans, draw.sources, cold.sampleFormat);
  return true;
}

/** A section a member asks of a pool, before it has a place. */
interface SectionAsk {
  tier: EntitySource["tier"];
  meta: Omit<LodIndirectionMeta, "offset">;
  size: number;
}

/** One changed member's sections by pool, and its view's indirection over each pool it holds or will hold. */
interface MemberPlan {
  entry: ColdStateActiveEntry;
  channel: number;
  memberId: string;
  wanted: Map<string, SectionAsk[]>;
  views: Map<string, ViewIndirection>;
}
