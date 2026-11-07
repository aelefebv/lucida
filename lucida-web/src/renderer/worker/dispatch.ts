/**
 * Worker message dispatcher: route a single {@link MainToWorkerMessage}
 * to its per-mode handler.
 *
 * `init` and `destroy` are handled in the entry point, which owns the
 * {@link WorkerCtx} lifecycle. The frame handlers are awaited here, so the
 * entry point's message order holds behind them (`inOrder.ts`).
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { MainToWorkerMessage } from "../workerProtocol.ts";
import { destroyProxyAtlas } from "../proxyAtlas.ts";
import { destroyDescriptorBuffer } from "../descriptorBuffer.ts";
import {
  applyColdState,
  applyColdStateDisplay,
  applyColdStateSelection,
  applyColdStateDelta,
} from "../coldState/index.ts";
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
import { handleCaptureFrame } from "./captureFrame.ts";
import { postChunksRequeued } from "../chunkUploadFeedback.ts";
import { sourceKey } from "../poolKeys.ts";

/**
 * Dispatch one main-thread message. The caller is responsible for
 * funnelling thrown errors back to the main thread as `error` messages.
 */
export async function dispatchMessage(ctx: WorkerCtx, msg: MainToWorkerMessage): Promise<void> {
  switch (msg.type) {
    case "init":
      // The entry point handles `init`. Reaching here means a duplicate.
      return;

    case "resize": {
      const canvas = ctx.context.canvas as OffscreenCanvas;
      canvas.width = msg.width;
      canvas.height = msg.height;
      return;
    }

    case "canvasColors":
      ctx.getCompositor().setBackground(msg.colors.background);
      ctx.getSliceRenderer().setTileBorderColor(msg.colors.tileBorder);
      return;

    case "sliceChunkData": {
      const memberId = msg.memberId;
      const poolKey = ctx.state.memberSourcePools
        .get(memberId)
        ?.get(sourceKey(msg.tier, msg.level));
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
      await handleSliceRenderMultiPass(ctx, msg);
      postFrameDone(ctx, msg.frameSeq);
      return;

    case "volumeChunkData": {
      const memberId = msg.memberId;
      const poolKey = ctx.state.memberSourcePools
        .get(memberId)
        ?.get(sourceKey(msg.tier, msg.level));
      if (!poolKey) {
        // No section for this (tier, level): cold state hasn't arrived for
        // this member, or the level is no longer a resident level.
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
      await handleVolumeRenderMultiPass(ctx, msg);
      postFrameDone(ctx, msg.frameSeq);
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
    case "captureFrame":
      handleCaptureFrame(ctx, msg);
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
      // Display-only edit. No residency changed, so no wanted-set is posted.
      applyColdStateDisplay(ctx, msg);
      return;

    case "coldStateSelection":
      // A T/Z scrub changes the wanted chunks, so the wanted-set is posted.
      applyColdStateSelection(ctx, msg);
      ctx.postWantedSet();
      return;

    case "coldStateDelta":
      // Posted even when the delta was a no-op, matching the full and
      // selection paths.
      applyColdStateDelta(ctx, msg);
      ctx.postWantedSet();
      return;

    case "removeLayerResources": {
      removeSliceResources(ctx, msg.datasetId);
      removeVolumeResources(ctx, msg.datasetId);
      removeMinimapResources(msg.datasetId);
      const dsPools = ctx.state.proxyPoolsByDataset.get(msg.datasetId);
      if (dsPools) {
        for (const pool of dsPools.values()) destroyProxyAtlas(pool);
        ctx.state.proxyPoolsByDataset.delete(msg.datasetId);
      }
      const desc = ctx.state.descriptorBuffersByDataset.get(msg.datasetId);
      if (desc) {
        destroyDescriptorBuffer(desc);
        ctx.state.descriptorBuffersByDataset.delete(msg.datasetId);
      }
      ctx.state.currentSourcesByDataset.delete(msg.datasetId);
      ctx.state.coldStateByDataset.delete(msg.datasetId);

      // These maps would otherwise grow for the worker's whole lifetime.
      for (const [memberId, dsId] of ctx.state.memberToDataset) {
        if (dsId === msg.datasetId) {
          ctx.state.memberToDataset.delete(memberId);
          ctx.state.memberSourcePools.delete(memberId);
          ctx.state.targetLevelByMember.delete(memberId);
        }
      }
      // groupsByDataset avoids scanning every group's child set.
      const groups = ctx.state.groupsByDataset.get(msg.datasetId);
      if (groups) {
        for (const groupId of groups) ctx.state.groupToTiles.delete(groupId);
        ctx.state.groupsByDataset.delete(msg.datasetId);
      }
      if (ctx.state.currentColdState?.datasetId === msg.datasetId) {
        ctx.state.currentColdState = null;
      }
      return;
    }

    case "destroy":
      // The entry point handles `destroy` so it can null the ctx before
      // `self.close()`. Reaching here means a duplicate.
      return;
  }
}

/**
 * Report a viewport frame done once the GPU has run everything submitted so
 * far, which includes the frame. Not awaited: the next message needn't wait.
 */
function postFrameDone(ctx: WorkerCtx, frameSeq: number | undefined): void {
  if (frameSeq === undefined) return;
  ctx.device.queue.onSubmittedWorkDone().then(
    () => ctx.post({ type: "frameDone", frameSeq }),
    () => {},
  );
}
