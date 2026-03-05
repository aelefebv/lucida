/** WebGPU device/canvas initialization and texture helpers. */

export interface GPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not supported in this browser");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("Failed to get WebGPU adapter");
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("Failed to get WebGPU canvas context");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  return { device, context, format };
}

export function createVolumeTexture(
  device: GPUDevice,
  width: number,
  height: number,
  depth: number,
  data: Uint16Array,
): GPUTexture {
  const texture = device.createTexture({
    size: [width, height, depth],
    format: "r16uint",
    dimension: "3d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    data.buffer,
    {
      offset: data.byteOffset,
      bytesPerRow: width * 2,
      rowsPerImage: height,
    },
    [width, height, depth],
  );

  return texture;
}

export function createSliceTexture(
  device: GPUDevice,
  width: number,
  height: number,
  data?: Uint16Array | null,
): GPUTexture {
  const texture = device.createTexture({
    size: [width, height],
    format: "r16uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  if (data) {
    const bytesPerRow = width * 2;
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

export function writeSliceRegion(
  device: GPUDevice,
  texture: GPUTexture,
  data: Uint16Array,
  srcRowStride: number,
  dstX: number,
  dstY: number,
  tileW: number,
  tileH: number,
): void {
  const bytesPerRow = tileW * 2;
  const alignedBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;

  // Extract tile rows from source data (which may have a different stride)
  const needsStrideCopy = srcRowStride !== tileW;
  const needsAlignment = alignedBytesPerRow !== bytesPerRow;

  if (!needsStrideCopy && !needsAlignment) {
    device.queue.writeTexture(
      { texture, origin: [dstX, dstY, 0] },
      data.buffer,
      { offset: data.byteOffset, bytesPerRow },
      [tileW, tileH],
    );
    return;
  }

  const paddedWidth = alignedBytesPerRow / 2;
  const padded = new Uint16Array(paddedWidth * tileH);
  for (let y = 0; y < tileH; y++) {
    padded.set(data.subarray(y * srcRowStride, y * srcRowStride + tileW), y * paddedWidth);
  }
  device.queue.writeTexture(
    { texture, origin: [dstX, dstY, 0] },
    padded.buffer,
    { bytesPerRow: alignedBytesPerRow },
    [tileW, tileH],
  );
}
