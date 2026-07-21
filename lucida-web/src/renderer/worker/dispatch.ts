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
 * existing per-mode files (`coldState/apply.ts`, `slice/upload.ts`,
 * `slice/render.ts`, `volume/upload.ts`,
 * `volume/render.ts`, `minimapHandlers.ts`).
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { MainToWorkerMessage } from "../workerProtocol.ts";
import { destroyDescriptorBuffer } from "../descriptorBuffer.ts";
import {
  applyColdState,
  applyColdStateDisplay,
  applyColdStateSelection,
  applyColdStateDelta,
} from "../coldState/index.ts";
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
import { postChunksRequeued } from "../chunkUploadFeedback.ts";
import { memberTierKey } from "../poolKeys.ts";
import { invalidateAggregateTopologyForDataset } from "./state.ts";
import { admitWorkerRenderSurface } from "./surface.ts";

/**
 * A render submission is only observable as presented after WebGPU confirms
 * every command already submitted to this queue has completed. Keeping this
 * handshake in one helper prevents slice and volume paths from drifting and
 * gives capture/FPS/overlay consumers a truthful lifecycle boundary.
 */
export function reportFramePresentedAfterGpuCompletion(
  ctx: WorkerCtx,
  frameId: number,
  contentPresented: boolean = false,
): void {
  void ctx.device.queue.onSubmittedWorkDone()
    .then(() => ctx.post({ type: "framePresented", frameId, contentPresented }))
    .catch((error) => ctx.post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    }));
}

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
      const surface = admitWorkerRenderSurface(ctx, msg.width, msg.height);
      if (!surface) return;
      const canvas = ctx.context.canvas as OffscreenCanvas;
      canvas.width = surface.width;
      canvas.height = surface.height;
      return;
    }

    case "sliceChunkData": {
      const memberId = msg.memberId;
      const tier = msg.tier ?? "detail";
      const poolKey =
        ctx.state.memberTierToPool.get(memberTierKey(memberId, tier)) ??
        (tier === "detail" ? ctx.state.memberToPool.get(memberId) : undefined);
      if (!poolKey) {
        postChunksRequeued(ctx, msg.datasetId, memberId, tier, msg.chunks, "missing-pool");
        return;
      }
      handleSliceChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
      const datasetId = ctx.state.memberToDataset.get(memberId);
      if (datasetId) invalidateAggregateTopologyForDataset(ctx.state, datasetId);
      return;
    }
    case "labelSliceChunkData":
      handleLabelSliceChunkData(ctx, msg);
      return;
    case "sliceRenderMultiPass": {
      const result = handleSliceRenderMultiPass(ctx, msg, (memberId) => {
        const detailPoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "detail")) ??
          ctx.state.memberToPool.get(memberId) ??
          null;
        const coarsePoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "coarse")) ?? null;
        const datasetId = ctx.state.memberToDataset.get(memberId) ?? null;
        if (!detailPoolKey && !coarsePoolKey) {
          return null;
        }
        return { detailPoolKey, coarsePoolKey, datasetId };
      });
      if (result) {
        reportFramePresentedAfterGpuCompletion(
          ctx,
          msg.frameId,
          result.contentPresented,
        );
      }
      return;
    }

    case "volumeChunkData": {
      const memberId = msg.memberId;
      const tier = msg.tier ?? "detail";
      const poolKey =
        ctx.state.memberTierToPool.get(memberTierKey(memberId, tier)) ??
        (tier === "detail" ? ctx.state.memberToPool.get(memberId) : undefined);
      if (!poolKey) {
        // No pool registered yet (cold state hasn't arrived for this member)
        postChunksRequeued(ctx, msg.datasetId, memberId, tier, msg.chunks, "missing-pool");
        return;
      }
      handleVolumeChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
      return;
    }
    case "labelVolumeChunkData":
      handleLabelVolumeChunkData(ctx, msg);
      return;
    case "volumeRenderMultiPass": {
      const result = handleVolumeRenderMultiPass(ctx, msg, (memberId) => {
        const detailPoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "detail")) ??
          ctx.state.memberToPool.get(memberId) ??
          null;
        const coarsePoolKey =
          ctx.state.memberTierToPool.get(memberTierKey(memberId, "coarse")) ?? null;
        const datasetId = ctx.state.memberToDataset.get(memberId) ?? null;
        if (!detailPoolKey && !coarsePoolKey) {
          return null;
        }
        return { detailPoolKey, coarsePoolKey, datasetId };
      });
      if (result) {
        reportFramePresentedAfterGpuCompletion(
          ctx,
          msg.frameId,
          result.contentPresented,
        );
      }
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
      invalidateAggregateTopologyForDataset(ctx.state, msg.datasetId);
      ctx.postWantedSet();
      return;

    case "coldStateDisplay":
      // Display-only edit: re-apply contrast/gamma/colormap/opacity to the
      // resident descriptor buffer without re-ingesting cold state. No
      // residency changed, so no wanted-set is posted.
      applyColdStateDisplay(ctx, msg);
      invalidateAggregateTopologyForDataset(ctx.state, msg.datasetId);
      return;

    case "coldStateSelection":
      // Selection scrub (T/Z move): re-point the dataset's retained cold state
      // at the new selection and re-ingest it, repacking the atlas indirection
      // for the new plane/timepoint. The freshly-wanted chunks changed, so the
      // wanted-set is posted (as with a full cold state).
      applyColdStateSelection(ctx, msg);
      invalidateAggregateTopologyForDataset(ctx.state, msg.datasetId);
      ctx.postWantedSet();
      return;

    case "coldStateDelta":
      // View move (pan/zoom/orbit): patch the dataset's retained cold state with
      // the changed/added descriptors + removed ids, reorder to the new active
      // set, and re-ingest it. The wanted-set is posted unconditionally for
      // consistency with the full / selection paths — even when the delta was a
      // no-op (dataset not yet ingested), matching how those paths always post.
      applyColdStateDelta(ctx, msg);
      invalidateAggregateTopologyForDataset(ctx.state, msg.datasetId);
      ctx.postWantedSet();
      return;

    case "removeLayerResources": {
      const aggregateDatasetId =
        ctx.state.memberToDataset.get(msg.datasetId) ?? msg.datasetId;
      invalidateAggregateTopologyForDataset(ctx.state, aggregateDatasetId);
      removeSliceResources(ctx, msg.datasetId);
      removeVolumeResources(ctx, msg.datasetId);
      removeMinimapResources(msg.datasetId);
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
      // If the dataset being dropped is the one whose cold state is
      // active, clear that pointer too — no more renders/uploads will
      // arrive against this state.
      if (ctx.state.currentColdState?.datasetId === msg.datasetId) {
        ctx.state.currentColdState = null;
      }
      // Explicit dataset ownership is the final reconciliation boundary for
      // any tracked resource a domain-specific registry missed.
      ctx.gpuResources.destroyDataset(msg.datasetId);
      return;
    }

    case "destroy":
      // Handled by the entry point (it owns the lifecycle so it can
      // null out the ctx before calling `self.close()`). Reaching here
      // means a duplicate `destroy` — ignore.
      return;
  }
}
