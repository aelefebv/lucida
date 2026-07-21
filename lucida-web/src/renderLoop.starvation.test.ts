import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest } from "./manifestTypes.ts";
import {
  INITIAL_RENDER_PIXEL_BUDGET,
  INITIAL_VOLUME_RENDER_PIXEL_BUDGET,
  RenderLoop,
} from "./renderLoop.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { Session } from "./session.ts";

function makeLoop(
  width = 800,
  height = 600,
  mode: "slice" | "volume" = "slice",
) {
  const expectNextMainFrame = vi.fn(() => 1);
  const cancelUnsubmittedFrameExpectations = vi.fn();
  const resize = vi.fn(() => false);
  const sliceRenderMultiPass = vi.fn();
  const volumeRenderMultiPass = vi.fn();
  let presented: ((frame: {
    frameId: number;
    receivedAt: number;
    contentPresented?: boolean;
  }) => void) | null = null;
  let lastPresented: ((frame: {
    frameId: number;
    receivedAt: number;
    contentPresented?: boolean;
  }) => void) | null = null;
  const client = {
    expectNextMainFrame,
    cancelUnsubmittedFrameExpectations,
    resize,
    sliceRenderMultiPass,
    volumeRenderMultiPass,
    getRuntimeSnapshot: vi.fn(() => ({
      frames: {
        posted: 0,
        presented: 0,
        pending: 0,
        lastPostedFrameId: null,
        lastPresentedFrameId: null,
      },
      worker: { messages: 1, lastMessageType: "ready", lastMessageAt: 0 },
      surface: {
        maxDimension: 8192,
        attempts: 0,
        forwarded: 0,
        suppressed: 0,
        byMode: {
          slice: { attempts: 0, forwarded: 0, suppressed: 0 },
          volume: { attempts: 0, forwarded: 0, suppressed: 0 },
          unspecified: { attempts: 0, forwarded: 0, suppressed: 0 },
        },
        lastAttempt: null,
        lastForwarded: null,
        lastSuppressed: null,
      },
    })),
    onChunksEvicted: null,
    onWantedSetDelta: null,
    onAggregateCacheMiss: null,
    subscribeFramePresented: vi.fn((listener: (frame: {
      frameId: number;
      receivedAt: number;
      contentPresented?: boolean;
    }) => void) => {
      presented = listener;
      lastPresented = listener;
      return () => { presented = null; };
    }),
  } as unknown as RenderClient;
  const session = {
    cpuCache: { subscribe: vi.fn(() => vi.fn()) },
    scene: {
      epochs: () => JSON.stringify({ content: 0, layout: 0, view: 0, selection: 0, request: 0 }),
      t: () => 0,
      c: () => 0,
      z: () => 0,
      set_t: vi.fn(),
      set_c: vi.fn(),
      set_z: vi.fn(),
      multi_channel: () => false,
      contrast_min: () => 0,
      contrast_max: () => 1,
      center: () => [0, 0],
      zoom: () => 1,
      set_viewport: vi.fn(),
      eye_position: () => [0, 0, 1],
      inv_view_proj: () => new Float32Array(16),
      view_proj: () => new Float32Array(16),
      camera_forward: () => [0, 0, -1],
      clip_distance: () => 0,
      clip_mode: () => "plane",
      dataset_order: () => JSON.stringify(["dataset-1"]),
      all_dataset_settings: () => JSON.stringify({}),
    },
  } as unknown as Session;
  const canvas = { clientWidth: width, clientHeight: height } as HTMLCanvasElement;
  const datasets = new Map([
    ["dataset-1", { manifest: {
      dataset_id: "dataset-1",
      name: "dataset-1",
      kind: "Single",
      entities: [],
      transforms: [],
      images: [],
      source_layouts: [],
      default_layout_id: null,
    } satisfies DatasetManifest }],
  ]);

  return {
    loop: new RenderLoop({ session, datasets, client, canvas, mode }),
    expectNextMainFrame,
    cancelUnsubmittedFrameExpectations,
    resize,
    sliceRenderMultiPass,
    volumeRenderMultiPass,
    canvas,
    client,
    present: (frameId: number, contentPresented: boolean = false) => presented?.({
      frameId,
      receivedAt: performance.now(),
      contentPresented,
    }),
    presentAfterUnsubscribe: (frameId: number, contentPresented: boolean = false) => lastPresented?.({
      frameId,
      receivedAt: performance.now(),
      contentPresented,
    }),
  };
}

