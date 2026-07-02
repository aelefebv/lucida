/** WebGPU device/canvas initialization and texture helpers. */

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
 * Read the queried device limits with WebGPU-spec-minimum fallbacks.
 * If a device reports a lower value than the spec minimum (rare but
 * legal), the queried value wins. `device.limits` itself is optional
 * here so partial mocks in unit tests (which may stub out only some
 * of the device surface) fall back to the spec minimums.
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

export async function initGPU(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not supported in this browser");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Failed to get WebGPU adapter");
  }

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Failed to get WebGPU canvas context");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  return { device, context, format };
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
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
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
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
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
