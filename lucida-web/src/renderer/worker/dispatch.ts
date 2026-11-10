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
} from "../slice/index.ts";
import {
  applyViewHotState,
  handleLabelVolumeChunkData,
  handleVolumeChunkData,
  handleVolumeRenderMultiPass,
} from "../volume/index.ts";
import {
  handleMinimapDestroy,
  handleMinimapInit,
  handleMinimapRender,
  handleMinimapUploadOverviewChunks,
  handleThumbnailRender,
} from "../minimapHandlers.ts";
import { removeDatasetResources } from "./lifecycle.ts";
import { postGpuMemoryIfChanged } from "./gpuBudget.ts";
import { handleCaptureFrame } from "./captureFrame.ts";
import { handleProbe } from "./probe.ts";
import { handlePresentViews } from "./viewFrame.ts";
import { postChunkResidency } from "../chunkUploadFeedback.ts";
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

    case "presentViews":
      await handlePresentViews(ctx, msg);
      return;

    case "canvasColors":
      ctx.state.canvasColors = msg.colors;
      ctx.getCompositor().setBackground(msg.colors.background);
      ctx.getSliceRenderer().setTileBorderColor(msg.colors.tileBorder);
      return;

    case "sliceChunkData": {
      const memberId = msg.memberId;
      const poolKey = ctx.state.memberSourcePools
        .get(memberId)
        ?.get(sourceKey(msg.tier, msg.level));
      if (!poolKey) {
        postChunkResidency(ctx, memberId, msg.tier, "refused", msg.chunks.map(c => c.key), "missing-pool");
        return;
      }
      handleSliceChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
      return;
    }
    case "labelSliceChunkData":
      handleLabelSliceChunkData(ctx, msg);
      return;
    case "sliceRenderMultiPass":
      try {
        await handleSliceRenderMultiPass(ctx, msg);
        ctx.state.lastFrames.set(msg.view, msg);
      } finally {
        postFrameDone(ctx, msg.frameSeq);
      }
      postGpuMemoryIfChanged(ctx);
      return;

    case "volumeChunkData": {
      const memberId = msg.memberId;
      const poolKey = ctx.state.memberSourcePools
        .get(memberId)
        ?.get(sourceKey(msg.tier, msg.level));
      if (!poolKey) {
        // No section for this (tier, level): cold state hasn't arrived for
        // this member, or the level is no longer a resident level.
        postChunkResidency(ctx, memberId, msg.tier, "refused", msg.chunks.map(c => c.key), "missing-pool");
        return;
      }
      handleVolumeChunkData(ctx, msg, ctx.state.currentEpochs, poolKey, memberId);
      return;
    }
    case "labelVolumeChunkData":
      handleLabelVolumeChunkData(ctx, msg);
      return;
    case "volumeRenderMultiPass":
      try {
        await handleVolumeRenderMultiPass(ctx, msg);
        ctx.state.lastFrames.set(msg.view, msg);
      } finally {
        postFrameDone(ctx, msg.frameSeq);
      }
      postGpuMemoryIfChanged(ctx);
      return;

    case "minimapInit":
      handleMinimapInit(ctx, msg);
      return;
    case "minimapRender":
      handleMinimapRender(ctx, msg);
      return;
    case "minimapUploadOverviewChunksForLayer":
      handleMinimapUploadOverviewChunks(ctx, msg);
      postGpuMemoryIfChanged(ctx);
      return;
    case "thumbnailRender":
      handleThumbnailRender(ctx, msg);
      return;
    case "captureFrame":
      handleCaptureFrame(ctx, msg);
      return;
    case "probe":
      handleProbe(ctx, msg);
      return;
    case "minimapDestroy":
      handleMinimapDestroy(ctx.state.minimap);
      return;

    case "updateCursorData": {
      const cursors = { data: new Float32Array(msg.data), count: msg.count };
      ctx.state.cursors = cursors;
      ctx.getCursorRenderer().updateCursors(cursors.data, cursors.count);
      return;
    }

    case "loseDevice":
      ctx.device.destroy();
      return;

    case "raiseValidationError":
      // Mapped for reading and for writing at once, which WebGPU forbids.
      if (import.meta.env.DEV) ctx.device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE });
      return;

    case "viewHotState":
      applyViewHotState(ctx, msg);
      return;

    case "coldState":
      ctx.state.currentColdState = msg;
      ctx.state.currentEpochs = msg.epochs;
      ctx.state.coldStateByDataset.set(msg.datasetId, msg);
      applyColdState(ctx, msg);
      ctx.postWantedSet(msg.datasetId);
      postGpuMemoryIfChanged(ctx);
      return;

    case "coldStateDisplay":
      // Display-only edit. No residency changed, so no wanted-set is posted.
      applyColdStateDisplay(ctx, msg);
      return;

    case "coldStateSelection":
      // A T/Z scrub changes the wanted chunks, so the wanted-set is posted.
      applyColdStateSelection(ctx, msg);
      ctx.postWantedSet(msg.datasetId);
      postGpuMemoryIfChanged(ctx);
      return;

    case "coldStateDelta":
      // Posted even when the delta was a no-op, matching the full and
      // selection paths.
      applyColdStateDelta(ctx, msg);
      ctx.postWantedSet(msg.datasetId);
      postGpuMemoryIfChanged(ctx);
      return;

    case "failedChunks": {
      // No residency changed, so no wanted-set is posted. The retained cold
      // state is re-ingested so the indirection marks the new list now,
      // not at the next view change.
      const failed = new Map(msg.images.map(({ imageId, chunkKeys }) => [imageId, new Set(chunkKeys)]));
      if (failed.size > 0) ctx.state.failedByDataset.set(msg.datasetId, failed);
      else ctx.state.failedByDataset.delete(msg.datasetId);
      const cold = ctx.state.coldStateByDataset.get(msg.datasetId);
      if (cold) applyColdState(ctx, cold);
      return;
    }

    case "removeLayerResources":
      removeDatasetResources(ctx, msg.datasetId);
      postGpuMemoryIfChanged(ctx);
      return;

    case "destroy":
      // The entry point handles `destroy` so it can null the ctx before
      // `self.close()`. Reaching here means a duplicate.
      return;

    case "abandonFrame":
      // The entry point notes it as it arrives, ahead of the frame it stops.
      noteAbandonedFrame(ctx, msg.frameSeq);
      return;
  }
}

/** Note that the page gave up viewport frames up to `frameSeq`. */
export function noteAbandonedFrame(ctx: WorkerCtx, frameSeq: number): void {
  ctx.state.abandonedFrameSeq = Math.max(ctx.state.abandonedFrameSeq, frameSeq);
}

/**
 * Report a viewport frame done once the GPU has run everything submitted so
 * far, which includes the frame. Not awaited: the next message needn't wait.
 *
 * A frame that failed to draw, or whose device was lost, is reported too: the
 * page holds its next frames until the ones before are done, so a frame that
 * is never answered would stop it drawing.
 */
function postFrameDone(ctx: WorkerCtx, frameSeq: number | undefined): void {
  if (frameSeq === undefined) return;
  const done = () => ctx.post({ type: "frameDone", frameSeq, doneAtMs: performance.timeOrigin + performance.now() });
  ctx.device.queue.onSubmittedWorkDone().then(done, done);
}
