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

import { axisAlignedQuad } from "./sliceQuad.ts";
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
      placement: { zoom: 1, cx, cy: 0, quad: axisAlignedQuad(0, 0, 10, 10) }, scissor: [0, 0, 10, 10],
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

  it("writes every member's uniforms in one write, and members that bind the same resources share bind groups", async () => {
    const { device, frame, member, createView } = await setup();
    const bindGroupsAtStart = device.createBindGroup.mock.calls.length;

    frame([member(0, 5), member(1, 15), member(2, 25)]);
    // One pools group and one entity group, which the three draws share.
    expect(device.createBindGroup.mock.calls.length - bindGroupsAtStart).toBe(2);
    // The uniform blocks, then the entity references.
    expect(device.queue.writeBuffer.mock.calls.slice(-2).map((call) => call[4])).toEqual([3 * 256, 3 * 256]);
    const views = createView.mock.calls.length;

    // A pan: every member moves and the roster reorders, but the resources
    // the draws bind stay the same.
    const pass = frame([member(2, 30), member(0, 10), member(1, 20)]);
    expect(device.createBindGroup.mock.calls.length - bindGroupsAtStart).toBe(2);
    expect(createView.mock.calls.length).toBe(views);
    expect(pass.draw).toHaveBeenCalledTimes(3);

    // The groups name the whole block size, and each draw index picks its own
    // block of the shared buffers by dynamic offset.
    const poolEntries = device.createBindGroup.mock.results.slice(bindGroupsAtStart)
      .map((r) => r.value.entries as GPUBindGroupEntry[])
      .find((entries) => entries.length > 3)!;
    const uniform = poolEntries[0].resource as GPUBufferBinding;
    expect([uniform.offset, uniform.size]).toEqual([undefined, SLICE_UNIFORM_SIZE]);
    const offsets = pass.setBindGroup.mock.calls.map((call) => [call[0], call[2][0]]);
    expect(offsets).toEqual([[0, 0], [1, 0], [0, 256], [1, 256], [0, 512], [1, 512]]);

    // The uniforms written carry this frame's camera, member by member.
    const uniforms = new Float32Array(device.queue.writeBuffer.mock.calls.at(-2)![2] as ArrayBuffer);
    const tx = (i: number) => uniforms[i * 64 + 12];
    expect([tx(0), tx(1), tx(2)]).toEqual([-5 + 3, -5 + 1, -5 + 2]);
    const refs = new Uint32Array(device.queue.writeBuffer.mock.calls.at(-1)![2] as ArrayBuffer);
    expect([refs[0], refs[64], refs[128]]).toEqual([2, 0, 1]);
  });

  it("creates no bind group when a zoom changes which members draw and the pools each binds", async () => {
    const { device, frame, member, texture } = await setup();
    const fine = pool(texture());
    const coarser = pool(texture());
    const at = (entityIndex: number, levels: SlicePoolBinding[]) => member(entityIndex, entityIndex * 10, { levels });
    frame([at(0, [fine]), at(1, [fine]), at(2, [coarser])]);
    const before = device.createBindGroup.mock.calls.length;

    // Members leave and arrive, and draw indices now bind other pools than
    // they did, but every combination was bound last frame.
    frame([at(2, [coarser]), at(1, [fine]), at(3, [coarser]), at(4, [fine])]);
    expect(device.createBindGroup.mock.calls.length).toBe(before);
  });

  it("places a turned member through its quad: the screen point of each corner reads that corner's UV", async () => {
    const { device, frame, member } = await setup();
    // At zoom 2 about (25, 25) on a 100 x 100 target, scene (x, y) is at
    // screen UV ((x - 25) * 2 / 100 + 0.5, ...).
    const quad = { origin: [20, 10] as [number, number], across: [8, 6] as [number, number], down: [-3, 4] as [number, number] };
    frame([member(0, 25, { placement: { zoom: 2, cx: 25, cy: 25, quad } })]);
    const m = new Float32Array(device.queue.writeBuffer.mock.calls.at(-2)![2] as ArrayBuffer);
    const uvAt = (x: number, y: number) => {
      const [sx, sy] = [(x - 25) * 2 / 100 + 0.5, (y - 25) * 2 / 100 + 0.5];
      return [m[0] * sx + m[4] * sy + m[12], m[1] * sx + m[5] * sy + m[13]];
    };
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const [x, y] = [20 + u * 8 + v * -3, 10 + u * 6 + v * 4];
      const [ru, rv] = uvAt(x, y);
      expect(ru).toBeCloseTo(u, 5);
      expect(rv).toBeCloseTo(v, 5);
    }
    // The border measures the member's own edges, 10 and 5 scene units.
    expect([m[36], m[37]]).toEqual([20, 10]);
  });

  it("makes a bind group for a replaced resource, and keeps no group the frame left out", async () => {
    const { device, frame, member, texture } = await setup();
    frame([member(0, 5), member(1, 15)]);
    const before = device.createBindGroup.mock.calls.length;

    // A grown pool is a new texture: the draw that binds it gets a pools group of its own.
    const grown = pool(texture());
    frame([member(0, 5), member(1, 15, { levels: [grown] })]);
    expect(device.createBindGroup.mock.calls.length - before).toBe(1);

    // A rebuilt descriptor buffer replaces the entity group the draws share.
    const descriptorBuffer = { destroy: vi.fn() } as unknown as GPUBuffer;
    frame([member(0, 5, { descriptorBuffer }), member(1, 15, { descriptorBuffer })]);
    expect(device.createBindGroup.mock.calls.length - before).toBe(1 + 1);

    // The grown pool's group went with the frame that left it out.
    frame([member(0, 5, { descriptorBuffer }), member(1, 15, { descriptorBuffer, levels: [grown] })]);
    expect(device.createBindGroup.mock.calls.length - before).toBe(1 + 1 + 1);
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
    expect(device.createBindGroup.mock.calls.length - before).toBe(2);
  });
});
