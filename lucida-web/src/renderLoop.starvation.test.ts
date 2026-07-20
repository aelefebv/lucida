import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest } from "./manifestTypes.ts";
import { RenderLoop } from "./renderLoop.ts";
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
  let presented: ((frame: { frameId: number; receivedAt: number }) => void) | null = null;
  const client = {
    expectNextMainFrame,
    cancelUnsubmittedFrameExpectations,
    resize,
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
    subscribeFramePresented: vi.fn((listener: (frame: { frameId: number; receivedAt: number }) => void) => {
      presented = listener;
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
      multi_channel: () => false,
      contrast_min: () => 0,
      contrast_max: () => 1,
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
    canvas,
    client,
    present: (frameId: number) => presented?.({ frameId, receivedAt: performance.now() }),
  };
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

    present(1);
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
      const { loop, resize, canvas } = makeLoop(0, 0, mode);

      loop.start();
      expect(frameCallback).not.toBeNull();
      (frameCallback as unknown as FrameRequestCallback)(0);
      expect(resize).toHaveBeenCalledWith(0, 0, mode);
      expect(requestFrame).toHaveBeenCalledTimes(1);

      Object.assign(canvas, { clientWidth: 320, clientHeight: 200 });
      expect(resizeCallback).not.toBeNull();
      (resizeCallback as unknown as ResizeObserverCallback)([], {} as ResizeObserver);
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
