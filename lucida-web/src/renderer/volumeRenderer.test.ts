import { describe, expect, it, vi } from "vitest";

// Imports are hoisted above these assignments. That is fine, because the
// renderer reads the enums in its constructor, not at import.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 0x40, STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};

import { DESCRIPTOR_ENTRY_SIZE, OFFSET_CONTRAST_MAX } from "./descriptor/layout.ts";
import {
  MEMBER_INSTANCE_SIZE,
  VOLUME_UNIFORM_OFFSETS,
  VolumeRenderer,
  type VolumeMemberDraw,
  type VolumePoolBinding,
} from "./volumeRenderer.ts";

function makeDevice() {
  const texture = () => ({ createView: vi.fn(() => ({})), destroy: vi.fn() }) as unknown as GPUTexture;
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(() => Promise.resolve({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() })),
    createTexture: vi.fn(texture),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ entries: descriptor.entries })),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
  };
  return { device, texture };
}

function makeEncoder() {
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setScissorRect: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const encoder = { beginRenderPass: vi.fn(() => pass), finish: vi.fn(() => ({})) } as unknown as GPUCommandEncoder;
  return { encoder, pass };
}

function pool(texture: GPUTexture, slots = 4): VolumePoolBinding {
  return { texture, indirectionBuf: { destroy: vi.fn() } as unknown as GPUBuffer, slotsX: slots, slotsY: slots, slotsZ: 1 };
}

