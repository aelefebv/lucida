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
): GPUTexture {
  return device.createTexture({
    size: [width, height, depth],
    format: "r16uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

export function writeVolumeChunk(
  device: GPUDevice,
  texture: GPUTexture,
  data: Uint16Array,
  chunkX: number,
  chunkY: number,
  cw: number,
  ch: number,
  cd: number,
  xOff: number,
  yOff: number,
  zOff: number,
): void {
  device.queue.writeTexture(
    { texture, origin: [xOff, yOff, zOff] },
    data.buffer,
    { offset: data.byteOffset, bytesPerRow: chunkX * 2, rowsPerImage: chunkY },
    [cw, ch, cd],
  );
}

/**
 * Write one **label** chunk region into an `r32uint` volume atlas texture. The
 * 3D twin of the slice path's `r32uint` `writeSliceRegion`: the source is a
 * `Uint32Array` (4 B/voxel, decoded via {@link asUint32}) so ids > 65535 keep
 * their high bits. `bytesPerRow`/`rowsPerImage` use the source chunk's full
 * `chunkX`/`chunkY` stride (the write copies the `cw×ch×cd` sub-region from a
 * densely-packed `chunkX×chunkY×chunkZ` source, matching {@link writeVolumeChunk}).
 * `chunkX * 4` is always a multiple of 4; WebGPU's 256-byte `bytesPerRow`
 * alignment does not apply to `writeTexture` from a `GPUBuffer`-backed
 * `ArrayBuffer` here (same as the intensity path, which uses `chunkX * 2`).
 */
export function writeVolumeChunkU32(
  device: GPUDevice,
  texture: GPUTexture,
  data: Uint32Array,
  chunkX: number,
  chunkY: number,
  cw: number,
  ch: number,
  cd: number,
  xOff: number,
  yOff: number,
  zOff: number,
): void {
  device.queue.writeTexture(
    { texture, origin: [xOff, yOff, zOff] },
    data.buffer,
    { offset: data.byteOffset, bytesPerRow: chunkX * 4, rowsPerImage: chunkY },
    [cw, ch, cd],
  );
}

/**
 * A single-channel unsigned integer texture format usable for the 2D slice
 * atlas. Intensity chunks use `r16uint` (2 bytes/texel); segmentation label
 * chunks use `r32uint` (4 bytes/texel) so ids > 65535 survive intact.
 */
export type SliceTexelFormat = "r16uint" | "r32uint";

/** Bytes per texel for a {@link SliceTexelFormat}. */
export function bytesPerTexel(format: SliceTexelFormat): 2 | 4 {
  return format === "r32uint" ? 4 : 2;
}

export function createSliceTexture(
  device: GPUDevice,
  width: number,
  height: number,
  data?: Uint16Array | null,
  format: SliceTexelFormat = "r16uint",
): GPUTexture {
  const bpt = bytesPerTexel(format);
  const texture = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  if (data) {
    const bytesPerRow = width * bpt;
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
      const paddedWidth = alignedBytesPerRow / 2;
      const padded = new Uint16Array(paddedWidth * height);
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

/**
 * Write one chunk region into a slice atlas texture. Handles both the intensity
 * `r16uint` (2 B/texel, `Uint16Array` source) and label `r32uint` (4 B/texel,
 * `Uint32Array` source) cases; `format` selects the texel width for the
 * bytes-per-row math and the padding-copy element type. Row padding to WebGPU's
 * 256-byte alignment is applied per format.
 */
export function writeSliceRegion(
  device: GPUDevice,
  texture: GPUTexture,
  data: Uint16Array | Uint32Array,
  srcRowStride: number,
  dstX: number,
  dstY: number,
  chunkW: number,
  chunkH: number,
  format: SliceTexelFormat = "r16uint",
): void {
  const bpt = bytesPerTexel(format);
  const bytesPerRow = chunkW * bpt;
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

  const paddedWidth = alignedBytesPerRow / bpt;
  const padded =
    bpt === 4
      ? new Uint32Array(paddedWidth * chunkH)
      : new Uint16Array(paddedWidth * chunkH);
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
