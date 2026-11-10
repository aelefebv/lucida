// @vitest-environment happy-dom
/**
 * What the render loop draws a volume frame at on a GPU too slow for its
 * full-quality frames: a gesture starts low, the frame that shows input is
 * never the full-quality one, and input gives up a banded frame it would
 * wait behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

/** What each frame the loop dispatched was drawn at. */
const drawn: Array<{ renderScale: number; resolutionScale: number; marchStepScale: number; bands: number }> = [];
let dispatch: () => void = () => {};

vi.mock("./volumePath.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./volumePath.ts")>();
  return {
    ...actual,
    tickVolume: (ctx: import("./renderLoopTypes.ts").TickContext, _c: unknown, _u: unknown, _m: unknown, shouldRender: boolean) => {
      if (shouldRender) {
        drawn.push({ renderScale: ctx.renderScale, resolutionScale: ctx.resolutionScale, marchStepScale: ctx.marchStepScale, bands: ctx.bands });
        dispatch();
      }
      return false;
    },
  };
});

import { RenderLoop } from "./renderLoop.ts";
import { CpuCache } from "./pipeline/fetch/cpuCache.ts";
import type { ContentSource } from "./pipeline/fetch/contentSource.ts";
import type { DecodePool } from "./pipeline/fetch/decodePool.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { Session } from "./session.ts";
import { MAX_BANDS } from "./framePacing.ts";
import { MAX_MARCH_COARSENING, MIN_ADAPTIVE_SCALE, RESTORE_AFTER_MS } from "./renderResolution.ts";
import { INTERACTION_MARCH_STEP_SCALE } from "./volumePath.ts";

/**
 * A stand-in GPU whose frames finish when the test says. The loop's first
 * frame, which waits for the pipelines to compile, is drawn and finished.
 */
function makeLoop() {
  const source = { fetch: () => new Promise(() => {}), handleBinary: () => {} } as unknown as ContentSource;
  const cpuCache = new CpuCache(source, { size: 1, decode: () => new Promise(() => {}) } as unknown as DecodePool);
  let seq = 0;
  const inFlight = new Set<number>();
  let latency: { frameSeq: number; ms: number } | null = null;
  dispatch = () => {
    seq += 1;
    inFlight.add(seq);
  };
  const client = {
    takeGpuPassUs: () => null,
    gpuMemory: () => null,
    framesAwaitingDone: () => inFlight.size,
    takeFrameLatency: () => {
      const taken = latency;
      latency = null;
      return taken;
    },
    lastFrameSeq: () => seq,
    setCanvasColors: () => {},
    abandonFrame: vi.fn(),
    onFrameDone: null as ((frameSeq: number, doneAtMs: number) => void) | null,
    onGpuStatus: () => () => {},
  };
  const loop = new RenderLoop({
    session: {
      cpuCache,
      scene: { z: () => 0, active_view: () => 0, view_ids: () => [0], view_rect: () => [0, 0, 1, 1] },
    } as unknown as Session,
    datasets: new Map(),
    client: client as unknown as RenderClient,
    canvas: document.createElement("canvas"),
    mode: "volume",
  });
  loop.start();
  /** The frame `frameSeq` finished after `ms`. */
  const finish = (frameSeq: number, ms: number) => {
    inFlight.delete(frameSeq);
    latency = { frameSeq, ms };
    client.onFrameDone?.(frameSeq, performance.now());
  };
  tick();
  finish(1, 600);
  loop.markInteractiveDirty("test");
  drawn.length = 0;
  return { loop, client, finish, lastSeq: () => seq };
}

let frameCallbacks: FrameRequestCallback[] = [];

/** Run the frame callbacks the loop asked for. */
function tick(): void {
  const callbacks = frameCallbacks;
  frameCallbacks = [];
  for (const callback of callbacks) callback(performance.now());
}

describe("volume frames on a GPU too slow for full quality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    drawn.length = 0;
    frameCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a gesture at the floors when the last full-quality frame was slow", () => {
    const { loop, finish } = makeLoop();
    tick();
    expect(drawn.at(-1)).toMatchObject({ renderScale: 1, resolutionScale: 1, marchStepScale: 1 });
    finish(2, 2_000);

    loop.setRenderScale(0.5);
    loop.markInput("orbit");
    tick();
    expect(drawn.at(-1)).toMatchObject({
      renderScale: 0.5,
      resolutionScale: MIN_ADAPTIVE_SCALE,
      marchStepScale: INTERACTION_MARCH_STEP_SCALE * MAX_MARCH_COARSENING,
      bands: 1,
    });
  });

  it("leaves a gesture's start alone where the last full-quality frame kept up", () => {
    const { loop, finish } = makeLoop();
    tick();
    finish(2, 30);

    loop.setRenderScale(0.5);
    loop.markInput("orbit");
    tick();
    expect(drawn.at(-1)).toMatchObject({ renderScale: 0.5, resolutionScale: 1, marchStepScale: INTERACTION_MARCH_STEP_SCALE });
  });

  it("draws a full-quality frame in bands once one ran long, and gives it up for the next input", () => {
    const { loop, client, finish } = makeLoop();
    tick();
    finish(2, 2_000);

    loop.markInteractiveDirty("test");
    tick();
    expect(drawn.at(-1)).toMatchObject({ renderScale: 1, resolutionScale: 1, bands: MAX_BANDS });

    loop.setRenderScale(0.5);
    loop.markInput("orbit");
    expect(client.abandonFrame).toHaveBeenCalledWith(3);
    // Given up once.
    loop.markInput("orbit");
    expect(client.abandonFrame).toHaveBeenCalledOnce();
  });

  it("learns nothing from the first full-quality frame, which waited for the pipelines", () => {
    makeLoop();
    tick();
    expect(drawn.at(-1)).toMatchObject({ renderScale: 1, bands: 1 });
  });

  it("gives up no banded frame that has finished", () => {
    const { loop, client, finish } = makeLoop();
    tick();
    finish(2, 2_000);
    loop.markInteractiveDirty("test");
    tick();
    finish(3, 2_000);

    loop.markInput("orbit");
    expect(client.abandonFrame).not.toHaveBeenCalled();
  });

  it("shows input at the gesture's quality when the quality came back while its frame waited, then restores", () => {
    const { loop, finish } = makeLoop();
    tick();
    finish(2, 30);

    loop.setRenderScale(0.5);
    loop.markInput("orbit");
    tick();
    expect(drawn).toHaveLength(2);
    expect(drawn[1].renderScale).toBe(0.5);

    // More input while frame 2 draws; the last frame ran long, so nothing
    // queues behind it. Input stops, and the viewer's render scale and the
    // adaptive resolution both come back meanwhile.
    loop.markInput("orbit");
    tick();
    expect(drawn).toHaveLength(2);
    loop.setRenderScale(1);
    vi.advanceTimersByTime(RESTORE_AFTER_MS);
    tick();
    expect(drawn).toHaveLength(2);

    finish(3, 400);
    tick();
    expect(drawn).toHaveLength(3);
    expect(drawn[2].renderScale).toBe(0.5);

    finish(4, 400);
    tick();
    expect(drawn).toHaveLength(4);
    expect(drawn[3]).toMatchObject({ renderScale: 1, resolutionScale: 1 });
  });
});
