import { describe, expect, it } from "vitest";
import { formatSampleValue, readoutBlocks, type ReadoutContext } from "./pixelReadout.ts";
import type { ProbeSample } from "../renderer/workerProtocol.ts";

function context(overrides: Partial<ReadoutContext> = {}): ReadoutContext {
  return {
    datasetName: (id) => `Dataset ${id}`,
    entityName: () => null,
    dataType: () => "Uint16",
    depth: () => 40,
    channel: (_id, channel) => ({ name: `Channel ${channel + 1}`, colormap: channel === 0 ? "green" : "magenta" }),
    ...overrides,
  };
}

function sample(overrides: Partial<ProbeSample> = {}): ProbeSample {
  return {
    datasetId: "a",
    entityId: "e",
    channel: 0,
    position: [120, 45, 12],
    state: "value",
    value: 1234,
    level: 0,
    ...overrides,
  };
}

describe("readoutBlocks", () => {
  it("lists each channel's value under one position, Z counted from 1, and the level they share", () => {
    const blocks = readoutBlocks([sample({ channel: 1, value: 7 }), sample()], context());
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.title).toBeNull();
    expect(block.position).toEqual([
      { label: "x", value: "120" },
      { label: "y", value: "45" },
      { label: "Z", value: "13" },
    ]);
    expect(block.level).toBe("level 0");
    expect(block.rows.map((r) => [r.name, r.colormap, r.value, r.level])).toEqual([
      ["Channel 1", "green", "1234", null],
      ["Channel 2", "magenta", "7", null],
    ]);
  });

  it("names the level on each row when the channels come from different levels", () => {
    const [block] = readoutBlocks([sample(), sample({ channel: 1, level: 2 })], context());
    expect(block.level).toBeNull();
    expect(block.rows.map((r) => r.level)).toEqual(["level 0", "level 2"]);
  });

  it("leaves Z out of a flat image's position", () => {
    const [block] = readoutBlocks([sample()], context({ depth: () => 1 }));
    expect(block.position.map((p) => p.label)).toEqual(["x", "y"]);
  });

  it("says when nothing is resident or the chunk failed, rather than a value", () => {
    const [block] = readoutBlocks(
      [sample({ state: "missing", value: undefined, level: undefined }), sample({ channel: 1, state: "failed", value: undefined, level: 3 })],
      context(),
    );
    expect(block.rows.map((r) => [r.value, r.absent])).toEqual([["not loaded", true], ["unavailable", true]]);
    expect(block.level).toBe("level 3");
  });

  it("titles a collection's tile, and each dataset when the point falls on several", () => {
    const tiles = readoutBlocks([sample()], context({ entityName: () => "B/3" }));
    expect(tiles[0].title).toBe("Dataset a · B/3");
    const several = readoutBlocks([sample(), sample({ datasetId: "b" })], context());
    expect(several.map((b) => b.title)).toEqual(["Dataset a", "Dataset b"]);
  });
});

describe("formatSampleValue", () => {
  it("shows a type a float32 holds exactly as it is stored", () => {
    expect(formatSampleValue(65535, "Uint16")).toBe("65535");
    expect(formatSampleValue(-128, "Int8")).toBe("-128");
    expect(formatSampleValue(Math.fround(0.1), "Float32")).toBe("0.1");
    expect(formatSampleValue(Math.fround(-200.75), "float32")).toBe("-200.75");
    expect(formatSampleValue(65504, "Float16")).toBe("65504");
    expect(formatSampleValue(2 ** -24, "Float16")).toBe("5.9604645e-8");
  });

  it("marks a value held at float32 precision whose type holds more", () => {
    expect(formatSampleValue(Math.fround(0.1), "Float64")).toBe("≈0.1");
    expect(formatSampleValue(Math.fround(4e9 + 1), "Uint32")).toBe("≈4000000000");
    expect(formatSampleValue(Math.fround(-6e9), "Int64")).toBe("≈-6000000000");
    expect(formatSampleValue(2 ** 64, "Uint64")).toBe("≈1.844674e+19");
  });

  it("shows an integer below 2^24 exactly, since a float32 holds every one of them", () => {
    expect(formatSampleValue(16777215, "Int32")).toBe("16777215");
    expect(formatSampleValue(-70000, "Int64")).toBe("-70000");
    expect(formatSampleValue(2 ** 24, "Uint32")).toBe("≈16777216");
  });

  it("names NaN and the infinities", () => {
    expect(formatSampleValue(Number.NaN, "Float32")).toBe("NaN");
    expect(formatSampleValue(Infinity, "Float16")).toBe("∞");
    expect(formatSampleValue(-Infinity, "Float64")).toBe("-∞");
  });
});
