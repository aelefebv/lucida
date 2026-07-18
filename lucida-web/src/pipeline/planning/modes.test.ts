import { describe, expect, it } from "vitest";

import { assignChunkModes, createSyntheticEntity, groupMembers } from "./index.ts";
import { syntheticImage } from "./testFixtures.ts";

describe("single-path active-set resolution", () => {
  it("maps every visible image or tile to one chunk entry", () => {
    const entries = assignChunkModes([
      syntheticImage(),
      syntheticImage({ entityId: "hidden", imageId: "hidden-image", visible: false }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      kind: "tile",
      entityId: "image-entity",
      imageId: "image-0",
      mode: "tiles-with-detail",
      targetLod: 0,
      coarsestDetailLod: 1,
      detailOwnedLodRange: [0, 1],
      detailLevel: 0,
      coarseLevel: 1,
      wantedLodLevels: [0, 1],
    });
    expect(entries[1]).toEqual({
      kind: "invisible",
      entityId: "hidden",
      imageId: "hidden-image",
      coarsestLod: 1,
    });
  });

  it("clamps invalid levels and rejects a coarse level finer than detail", () => {
    const [entry] = assignChunkModes([
      syntheticImage({ detailLevel: 99, coarseLevel: 0 }),
    ]);
    expect(entry).toMatchObject({
      kind: "tile",
      detailLevel: 1,
      coarseLevel: null,
      wantedLodLevels: [1],
    });
  });

  it("is invariant across the legacy projected-size mode bands", () => {
    // Executable coarseDetail-only guard (lucida-76c): view-query deltas do
    // not quantize projectedDiagonalPx. That is safe only while the shipping
    // active-set resolver derives mode/LOD from visible + detail/coarse levels,
    // never the retired 80/150 px legacy bands. If a threshold-based resolver
    // is reintroduced, this test fails and the Rust delta contract must gain
    // an explicit mode band before that path can consume folded records.
    const projectedSizes = [0, 79.9, 80, 80.1, 149.9, 150, 150.1, 100_000];
    const resolved = projectedSizes.map((projectedDiagonalPx) => assignChunkModes([
      syntheticImage({ projectedDiagonalPx, detailLevel: 0, coarseLevel: 1 }),
    ]));
    for (const activeSet of resolved.slice(1)) {
      expect(activeSet).toEqual(resolved[0]);
    }
    expect(resolved[0][0]).toMatchObject({
      mode: "tiles-with-detail",
      targetLod: 0,
      coarseLevel: 1,
    });
  });

  it("groups collection tiles by parent and standalone images independently", () => {
    const groups = groupMembers([
      createSyntheticEntity({ entityId: "g", imageId: "", kind: "Group" }),
      createSyntheticEntity({ entityId: "t1", imageId: "i1", kind: "Tile", parentId: "g" }),
      createSyntheticEntity({ entityId: "t2", imageId: "i2", kind: "Tile", parentId: "g" }),
      syntheticImage({ entityId: "standalone", imageId: "standalone-image" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.groupId === "g")?.tiles.map((tile) => tile.entityId))
      .toEqual(["t1", "t2"]);
    expect(groups.find((group) => group.groupId === "__image__standalone-image")?.tiles)
      .toHaveLength(1);
  });
});
