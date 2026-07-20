import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUShaderStage = {
  FRAGMENT: 0x02,
};

import { LayerCompositor } from "./layerCompositor.ts";

function makeDevice() {
  const passes: Array<{
    setPipeline: ReturnType<typeof vi.fn>;
    setBindGroup: ReturnType<typeof vi.fn>;
    setScissorRect: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }> = [];
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
  } as unknown as GPUDevice;
  const beginRenderPass = vi.fn((_descriptor: GPURenderPassDescriptor) => {
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setScissorRect: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    };
    passes.push(pass);
    return pass;
  });
  const encoder = { beginRenderPass } as unknown as GPUCommandEncoder;
  return { device, encoder, beginRenderPass, passes };
}

describe("LayerCompositor", () => {
  it("uses each layer's visible rect while clearing the destination only once", () => {
    const { device, encoder, beginRenderPass, passes } = makeDevice();
    const compositor = new LayerCompositor(device, "bgra8unorm");
    const firstRect: [number, number, number, number] = [12, 24, 80, 60];
    const secondRect: [number, number, number, number] = [140, 90, 32, 48];

    compositor.composite(
      {} as GPUTextureView,
      [
        { view: {} as GPUTextureView, blendMode: "alpha", scissorRect: firstRect },
        { view: {} as GPUTextureView, blendMode: "additive", scissorRect: secondRect },
      ],
      encoder,
    );

    expect(beginRenderPass).toHaveBeenCalledTimes(2);
    const firstAttachment = [...beginRenderPass.mock.calls[0]![0].colorAttachments][0];
    const secondAttachment = [...beginRenderPass.mock.calls[1]![0].colorAttachments][0];
    expect(firstAttachment).toMatchObject({
      loadOp: "clear",
      storeOp: "store",
    });
    expect(secondAttachment).toEqual({
      view: expect.anything(),
      loadOp: "load",
      storeOp: "store",
    });
    expect(passes[0].setScissorRect).toHaveBeenCalledWith(...firstRect);
    expect(passes[1].setScissorRect).toHaveBeenCalledWith(...secondRect);
    expect(passes[0].draw).toHaveBeenCalledWith(3);
    expect(passes[1].draw).toHaveBeenCalledWith(3);
  });

  it("keeps an omitted rect as a full-surface composite", () => {
    const { device, encoder, passes } = makeDevice();
    const compositor = new LayerCompositor(device, "bgra8unorm");

    compositor.composite(
      {} as GPUTextureView,
      [{ view: {} as GPUTextureView, blendMode: "max" }],
      encoder,
      false,
    );

    expect(passes[0].setScissorRect).not.toHaveBeenCalled();
  });
});
