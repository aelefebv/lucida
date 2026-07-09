/**
 * Worker message dispatcher: route a single {@link MainToWorkerMessage}
 * to the appropriate per-mode handler.
 *
 * Cases `init` and `destroy` are handled in the entry point itself —
 * the former assembles the {@link WorkerCtx} (so we don't have one yet),
 * the latter shuts the worker down. Everything else flows through this
 * function.
 *
 * Renderer-thin cases (`updateCursorData`, `viewHotState`) stay inline
 * here — they're small enough that extracting them into individual files
 * would obscure rather than clarify. The bigger cases delegate to their
 * existing per-mode files (`coldState/apply.ts`, `proxy/upload.ts`,
 * `slice/upload.ts`, `slice/render.ts`, `volume/upload.ts`,
 * `volume/render.ts`, `minimapHandlers.ts`).
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { MainToWorkerMessage } from "../workerProtocol.ts";
import { destroyProxyAtlas } from "../proxyAtlas.ts";
import { destroyDescriptorBuffer } from "../descriptorBuffer.ts";
import { applyColdState, applyColdStateDisplay } from "../coldState/index.ts";
import { handleProxyUpload } from "../proxy/index.ts";
import {
  handleLabelSliceChunkData,
  handleSliceChunkData,
  handleSliceRenderMultiPass,
  removeSliceResources,
} from "../slice/index.ts";
import {
  applyViewHotState,
  handleLabelVolumeChunkData,
  handleVolumeChunkData,
  handleVolumeRenderMultiPass,
  removeVolumeResources,
} from "../volume/index.ts";
import {
  handleMinimapDestroy,
  handleMinimapInit,
  handleMinimapRender,
  handleMinimapUploadOverviewChunks,
  handleThumbnailRender,
  removeMinimapResources,
} from "../minimapHandlers.ts";
import { rebuildDescriptorIfMatching } from "./bootstrap.ts";
import { postChunksRequeued } from "../chunkUploadFeedback.ts";
import { memberTierKey } from "../poolKeys.ts";

/**
 * Dispatch one main-thread message. The caller is responsible for
 * funnelling thrown errors back to the main thread as `error` messages.
 */
