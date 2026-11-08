import { describe, it, expect } from "vitest";
import { extractDataType, type WireFormat } from "./manifestTypes.ts";

describe("extractDataType", () => {
  it.each<[string, WireFormat, string]>([
    ["Raw uint16", { Raw: { data_type: "uint16" } }, "uint16"],
    ["Raw uint8", { Raw: { data_type: "uint8" } }, "uint8"],
    ["Lz4 uint8", { Lz4: { data_type: "uint8" } }, "uint8"],
    ["Zstd uint16", { Zstd: { data_type: "uint16" } }, "uint16"],
  ])("%s → %s", (_name, wf, expected) => {
    expect(extractDataType(wf)).toBe(expected);
  });
});
