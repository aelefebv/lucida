import { describe, it, expect } from "vitest";
import { chunkPoolKey, chunkTierPoolKey, sourceKey } from "./poolKeys.ts";

describe("chunkPoolKey", () => {
  it("3D volume includes :chN", () => {
    expect(chunkPoolKey("ds1", 0, [64, 64, 64])).toBe("ds1:ch0:64x64x64");
    expect(chunkPoolKey("ds1", 2, [64, 64, 32])).toBe("ds1:ch2:64x64x32");
  });

  it("2D slice includes :chN", () => {
    expect(chunkPoolKey("ds1", 0, [128, 128])).toBe("ds1:ch0:128x128");
    expect(chunkPoolKey("ds1", 1, [256, 128])).toBe("ds1:ch1:256x128");
  });

  it("gives every channel its own pool, so a solo keeps the soloed channel's", () => {
    expect(chunkPoolKey("ds1", 0, [64, 64])).not.toBe(chunkPoolKey("ds1", 1, [64, 64]));
  });

  it("throws on unsupported chunkDims arity", () => {
    expect(() => chunkPoolKey("ds1", 0, [1])).toThrow(
      /unsupported chunkDims arity 1/,
    );
    expect(() => chunkPoolKey("ds1", 0, [1, 2, 3, 4])).toThrow(
      /unsupported chunkDims arity 4/,
    );
  });
});

describe("chunkTierPoolKey", () => {
  it("adds a tier suffix after the dataset/channel/chunk-shape key", () => {
    expect(chunkTierPoolKey("ds1", "detail", 0, [64, 64, 32])).toBe(
      "ds1:ch0:64x64x32:detail",
    );
    expect(chunkTierPoolKey("ds1", "coarse", 2, [128, 128])).toBe(
      "ds1:ch2:128x128:coarse",
    );
  });
});

describe("sourceKey", () => {
  it("separates the tiers and the levels of one member's sections", () => {
    expect(sourceKey("detail", 0)).toBe("detail:0");
    expect(sourceKey("detail", 2)).toBe("detail:2");
    expect(sourceKey("coarse", 2)).toBe("coarse:2");
    expect(sourceKey("detail", 2)).not.toBe(sourceKey("coarse", 2));
  });
});