export async function dispatchMessage(ctx: WorkerCtx, msg: MainToWorkerMessage): Promise<void> {
  switch (msg.type) {
    case "init":
      // Handled by the entry point (it assembles the ctx). Reaching
      // here means a duplicate `init` — ignore.
      return;

    case "resize": {
      const canvas = ctx.context.canvas as OffscreenCanvas;
      canvas.width = msg.width;
      canvas.height = msg.height;
      return;
    }

    case "sliceChunkData": {
      const memberId = msg.memberId;
      const tier = msg.tier ?? "detail";
      const poolKey =
        ctx.state.memberTierToPool.get(memberTierKey(memberId, tier)) ??
        (tier === "detail" ? ctx.state.memberToPool.get(memberId) : undefined);
      if (!poolKey) {
        postChunksRequeued(ctx, memberId, msg.chunks, "missing-pool");
        return;
      }
      handleSliceChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
      return;
    }
    case "labelSliceChunkData":
      handleLabelSliceChunkData(ctx, msg);
      return;
    case "sliceRenderMultiPass":
      handleSliceRenderMultiPass(ctx, msg, (memberId) => {
        const detailPoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "detail")) ??
          ctx.state.memberToPool.get(memberId) ??
          null;
        const coarsePoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "coarse")) ?? null;
        const datasetId = ctx.state.memberToDataset.get(memberId) ?? null;
        if (!detailPoolKey && !coarsePoolKey) {
          // No chunk pool — still report dataset so the handler can
          // bind a dummy chunk atlas and proceed with proxy-only render
          // (e.g. group-as-proxy entries).
          return datasetId ? { detailPoolKey: null, coarsePoolKey: null, datasetId } : null;
        }
        return { detailPoolKey, coarsePoolKey, datasetId };
      });
      return;

    case "volumeChunkData": {
      const memberId = msg.memberId;
      const tier = msg.tier ?? "detail";
      const poolKey =
        ctx.state.memberTierToPool.get(memberTierKey(memberId, tier)) ??
        (tier === "detail" ? ctx.state.memberToPool.get(memberId) : undefined);
      if (!poolKey) {
        // No pool registered yet (cold state hasn't arrived for this member)
        postChunksRequeued(ctx, memberId, msg.chunks, "missing-pool");
        return;
      }
      handleVolumeChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
      return;
    }
    case "labelVolumeChunkData":
      handleLabelVolumeChunkData(ctx, msg);
      return;
    case "volumeRenderMultiPass":
      handleVolumeRenderMultiPass(ctx, msg, (memberId) => {
        const detailPoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "detail")) ??
          ctx.state.memberToPool.get(memberId) ??
          null;
        const coarsePoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "coarse")) ?? null;
        const datasetId = ctx.state.memberToDataset.get(memberId) ?? null;
        if (!detailPoolKey && !coarsePoolKey) {
          // No chunk pool — still report datasetId so the handler can
          // bind a dummy chunk atlas and proceed with a proxy-only
          // render (group-as-proxy entries take this path).
          return datasetId ? { detailPoolKey: null, coarsePoolKey: null, datasetId } : null;
        }
        return { detailPoolKey, coarsePoolKey, datasetId };
      });
      return;

    case "proxyAssetData": {
      const outcome = handleProxyUpload(ctx, msg);
      if (outcome.rebuildDescriptor) rebuildDescriptorIfMatching(ctx, msg.datasetId);
      if (outcome.wantedSetChanged) ctx.postWantedSet();
      return;
    }

    case "minimapInit":
      handleMinimapInit(ctx, msg);
      return;
    case "minimapRender":
      handleMinimapRender(ctx, msg);
      return;
    case "minimapUploadOverviewChunksForLayer":
      handleMinimapUploadOverviewChunks(ctx, msg);
      return;
    case "thumbnailRender":
      handleThumbnailRender(ctx, msg);
      return;
    case "minimapDestroy":
      handleMinimapDestroy();
      return;

    case "updateCursorData": {
      const cr = ctx.getCursorRenderer();
      cr.updateCursors(new Float32Array(msg.data), msg.count);
      return;
    }

    case "viewHotState":
      applyViewHotState(ctx, msg);
      return;

    case "coldState":
      ctx.state.currentColdState = msg;
      ctx.state.currentEpochs = msg.epochs;
      ctx.state.coldStateByDataset.set(msg.datasetId, msg);
      applyColdState(ctx, msg);
      ctx.postWantedSet();
      return;

    case "coldStateDisplay":
      // Display-only edit: re-apply contrast/gamma/colormap/opacity to the
      // resident descriptor buffer without re-ingesting cold state. No
      // residency changed, so no wanted-set is posted.
      applyColdStateDisplay(ctx, msg);
      return;

    case "removeLayerResources": {
      removeSliceResources(ctx, msg.datasetId);
      removeVolumeResources(ctx, msg.datasetId);
      removeMinimapResources(msg.datasetId);
      // Destroy proxy pools for this dataset.
      const dsPools = ctx.state.proxyPoolsByDataset.get(msg.datasetId);
      if (dsPools) {
        for (const pool of dsPools.values()) destroyProxyAtlas(pool);
        ctx.state.proxyPoolsByDataset.delete(msg.datasetId);
      }
      // Drop the per-dataset descriptor buffer.
      const desc = ctx.state.descriptorBuffersByDataset.get(msg.datasetId);
      if (desc) {
        destroyDescriptorBuffer(desc);
        ctx.state.descriptorBuffersByDataset.delete(msg.datasetId);
      }
      ctx.state.currentEntityMetasByDataset.delete(msg.datasetId);
      ctx.state.coldStateByDataset.delete(msg.datasetId);

      // Clear member-id routing for entries owned by this dataset so
      // dropped layers don't keep stale memberToDataset / memberToPool
      // entries around (these maps would otherwise grow monotonically
      // across the worker's lifetime).
      for (const [memberId, dsId] of ctx.state.memberToDataset) {
        if (dsId === msg.datasetId) {
          ctx.state.memberToDataset.delete(memberId);
          ctx.state.memberToPool.delete(memberId);
          ctx.state.memberTierToPool.delete(memberTierKey(memberId, "detail"));
          ctx.state.memberTierToPool.delete(memberTierKey(memberId, "coarse"));
        }
      }
      // Drop group→tiles entries owned by this dataset. Tracked via
      // groupsByDataset so we don't have to scan every group's child set.
      const groups = ctx.state.groupsByDataset.get(msg.datasetId);
      if (groups) {
        for (const groupId of groups) ctx.state.groupToTiles.delete(groupId);
        ctx.state.groupsByDataset.delete(msg.datasetId);
      }
      // If the dataset being dropped is the one whose cold state is
      // active, clear that pointer too — no more renders/uploads will
      // arrive against this state.
      if (ctx.state.currentColdState?.datasetId === msg.datasetId) {
        ctx.state.currentColdState = null;
      }
      return;
    }

    case "destroy":
      // Handled by the entry point (it owns the lifecycle so it can
      // null out the ctx before calling `self.close()`). Reaching here
      // means a duplicate `destroy` — ignore.
      return;
  }
}
