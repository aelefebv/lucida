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
