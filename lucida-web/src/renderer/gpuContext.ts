/** WebGPU device/canvas initialization and texture helpers. */

import { requestAdapterWithRetry } from "./requestAdapter.ts";

export const OFFSCREEN_FORMAT: GPUTextureFormat = "rgba16float";

/**
 * Subset of `GPUSupportedLimits` that renderer code actually queries.
 * Centralized so atlas-sizing math can be called from pure helpers
 * without depending on the live `GPUDevice` object.
 */
export interface DeviceLimits {
  maxTextureDimension2D: number;
  maxTextureDimension3D: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
}

/**
 * Read the queried device limits with WebGPU spec-minimum fallbacks. A
 * queried value below the minimum still wins. `device.limits` is optional
 * so partial test mocks fall back to the minimums.
 */
export function getDeviceLimits(device: GPUDevice): DeviceLimits {
  const limits = device.limits as Partial<GPUSupportedLimits> | undefined;
  return {
    maxTextureDimension2D: limits?.maxTextureDimension2D ?? 8192,
    maxTextureDimension3D: limits?.maxTextureDimension3D ?? 2048,
    maxStorageBufferBindingSize:
      limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024,
    maxBufferSize: limits?.maxBufferSize ?? 256 * 1024 * 1024,
  };
}

export function createOffscreenTarget(device: GPUDevice, w: number, h: number): GPUTexture {
  return device.createTexture({
    size: [w, h],
    format: OFFSCREEN_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export interface GPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

const WEBGPU_MISSING = "WebGPU is not supported in this browser";
const NO_ADAPTER = "Failed to get WebGPU adapter";

/** Why the viewer can't draw: no WebGPU at all, or no adapter behind it. */
export type WebGpuUnavailableReason = "missing" | "no-adapter";

/**
 * Whether a render-worker init failure means the browser can't draw at all,
 * which the page explains in place of the viewer rather than as an error.
 */
export function webGpuUnavailableReason(message: string): WebGpuUnavailableReason | null {
  if (message.includes(WEBGPU_MISSING)) return "missing";
  if (message.includes(NO_ADAPTER)) return "no-adapter";
  return null;
}

export async function initGPU(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<GPUContext> {
  const device = await requestGpuDevice();
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Failed to get WebGPU canvas context");
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  configureCanvas(context, device, format);
  return { device, context, format };
}

/**
 * Point a canvas context at a device. A context outlives the device it was
 * configured with, so a replacement device draws to the same canvas.
 */
export function configureCanvas(context: GPUCanvasContext, device: GPUDevice, format: GPUTextureFormat): void {
  // `COPY_SRC` lets the frame capture copy the canvas texture out from
  // inside a frame, for the trace bundle. See `worker/captureFrame.ts`.
  // `COPY_DST` lets a view that covers part of the canvas land its frame
  // there. See `worker/viewFrame.ts`.
  context.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
}

/** A fresh adapter and device. A lost device's adapter can't make another, so recovery comes here too. */
export async function requestGpuDevice(): Promise<GPUDevice> {
  if (!navigator.gpu) {
    throw new Error(WEBGPU_MISSING);
  }

  const adapter = await requestAdapterWithRetry(navigator.gpu);
  if (!adapter) {
    throw new Error(NO_ADAPTER);
  }

  // `timestamp-query` lets the render worker read a GPU pass time back per
  // frame for the trace. A device without it initializes untimed.
  const requiredFeatures: GPUFeatureName[] = adapter.features.has("timestamp-query") ? ["timestamp-query"] : [];
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
  } catch (err) {
    // A driver can advertise limits it then refuses to grant. The default
    // limits still draw, and the atlas budgets follow the smaller buffers.
    // The retry takes a fresh adapter, in case the refusal consumed this one.
    console.warn("WebGPU device at adapter limits refused; using default limits", err);
    const retry = (await requestAdapterWithRetry(navigator.gpu)) ?? adapter;
    device = await retry.requestDevice({
      requiredFeatures: retry.features.has("timestamp-query") ? ["timestamp-query"] : [],
    });
  }
  return device;
}

export function createEmptyVolumeTexture(
  device: GPUDevice,
  width: number,
  height: number,
  depth: number,
  format: SliceTextureFormat = "r16uint",
): GPUTexture {
  return device.createTexture({
    size: [width, height, depth],
    format,
    dimension: "3d",
    // COPY_SRC so the pixel readout can copy a texel out.
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
}

export function writeVolumeChunk(
  device: GPUDevice,
  texture: GPUTexture,
  data: SliceVoxels,
  chunkX: number,
  chunkY: number,
  cw: number,
  ch: number,
  cd: number,
  xOff: number,
  yOff: number,
  zOff: number,
  format: SliceTextureFormat = "r16uint",
): void {
  const bpv = bytesPerVoxelFor(format);
  device.queue.writeTexture(
    { texture, origin: [xOff, yOff, zOff] },
    data.buffer,
    { offset: data.byteOffset, bytesPerRow: chunkX * bpv, rowsPerImage: chunkY },
    [cw, ch, cd],
  );
}

/**
 * Single-channel unsigned-integer texture formats the 2D slice atlas and
 * 3D volume textures hold: `r16uint` for intensity images (2 bytes/voxel,
 * `Uint16Array`) and `r32uint` for label masks whose ids exceed 16 bits (4
 * bytes/voxel, `Uint32Array`). Both bind to the shader's `texture_*d<u32>`
 * samplers.
 */
export type SliceTextureFormat = "r16uint" | "r32uint";

/** A voxel payload matching its texture format's element size. */
export type SliceVoxels = Uint16Array | Uint32Array;

function bytesPerVoxelFor(format: SliceTextureFormat): number {
  return format === "r32uint" ? 4 : 2;
}

function makeLike(source: SliceVoxels, length: number): SliceVoxels {
  return source instanceof Uint32Array
    ? new Uint32Array(length)
    : new Uint16Array(length);
}

export function createSliceTexture(
  device: GPUDevice,
  width: number,
  height: number,
  data?: SliceVoxels | null,
  format: SliceTextureFormat = "r16uint",
): GPUTexture {
  const bpv = bytesPerVoxelFor(format);
  const texture = device.createTexture({
    size: [width, height],
    format,
    // COPY_SRC so the pixel readout can copy a texel out.
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });

  if (data) {
    const bytesPerRow = width * bpv;
    const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;

    if (alignedBytesPerRow === bytesPerRow) {
      device.queue.writeTexture(
        { texture },
        data.buffer,
        { offset: data.byteOffset, bytesPerRow },
        [width, height],
      );
    } else {
      // Pad rows to satisfy WebGPU 256-byte alignment
      const paddedWidth = alignedBytesPerRow / bpv;
      const padded = makeLike(data, paddedWidth * height);
      for (let y = 0; y < height; y++) {
        padded.set(data.subarray(y * width, y * width + width), y * paddedWidth);
      }
      device.queue.writeTexture(
        { texture },
        padded.buffer,
        { bytesPerRow: alignedBytesPerRow },
        [width, height],
      );
    }
  }

  return texture;
}

export function writeSliceRegion(
  device: GPUDevice,
  texture: GPUTexture,
  data: SliceVoxels,
  srcRowStride: number,
  dstX: number,
  dstY: number,
  chunkW: number,
  chunkH: number,
  format: SliceTextureFormat = "r16uint",
): void {
  const bpv = bytesPerVoxelFor(format);
  const bytesPerRow = chunkW * bpv;
  const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;

  // Extract chunk rows from source data (which may have a different stride)
  const needsStrideCopy = srcRowStride !== chunkW;
  const needsAlignment = alignedBytesPerRow !== bytesPerRow;

  if (!needsStrideCopy && !needsAlignment) {
    device.queue.writeTexture(
      { texture, origin: [dstX, dstY, 0] },
      data.buffer,
      { offset: data.byteOffset, bytesPerRow },
      [chunkW, chunkH],
    );
    return;
  }

  const paddedWidth = alignedBytesPerRow / bpv;
  const padded = makeLike(data, paddedWidth * chunkH);
  for (let y = 0; y < chunkH; y++) {
    padded.set(data.subarray(y * srcRowStride, y * srcRowStride + chunkW), y * paddedWidth);
  }
  device.queue.writeTexture(
    { texture, origin: [dstX, dstY, 0] },
    padded.buffer,
    { bytesPerRow: alignedBytesPerRow },
    [chunkW, chunkH],
  );
}
