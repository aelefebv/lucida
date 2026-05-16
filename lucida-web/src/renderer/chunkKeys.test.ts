import { describe, it, expect } from "vitest";
import {
  parseChunkKey,
  makeCompositeKey,
  parseCompositeKey,
  derivePoolKey,
} from "./chunkKeys.ts";

describe("parseChunkKey", () => {
  it("parses a valid 6-component chunk key", () => {
    expect(parseChunkKey("0/1/2/3/4/5")).toEqual({
      level: 0, t: 1, c: 2, z: 3, y: 4, x: 5,
    });
  });

  it("parses a key with multi-digit components", () => {
    expect(parseChunkKey("12/34/56/78/90/100")).toEqual({
      level: 12, t: 34, c: 56, z: 78, y: 90, x: 100,
    });
  });

  it("returns null for malformed input", () => {
    expect(parseChunkKey("bad")).toBeNull();
    expect(parseChunkKey("1/2/3")).toBeNull();
    expect(parseChunkKey("1/2/3/4/5/6/7")).toBeNull();
    expect(parseChunkKey("")).toBeNull();
  });
});

describe("makeCompositeKey", () => {
  it("joins memberId and chunkKey with the | separator", () => {
    expect(makeCompositeKey("memberA", "0/0/0/0/0/0")).toBe(
      "memberA|0/0/0/0/0/0",
    );
  });

  it("preserves multi-channel composite memberIds", () => {
    expect(makeCompositeKey("img1:ch0", "2/5/1/3/4/7")).toBe(
      "img1:ch0|2/5/1/3/4/7",
    );
  });
});

describe("parseCompositeKey", () => {
  it("round-trips with makeCompositeKey", () => {
    const composite = makeCompositeKey("memberA", "0/1/2/3/4/5");
    expect(parseCompositeKey(composite)).toEqual({
      memberId: "memberA",
      chunkKey: "0/1/2/3/4/5",
    });
  });

  it("round-trips multi-channel composite memberIds", () => {
    const composite = makeCompositeKey("img1:ch0", "2/5/1/3/4/7");
    expect(parseCompositeKey(composite)).toEqual({
      memberId: "img1:ch0",
      chunkKey: "2/5/1/3/4/7",
    });
  });

  it("returns null when separator is absent", () => {
    expect(parseCompositeKey("nopipehere")).toBeNull();
  });

  it("splits on the first | so chunk keys containing | (if any) are preserved", () => {
    // chunkKey shouldn't contain | in practice, but the helper splits
    // on the first pipe, leaving the rest in chunkKey.
    expect(parseCompositeKey("mem|a|b|c")).toEqual({
      memberId: "mem",
      chunkKey: "a|b|c",
    });
  });
});

describe("derivePoolKey", () => {
  it("returns datasetId for a single-channel memberId", () => {
    expect(derivePoolKey("imageA", "ds1")).toBe("ds1");
  });

  it("appends the :chN suffix for a multi-channel memberId", () => {
    expect(derivePoolKey("imageA:ch0", "ds1")).toBe("ds1:ch0");
    expect(derivePoolKey("imageA:ch5", "ds1")).toBe("ds1:ch5");
  });
});
