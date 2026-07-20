import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUShaderStage = {
  VERTEX: 0x01,
  FRAGMENT: 0x02,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_DST: 0x08,
  UNIFORM: 0x40,
  STORAGE: 0x80,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
};

import { GpuResourceBudget } from "./gpuResourceBudget.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";

function makeTexture(): GPUTexture {
  return {
    createView: vi.fn(() => ({})),
    destroy: vi.fn(),
  } as unknown as GPUTexture;
}

function makeRenderer() {
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createTexture: vi.fn(() => makeTexture()),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
    },
  } as unknown as GPUDevice;
  const renderer = new VolumeRenderer(
    device,
    new GpuResourceBudget(32 * 1024 * 1024),
  );
  renderer.setVolume(makeTexture(), 8, 8, 8);
  renderer.setTransientDescriptor(
    new Float32Array(16),
    new Float32Array(16),
    [8, 8, 8],
    0,
    1,
    1,
    1,
  );
  return renderer;
}

function makeEncoder() {
  const pass = {
    setScissorRect: vi.fn(),
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const beginRenderPass = vi.fn((_descriptor: GPURenderPassDescriptor) => pass);
  return {
    encoder: { beginRenderPass } as unknown as GPUCommandEncoder,
    beginRenderPass,
    pass,
  };
}

describe("VolumeRenderer render target admission", () => {
  it("loads a reusable intensity target and bounds the draw to its scissor", () => {
    const renderer = makeRenderer();
    const { encoder, beginRenderPass, pass } = makeEncoder();
    const scissorRect: [number, number, number, number] = [5, 6, 70, 80];

    renderer.renderTo({} as GPUTextureView, encoder, {
      depthView: {} as GPUTextureView,
      scissorRect,
      clearColor: false,
    });

    const descriptor = beginRenderPass.mock.calls[0]![0];
    const color = [...descriptor.colorAttachments][0];
    expect(color).toEqual({
      view: expect.anything(),
      loadOp: "load",
      storeOp: "store",
    });
    expect(pass.setScissorRect).toHaveBeenCalledWith(...scissorRect);
  });

  it("clears by default for categorical/discard-capable callers", () => {
    const renderer = makeRenderer();
    const { encoder, beginRenderPass } = makeEncoder();

    renderer.renderTo({} as GPUTextureView, encoder, {
      depthView: {} as GPUTextureView,
    });

    const descriptor = beginRenderPass.mock.calls[0]![0];
    const color = [...descriptor.colorAttachments][0];
    expect(color).toMatchObject({
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    });
  });
});
