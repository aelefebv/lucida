import { describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  STORAGE: 0x80,
  COPY_DST: 0x08,
  UNIFORM: 0x40,
};

import { labelVolumePoolKey } from "../labelPools.ts";
import type { EntityDescriptorIndex, MemberSourceBinding } from "../descriptorBuffer.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { UNTIMED } from "../passTiming.ts";
import type { VolumeMemberDraw, VolumePoolBinding } from "../volumeRenderer.ts";
import type { VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import { attachView, fakeDraw, viewOf } from "../viewIndirectionFixtures.ts";
import { createInitialState, type RendererState } from "../worker/state.ts";
import { captureRenderedFrame } from "../worker/captureFrame.ts";

vi.mock("../worker/captureFrame.ts", () => ({ captureRenderedFrame: vi.fn() }));
import { getOrCreateVolumePool, type AtlasState } from "./atlas.ts";
import { handleVolumeRenderMultiPass } from "./render.ts";

function makeDevice(): GPUDevice {
  const texture = {
    destroy: vi.fn(),
    createView: vi.fn(() => ({})),
  };
  const encoder = {
    finish: vi.fn(() => ({})),
  };
  return {
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createTexture: vi.fn(() => texture),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve(null)),
    createCommandEncoder: vi.fn(() => encoder),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
}

/** `atlas` with view 0 drawing from it, laying out nothing yet. */
function withView(atlas: AtlasState): AtlasState {
  attachView(atlas, new Map(), { entries: 1, draw: fakeDraw({ datasetId: atlas.datasetId }) });
  return atlas;
}

/** The binding the renderer receives for `atlas` in view 0. */
function bindingOf(atlas: AtlasState): VolumePoolBinding {
  return {
    texture: atlas.texture,
    indirectionBuf: viewOf(atlas).indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
    slotsZ: atlas.slotsZ,
  };
}

function makeDescIndex(
  memberIds: string[],
  overrides?: Partial<EntityDescriptorIndex>,
): EntityDescriptorIndex {
  return {
    buffer: {} as GPUBuffer,
    indexByMember: new Map(memberIds.map((id, i) => [id, i])),
    memberByIndex: [...memberIds],
    sourceBindingByMember: new Map(),
    entityCount: memberIds.length,
    colormapLutIndices: new Map([["gray", 0]]),
    colormapNameByMember: new Map(memberIds.map((id) => [id, "gray"])),
    written: new Map(),
    bytes: new ArrayBuffer(0),
    ...overrides,
  };
}

function bindings(entries: Record<string, MemberSourceBinding>): Map<string, MemberSourceBinding> {
  return new Map(Object.entries(entries));
}

interface MockRenderer {
  setColormapTexture: ReturnType<typeof vi.fn>;
  setTierAtlases: ReturnType<typeof vi.fn>;
  setRenderMode: ReturnType<typeof vi.fn>;
  setPixelRatio: ReturnType<typeof vi.fn>;
  setMarchStepScale: ReturnType<typeof vi.fn>;
  setMatrices: ReturnType<typeof vi.fn>;
  setLabelColorBuffer: ReturnType<typeof vi.fn>;
  setDescriptorBinding: ReturnType<typeof vi.fn>;
  renderTo: ReturnType<typeof vi.fn>;
  prepareMembers: ReturnType<typeof vi.fn>;
  renderMembers: ReturnType<typeof vi.fn>;
  compiled: Promise<void>;
}

function makeRenderer(): MockRenderer {
  return {
    setColormapTexture: vi.fn(),
    setTierAtlases: vi.fn(),
    setRenderMode: vi.fn(),
    setPixelRatio: vi.fn(),
    setMarchStepScale: vi.fn(),
    setMatrices: vi.fn(),
    setLabelColorBuffer: vi.fn(),
    setDescriptorBinding: vi.fn(),
    renderTo: vi.fn(),
    prepareMembers: vi.fn(),
    renderMembers: vi.fn(),
    compiled: Promise.resolve(),
  };
}

/** The draws the frame prepared. */
function preparedDraws(renderer: MockRenderer): VolumeMemberDraw[] {
  return renderer.prepareMembers.mock.calls.at(-1)![1];
}

/** A compile the test finishes by hand. */
function pendingCompile(): { compiled: Promise<void>; finish: () => void } {
  let finish!: () => void;
  const compiled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { compiled, finish };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeCtx(opts: {
  device: GPUDevice;
  state: RendererState;
  renderer: MockRenderer;
  composite: ReturnType<typeof vi.fn>;
  descIndex: EntityDescriptorIndex;
  compositorCompiled?: Promise<void>;
  cursorCompiled?: Promise<void>;
}): WorkerCtx {
  for (const memberId of opts.descIndex.memberByIndex) {
    opts.state.memberToDataset.set(memberId, "ds-0");
  }
  return {
    device: opts.device,
    context: {
      canvas: { width: 0, height: 0 },
      getCurrentTexture: () => ({ createView: () => ({}) }),
    },
    state: opts.state,
    passTimer: UNTIMED,
    getVolumeRenderer: () => opts.renderer,
    getCompositor: () => ({
      composite: opts.composite,
      underlayBackground: () => {},
      compiled: opts.compositorCompiled ?? Promise.resolve(),
    }),
    getCursorRenderer: () => ({ hasData: () => false, compiled: opts.cursorCompiled ?? Promise.resolve() }),
    ensureOffscreenPool: () => [{ createView: () => ({}) }],
    getOrCreateLUT: () => ({}),
    lookupEntityDescriptor: () => opts.descIndex,
  } as unknown as WorkerCtx;
}

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

function msgFor(layers: Array<{
  memberId: string;
  entityIndex: number;
  blendMode?: "alpha" | "additive";
  scissorRect?: [number, number, number, number];
}>): VolumeRenderMultiPassMessage {
  return {
    type: "volumeRenderMultiPass",
    epochs: EPOCHS,
    layers: layers.map((l) => ({
      datasetId: l.memberId,
      entityId: `entity-${l.memberId}`,
      entityIndex: l.entityIndex,
      blendMode: l.blendMode ?? "alpha",
      renderMode: "translucent" as const,
      scissorRect: l.scissorRect,
    })),
    invViewProj: new Float32Array(16),
    eye: new Float32Array(3),
    view: 0,
    canvasW: 64,
    canvasH: 64,
    rect: [0, 0, 64, 64],
    fullW: 64,
    fullH: 64,
  };
}

describe("handleVolumeRenderMultiPass — the compile", () => {
  // The reason is in `pipelineCompile.ts`.
  it.each([
    ["volume renderer", "renderer"],
    ["layer compositor", "compositor"],
    ["cursor renderer", "cursor"],
  ] as const)("waits for the %s before it draws", async (_name, which) => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const gate = pendingCompile();
    if (which === "renderer") renderer.compiled = gate.compiled;
    const state = createInitialState();
    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({ "img-a": { levelPoolKeys: [], coarsePoolKey: null } }),
    });
    const ctx = makeCtx({
      device, state, renderer, composite, descIndex,
      compositorCompiled: which === "compositor" ? gate.compiled : undefined,
      cursorCompiled: which === "cursor" ? gate.compiled : undefined,
    });

    const frame = handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));
    await flush();
    expect(composite).not.toHaveBeenCalled();
    expect(device.queue.submit).not.toHaveBeenCalled();

    gate.finish();
    await frame;
    expect(composite).toHaveBeenCalledOnce();
    expect(device.queue.submit).toHaveBeenCalled();
  });
});

