import { describe, expect, it } from "vitest";

import {
  formatChunkKeyCanonical,
  formatChunkKeyPath,
  parseChunkKeyCanonical,
  parseChunkKeyPath,
  type ChunkKey,
} from "../src/chunk-key";

describe("chunk key canonical formatter/parser", () => {
  it("round-trips canonical string and URL path forms", () => {
    const key: ChunkKey = {
      sourceId: "src_00000001",
      generationSeq: 8,
      assetKind: "tile2d",
      lod: 2,
      t: 1,
      z: 5,
      channelBlock: 0,
      y: 42,
      x: 18,
    };

    const canonical = formatChunkKeyCanonical(key);
    expect(parseChunkKeyCanonical(canonical)).toEqual(key);

    const path = formatChunkKeyPath(key);
    expect(parseChunkKeyPath(path)).toEqual(key);
  });

  it("rejects invalid path layout", () => {
    expect(() => parseChunkKeyPath("/v1/tile2d/src_01/gen/1/lod/0")).toThrow(
      "17 segments",
    );
  });
});
