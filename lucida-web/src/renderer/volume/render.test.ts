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

import type { EntityDescriptorIndex, MemberSourceBinding } from "../descriptorBuffer.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { UNTIMED } from "../passTiming.ts";
import type { VolumeMemberDraw, VolumePoolBinding } from "../volumeRenderer.ts";
import type { VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
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

/** The binding the renderer receives for `atlas`. */
function bindingOf(atlas: AtlasState): VolumePoolBinding {
  return {
    texture: atlas.texture,
    indirectionBuf: atlas.indirectionBuf,
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
    canvasW: 64,
    canvasH: 64,
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

  it("does not advance first-layer state for skipped non-renderable layers", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const atlas = getOrCreateVolumePool(
      { device, state } as unknown as WorkerCtx,
      "pool-b",
      "ds-0",
      16,
      16,
      16,
      0,
      0,
      "u16",
    );
    atlas.entityMetas.set("img-b", [
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
    const coarseAtlas = getOrCreateVolumePool(
      { device, state } as unknown as WorkerCtx,
      "coarse-pool",
      "ds-0",
      64,
      64,
      16,
      0,
      0,
      "u16",
    );
    coarseAtlas.indirectionDirty = false;
    coarseAtlas.entityMetas.set("img-a", [
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
    const finePool = getOrCreateVolumePool(stub, "ds-0:32x32x32:detail", "ds-0", 32, 32, 32, 0, 0, "u16");
    const smallChunkPool = getOrCreateVolumePool(stub, "ds-0:16x16x16:detail", "ds-0", 16, 16, 16, 0, 0, "u16");
    const coarsePool = getOrCreateVolumePool(stub, "ds-0:16x16x16:coarse", "ds-0", 16, 16, 16, 0, 0, "u16");
    const meta = (level: number, chunk: number) => [{
      level,
      gridDims: [1, 1, 1] as [number, number, number],
      chunkDims: [chunk, chunk, chunk] as [number, number, number],
      levelDims: [chunk, chunk, chunk] as [number, number, number],
      offset: 0,
    }];
    finePool.entityMetas.set("img-a", meta(0, 32));
    smallChunkPool.entityMetas.set("img-a", meta(1, 16));
    coarsePool.entityMetas.set("img-a", meta(3, 16));
    finePool.indirectionDirty = true;
    smallChunkPool.indirectionDirty = true;
    coarsePool.indirectionDirty = true;

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
    expect(finePool.indirectionDirty).toBe(false);
    expect(smallChunkPool.indirectionDirty).toBe(false);
    expect(coarsePool.indirectionDirty).toBe(false);
  });

  it("draws side-by-side members a channel to a pass and a composite, all in one submit", async () => {
    const device = makeDevice();
    const renderer = makeRenderer();
    const composite = vi.fn();
    const state = createInitialState();
    const stub = { device, state } as unknown as WorkerCtx;
    const pool = getOrCreateVolumePool(stub, "ds-0:16x16x16:coarse", "ds-0", 16, 16, 16, 0, 0, "u16");
    pool.indirectionDirty = false;
    // Three members side by side, each shown in two channels.
    const members = ["a0", "a1", "b0", "b1", "c0", "c1"];
    for (const id of members) {
      pool.entityMetas.set(id, [{
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
