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
    expect(resolveIntensitySource("wds-single:ch2", datasets, 0)).toEqual({ datasetId: "wds-single", channel: 2 });
    expect(resolveIntensitySource("tile-b:ch1", datasets, 0)).toEqual({ datasetId: "wds-collection", channel: 1 });
  });

  it("takes the current channel for a single-channel member id", () => {
    expect(resolveIntensitySource("wds-single", datasets, 3)).toEqual({ datasetId: "wds-single", channel: 3 });
    expect(resolveIntensitySource("tile-a", datasets, 1)).toEqual({ datasetId: "wds-collection", channel: 1 });
  });
});
