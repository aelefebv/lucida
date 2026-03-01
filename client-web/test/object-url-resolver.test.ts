import { describe, expect, it } from "vitest";

import type { ChunkKey } from "../src/chunk-key";
import {
  EngineDataPlaneUrlResolver,
  StaticObjectUrlResolver,
} from "../src/object-url-resolver";

const sampleKey: ChunkKey = {
  sourceId: "src_00000001",
  generationSeq: 7,
  assetKind: "tile2d",
  lod: 0,
  t: 0,
  z: 0,
  channelBlock: 0,
  y: 1,
  x: 2,
};

describe("object URL resolvers", () => {
  it("maps engine data-plane URLs without assuming local-only shapes", () => {
    const resolver = new EngineDataPlaneUrlResolver("http://localhost:4000/");
    expect(resolver.resolveChunkUrl(sampleKey)).toBe(
      "http://localhost:4000/v1/data/v1/tile2d/src_00000001/gen/7/lod/0/t/0/z/0/cb/0/y/1/x/2",
    );
  });

  it("accepts dataBase values that already include /v1/data", () => {
    const resolver = new EngineDataPlaneUrlResolver(
      "http://localhost:4000/v1/data",
    );
    expect(resolver.resolveChunkUrl(sampleKey)).toBe(
      "http://localhost:4000/v1/data/v1/tile2d/src_00000001/gen/7/lod/0/t/0/z/0/cb/0/y/1/x/2",
    );
  });

  it("maps static object store URLs with a prefix", () => {
    const resolver = new StaticObjectUrlResolver(
      "https://cdn.example.com/",
      "/lucida-cache/",
    );
    expect(resolver.resolveChunkUrl(sampleKey)).toBe(
      "https://cdn.example.com/lucida-cache/v1/tile2d/src_00000001/gen/7/lod/0/t/0/z/0/cb/0/y/1/x/2",
    );
  });
});
