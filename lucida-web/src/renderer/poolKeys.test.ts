import { describe, it, expect } from "vitest";
import { chunkPoolKey, chunkTierPoolKey, memberTierKey, proxyPoolKey } from "./poolKeys.ts";

describe("chunkPoolKey", () => {
  it("single-channel 3D volume", () => {
    expect(chunkPoolKey("ds1", 0, [64, 64, 64], false)).toBe("ds1:64x64x64");
  });

  it("multi-channel 3D volume includes :chN", () => {
    expect(chunkPoolKey("ds1", 2, [64, 64, 32], true)).toBe(
      "ds1:ch2:64x64x32",
    );
  });

  it("single-channel 2D slice", () => {
    expect(chunkPoolKey("ds1", 0, [128, 128], false)).toBe("ds1:128x128");
  });

  it("multi-channel 2D slice includes :chN", () => {
    expect(chunkPoolKey("ds1", 1, [256, 128], true)).toBe(
      "ds1:ch1:256x128",
    );
  });

  it("throws on unsupported chunkDims arity", () => {
    expect(() => chunkPoolKey("ds1", 0, [1], false)).toThrow(
      /unsupported chunkDims arity 1/,
    );
    expect(() => chunkPoolKey("ds1", 0, [1, 2, 3, 4], false)).toThrow(
      /unsupported chunkDims arity 4/,
    );
  });

  it("matches the inline format string used in gpu.worker.ts (cold-state handler)", () => {
    // Format mirrored from gpu.worker.ts lines 580-582 (volume) and
    // 665-667 (slice). Any drift here is the canary — bump both sides.
    const datasetId = "ds1";
    const channel = 3;

    // Volume single-channel (line 582): `${datasetId}:${chunkX}x${chunkY}x${chunkZ}`
    const chunkX = 32, chunkY = 32, chunkZ = 16;
    expect(chunkPoolKey(datasetId, channel, [chunkX, chunkY, chunkZ], false))
      .toBe(`${datasetId}:${chunkX}x${chunkY}x${chunkZ}`);

    // Volume multi-channel (line 581): `${datasetId}:ch${channel}:${chunkX}x${chunkY}x${chunkZ}`
    expect(chunkPoolKey(datasetId, channel, [chunkX, chunkY, chunkZ], true))
      .toBe(`${datasetId}:ch${channel}:${chunkX}x${chunkY}x${chunkZ}`);

    // Slice single-channel (line 667): `${datasetId}:${chunkX}x${chunkY}`
    expect(chunkPoolKey(datasetId, channel, [chunkX, chunkY], false))
      .toBe(`${datasetId}:${chunkX}x${chunkY}`);

    // Slice multi-channel (line 666): `${datasetId}:ch${channel}:${chunkX}x${chunkY}`
    expect(chunkPoolKey(datasetId, channel, [chunkX, chunkY], true))
      .toBe(`${datasetId}:ch${channel}:${chunkX}x${chunkY}`);
  });
});

describe("chunkTierPoolKey", () => {
  it("adds a tier suffix after the dataset/channel/chunk-shape key", () => {
    expect(chunkTierPoolKey("ds1", "detail", 0, [64, 64, 32], false)).toBe(
      "ds1:64x64x32:detail",
    );
    expect(chunkTierPoolKey("ds1", "coarse", 2, [128, 128], true)).toBe(
      "ds1:ch2:128x128:coarse",
    );
  });
});

describe("memberTierKey", () => {
  it("separates detail and coarse routing for one member", () => {
    expect(memberTierKey("img-0:ch2", "detail")).toBe("img-0:ch2|detail");
    expect(memberTierKey("img-0:ch2", "coarse")).toBe("img-0:ch2|coarse");
  });
});

describe("proxyPoolKey (re-export)", () => {
  it("is the same function as proxyAtlas.proxyPoolKey", () => {
    // Smoke check: the canonical proxy format is `${datasetId}|proxy|${kind}|${x}x${y}x${z}|ch${channel}`.
    expect(proxyPoolKey("ds1", "WellProxy3D", [64, 128, 256], 0)).toBe(
      "ds1|proxy|WellProxy3D|256x128x64|ch0",
    );
  });
});