describe("handleVolumeRenderMultiPass", () => {
  it("hands the canvas texture it drew to the frame capture, after the frame's last submit", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({ "img-a": { levelPoolKeys: [], coarsePoolKey: null } }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });
    const canvasTexture = { createView: () => ({}) };
    ctx.context.getCurrentTexture = () => canvasTexture as unknown as GPUTexture;
    const capture = vi.mocked(captureRenderedFrame);
    capture.mockClear();

    await handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(ctx, canvasTexture);
    const submit = vi.mocked(device.queue.submit);
    const lastSubmit = submit.mock.invocationCallOrder[submit.mock.invocationCallOrder.length - 1];
    expect(capture.mock.invocationCallOrder[0]).toBeGreaterThan(lastSubmit);
  });

  it("marches coarser for the frame that asks, and hands the renderer back at full quality", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({ "img-a": { levelPoolKeys: [], coarsePoolKey: null } }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    await handleVolumeRenderMultiPass(ctx, { ...msgFor([{ memberId: "img-a", entityIndex: 0 }]), marchStepScale: 2 });
    expect(renderer.setMarchStepScale.mock.calls).toEqual([[2], [1]]);
    const [setCoarse, setFull] = renderer.setMarchStepScale.mock.invocationCallOrder;
    const submits = vi.mocked(device.queue.submit).mock.invocationCallOrder;
    expect(setCoarse).toBeLessThan(submits[0]);
    expect(setFull).toBeGreaterThan(submits[submits.length - 1]);

    renderer.setMarchStepScale.mockClear();
    await handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));
    expect(renderer.setMarchStepScale.mock.calls).toEqual([[1], [1]]);
  });

  it("does not advance first-layer state for skipped non-renderable layers", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const atlas = withView(getOrCreateVolumePool({ device, state } as unknown as WorkerCtx, "pool-b", "ds-0", 16, 16, 16, 0, "u16"));
    viewOf(atlas).entityMetas.set("img-b", [
      {
        level: 0,
        gridDims: [1, 1, 1],
        chunkDims: [16, 16, 16],
        levelDims: [16, 16, 16],
        offset: 0,
      },
    ]);

    // img-a's descriptor names no pool; img-b's names pool-b.
    const descIndex = makeDescIndex(["img-a", "img-b"], {
      sourceBindingByMember: bindings({ "img-b": { levelPoolKeys: ["pool-b"], coarsePoolKey: null } }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    await handleVolumeRenderMultiPass(ctx, msgFor([
      { memberId: "img-a", entityIndex: 0 },
      { memberId: "img-b", entityIndex: 1 },
    ]));

    expect(renderer.renderMembers).toHaveBeenCalledTimes(1);
    // The one drawn layer clears the depth and the canvas.
    expect(renderer.renderMembers.mock.calls[0][1]).toEqual([0]);
    expect(renderer.renderMembers.mock.calls[0][6]).toBe(true);
    expect(composite).toHaveBeenCalledTimes(1);
    expect(composite.mock.calls[0][3]).toBe(true);
    expect(preparedDraws(renderer)).toHaveLength(1);
    expect(preparedDraws(renderer)[0]).toMatchObject({ levels: [bindingOf(atlas)], coarse: null, entityIndex: 1 });
  });

  it("renders a layer backed only by a resident coarse chunk tier", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const coarseAtlas = withView(getOrCreateVolumePool({ device, state } as unknown as WorkerCtx, "coarse-pool", "ds-0", 64, 64, 16, 0, "u16"));
    viewOf(coarseAtlas).dirty = false;
    viewOf(coarseAtlas).entityMetas.set("img-a", [
      {
        level: 2,
        gridDims: [1, 2, 2],
        chunkDims: [16, 64, 64],
        levelDims: [16, 128, 128],
        offset: 0,
      },
    ]);

    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({ "img-a": { levelPoolKeys: [], coarsePoolKey: "coarse-pool" } }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    await handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));

    expect(renderer.renderMembers).toHaveBeenCalledTimes(1);
    expect(preparedDraws(renderer)[0]).toMatchObject({ levels: [], coarse: bindingOf(coarseAtlas) });
    expect(composite).toHaveBeenCalledTimes(1);
  });

  it("binds every level pool the entity's level sources name, in slot order, plus the coarse pool", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const stub = { device, state } as unknown as WorkerCtx;
    const finePool = withView(getOrCreateVolumePool(stub, "ds-0:32x32x32:detail", "ds-0", 32, 32, 32, 0, "u16"));
    const smallChunkPool = withView(getOrCreateVolumePool(stub, "ds-0:16x16x16:detail", "ds-0", 16, 16, 16, 0, "u16"));
    const coarsePool = withView(getOrCreateVolumePool(stub, "ds-0:16x16x16:coarse", "ds-0", 16, 16, 16, 0, "u16"));
    const meta = (level: number, chunk: number) => [{
      level,
      gridDims: [1, 1, 1] as [number, number, number],
      chunkDims: [chunk, chunk, chunk] as [number, number, number],
      levelDims: [chunk, chunk, chunk] as [number, number, number],
      offset: 0,
    }];
    viewOf(finePool).entityMetas.set("img-a", meta(0, 32));
    viewOf(smallChunkPool).entityMetas.set("img-a", meta(1, 16));
    viewOf(coarsePool).entityMetas.set("img-a", meta(3, 16));
    viewOf(finePool).dirty = true;
    viewOf(smallChunkPool).dirty = true;
    viewOf(coarsePool).dirty = true;

    const descIndex = makeDescIndex(["img-a"], {
      sourceBindingByMember: bindings({
        "img-a": {
          levelPoolKeys: ["ds-0:32x32x32:detail", "ds-0:16x16x16:detail"],
          coarsePoolKey: "ds-0:16x16x16:coarse",
        },
      }),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });

    await handleVolumeRenderMultiPass(ctx, msgFor([{ memberId: "img-a", entityIndex: 0 }]));

    expect(renderer.renderMembers).toHaveBeenCalledTimes(1);
    expect(preparedDraws(renderer)[0]).toMatchObject({
      levels: [bindingOf(finePool), bindingOf(smallChunkPool)],
      coarse: bindingOf(coarsePool),
    });
    // Every bound pool's indirection is flushed before the draw.
    expect(viewOf(finePool).dirty).toBe(false);
    expect(viewOf(smallChunkPool).dirty).toBe(false);
    expect(viewOf(coarsePool).dirty).toBe(false);
  });

  describe("a frame drawn in bands", () => {
    /** Two channels of one member, which overlap and so draw as two batches. */
    function bandedFrame(onBandDone: (state: RendererState) => void = () => {}) {
      const device = makeDevice();
      const renderer = makeRenderer();
      const composite = vi.fn();
      const state = createInitialState();
      const stub = { device, state } as unknown as WorkerCtx;
      const pool = withView(getOrCreateVolumePool(stub, "ds-0:16x16x16:coarse", "ds-0", 16, 16, 16, 0, "u16"));
      viewOf(pool).dirty = false;
      const members = ["c0", "c1"];
      for (const id of members) {
        viewOf(pool).entityMetas.set(id, [{ level: 2, gridDims: [1, 1, 1], chunkDims: [16, 16, 16], levelDims: [16, 16, 16], offset: 0 }]);
      }
      const descIndex = makeDescIndex(members, {
        sourceBindingByMember: bindings(Object.fromEntries(
          members.map((id) => [id, { levelPoolKeys: [], coarsePoolKey: "ds-0:16x16x16:coarse" }]),
        )),
      });
      const ctx = makeCtx({ device, state, renderer, composite, descIndex });
      const targets = members.map((id) => ({ id }));
      ctx.ensureOffscreenPool = ((_view: number, count: number) =>
        Array.from({ length: Math.max(count, 2) }, (_, i) => ({ createView: () => targets[i] }))) as unknown as WorkerCtx["ensureOffscreenPool"];
      const getCurrentTexture = vi.fn(() => ({ createView: () => ({}) }));
      ctx.context.getCurrentTexture = getCurrentTexture as unknown as () => GPUTexture;
      (device.queue as { onSubmittedWorkDone?: () => Promise<void> }).onSubmittedWorkDone = vi.fn(() => {
        onBandDone(state);
        return Promise.resolve();
      });
      // The volume covers rows 8 to 56 of the 64.
      const msg: VolumeRenderMultiPassMessage = {
        ...msgFor(members.map((memberId, i) => ({ memberId, entityIndex: i, blendMode: "additive" as const, scissorRect: [0, 8, 64, 48] as [number, number, number, number] }))),
        bands: 4,
        frameSeq: 7,
      };
      return { device, renderer, composite, ctx, msg, targets, getCurrentTexture };
    }

    it("marches each band of the rows it covers as a submission of its own, and presents only after the last", async () => {
      const { device, renderer, composite, ctx, msg, targets, getCurrentTexture } = bandedFrame();
      const capture = vi.mocked(captureRenderedFrame);
      capture.mockClear();

      await handleVolumeRenderMultiPass(ctx, msg);

      // Every batch per band, into a target of its own; only the first draw clears the depth.
      expect(renderer.renderMembers.mock.calls.map((call) => [call[1], call[2], call[6], call[9]])).toEqual([
        [[0], targets[0], true, { y: 8, height: 12, first: true }],
        [[1], targets[1], false, { y: 8, height: 12, first: true }],
        [[0], targets[0], false, { y: 20, height: 12, first: false }],
        [[1], targets[1], false, { y: 20, height: 12, first: false }],
        [[0], targets[0], false, { y: 32, height: 12, first: false }],
        [[1], targets[1], false, { y: 32, height: 12, first: false }],
        [[0], targets[0], false, { y: 44, height: 12, first: false }],
        [[1], targets[1], false, { y: 44, height: 12, first: false }],
      ]);
      const submits = vi.mocked(device.queue.submit).mock.invocationCallOrder;
      expect(submits).toHaveLength(5);
      // The canvas is taken after the bands' last submit, then each batch is composited from its target.
      expect(getCurrentTexture.mock.invocationCallOrder[0]).toBeGreaterThan(submits[3]);
      expect(composite.mock.calls.map((call) => [call[1][0].view, call[3]])).toEqual([[targets[0], true], [targets[1], false]]);
      expect(capture).toHaveBeenCalledOnce();
    });

    it("stops between bands once the page gives the frame up, and presents nothing", async () => {
      const { renderer, composite, ctx, msg, getCurrentTexture } = bandedFrame((state) => {
        state.abandonedFrameSeq = 7;
      });
      const capture = vi.mocked(captureRenderedFrame);
      capture.mockClear();

      await handleVolumeRenderMultiPass(ctx, msg);

      expect(renderer.renderMembers).toHaveBeenCalledTimes(2);
      expect(getCurrentTexture).not.toHaveBeenCalled();
      expect(composite).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      // The minimap and thumbnails draw with this renderer, at full quality.
      expect(renderer.setMarchStepScale.mock.calls.at(-1)).toEqual([1]);
    });

    it("draws a frame with a label layer whole", async () => {
      const { renderer, ctx, msg } = bandedFrame();
      ctx.state.labelVolumePools.set(labelVolumePoolKey("labels", 0), {} as never);
      // The stand-in label pool cannot draw; the batches before it already have.
      await handleVolumeRenderMultiPass(ctx, {
        ...msg,
        layers: [...msg.layers, { ...msg.layers[0], datasetId: "labels", isLabel: true, labelChunk: { level: 0, t: 0 } }],
      }).catch(() => {});
      expect(renderer.renderMembers.mock.calls.map((call) => call[9])).toEqual([undefined, undefined]);
    });
  });

  it("draws side-by-side members a channel to a pass and a composite, all in one submit", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const stub = { device, state } as unknown as WorkerCtx;
    const pool = withView(getOrCreateVolumePool(stub, "ds-0:16x16x16:coarse", "ds-0", 16, 16, 16, 0, "u16"));
    viewOf(pool).dirty = false;
    // Three members side by side, each shown in two channels.
    const members = ["a0", "a1", "b0", "b1", "c0", "c1"];
    for (const id of members) {
      viewOf(pool).entityMetas.set(id, [{
        level: 2, gridDims: [1, 1, 1], chunkDims: [16, 16, 16], levelDims: [16, 16, 16], offset: 0,
      }]);
    }
    const descIndex = makeDescIndex(members, {
      sourceBindingByMember: bindings(Object.fromEntries(
        members.map((id) => [id, { levelPoolKeys: [], coarsePoolKey: "ds-0:16x16x16:coarse" }]),
      )),
    });
    const ctx = makeCtx({ device, state, renderer, composite, descIndex });
    const column = (i: number): [number, number, number, number] => [Math.floor(i / 2) * 21, 0, 20, 64];

    await handleVolumeRenderMultiPass(ctx, msgFor(members.map((memberId, i) => ({
      memberId,
      entityIndex: i,
      blendMode: "additive" as const,
      scissorRect: column(i),
    }))));

    expect(renderer.prepareMembers).toHaveBeenCalledOnce();
    expect(preparedDraws(renderer).map((d) => d.scissor)).toEqual(members.map((_, i) => column(i)));
    expect(renderer.renderMembers.mock.calls.map((call) => [call[1], call[6]])).toEqual([
      [[0, 2, 4], true],
      [[1, 3, 5], false],
    ]);
    expect(composite.mock.calls.map((call) => [call[1][0].blendMode, call[3]])).toEqual([
      ["additive", true],
      ["additive", false],
    ]);
    expect(device.queue.submit).toHaveBeenCalledOnce();
  });
});
