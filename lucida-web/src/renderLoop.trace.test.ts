// @vitest-environment happy-dom
/**
 * The render loop's half of the monitor: it opens the run on a dataset-open
 * cause, publishes quiescence, and answers for the conditions the run ran
 * under.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./debug/logging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./debug/logging.ts")>();
  return { ...actual, debugLog: vi.fn() };
});

import { RenderLoop } from "./renderLoop.ts";
import { CpuCache } from "./pipeline/fetch/cpuCache.ts";
import type { ContentSource } from "./pipeline/fetch/contentSource.ts";
import type { DecodePool } from "./pipeline/fetch/decodePool.ts";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { Session } from "./session.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import { traceRecorder } from "./trace/recorder.ts";
import { installTraceSeam } from "./trace/seam.ts";

function makeLoop() {
  const source = {
    fetch: () => new Promise(() => {}),
    fetchProxy: () => new Promise(() => {}),
    handleBinary: () => {},
  } as unknown as ContentSource;
  const cpuCache = new CpuCache(source, { size: 1, decode: () => new Promise(() => {}) } as unknown as DecodePool);

  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1200;

  const loop = new RenderLoop({
    session: { cpuCache } as unknown as Session,
    datasets: new Map(),
    client: {} as unknown as RenderClient,
    canvas,
    mode: "slice",
  });
  return { loop, canvas };
}

const MANIFEST = { images: [] } as unknown as DatasetManifest;

describe("render loop trace wiring", () => {
  beforeEach(() => {
    traceRecorder.reset();
    installTraceSeam();
  });

  it("publishes quiescence as soon as it exists, without waiting for a tick", () => {
    makeLoop();
    const published = window.lucidaTrace!.quiescence;
    expect(published).not.toBeNull();
    expect(published!.reason).toBeTypeOf("string");
  });

  it("publishes the loop's own dirty state, not an outside inference", () => {
    const { loop } = makeLoop();
    loop.markInteractiveDirty("test");
    const published = window.lucidaTrace!.quiescence!;
    expect(published.quiescent).toBe(false);
    expect(published.interactiveDirty).toBe(true);
    expect(published.reason).toBe("interactive_dirty");
  });

  it("opens one run on a dataset-open cause, whatever the member count", () => {
    const { loop } = makeLoop();
    loop.addDataset("ds-1", MANIFEST);
    loop.addDataset("ds-2", MANIFEST);

    const doc = window.lucidaTrace!.exportTrace();
    expect(doc.runs).toHaveLength(1);
    expect(doc.runs[0].header.cause).toEqual({
      epoch: "content",
      dirtyKind: "interactive",
      source: "dataset_added",
    });
  });

  it("records the conditions that make two runs comparable", () => {
    window.devicePixelRatio = 2;
    const { loop } = makeLoop();
    loop.addDataset("ds-1", MANIFEST);

    const { header } = window.lucidaTrace!.exportTrace().runs[0];
    expect(header.devicePixelRatio).toBe(2);
    expect(header.viewport.deviceWidth).toBe(1600);
    expect(header.viewport.deviceHeight).toBe(1200);
    expect(header.composedView.mode).toBe("slice");
    expect(header.datasetIds).toEqual(["ds-1"]);
    expect(header.cacheWarmth.detailChunks).toBe(0);
  });
});