function makeVolumeRenderable(loop: RenderLoop): void {
  const internals = loop as unknown as {
    tickCoordinator: {
      planAndFetch: ReturnType<typeof vi.fn>;
      hasPendingRebuild: ReturnType<typeof vi.fn>;
    };
    uploader: { deliverToWorker: ReturnType<typeof vi.fn> };
  };
  internals.tickCoordinator.planAndFetch = vi.fn(() => ({
    memberRoster: new Map(),
    memberPositionsByDataset: new Map(),
    settings: { layerOrder: [], allSettings: {} },
    multiChannel: false,
    epochs: { content: 0, layout: 0, view: 0, selection: 0, request: 0 },
    entityIndexByDataset: new Map(),
  }));
  internals.tickCoordinator.hasPendingRebuild = vi.fn(() => false);
  internals.uploader.deliverToWorker = vi.fn(() => false);
}

describe("RenderLoop frame-starvation boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("arms presentation liveness when residency becomes dirty before RAF", () => {
    const { loop, expectNextMainFrame } = makeLoop();

    loop.markResidencyDirty("chunk_arrived");

    expect(expectNextMainFrame).toHaveBeenCalledOnce();
    loop.stop();
  });

  it("does not arm while a collapsed canvas cannot render", () => {
    const {
      loop,
      expectNextMainFrame,
      cancelUnsubmittedFrameExpectations,
    } = makeLoop(0, 0);

    loop.markResidencyDirty("hidden_panel");

    expect(expectNextMainFrame).not.toHaveBeenCalled();
    loop.stop();
    expect(cancelUnsubmittedFrameExpectations).toHaveBeenCalledOnce();
  });

  it("joins worker residency with the correlated presented frame", () => {
    const { loop, client, present } = makeLoop();
    loop.start();

    expect(loop.getViewportLoadingState().phase).toBe("evaluating");
    client.onWantedSetDelta?.(
      "dataset-1",
      { content: 0, layout: 0, view: 0, selection: 0, request: 0 },
      [],
    );
    expect(loop.getViewportLoadingState()).toMatchObject({
      phase: "evaluating",
      missingChunks: 0,
    });

    present(1, true);
    expect(loop.getViewportLoadingState().phase).toBe("idle");
    loop.stop();
  });

  it("schedules a replacement frame after a recoverable aggregate cache miss", () => {
    const { loop, client, expectNextMainFrame } = makeLoop();
    loop.start();
    expectNextMainFrame.mockClear();

    client.onAggregateCacheMiss?.({
      type: "aggregateCacheMiss",
      frameId: 1,
      cacheKey: "aggregate-1",
      cacheOwnerKey: "dataset-1|single",
      ownerDatasetId: "dataset-1",
    });

    expect(expectNextMainFrame).toHaveBeenCalledOnce();
    loop.stop();
    expect(client.onAggregateCacheMiss).toBeNull();
  });

  it("presents a coarse DPR2 volume frame before one full-resolution refinement", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, volumeRenderMultiPass, present } = makeLoop(800, 600, "volume");
    makeVolumeRenderable(loop);

    loop.start();
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(0);
    expect(volumeRenderMultiPass).toHaveBeenCalledTimes(1);
    const [coarseWidth, coarseHeight, fullWidth, fullHeight] =
      volumeRenderMultiPass.mock.calls[0].slice(3, 7) as number[];
    expect(fullWidth).toBe(1600);
    expect(fullHeight).toBe(1200);
    expect(coarseWidth).toBeGreaterThan(0);
    expect(coarseHeight).toBeGreaterThan(0);
    expect(coarseWidth).toBeLessThan(fullWidth);
    expect(coarseHeight).toBeLessThan(fullHeight);
    expect(coarseWidth * coarseHeight).toBeLessThanOrEqual(
      INITIAL_VOLUME_RENDER_PIXEL_BUDGET,
    );
    expect(frameCallbacks).toHaveLength(0);

    present(1, true);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(1);
    expect(volumeRenderMultiPass).toHaveBeenCalledTimes(2);
    expect(volumeRenderMultiPass.mock.calls[1].slice(3, 7)).toEqual([
      1600, 1200, 1600, 1200,
    ]);

    present(2, true);
    expect(frameCallbacks).toHaveLength(0);
    expect(volumeRenderMultiPass).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("keeps the bootstrap cap through clear-only presentations", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, volumeRenderMultiPass, present } = makeLoop(800, 600, "volume");
    makeVolumeRenderable(loop);

    loop.start();
    frameCallbacks.shift()!(0);
    const first = volumeRenderMultiPass.mock.calls[0].slice(3, 7) as number[];
    expect(first[0] * first[1]).toBeLessThanOrEqual(
      INITIAL_VOLUME_RENDER_PIXEL_BUDGET,
    );

    present(1, false);
    expect(frameCallbacks).toHaveLength(0);

    loop.setRenderScale(1);
    frameCallbacks.shift()!(1);
    const second = volumeRenderMultiPass.mock.calls[1].slice(3, 7) as number[];
    expect(second[0] * second[1]).toBeLessThanOrEqual(
      INITIAL_VOLUME_RENDER_PIXEL_BUDGET,
    );

    present(2, true);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(2);
    expect(volumeRenderMultiPass.mock.calls[2].slice(3, 7)).toEqual([
      1600, 1200, 1600, 1200,
    ]);
    loop.stop();
  });

  it("caps interaction that arrives before the first volume RAF", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, volumeRenderMultiPass, present } = makeLoop(2560, 1440, "volume");
    makeVolumeRenderable(loop);

    loop.start();
    loop.setRenderScale(0.5);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(0);
    const initial = volumeRenderMultiPass.mock.calls[0].slice(3, 7) as number[];
    expect(initial[0] * initial[1]).toBeLessThanOrEqual(
      INITIAL_VOLUME_RENDER_PIXEL_BUDGET,
    );

    present(1, true);
    expect(frameCallbacks).toHaveLength(0);

    loop.setRenderScale(1);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(1);
    expect(volumeRenderMultiPass.mock.calls[1].slice(3, 7)).toEqual([
      5120, 2880, 5120, 2880,
    ]);
    loop.stop();
  });

  it("lets interaction override a pending volume refinement", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, volumeRenderMultiPass, present } = makeLoop(800, 600, "volume");
    makeVolumeRenderable(loop);

    loop.start();
    frameCallbacks.shift()!(0);
    loop.setRenderScale(0.25);
    present(1, true);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(1);
    expect(volumeRenderMultiPass.mock.calls[1].slice(3, 7)).toEqual([
      400, 300, 1600, 1200,
    ]);

    present(2, true);
    expect(frameCallbacks).toHaveLength(0);
    expect(volumeRenderMultiPass).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("ignores an earlier frame acknowledgement from before the volume loop", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, expectNextMainFrame, volumeRenderMultiPass, present } =
      makeLoop(800, 600, "volume");
    expectNextMainFrame.mockReturnValue(2);
    makeVolumeRenderable(loop);

    loop.start();
    frameCallbacks.shift()!(0);
    present(1, true);
    expect(frameCallbacks).toHaveLength(0);

    present(2, true);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(1);
    expect(volumeRenderMultiPass.mock.calls[1].slice(3, 7)).toEqual([
      1600, 1200, 1600, 1200,
    ]);
    loop.stop();
  });

  it("does not refine a stopped volume loop from a late presentation", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, presentAfterUnsubscribe } = makeLoop(800, 600, "volume");
    makeVolumeRenderable(loop);

    loop.start();
    frameCallbacks.shift()!(0);
    loop.stop();
    presentAfterUnsubscribe(1, true);

    expect(frameCallbacks).toHaveLength(0);
  });

  it("presents a coarse DPR2 slice frame before one full-resolution refinement", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, sliceRenderMultiPass, present } = makeLoop(800, 600, "slice");
    makeVolumeRenderable(loop);

    loop.start();
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(0);
    expect(sliceRenderMultiPass).toHaveBeenCalledTimes(1);
    const coarse = sliceRenderMultiPass.mock.calls[0];
    expect(coarse[4] * coarse[5]).toBeLessThanOrEqual(INITIAL_RENDER_PIXEL_BUDGET);
    expect(coarse.slice(4, 6)).not.toEqual([1600, 1200]);
    expect(coarse[4] / coarse[1]).toBeCloseTo(800, 0);

    present(1, false);
    expect(frameCallbacks).toHaveLength(0);

    loop.setRenderScale(1);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(1);
    expect(sliceRenderMultiPass).toHaveBeenCalledTimes(2);
    expect(sliceRenderMultiPass.mock.calls[1].slice(4, 6)).toEqual(coarse.slice(4, 6));

    present(1, true);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()!(2);
    expect(sliceRenderMultiPass).toHaveBeenCalledTimes(3);
    expect(sliceRenderMultiPass.mock.calls[2].slice(4, 6)).toEqual([1600, 1200]);

    present(2, true);
    expect(frameCallbacks).toHaveLength(0);
    loop.stop();
  });

  it("starts a DPR1 volume at full resolution when it fits the pixel budget", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    const { loop, present, volumeRenderMultiPass } = makeLoop(640, 640, "volume");
    makeVolumeRenderable(loop);
    const context = (loop as unknown as { buildContext(): { renderScale: number } })
      .buildContext();

    expect(640 * 640).toBeLessThan(INITIAL_VOLUME_RENDER_PIXEL_BUDGET);
    expect(context.renderScale).toBe(1);
    loop.start();
    frameCallbacks.shift()!(0);
    expect(volumeRenderMultiPass.mock.calls[0].slice(3, 7)).toEqual([
      640, 640, 640, 640,
    ]);
    present(1, true);
    expect(frameCallbacks).toHaveLength(0);
    loop.stop();
  });

  it.each(["slice", "volume"] as const)(
    "records an initial 0×0 %s mount before ResizeObserver restores scheduling",
    (mode) => {
      let frameCallback: FrameRequestCallback | null = null;
      let resizeCallback: ResizeObserverCallback | null = null;
      const requestFrame = vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        return 1;
      });
      vi.stubGlobal("requestAnimationFrame", requestFrame);
      vi.stubGlobal("ResizeObserver", class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        disconnect() {}
      });
      const { loop, expectNextMainFrame, resize, canvas } = makeLoop(0, 0, mode);

      loop.start();
      expect(frameCallback).not.toBeNull();
      (frameCallback as unknown as FrameRequestCallback)(0);
      expect(resize).toHaveBeenCalledWith(0, 0, mode);
      expect(expectNextMainFrame).not.toHaveBeenCalled();
      expect(requestFrame).toHaveBeenCalledTimes(1);

      Object.assign(canvas, { clientWidth: 320, clientHeight: 200 });
      expect(resizeCallback).not.toBeNull();
      (resizeCallback as unknown as ResizeObserverCallback)([], {} as ResizeObserver);
      expect(expectNextMainFrame).toHaveBeenCalledOnce();
      expect(requestFrame).toHaveBeenCalledTimes(2);
      loop.stop();
    },
  );

  it("publishes and removes a bounded mounted-renderer contract", () => {
    const { loop } = makeLoop(800, 600, "volume");
    vi.stubGlobal("window", {});
    loop.start();

    expect(window.__lucidaRenderContract).toMatchObject({ version: 1 });
    expect(window.__lucidaRenderContract?.getSnapshot()).toMatchObject({
      version: 1,
      mode: "volume",
      loop: {
        animationFramePending: true,
        interactiveDirty: true,
        residencyDirty: false,
      },
      client: {
        frames: { posted: 0, presented: 0, pending: 0 },
        worker: { messages: 1, lastMessageType: "ready" },
      },
      mainThread: {
        longTaskObserverSupported: expect.any(Boolean),
        longTaskCount: 0,
      },
    });

    loop.stop();
    expect(window.__lucidaRenderContract).toBeUndefined();
  });

  it("invalidates rendered capture readiness when the loop stops", () => {
    vi.stubGlobal("window", {});
    const { loop, present } = makeLoop();
    loop.start();

    present(1);
    expect(window.__lucidaCaptureReady).toMatchObject({
      ready: true,
      reason: "rendered",
      frameCount: 1,
    });

    loop.stop();
    expect(window.__lucidaCaptureReady).toMatchObject({
      ready: false,
      reason: "render_loop_stopped",
      frameCount: 1,
    });

    loop.start();
    expect(window.__lucidaCaptureReady?.ready).toBe(false);
    present(2);
    expect(window.__lucidaCaptureReady).toMatchObject({
      ready: true,
      reason: "rendered",
      frameCount: 2,
    });
    loop.stop();
  });

  it("does not let an older loop invalidate a replacement loop's readiness", () => {
    vi.stubGlobal("window", {});
    const old = makeLoop();
    old.loop.start();
    old.present(1);

    const replacement = makeLoop();
    replacement.loop.start();
    replacement.present(1);
    const replacementReady = window.__lucidaCaptureReady;

    // A delayed acknowledgement from the superseded loop must not combine its
    // stale capture metadata with the replacement's runtime contract.
    old.present(2);
    expect(window.__lucidaCaptureReady).toBe(replacementReady);

    old.loop.stop();
    expect(window.__lucidaCaptureReady).toBe(replacementReady);
    expect(window.__lucidaCaptureReady?.ready).toBe(true);

    replacement.loop.stop();
  });
});
