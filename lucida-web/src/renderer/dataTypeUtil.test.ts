import { describe, it, expect } from "vitest";
import { asUint16, asUint16Slice } from "./dataTypeUtil.ts";

describe("asUint16", () => {
  it("throws on odd-length uint16 buffer", () => {
    expect(() => asUint16(new ArrayBuffer(3), "uint16")).toThrowError(/byteLength/);
  });

  it("accepts even-length uint16 buffer", () => {
    expect(asUint16(new ArrayBuffer(4), "uint16")).toBeInstanceOf(Uint16Array);
  });

  it("expands uint8 buffer regardless of length", () => {
    const out = asUint16(new ArrayBuffer(3), "uint8");
    expect(out).toBeInstanceOf(Uint16Array);
    expect(out.length).toBe(3);
  });
});

describe("asUint16Slice", () => {
  it("throws when offset+length exceeds buffer for uint16", () => {
    // 8-byte buf = 4 uint16; ask for offset=3 length=2 → needs 5 uint16 = 10 bytes
    expect(() => asUint16Slice(new ArrayBuffer(8), "uint16", 3, 2)).toThrowError(/byteLength/);
  });
});