describe("the volume renderer's member draws", () => {
  async function setup() {
    const { device, texture } = makeDevice();
    const renderer = new VolumeRenderer(device as unknown as GPUDevice);
    await renderer.compiled;
    const coarse = [pool(texture()), pool(texture())];
    const colormaps = [texture(), texture()];
    const descriptorBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    // A member's channel `c`, as a collection lists them: one pool and colormap per channel.
    const draw = (entityIndex: number, c: number, over: Partial<VolumeMemberDraw> = {}): VolumeMemberDraw => ({
      levels: [], coarse: coarse[c], colormap: colormaps[c], renderMode: 0, descriptorBuffer, entityIndex,
      scissor: [entityIndex * 10, 0, 10, 10],
      ...over,
    });
    const collection = (members: number) =>
      Array.from({ length: members * 2 }, (_, i) => draw(i, i % 2));
    const writesTo = (buffer: unknown) => device.queue.writeBuffer.mock.calls.filter((call) => call[0] === buffer);
    return { device, renderer, draw, collection, writesTo, texture, coarse };
  }

  it("shares uniform blocks and bind groups among like members, and makes none on the next frame", async () => {
    const { device, renderer, collection } = await setup();
    const bindGroupsAtStart = device.createBindGroup.mock.calls.length;

    renderer.prepareMembers("view", collection(50));
    // A group-0 bind group per channel and one entity bind group. The
    // channels' pools have one slot grid, so every draw reads one block.
    expect(device.createBindGroup.mock.calls.length - bindGroupsAtStart).toBe(3);
    expect(device.queue.writeBuffer.mock.calls.filter((call) => call[4] === 512)).toHaveLength(1);

    device.createBindGroup.mockClear();
    device.queue.writeBuffer.mockClear();
    renderer.prepareMembers("view", collection(50));
    expect(device.createBindGroup).not.toHaveBeenCalled();
    // The view's uniforms, written again; the entity references, unchanged, are not.
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
  });

  it("writes the camera the renderer was given into each draw's block", async () => {
    const { device, renderer, draw } = await setup();
    const invViewProj = new Float32Array(16).map((_, i) => i + 1);
    renderer.setMatrices(invViewProj, new Float32Array([7, 8, 9]));
    renderer.setPixelRatio(2);

    renderer.prepareMembers("view", [draw(0, 0, { renderMode: 1 })]);

    const [, , data] = device.queue.writeBuffer.mock.calls.find((call) => call[4] === 512)!;
    const f32 = new Float32Array(data as ArrayBuffer, 0, 512 / 4);
    expect([...f32.subarray(0, 16)]).toEqual([...invViewProj]);
    expect([...f32.subarray(VOLUME_UNIFORM_OFFSETS.cameraPos / 4, VOLUME_UNIFORM_OFFSETS.cameraPos / 4 + 3)]).toEqual([7, 8, 9]);
    const stepInfo = VOLUME_UNIFORM_OFFSETS.stepInfo / 4;
    expect([f32[stepInfo + 1], f32[stepInfo + 2]]).toEqual([1, 2]);
    const coarseSlots = new Uint32Array(data as ArrayBuffer, VOLUME_UNIFORM_OFFSETS.coarseAtlasSlotDims, 3);
    expect([...coarseSlots]).toEqual([4, 4, 1]);
  });

  it("draws each prepared draw through its scissor, block and entity reference, in one pass", async () => {
    const { renderer, collection } = await setup();
    renderer.prepareMembers("view", collection(3));
    const { encoder, pass } = makeEncoder();

    renderer.renderMembers("view", [0, 2, 4], {} as GPUTextureView, 64, 64, {} as GPUTextureView, true, encoder);

    expect(encoder.beginRenderPass).toHaveBeenCalledOnce();
    expect(pass.setScissorRect.mock.calls).toEqual([[0, 0, 10, 10], [20, 0, 10, 10], [40, 0, 10, 10]]);
    const offsets = pass.setBindGroup.mock.calls.map((call) => [call[0], call[2][0]]);
    expect(offsets).toEqual([[0, 0], [1, 0], [0, 0], [1, 2 * 256], [0, 0], [1, 4 * 256]]);
    expect(pass.draw).toHaveBeenCalledTimes(3);
  });

  it("draws only a band's rows, clearing the target for the first band and keeping it for the rest", async () => {
    const { renderer, draw } = await setup();
    // Rows 0-9, 20-39 and 50-59.
    renderer.prepareMembers("view", [
      draw(0, 0, { scissor: [0, 0, 10, 10] }),
      draw(1, 0, { scissor: [10, 20, 10, 20] }),
      draw(2, 0, { scissor: [20, 50, 10, 10] }),
    ]);

    const first = makeEncoder();
    renderer.renderMembers("view", [0, 1, 2], {} as GPUTextureView, 64, 64, {} as GPUTextureView, true, first.encoder, undefined, { y: 0, height: 32, first: true });
    expect(first.pass.setScissorRect.mock.calls).toEqual([[0, 0, 10, 10], [10, 20, 10, 12]]);
    expect(vi.mocked(first.encoder.beginRenderPass).mock.calls[0][0].colorAttachments).toMatchObject([{ loadOp: "clear" }]);

    const second = makeEncoder();
    renderer.renderMembers("view", [0, 1, 2], {} as GPUTextureView, 64, 64, {} as GPUTextureView, false, second.encoder, undefined, { y: 32, height: 32, first: false });
    expect(second.pass.setScissorRect.mock.calls).toEqual([[10, 32, 10, 8], [20, 50, 10, 10]]);
    expect(second.pass.draw).toHaveBeenCalledTimes(2);
    expect(vi.mocked(second.encoder.beginRenderPass).mock.calls[0][0].colorAttachments).toMatchObject([{ loadOp: "load" }]);
  });

  it("makes a bind group again for a pool or descriptor buffer that was replaced", async () => {
    const { device, renderer, collection, draw, texture } = await setup();
    renderer.prepareMembers("view", collection(2));
    device.createBindGroup.mockClear();

    const draws = collection(2);
    draws[0] = draw(0, 0, { coarse: pool(texture()) });
    draws[3] = draw(3, 1, { descriptorBuffer: { destroy: vi.fn() } as unknown as GPUBuffer });
    renderer.prepareMembers("view", draws);

    expect(device.createBindGroup).toHaveBeenCalledTimes(2);
  });

  it("keeps the view, the minimap and the thumbnails in buffers of their own", async () => {
    const { device, renderer, collection } = await setup();
    device.queue.writeBuffer.mockClear();
    renderer.prepareMembers("view", collection(1));
    renderer.prepareMembers("minimap", collection(1));
    const written = new Set(device.queue.writeBuffer.mock.calls.map((call) => call[0]));
    // Each set's uniform and entity-reference buffers.
    expect(written.size).toBe(4);
  });

  it("writes a descriptor table entry per layer, in order", async () => {
    const { device, renderer } = await setup();
    const params = (contrastMax: number) => ({
      modelMatrix: new Float32Array(16), invModelMatrix: new Float32Array(16), volumeDims: [4, 4, 1] as [number, number, number],
      contrastMin: 0, contrastMax, gamma: 1, opacity: 1,
    });

    const table = renderer.writeDescriptorTable("minimap", [params(10), params(20)]);

    const [buffer, , bytes] = device.queue.writeBuffer.mock.calls.at(-1)!;
    expect(buffer).toBe(table);
    const f32 = new Float32Array(bytes as ArrayBuffer);
    expect((bytes as ArrayBuffer).byteLength).toBe(2 * DESCRIPTOR_ENTRY_SIZE);
    expect([f32[OFFSET_CONTRAST_MAX / 4], f32[(DESCRIPTOR_ENTRY_SIZE + OFFSET_CONTRAST_MAX) / 4]]).toEqual([10, 20]);
  });
});

