/**
 * The frame on the worker's canvas as a PNG, for the trace bundle (#1055).
 *
 * A hardware host refused `convertToBlob` on the canvas after a frame was
 * presented. Most likely a WebGPU canvas's current texture expires when the
 * frame handler returns, and nothing readable is left behind it. So a
 * capture request only arms the worker, and the next frame handler hands
 * over the canvas texture while it is still current. The main thread asks
 * the render loop for a frame when it arms a capture.
 *
 * A worker that renders no frame still answers. After a wait, the capture
 * reads the canvas as presented. A refusal is reported by name, so the
 * bundle can say why it has no frame. The main thread settles each pending
 * id itself when the client is destroyed.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { CaptureFailure, CaptureFrameMessage } from "../workerProtocol.ts";
import type { RendererState } from "./state.ts";

/**
 * How long an armed capture waits for a frame before it reads the canvas as
 * presented. A frame the loop was asked for lands within a few frames even
 * on a page that is busy loading. A loop that renders nothing, because there
 * is no dataset or no session yet, never lands one, and the presented canvas
 * is the only picture there is.
 */
export const FRAME_CAPTURE_WAIT_MS = 1000;

/** A capture the worker owes: the request's id and the timer that reads the presented canvas if no frame comes. */
export interface PendingFrameCapture {
  id: number;
  fallbackTimer: ReturnType<typeof setTimeout>;
}

type ChannelOrder = "rgba" | "bgra";

/** WebGPU requires each row of a texture-to-buffer copy to start on a 256-byte boundary. */
const ROW_ALIGNMENT = 256;
const BYTES_PER_PIXEL = 4;

/** Arm a capture: the next frame answers it, or the fallback timer does. */
export function handleCaptureFrame(ctx: WorkerCtx, msg: CaptureFrameMessage): void {
  const capture: PendingFrameCapture = {
    id: msg.id,
    fallbackTimer: setTimeout(() => void capturePresentedCanvas(ctx, capture), FRAME_CAPTURE_WAIT_MS),
  };
  ctx.state.frameCaptures.push(capture);
}

/**
 * Take the frame for every armed capture, from inside the frame handler
 * that drew `texture`. Call it after the frame's last submit and before the
 * handler returns, while the texture is still the canvas's current one. A
 * frame with no capture armed pays nothing.
 */
export function captureRenderedFrame(ctx: WorkerCtx, texture: GPUTexture): void {
  const captures = takeAll(ctx.state);
  if (captures.length === 0) return;
  const { width, height } = texture;
  readFrame(ctx.device, texture, ctx.format).then(
    (png) => {
      captures.forEach((capture, index) => {
        // The bytes move to the main thread, so every waiter but the last gets its own copy.
        const bytes = index === captures.length - 1 ? png : png.slice(0);
        reply(ctx, capture.id, width, height, bytes, null);
      });
    },
    (error: unknown) => {
      const failure = describeFailure(error);
      for (const capture of captures) reply(ctx, capture.id, width, height, null, failure);
    },
  );
}

/** Forget every armed capture. The main thread settles their promises when it destroys the client. */
export function clearFrameCaptures(state: RendererState): void {
  takeAll(state);
}

/** The bytes per row of a copy of a `width`-pixel-wide frame, padded to the alignment. */
export function paddedBytesPerRow(width: number): number {
  return Math.ceil((width * BYTES_PER_PIXEL) / ROW_ALIGNMENT) * ROW_ALIGNMENT;
}

function takeAll(state: RendererState): PendingFrameCapture[] {
  const captures = state.frameCaptures.splice(0);
  for (const capture of captures) clearTimeout(capture.fallbackTimer);
  return captures;
}

/** Submit the copy before the first await. The canvas texture expires when the frame handler returns. */
async function readFrame(
  device: GPUDevice,
  texture: GPUTexture,
  format: GPUTextureFormat,
): Promise<ArrayBuffer> {
  const order = channelOrder(format);
  const { width, height } = texture;
  const bytesPerRow = paddedBytesPerRow(width);
  // A copy the device refuses raises no exception. The buffer reads back
  // black. The error scope turns that into a named failure.
  device.pushErrorScope("validation");
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  const refused = device.popErrorScope();
  try {
    const [refusal] = await Promise.all([refused, buffer.mapAsync(GPUMapMode.READ)]);
    if (refusal) throw Object.assign(new Error(refusal.message), { name: "GPUValidationError" });
    const pixels = rgbaPixels(new Uint8Array(buffer.getMappedRange()), bytesPerRow, width, height, order);
    buffer.unmap();
    return await encodePng(pixels, width, height);
  } finally {
    buffer.destroy();
  }
}

/** `getPreferredCanvasFormat` only ever returns these two. */
function channelOrder(format: GPUTextureFormat): ChannelOrder {
  if (format === "rgba8unorm") return "rgba";
  if (format === "bgra8unorm") return "bgra";
  throw new Error(`the canvas format ${format} is not one the frame capture reads`);
}

/**
 * Alpha is forced opaque. The canvas is configured opaque, so the screen
 * ignores the alpha the shader wrote, and the PNG matches the screen.
 */
function rgbaPixels(
  rows: Uint8Array,
  bytesPerRow: number,
  width: number,
  height: number,
  order: ChannelOrder,
): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = width * BYTES_PER_PIXEL;
  const pixels = new Uint8ClampedArray(rowBytes * height);
  for (let y = 0; y < height; y++) {
    pixels.set(rows.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  if (order === "bgra") {
    for (let i = 0; i < pixels.length; i += BYTES_PER_PIXEL) {
      const blue = pixels[i];
      pixels[i] = pixels[i + 2];
      pixels[i + 2] = blue;
    }
  }
  for (let i = 3; i < pixels.length; i += BYTES_PER_PIXEL) pixels[i] = 255;
  return pixels;
}

/** Encode through a 2D canvas, which reads nothing from the GPU. */
async function encodePng(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(width, height);
  const c2d = canvas.getContext("2d");
  if (!c2d) throw new Error("no 2D canvas context to encode the frame with");
  c2d.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blob.arrayBuffer();
}

/**
 * Fallback for a capture no frame reaches. Some hosts allow reading the
 * presented canvas. The rest get the refusal by name.
 */
async function capturePresentedCanvas(ctx: WorkerCtx, capture: PendingFrameCapture): Promise<void> {
  const index = ctx.state.frameCaptures.indexOf(capture);
  if (index < 0) return;
  ctx.state.frameCaptures.splice(index, 1);
  const canvas = ctx.context.canvas as OffscreenCanvas;
  const { width, height } = canvas;
  try {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    reply(ctx, capture.id, width, height, await blob.arrayBuffer(), null);
  } catch (error) {
    const { name, message } = describeFailure(error);
    reply(ctx, capture.id, width, height, null, {
      name,
      message:
        `no frame was rendered within ${FRAME_CAPTURE_WAIT_MS} ms, ` +
        `and reading the canvas as presented failed: ${message}`,
    });
  }
}

function reply(
  ctx: WorkerCtx,
  id: number,
  width: number,
  height: number,
  png: ArrayBuffer | null,
  failure: CaptureFailure | null,
): void {
  ctx.post({ type: "frameCaptured", id, png, width, height, failure }, png ? [png] : undefined);
}

function describeFailure(error: unknown): CaptureFailure {
  const named = error as { name?: unknown; message?: unknown } | null;
  const name = typeof named?.name === "string" && named.name.length > 0 ? named.name : "Error";
  const message = typeof named?.message === "string" ? named.message : String(error);
  return { name, message };
}
