/**
 * Read the frame on the worker's canvas as a PNG, for the trace bundle
 * (#1055).
 *
 * The canvas is the one the worker presents every frame to, so this encodes
 * what is on screen and draws nothing. A canvas that cannot be read, because
 * the context was lost or the browser refuses the read, still answers, with
 * a null PNG. The main thread has a promise waiting on this id, and the
 * bundle records an absent frame with a reason.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { CaptureFrameMessage } from "../workerProtocol.ts";

export async function handleCaptureFrame(ctx: WorkerCtx, msg: CaptureFrameMessage): Promise<void> {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  const width = canvas.width;
  const height = canvas.height;
  let png: ArrayBuffer | null = null;
  try {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    png = await blob.arrayBuffer();
  } catch {
    png = null;
  }
  ctx.post({ type: "frameCaptured", id: msg.id, png, width, height }, png ? [png] : undefined);
}