describe("the volume renderer's member batches", () => {
  async function setup() {
    const { device, texture } = makeDevice();
    const renderer = new VolumeRenderer(device as unknown as GPUDevice);
    await Promise.all([renderer.compiled, renderer.compileMemberBatches()]);
    const descriptorBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const run = (c: number, contrastMax: number): VolumeMemberDraw => ({
      levels: [pool(texture())], coarse: null, colormap: texture(), descriptorBuffer, entityIndex: 0,
      display: { contrastMin: 0, contrastMax, gamma: 0.5, opacity: 1 },
      renderMode: c,
    });
    return { device, renderer, run };
  }

  it("writes each draw's index, and its members' display, into its entity reference", async () => {
    const { device, renderer, run } = await setup();
    renderer.prepareMembers("minimap", [run(0, 10), run(0, 20)]);

    // The reference blocks, written after the one uniform block, which is as long.
    const [, offset, data, start, size] = device.queue.writeBuffer.mock.calls.filter((call) => call[4] === 2 * 256).at(-1)!;
    expect([offset, start]).toEqual([0, 0]);
    const words = new Uint32Array(data as ArrayBuffer, 0, size as number / 4);
    const floats = new Float32Array(data as ArrayBuffer, 0, size as number / 4);
    expect([words[2], ...floats.subarray(4, 8)]).toEqual([0, 0, 10, 0.5, 1]);
    expect([words[64 + 2], ...floats.subarray(64 + 4, 64 + 8)]).toEqual([1, 0, 20, 0.5, 1]);
  });

  it("writes each instance's rect in the target's NDC, with its entity and draw", async () => {
    const { device, renderer } = await setup();
    renderer.setMemberInstances("minimap", [{ entityIndex: 7, draw: 1, rect: [10, 20, 30, 40] }], 100, 200);

    const [, , data] = device.queue.writeBuffer.mock.calls.at(-1)!;
    expect((data as ArrayBuffer).byteLength).toBe(MEMBER_INSTANCE_SIZE);
    expect([...new Float32Array(data as ArrayBuffer, 0, 4)].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-0.8, 0.8, -0.2, 0.4]);
    expect([...new Uint32Array(data as ArrayBuffer, 16, 2)]).toEqual([7, 1]);
  });

  it("draws a batch as one instanced id pass, then one full-screen draw per draw its members take", async () => {
    const { renderer, run } = await setup();
    renderer.prepareMembers("minimap", [run(0, 10), run(0, 20)]);
    renderer.setMemberInstances("minimap", Array.from({ length: 6 }, (_, i) => ({ entityIndex: i, draw: i % 2, rect: [i * 10, 0, 10, 10] as const })), 64, 64);
    const passes: Array<ReturnType<typeof makeEncoder>["pass"]> = [];
    const encoder = {
      beginRenderPass: vi.fn(() => {
        const { pass } = makeEncoder();
        passes.push(pass);
        return pass;
      }),
    } as unknown as GPUCommandEncoder;
    const memberIds = { createView: vi.fn(() => ({})) } as unknown as GPUTexture;

    renderer.renderMemberBatch(
      "minimap", { first: 2, count: 4, draws: [0, 1], bounds: [20, 0, 40, 10] }, {} as GPUTextureView, memberIds,
      {} as GPUTextureView, true, encoder,
    );

    const [ids, march] = passes;
    expect(vi.mocked(encoder.beginRenderPass).mock.calls[0][0].colorAttachments).toMatchObject([
      { loadOp: "clear", clearValue: { r: 0xffffffff } },
    ]);
    expect(ids.draw.mock.calls).toEqual([[6, 4, 0, 2]]);
    expect(march.setScissorRect.mock.calls).toEqual([[20, 0, 40, 10]]);
    expect(march.setBindGroup.mock.calls.map((call) => [call[0], call[2]?.[0]])).toEqual([
      [2, undefined], [0, 0], [1, 0], [0, 0], [1, 256],
    ]);
    expect(march.draw.mock.calls).toEqual([[3], [3]]);
  });
});
