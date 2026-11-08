// @vitest-environment happy-dom
/**
 * Removing a dataset clears the CPU cache under every id the cache keys its
 * entries by, so a reopened dataset, which keeps its ids, is not treated as
 * already delivered.
 */
import { describe, expect, it, vi } from "vitest";

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

function makeLoop() {
  const source = {
    fetch: () => new Promise(() => {}),
    handleBinary: () => {},
  } as unknown as ContentSource;
  const cpuCache = new CpuCache(source, { size: 1, decode: () => new Promise(() => {}) } as unknown as DecodePool);
  const canvas = document.createElement("canvas");
  const loop = new RenderLoop({
    session: { cpuCache, contentSource: { unregisterDataset: () => {} } } as unknown as Session,
    datasets: new Map(),
    client: {
      takeGpuPassUs: () => null,
      framesAwaitingDone: () => 0,
      takeFrameLatency: () => null,
      lastFrameSeq: () => 0,
      setCanvasColors: () => {},
      removeLayerResources: () => {},
      resize: () => {},
      sliceRenderMultiPass: () => 0,
    } as unknown as RenderClient,
    canvas,
    mode: "slice",
  });
  return { loop, cpuCache };
}

describe("removing a dataset", () => {
  it("cancels the cache under its entity ids, image ids, and label image ids", () => {
    const { loop, cpuCache } = makeLoop();
    const cancel = vi.spyOn(cpuCache, "cancelDataset");
    const manifest = {
      dataset_id: "ds",
      entities: [
        { id: "ds:grid", kind: "Group", parent: null, labels: {} },
        { id: "ds:tile-0", kind: "Tile", parent: "ds:grid", labels: {} },
      ],
      images: [{ image_id: "ds:image-0" }],
      labels: [{ name: "regions", source_image_id: "ds:image-0", image: { image_id: "ds:label-0" } }],
    } as unknown as DatasetManifest;
    loop.addDataset("ds", manifest);

    loop.removeDataset("ds");

    expect(cancel).toHaveBeenCalledTimes(1);
    const [datasetId, ids] = cancel.mock.calls[0];
    expect(datasetId).toBe("ds");
    expect([...ids].sort()).toEqual(["ds:grid", "ds:image-0", "ds:label-0", "ds:tile-0"]);
  });
});
