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

import { SLICE_UNIFORM_SIZE, SliceRenderer, type LayerGroupDraw, type MemberDraw, type SlicePoolBinding } from "./sliceRenderer.ts";

function makeDevice() {
  const createView = vi.fn(() => ({}));
  const texture = () => ({ createView, destroy: vi.fn() }) as unknown as GPUTexture;
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
  return { device, texture, createView };
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

function pool(texture: GPUTexture): SlicePoolBinding {
  return { texture, indirectionBuf: { destroy: vi.fn() } as unknown as GPUBuffer, slotsX: 4, slotsY: 4 };
}

describe("the slice renderer's member draws", () => {
  async function setup() {
    const { device, texture, createView } = makeDevice();
    const renderer = new SliceRenderer(device as unknown as GPUDevice);
    await renderer.compiled;
    const level = pool(texture());
    const coarse = pool(texture());
    const colormap = texture();
    const descriptorBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    const member = (entityIndex: number, cx: number, over: Partial<MemberDraw> = {}): MemberDraw => ({
      levels: [level], coarse, colormap, descriptorBuffer, entityIndex,
      zoom: 1, cx, cy: 0, dataW: 10, dataH: 10, scissor: [0, 0, 10, 10],
      ...over,
    });
    const group = (members: MemberDraw[]): LayerGroupDraw => ({
      blendMode: "alpha", canvasW: 100, canvasH: 100, aggregate: null, members,
    });
    const frame = (members: MemberDraw[]) => {
      const { encoder, pass } = makeEncoder();
      renderer.renderLayerGroup({} as GPUTextureView, encoder, group(members));
      return pass;
    };
    return { device, renderer, frame, member, createView, texture };
  }

  it("writes every member's uniforms in one write and creates bind groups only on the first frame", async () => {
    const { device, frame, member, createView } = await setup();
    const bindGroupsAtStart = device.createBindGroup.mock.calls.length;

    frame([member(0, 5), member(1, 15), member(2, 25)]);
    expect(device.createBindGroup.mock.calls.length - bindGroupsAtStart).toBe(6);
    // The uniform blocks, then the entity references.
    expect(device.queue.writeBuffer.mock.calls.slice(-2).map((call) => call[4])).toEqual([3 * 256, 3 * 256]);
    const views = createView.mock.calls.length;

    // A pan: every member moves and the roster reorders, but the resources
    // each draw index binds stay the same.
    const pass = frame([member(2, 30), member(0, 10), member(1, 20)]);
    expect(device.createBindGroup.mock.calls.length - bindGroupsAtStart).toBe(6);
    expect(createView.mock.calls.length).toBe(views);
    expect(pass.draw).toHaveBeenCalledTimes(3);

    // Each draw index reads its own block of the shared buffers.
    const pools = device.createBindGroup.mock.results.slice(bindGroupsAtStart).map((r) => r.value.entries);
    const offsets = pools
      .filter((entries: GPUBindGroupEntry[]) => entries.length > 3)
      .map((entries: GPUBindGroupEntry[]) => (entries[0].resource as GPUBufferBinding));
    expect(offsets.map((b: GPUBufferBinding) => [b.offset, b.size])).toEqual([
      [0, SLICE_UNIFORM_SIZE],
      [256, SLICE_UNIFORM_SIZE],
      [512, SLICE_UNIFORM_SIZE],
    ]);

    // The uniforms written carry this frame's camera, member by member.
    const uniforms = new Float32Array(device.queue.writeBuffer.mock.calls.at(-2)![2] as ArrayBuffer);
    const tx = (i: number) => uniforms[i * 64 + 12];
    expect([tx(0), tx(1), tx(2)]).toEqual([-5 + 3, -5 + 1, -5 + 2]);
    const refs = new Uint32Array(device.queue.writeBuffer.mock.calls.at(-1)![2] as ArrayBuffer);
    expect([refs[0], refs[64], refs[128]]).toEqual([2, 0, 1]);
  });

  it("rebuilds a draw index's bind groups when a resource it names is replaced", async () => {
    const { device, frame, member, texture } = await setup();
    frame([member(0, 5), member(1, 15)]);
    const before = device.createBindGroup.mock.calls.length;

    // A grown pool is a new texture: only the draw that binds it rebuilds its pools group.
    frame([member(0, 5), member(1, 15, { levels: [pool(texture())] })]);
    expect(device.createBindGroup.mock.calls.length - before).toBe(1);

    // A rebuilt descriptor buffer replaces every entity group.
    const descriptorBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    frame([member(0, 5, { descriptorBuffer }), member(1, 15, { descriptorBuffer })]);
    expect(device.createBindGroup.mock.calls.length - before).toBe(1 + 2 + 1);
  });

  it("grows its shared buffers past their capacity and drops the bind groups that named the old ones", async () => {
    const { device, frame, member } = await setup();
    const many = (n: number) => Array.from({ length: n }, (_, i) => member(i, i * 10));
    frame(many(64));
    const created = device.createBuffer.mock.results.map((r) => r.value);
    const before = device.createBindGroup.mock.calls.length;

    frame(many(65));
    const grown = device.createBuffer.mock.results.slice(created.length).map((r) => r.value);
    expect(grown.map((b) => b.size)).toEqual([128 * 256, 128 * 256]);
    expect(created.at(-1).destroy).toHaveBeenCalled();
    expect(device.createBindGroup.mock.calls.length - before).toBe(65 * 2);
  });
});
