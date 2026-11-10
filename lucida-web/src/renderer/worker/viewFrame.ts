/**
 * Where a view's frame is drawn. A view draws in its own pixels, as if its
 * rectangle were the whole target, so every pass and shader stays the same
 * whatever the rectangle.
 *
 * A view that covers the canvas draws straight onto it: it is the only view.
 * One that covers part draws into a frame of its own, which it keeps. The
 * canvas starts every frame clear, so each present lands every view's kept
 * frame on its rectangle, and a view that did not move need not draw again.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { PresentViewsMessage, ViewRect } from "../workerProtocol.ts";
import { captureRenderedFrame } from "./captureFrame.ts";
import { dropViewFrame, heldViewFrame, releaseViewsBut, viewFrameTarget } from "./viewResources.ts";

export interface ViewFrame {
  /** What the view's passes draw into. */
  texture: GPUTexture;
  /** The canvas texture when the view draws straight onto the canvas, else null. */
  canvasTexture: GPUTexture | null;
}

/** Whether `rect` is the whole of a `canvasW` x `canvasH` canvas. */
export function coversCanvas(rect: ViewRect, canvasW: number, canvasH: number): boolean {
  return rect[0] === 0 && rect[1] === 0 && rect[2] === canvasW && rect[3] === canvasH;
}

function canvasTextureAt(ctx: WorkerCtx, canvasW: number, canvasH: number): GPUTexture {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = canvasW;
  canvas.height = canvasH;
  return ctx.context.getCurrentTexture();
}

/**
 * This frame's target for `view`, drawn at `rect` of a `canvasW` x `canvasH`
 * canvas. A view that covers the canvas sizes it and draws onto it, so call
 * this after any wait the frame makes: the canvas presents the texture it
 * hands out once the handler yields.
 */
export function beginViewFrame(
  ctx: WorkerCtx,
  view: number,
  canvasW: number,
  canvasH: number,
  rect: ViewRect,
): ViewFrame {
  if (coversCanvas(rect, canvasW, canvasH)) {
    // The only view: every other view's resources, and its own kept frame,
    // have gone with the layout that needed them.
    releaseViewsBut(ctx, new Set([view]));
    dropViewFrame(ctx, view);
    const canvasTexture = canvasTextureAt(ctx, canvasW, canvasH);
    return { texture: canvasTexture, canvasTexture };
  }
  return { texture: viewFrameTarget(ctx, view, rect[2], rect[3]), canvasTexture: null };
}

/**
 * Land every view's kept frame on its rectangle of the canvas. A view the
 * page no longer has lets its resources go, and one that has not drawn yet
 * leaves its rectangle clear.
 */
export async function handlePresentViews(ctx: WorkerCtx, msg: PresentViewsMessage): Promise<void> {
  releaseViewsBut(ctx, new Set(msg.views.map(({ view }) => view)));
  const lander = ctx.getViewLander();
  // The wait holds every message behind this one (`worker/inOrder.ts`).
  await lander.compiled;
  const landed = msg.views.flatMap(({ view, rect }) => {
    const frame = heldViewFrame(ctx, view);
    return frame ? [{ frame, rect }] : [];
  });
  const canvasTexture = canvasTextureAt(ctx, msg.canvasW, msg.canvasH);
  const encoder = ctx.device.createCommandEncoder();
  lander.land(canvasTexture.createView(), landed, encoder);
  ctx.device.queue.submit([encoder.finish()]);
  // The frame can be read only here, before the texture expires with this
  // handler.
  captureRenderedFrame(ctx, canvasTexture);
}
