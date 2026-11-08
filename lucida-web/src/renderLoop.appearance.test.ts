// @vitest-environment happy-dom
/**
 * The worker cannot read styles, so the render loop hands it the canvas
 * colors: before its first frame, and again with a redraw whenever the
 * appearance changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { RenderLoop } from "./renderLoop.ts";
import { CpuCache } from "./pipeline/fetch/cpuCache.ts";
import type { ContentSource } from "./pipeline/fetch/contentSource.ts";
import type { DecodePool } from "./pipeline/fetch/decodePool.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { CanvasColors } from "./renderer/workerProtocol.ts";
import type { Session } from "./session.ts";
import { canvasBackgroundPreference, installAppearance } from "./theme/appearance.ts";
import { __resetPreferencesForTesting, setPreference } from "./theme/preferences.ts";

function makeLoop() {
  const source = { fetch: () => new Promise(() => {}) } as unknown as ContentSource;
  const cpuCache = new CpuCache(source, { size: 1, decode: () => new Promise(() => {}) } as unknown as DecodePool);
  const sent: CanvasColors[] = [];
  const loop = new RenderLoop({
    session: { cpuCache } as unknown as Session,
    datasets: new Map(),
    client: {
      takeGpuPassUs: () => null,
      gpuMemory: () => null,
      framesAwaitingDone: () => 0,
      takeFrameLatency: () => null,
      lastFrameSeq: () => 0,
      setCanvasColors: (colors: CanvasColors) => sent.push(colors),
    } as unknown as RenderClient,
    canvas: document.createElement("canvas"),
    mode: "slice",
  });
  return { loop, sent };
}

describe("the render loop's canvas colors", () => {
  let uninstall: () => void;
  beforeEach(() => {
    localStorage.clear();
    __resetPreferencesForTesting();
    uninstall = installAppearance();
  });
  afterEach(() => uninstall());

  it("sends them before the first frame and again, with a redraw, when the appearance changes", () => {
    const { loop, sent } = makeLoop();
    expect(sent).toHaveLength(1);
    expect(sent[0].background).toHaveLength(4);

    const dirty = vi.spyOn(loop as unknown as { setDirty: (kind: string, source: string) => void }, "setDirty");
    setPreference(canvasBackgroundPreference, "white");
    expect(sent).toHaveLength(2);
    expect(dirty).toHaveBeenCalledWith("interactive", "appearance_changed");

    loop.stop();
    setPreference(canvasBackgroundPreference, "black");
    expect(sent).toHaveLength(2);
  });
});
