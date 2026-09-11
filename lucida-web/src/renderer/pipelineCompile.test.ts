import { describe, expect, it, vi } from "vitest";

// Imports are hoisted above these assignments. That is fine, because the
// renderers read the enums in their constructors, not at import.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

import { CursorRenderer } from "./cursorRenderer.ts";
import { LayerCompositor } from "./layerCompositor.ts";
import { requireCompiled } from "./pipelineCompile.ts";
import { SliceRenderer } from "./sliceRenderer.ts";
import { VolumeRenderer } from "./volumeRenderer.ts";

/** One `createRenderPipelineAsync` call the test settles by hand. */
interface PendingPipeline {
  descriptor: GPURenderPipelineDescriptor;
  resolve: (pipeline: GPURenderPipeline) => void;
  reject: (err: Error) => void;
}

/**
 * A device that offers `createRenderPipelineAsync` and refuses the
 * synchronous form, so a renderer that compiled on the GPU process's main
 * thread fails here. Everything else answers with an inert object.
 */
function makeDevice(): { device: GPUDevice; pending: PendingPipeline[] } {
  const pending: PendingPipeline[] = [];
  const texture = { createView: () => ({}), destroy: vi.fn() };
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => {
      throw new Error("a pipeline was created synchronously");
    }),
    createRenderPipelineAsync: vi.fn(
      (descriptor: GPURenderPipelineDescriptor) =>
        new Promise<GPURenderPipeline>((resolve, reject) => {
          pending.push({ descriptor, resolve, reject });
        }),
    ),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createTexture: vi.fn(() => texture),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
  return { device, pending };
}

function makeEncoder() {
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setScissorRect: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const encoder = {
    beginRenderPass: vi.fn(() => pass),
    finish: vi.fn(() => ({})),
  } as unknown as GPUCommandEncoder;
  return { encoder, pass };
}

function pipeline(name: string): GPURenderPipeline {
  return { label: name } as unknown as GPURenderPipeline;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Whether `promise` has settled, without waiting for it. */
function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    Promise.resolve().then(() => false),
  ]);
}

const view = {} as GPUTextureView;
const buffer = {} as GPUBuffer;

interface Compiles {
  readonly compiled: Promise<void>;
  readonly isCompiled: boolean;
}

describe.each<[string, (device: GPUDevice) => Compiles, number]>([
  ["slice renderer", (device) => new SliceRenderer(device), 4],
  ["layer compositor", (device) => new LayerCompositor(device, "bgra8unorm"), 3],
  ["cursor renderer", (device) => new CursorRenderer(device, "bgra8unorm"), 2],
  ["volume renderer", (device) => new VolumeRenderer(device), 1],
])("the %s", (_name, construct, pipelineCount) => {
  it("creates every pipeline asynchronously and is compiled once the last one resolves", async () => {
    const { device, pending } = makeDevice();
    const renderer = construct(device);

    expect(device.createRenderPipeline).not.toHaveBeenCalled();
    expect(pending).toHaveLength(pipelineCount);
    expect(renderer.isCompiled).toBe(false);

    for (const creation of pending.slice(0, -1)) creation.resolve(pipeline("early"));
    await flush();
    expect(renderer.isCompiled).toBe(false);
    expect(await isSettled(renderer.compiled)).toBe(false);

    pending[pending.length - 1].resolve(pipeline("last"));
    await flush();
    expect(renderer.isCompiled).toBe(true);
    await expect(renderer.compiled).resolves.toBeUndefined();
  });

  it("rejects compiled when a pipeline fails to compile", async () => {
    const { device, pending } = makeDevice();
    const renderer = construct(device);

    pending[0].reject(new Error("compile failed"));
    for (const creation of pending.slice(1)) creation.resolve(pipeline("ok"));

    await expect(renderer.compiled).rejects.toThrow("compile failed");
    expect(renderer.isCompiled).toBe(false);
  });
});

describe("drawing before the compile", () => {
  it("names the renderer instead of handing WebGPU a missing pipeline", () => {
    expect(() => requireCompiled(null, "slice renderer")).toThrow(
      "the slice renderer drew before its pipelines compiled",
    );
    const built = pipeline("built");
    expect(requireCompiled(built, "slice renderer")).toBe(built);
  });

  it("throws from the compositor for a layer, and clears without one", async () => {
    const { device, pending } = makeDevice();
    const compositor = new LayerCompositor(device, "bgra8unorm");
    const { encoder, pass } = makeEncoder();

    expect(() => compositor.composite(view, [{ view, blendMode: "alpha" }], encoder)).toThrow(
      "the layer compositor drew before its pipelines compiled",
    );
    expect(() => compositor.composite(view, [], encoder)).not.toThrow();

    const [alpha, additive, max] = ["alpha", "additive", "max"].map(pipeline);
    pending[0].resolve(alpha);
    pending[1].resolve(additive);
    pending[2].resolve(max);
    await compositor.compiled;

    compositor.composite(view, [{ view, blendMode: "max" }], encoder);
    expect(pass.setPipeline).toHaveBeenCalledWith(max);
  });

  it("throws from the cursor renderer, then draws with the resolved pipeline", async () => {
    const { device, pending } = makeDevice();
    const cursors = new CursorRenderer(device, "bgra8unorm");
    const { encoder, pass } = makeEncoder();
    cursors.updateCursors(new Float32Array(16), 1);

    expect(() => cursors.renderSlice(view, encoder, 1, 0, 0, 10, 10)).toThrow(
      "the cursor renderer drew before its pipelines compiled",
    );

    const [twoD, threeD] = ["2d", "3d"].map(pipeline);
    pending[0].resolve(twoD);
    pending[1].resolve(threeD);
    await cursors.compiled;

    cursors.renderSlice(view, encoder, 1, 0, 0, 10, 10);
    expect(pass.setPipeline).toHaveBeenCalledWith(twoD);
    cursors.renderVolume(view, view, encoder, new Float32Array(16), 10, 10);
    expect(pass.setPipeline).toHaveBeenLastCalledWith(threeD);
  });

  it("throws from the slice renderer, then draws with the resolved pipeline", async () => {
    const { device, pending } = makeDevice();
    const slices = new SliceRenderer(device);
    const { encoder, pass } = makeEncoder();
    slices.setTierAtlases([], null);
    slices.setDescriptorBinding(buffer, 0);

    expect(() => slices.renderTo(view, encoder)).toThrow(
      "the slice renderer drew before its pipelines compiled",
    );

    const main = pipeline("slice");
    pending[0].resolve(main);
    for (const creation of pending.slice(1)) creation.resolve(pipeline("aggregate"));
    await slices.compiled;

    slices.renderTo(view, encoder);
    expect(pass.setPipeline).toHaveBeenCalledWith(main);
  });

  it("throws from the volume renderer, then draws with the resolved pipeline", async () => {
    const { device, pending } = makeDevice();
    const volumes = new VolumeRenderer(device);
    const { encoder, pass } = makeEncoder();
    volumes.setTierAtlases([], null);
    volumes.setDescriptorBinding(buffer, 0);

    expect(() => volumes.renderTo(view, encoder)).toThrow(
      "the volume renderer drew before its pipelines compiled",
    );

    const main = pipeline("volume");
    pending[0].resolve(main);
    await volumes.compiled;

    volumes.renderTo(view, encoder);
    expect(pass.setPipeline).toHaveBeenCalledWith(main);
  });
});
