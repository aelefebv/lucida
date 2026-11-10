/**
 * Where a view's frame is drawn. A view draws in its own pixels, as if its
 * rectangle were the whole target, so every pass and shader stays the same
 * whatever the rectangle. A view that covers the canvas draws straight onto
 * it. One that covers part draws into a target its size, which lands on its
 * rectangle of the canvas once the frame is drawn.
 *
 * A frame draws one view: the canvas starts each frame clear, so the rest of
 * it stays clear.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ViewRect } from "../workerProtocol.ts";

export interface ViewFrame {
  /** What the view's passes draw into. */
  texture: GPUTexture;
  /** The canvas texture of this frame, which `land` fills. */
  canvasTexture: GPUTexture;
  /** Put the drawn view on its rectangle of the canvas. A no-op for a view that covers it. */
  land(): void;
}

/** Whether `rect` is the whole of a `canvasW` x `canvasH` canvas. */
export function coversCanvas(rect: ViewRect, canvasW: number, canvasH: number): boolean {
  return rect[0] === 0 && rect[1] === 0 && rect[2] === canvasW && rect[3] === canvasH;
}

/**
 * Size the canvas to `canvasW` x `canvasH` and take this frame's target for
 * a view drawn at `rect`. Call it after any wait the frame makes, since the
 * canvas presents the texture it hands out once the handler yields.
 */
export function beginViewFrame(
  ctx: WorkerCtx,
  view: number,
  canvasW: number,
  canvasH: number,
  rect: ViewRect,
): ViewFrame {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = canvasW;
  canvas.height = canvasH;
  const canvasTexture = ctx.context.getCurrentTexture();
  if (coversCanvas(rect, canvasW, canvasH)) {
    return { texture: canvasTexture, canvasTexture, land: () => {} };
  }
  const texture = viewTarget(ctx, view, rect[2], rect[3], canvasTexture.format);
  return {
    texture,
    canvasTexture,
    land: () => {
      const encoder = ctx.device.createCommandEncoder();
      encoder.copyTextureToTexture(
        { texture },
        { texture: canvasTexture, origin: { x: rect[0], y: rect[1] } },
        { width: rect[2], height: rect[3] },
      );
      ctx.device.queue.submit([encoder.finish()]);
    },
  };
}

/** The view's own target, kept while its size and format hold. */
function viewTarget(ctx: WorkerCtx, view: number, w: number, h: number, format: GPUTextureFormat): GPUTexture {
  const targets = ctx.state.viewTargets;
  const held = targets.get(view);
  if (held && held.width === w && held.height === h && held.format === format) return held;
  held?.destroy();
  const texture = ctx.device.createTexture({
    size: [w, h],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
  targets.set(view, texture);
  return texture;
}
