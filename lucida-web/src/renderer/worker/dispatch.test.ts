import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerCtx } from "../workerContext.ts";
import type { FrameCapturedMessage, WorkerToMainMessage } from "../workerProtocol.ts";
import { FRAME_CAPTURE_WAIT_MS, captureRenderedFrame, paddedBytesPerRow } from "./captureFrame.ts";
import { createInitialState } from "./state.ts";
import { dispatchMessage } from "./dispatch.ts";

function makeCtx(): {
  ctx: WorkerCtx;
  posts: WorkerToMainMessage[];
  wantedSetPosts: number;
} {
  const posts: WorkerToMainMessage[] = [];
  const counters = { wantedSet: 0 };
  const ctx = {
    state: createInitialState(),
    post(msg: WorkerToMainMessage) { posts.push(msg); },
    postWantedSet() { counters.wantedSet++; },
  } as unknown as WorkerCtx;
  return {
    ctx,
    posts,
    get wantedSetPosts() { return counters.wantedSet; },
  };
}

describe("worker dispatch upload feedback", () => {
  it("requeues slice chunks when no pool is registered for the member", async () => {
    const { ctx, posts } = makeCtx();

    await dispatchMessage(ctx, {
      type: "sliceChunkData",
      tier: "detail",
      memberId: "img-0:ch1",
      chunks: [{ data: new ArrayBuffer(8), dataType: "uint16", x: 0, y: 0, z: 0, key: "0/0/1/0/0/0" }],
      level: 0,
      z: 0,
      t: 0,
      c: 1,
      levelWidth: 1,
      levelHeight: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      fullResDepth: 1,
      levelDepth: 1,
      fullResZ: 0,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        memberId: "img-0:ch1",
        keys: ["0/0/1/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("requeues volume chunks when no pool is registered for the member", async () => {
    const { ctx, posts } = makeCtx();

    await dispatchMessage(ctx, {
      type: "volumeChunkData",
      tier: "detail",
      memberId: "img-0",
      chunks: [{ data: new ArrayBuffer(8), dataType: "uint16", x: 0, y: 0, z: 0, key: "0/0/0/0/0/0" }],
      level: 0,
      t: 0,
      c: 0,
      levelWidth: 1,
      levelHeight: 1,
      levelDepth: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        memberId: "img-0",
        keys: ["0/0/0/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("does not route coarse chunk uploads through the detail pool fallback", async () => {
    const { ctx, posts } = makeCtx();
    ctx.state.memberSourcePools.set("img-0", new Map([["detail:2", "detail-pool"]]));
    ctx.state.volumeAtlases.set("detail-pool", {
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      entityMetas: new Map(),
    } as never);

    await dispatchMessage(ctx, {
      type: "volumeChunkData",
      tier: "coarse",
      memberId: "img-0",
      chunks: [{ data: new ArrayBuffer(8), dataType: "uint16", x: 0, y: 0, z: 0, key: "2/0/0/0/0/0" }],
      level: 2,
      t: 0,
      c: 0,
      levelWidth: 1,
      levelHeight: 1,
      levelDepth: 1,
      chunkX: 1,
      chunkY: 1,
      chunkZ: 1,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([
      {
        type: "chunksEvicted",
        memberId: "img-0",
        keys: ["2/0/0/0/0/0"],
        skipped: [],
        reason: "missing-pool",
      },
    ]);
  });

  it("routes a detail upload by its level, not just its tier", async () => {
    // Level 0 and level 2 of one member live in different detail pools
    // (their chunk shapes differ). A level-2 upload must reach level 2's
    // pool, and a level with no section is requeued as missing-pool.
    const { ctx, posts } = makeCtx();
    ctx.state.memberSourcePools.set("img-0", new Map([
      ["detail:0", "fine-pool"],
      ["detail:2", "small-chunk-pool"],
    ]));
    ctx.state.volumeAtlases.set("fine-pool", {
      chunkX: 32, chunkY: 32, chunkZ: 32,
      entityMetas: new Map([["img-0", [{ level: 0, gridDims: [1, 1, 1], chunkDims: [32, 32, 32], levelDims: [32, 32, 32], offset: 0 }]]]),
    } as never);
    const smallChunkPool = {
      chunkX: 8, chunkY: 8, chunkZ: 8,
      slots: new Map<string, number>(),
      slotGridIdx: new Int32Array(1).fill(-1),
      freeSlots: [0],
      totalSlots: 1,
      slotsX: 1, slotsY: 1, slotsZ: 1,
      indirectionData: new Uint32Array(1).fill(0xffffffff),
      indirectionBuf: {} as GPUBuffer,
      texture: {} as GPUTexture,
      entityMetas: new Map([["img-0", [{ level: 2, gridDims: [1, 1, 1], chunkDims: [8, 8, 8], levelDims: [8, 8, 8], offset: 0 }]]]),
      t: 0, c: 0,
      intensityMin: 65535, intensityMax: 0,
      indirectionDirty: false,
    };
    ctx.state.volumeAtlases.set("small-chunk-pool", smallChunkPool as never);
    (ctx as unknown as { device: unknown }).device = { queue: { writeTexture() {}, writeBuffer() {} } };

    const upload = (level: number, chunk: number) => dispatchMessage(ctx, {
      type: "volumeChunkData",
      tier: "detail",
      memberId: "img-0",
      chunks: [{ data: new Uint16Array(chunk * chunk * chunk).buffer, dataType: "uint16", x: 0, y: 0, z: 0, key: `${level}/0/0/0/0/0` }],
      level,
      t: 0,
      c: 0,
      levelWidth: chunk,
      levelHeight: chunk,
      levelDepth: chunk,
      chunkX: chunk,
      chunkY: chunk,
      chunkZ: chunk,
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
    });

    await upload(2, 8);
    expect(smallChunkPool.slots.has("img-0|2/0/0/0/0/0")).toBe(true);

    await upload(1, 16);
    // The first upload also posts an intensity-range update; only the
    // feedback messages matter here.
    expect(posts.filter((p) => p.type === "chunksEvicted")).toEqual([
      expect.objectContaining({ type: "chunksEvicted", memberId: "img-0", keys: ["1/0/0/0/0/0"], reason: "missing-pool" }),
    ]);
  });

  it("treats a selection scrub for an un-ingested dataset as a safe no-op", async () => {
    // A scrub patch can race ahead of the dataset's first full cold state
    // (nothing retained yet). It must not touch GPU state or throw — the
    // following full cold state carries the selection itself — but it still
    // posts the wanted set, matching the full cold-state path.
    const harness = makeCtx();
    const { ctx, posts } = harness;

    await dispatchMessage(ctx, {
      type: "coldStateSelection",
      datasetId: "ds-not-yet-ingested",
      currentT: 7,
      currentZ: 2,
      visibleRegion: {
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [2, 3],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      desiredProxyKeys: [],
      epochs: { content: 1, layout: 1, view: 1, selection: 2, asset: 0, request: 1 },
    });

    expect(posts).toEqual([]);
    expect(ctx.state.coldStateByDataset.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
    expect(harness.wantedSetPosts).toBe(1);
  });

  it("treats a view-move delta for an un-ingested dataset as a safe no-op", async () => {
    // A delta can race ahead of the dataset's first full cold state. It must not
    // touch GPU state or throw, but still posts the wanted set (matching the
    // full path).
    const harness = makeCtx();
    const { ctx, posts } = harness;

    await dispatchMessage(ctx, {
      type: "coldStateDelta",
      datasetId: "ds-not-yet-ingested",
      currentT: 0,
      currentZ: 0,
      visibleRegion: {
        xyBoundsVox: [0, 0, 1024, 1024],
        zRangeVox: [0, 1],
        effectiveZoom: 1,
        sortCenterVox: null,
        frustumPlanes: null,
      },
      desiredProxyKeys: [],
      removedEntityIds: [],
      upserts: [],
      activeSetOrder: [],
      epochs: { content: 1, layout: 1, view: 2, selection: 1, asset: 0, request: 1 },
    });

    expect(posts).toEqual([]);
    expect(ctx.state.coldStateByDataset.size).toBe(0);
    expect(ctx.state.currentColdState).toBeNull();
    expect(harness.wantedSetPosts).toBe(1);
  });
});

// The frame capture reads these when it copies a frame out, and node has neither.
(globalThis as Record<string, unknown>).GPUBufferUsage = { MAP_READ: 0x01, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUMapMode = { READ: 0x01 };

const encoded: { imageData: FakeImageData | null; png: Uint8Array<ArrayBuffer> } = {
  imageData: null,
  png: new Uint8Array(),
};

class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

/** Node has no canvas, so the 2D encoder gets one that records what it was given. */
class FakeOffscreenCanvas {
  constructor(_width: number, _height: number) {}
  getContext() {
    return { putImageData: (imageData: FakeImageData) => { encoded.imageData = imageData; } };
  }
  convertToBlob() {
    return Promise.resolve(new Blob([encoded.png], { type: "image/png" }));
  }
}
(globalThis as Record<string, unknown>).ImageData = FakeImageData;
(globalThis as Record<string, unknown>).OffscreenCanvas = FakeOffscreenCanvas;

describe("worker dispatch frame capture", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const WIDTH = 3;
  const HEIGHT = 2;
  /** Three pixels a row is 12 bytes, and the copy pads every row to the 256-byte alignment. */
  const BYTES_PER_ROW = 256;

  interface Post { msg: WorkerToMainMessage; transfer: Transferable[] | undefined }

  interface Gpu {
    ctx: WorkerCtx;
    posts: Post[];
    convertToBlob: ReturnType<typeof vi.fn>;
    copyTextureToBuffer: ReturnType<typeof vi.fn>;
    pushErrorScope: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    buffer: { mapAsync: ReturnType<typeof vi.fn>; unmap: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    texture: GPUTexture;
  }

  /** The canvas's rows as the GPU would hand them back: BGRA, padded, with an alpha the shader wrote. */
  function paddedRows(): Uint8Array {
    const rows = new Uint8Array(BYTES_PER_ROW * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const at = y * BYTES_PER_ROW + x * 4;
        rows[at] = 10 * (y * WIDTH + x); // blue
        rows[at + 1] = 100; // green
        rows[at + 2] = 200 + x; // red
        rows[at + 3] = 7; // alpha, not what the opaque canvas shows
      }
    }
    return rows;
  }

  function makeGpu(
    options: {
      mapAsync?: () => Promise<void>;
      popErrorScope?: () => Promise<{ message: string } | null>;
      convertToBlob?: () => Promise<Blob>;
    } = {},
  ): Gpu {
    const posts: Post[] = [];
    const rows = paddedRows();
    const buffer = {
      mapAsync: vi.fn(options.mapAsync ?? (() => Promise.resolve())),
      getMappedRange: () => rows.buffer,
      unmap: vi.fn(),
      destroy: vi.fn(),
    };
    const copyTextureToBuffer = vi.fn();
    const pushErrorScope = vi.fn();
    const submit = vi.fn();
    const convertToBlob = vi.fn(
      options.convertToBlob ?? (() => Promise.resolve(new Blob([PNG], { type: "image/png" }))),
    );
    const texture = { width: WIDTH, height: HEIGHT } as GPUTexture;
    const ctx = {
      state: createInitialState(),
      format: "bgra8unorm",
      device: {
        createBuffer: vi.fn(() => buffer),
        createCommandEncoder: () => ({ copyTextureToBuffer, finish: () => "commands" }),
        pushErrorScope,
        popErrorScope: vi.fn(options.popErrorScope ?? (() => Promise.resolve(null))),
        queue: { submit },
      },
      context: { canvas: { width: 2880, height: 1800, convertToBlob } },
      post(msg: WorkerToMainMessage, transfer?: Transferable[]) { posts.push({ msg, transfer }); },
    } as unknown as WorkerCtx;
    return { ctx, posts, convertToBlob, copyTextureToBuffer, pushErrorScope, submit, buffer, texture };
  }

  function captured(post: Post): FrameCapturedMessage {
    if (post.msg.type !== "frameCaptured") throw new Error(`expected frameCaptured, got ${post.msg.type}`);
    return post.msg;
  }

  /** Run the read-back's awaits without reaching the fallback timer. */
  const settle = () => vi.advanceTimersByTimeAsync(1);

  beforeEach(() => {
    vi.useFakeTimers();
    encoded.imageData = null;
    encoded.png = PNG;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("arms the capture for the next frame instead of reading the canvas now", async () => {
    const gpu = makeGpu();

    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 7 });

    expect(gpu.posts).toEqual([]);
    expect(gpu.convertToBlob).not.toHaveBeenCalled();
    expect(gpu.ctx.state.frameCaptures.map((capture) => capture.id)).toEqual([7]);
  });

  it("takes the next frame from inside it: copies the canvas texture out, packs the rows as opaque RGBA, and answers every waiter", async () => {
    const gpu = makeGpu();
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 7 });
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 8 });

    captureRenderedFrame(gpu.ctx, gpu.texture);

    // The copy is on the queue before the handler returns, while the texture is still current.
    expect(gpu.copyTextureToBuffer).toHaveBeenCalledWith(
      { texture: gpu.texture },
      { buffer: gpu.buffer, bytesPerRow: BYTES_PER_ROW },
      [WIDTH, HEIGHT],
    );
    expect(gpu.submit).toHaveBeenCalledWith(["commands"]);
    expect(gpu.pushErrorScope).toHaveBeenCalledWith("validation");
    expect(gpu.ctx.state.frameCaptures).toEqual([]);

    await settle();

    const { data: pixels, width, height } = encoded.imageData!;
    expect([width, height]).toEqual([WIDTH, HEIGHT]);
    expect(pixels).toHaveLength(WIDTH * HEIGHT * 4);
    expect(Array.from(pixels.subarray(0, 8))).toEqual([200, 100, 0, 255, 201, 100, 10, 255]);
    expect(Array.from(pixels.subarray(WIDTH * 4, WIDTH * 4 + 4))).toEqual([200, 100, 30, 255]);
    expect(gpu.buffer.unmap).toHaveBeenCalledOnce();
    expect(gpu.buffer.destroy).toHaveBeenCalledOnce();

    expect(gpu.posts).toHaveLength(2);
    const [first, second] = gpu.posts;
    expect(captured(first)).toMatchObject({ id: 7, width: WIDTH, height: HEIGHT, failure: null });
    expect(captured(second)).toMatchObject({ id: 8, width: WIDTH, height: HEIGHT, failure: null });
    expect(new Uint8Array(captured(first).png!)).toEqual(PNG);
    expect(new Uint8Array(captured(second).png!)).toEqual(PNG);
    // Each waiter's bytes are transferred, so two waiters get two buffers.
    expect(first.transfer).toEqual([captured(first).png]);
    expect(second.transfer).toEqual([captured(second).png]);
    expect(captured(first).png).not.toBe(captured(second).png);

    // The fallback timers were cleared with the captures, so the wait passing answers nothing again.
    await vi.advanceTimersByTimeAsync(FRAME_CAPTURE_WAIT_MS);
    expect(gpu.posts).toHaveLength(2);
    expect(gpu.convertToBlob).not.toHaveBeenCalled();
  });

  it("a frame with no capture armed pays nothing", () => {
    const gpu = makeGpu();
    captureRenderedFrame(gpu.ctx, gpu.texture);
    expect(gpu.copyTextureToBuffer).not.toHaveBeenCalled();
    expect(gpu.submit).not.toHaveBeenCalled();
  });

  it("a read-back that fails answers with the error's name and message, so the bundle can say why", async () => {
    const gpu = makeGpu({
      mapAsync: () => Promise.reject(new DOMException("the device was lost", "OperationError")),
    });
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 9 });

    captureRenderedFrame(gpu.ctx, gpu.texture);
    await settle();

    expect(gpu.posts).toEqual([
      {
        msg: {
          type: "frameCaptured",
          id: 9,
          png: null,
          width: WIDTH,
          height: HEIGHT,
          failure: { name: "OperationError", message: "the device was lost" },
        },
        transfer: undefined,
      },
    ]);
    expect(gpu.buffer.destroy).toHaveBeenCalledOnce();
  });

  it("a copy the device refuses is named rather than pictured as a black frame", async () => {
    const gpu = makeGpu({
      popErrorScope: () => Promise.resolve({ message: "the texture's usage does not include CopySrc" }),
    });
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 13 });

    captureRenderedFrame(gpu.ctx, gpu.texture);
    await settle();

    expect(encoded.imageData).toBeNull();
    expect(captured(gpu.posts[0]).failure).toEqual({
      name: "GPUValidationError",
      message: "the texture's usage does not include CopySrc",
    });
    expect(gpu.buffer.destroy).toHaveBeenCalledOnce();
  });

  it("a canvas format the capture cannot unpack is refused by name rather than read wrong", async () => {
    const gpu = makeGpu();
    (gpu.ctx as { format: string }).format = "rgba16float";
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 10 });

    captureRenderedFrame(gpu.ctx, gpu.texture);
    await settle();

    expect(captured(gpu.posts[0]).failure).toEqual({
      name: "Error",
      message: "the canvas format rgba16float is not one the frame capture reads",
    });
    expect(gpu.copyTextureToBuffer).not.toHaveBeenCalled();
  });

  it("a capture no frame reaches within the wait reads the canvas as presented", async () => {
    const gpu = makeGpu();
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 11 });

    await vi.advanceTimersByTimeAsync(FRAME_CAPTURE_WAIT_MS - 1);
    expect(gpu.posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(gpu.convertToBlob).toHaveBeenCalledWith({ type: "image/png" });
    expect(gpu.posts).toHaveLength(1);
    const post = gpu.posts[0];
    expect(captured(post)).toMatchObject({ id: 11, width: 2880, height: 1800, failure: null });
    expect(new Uint8Array(captured(post).png!)).toEqual(PNG);
    expect(post.transfer).toEqual([captured(post).png]);
    expect(gpu.ctx.state.frameCaptures).toEqual([]);
  });

  it("names what refused the presented read, and that no frame came, when the fallback fails too", async () => {
    const gpu = makeGpu({
      convertToBlob: () => Promise.reject(new DOMException("The canvas has no image", "InvalidStateError")),
    });
    await dispatchMessage(gpu.ctx, { type: "captureFrame", id: 12 });

    await vi.advanceTimersByTimeAsync(FRAME_CAPTURE_WAIT_MS);

    expect(gpu.posts).toEqual([
      {
        msg: {
          type: "frameCaptured",
          id: 12,
          png: null,
          width: 2880,
          height: 1800,
          failure: {
            name: "InvalidStateError",
            message:
              "no frame was rendered within 1000 ms, and reading the canvas as presented failed: The canvas has no image",
          },
        },
        transfer: undefined,
      },
    ]);
  });

  it("pads a copy's rows to the 256-byte alignment", () => {
    expect(paddedBytesPerRow(3)).toBe(256);
    expect(paddedBytesPerRow(1440)).toBe(5888);
    expect(paddedBytesPerRow(2880)).toBe(11520);
  });
});
