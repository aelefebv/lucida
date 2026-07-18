import { describe, expect, it } from "vitest";

import {
  assignChunkModes,
  chunkKey,
  chunkOutsideFrustum,
  iterateChunks,
} from "./index.ts";
import {
  syntheticImage,
  syntheticPlanningSnapshot,
} from "./testFixtures.ts";

describe("chunk enumeration", () => {
  it("uses the canonical chunk key", () => {
    expect(chunkKey(2, 3, 4, 5, 6, 7)).toBe("2/3/4/5/6/7");
  });

  it("culls an AABB only when it is fully outside a frustum plane", () => {
    expect(chunkOutsideFrustum([0, 0, 0], [1, 1, 1], [[1, 0, 0, -2]])).toBe(true);
    expect(chunkOutsideFrustum([0, 0, 0], [1, 1, 1], [[1, 0, 0, -0.5]])).toBe(false);
  });

  it("clips to the visible grid and interleaves channels per spatial cell", () => {
    const entity = syntheticImage();
    const [entry] = assignChunkModes([entity]);
    const fixture = syntheticPlanningSnapshot();
    const requests = iterateChunks(
      entity,
      entry,
      { ...fixture.visibleRegion, xyBoundsVox: [0, 0, 64, 128] },
      { ...fixture.selection, visibleChannels: [0, 1] },
      fixture.datasetId,
    );

    expect(requests).toHaveLength(6);
    expect(requests.slice(0, 4).map((request) => request.c)).toEqual([0, 1, 0, 1]);
    expect(new Set(requests.map((request) => request.datasetId))).toEqual(new Set(["ds-1"]));
    expect(new Set(requests.map((request) => request.contract.datasetId))).toEqual(new Set(["ds-1"]));
    expect(new Set(requests.map((request) => request.contract.imageId))).toEqual(new Set(["image-0"]));
  });

  it("returns no requests for invisible entries or entities without levels", () => {
    const fixture = syntheticPlanningSnapshot();
    const hidden = syntheticImage({ visible: false });
    const [hiddenEntry] = assignChunkModes([hidden]);
    expect(iterateChunks(hidden, hiddenEntry, fixture.visibleRegion, fixture.selection, fixture.datasetId)).toEqual([]);

    const empty = syntheticImage({ levels: [] });
    const [emptyEntry] = assignChunkModes([empty]);
    expect(iterateChunks(empty, emptyEntry, fixture.visibleRegion, fixture.selection, fixture.datasetId)).toEqual([]);
  });
});
