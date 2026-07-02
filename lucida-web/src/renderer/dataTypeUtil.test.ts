import { describe, it, expect } from "vitest";
import { asUint16, asUint16Slice, asUint32Slice, isUint32 } from "./dataTypeUtil.ts";

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

describe("isUint32", () => {
  it("recognizes both spellings, rejects others", () => {
    expect(isUint32("uint32")).toBe(true);
    expect(isUint32("Uint32")).toBe(true);
    expect(isUint32("uint16")).toBe(false);
    expect(isUint32("uint8")).toBe(false);
  });
});

describe("asUint32Slice", () => {
  it("extracts a full-width uint32 slice without truncation", () => {
    const src = new Uint32Array([0, 92801, 92801 + 65536, 4_294_967_295]);
    const out = asUint32Slice(src.buffer, 1, 3);
    expect(Array.from(out)).toEqual([92801, 92801 + 65536, 4_294_967_295]);
  });

  it("throws when offset+length exceeds buffer", () => {
    // 16-byte buf = 4 uint32; ask offset=3 length=2 → needs 5 uint32 = 20 bytes
    expect(() => asUint32Slice(new ArrayBuffer(16), 3, 2)).toThrowError(/byteLength/);
  });

  it("throws on a buffer whose length is not a multiple of 4", () => {
    expect(() => asUint32Slice(new ArrayBuffer(6), 0, 1)).toThrowError(/multiple of 4/);
  });
});
