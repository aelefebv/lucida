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
import { VOLUME_UNIFORM_OFFSETS, VolumeRenderer, type VolumeMemberDraw, type VolumePoolBinding } from "./volumeRenderer.ts";

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
