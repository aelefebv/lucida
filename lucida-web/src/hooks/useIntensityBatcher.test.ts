import { describe, expect, it } from "vitest";
import type { DatasetState } from "../types.ts";
import { resolveIntensitySource } from "./useIntensityBatcher.ts";

const datasets = new Map<string, DatasetState>([
  ["wds-single", { manifest: { images: [{ image_id: "wds-single" }] } } as unknown as DatasetState],
  [
    "wds-collection",
    { manifest: { images: [{ image_id: "tile-a" }, { image_id: "tile-b" }] } } as unknown as DatasetState,
  ],
]);

describe("resolveIntensitySource", () => {
  it("reads the channel from a composite member id", () => {
    expect(resolveIntensitySource("wds-single:ch2", datasets)).toEqual({ datasetId: "wds-single", channel: 2 });
    expect(resolveIntensitySource("tile-b:ch1", datasets)).toEqual({ datasetId: "wds-collection", channel: 1 });
  });

  it("reads a bare member id as channel 0", () => {
    expect(resolveIntensitySource("wds-single", datasets)).toEqual({ datasetId: "wds-single", channel: 0 });
    expect(resolveIntensitySource("tile-a", datasets)).toEqual({ datasetId: "wds-collection", channel: 0 });
  });
});
