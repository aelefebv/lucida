import { describe, it, expect } from "vitest";
import {
  asUint16,
  asUint16Slice,
  asUint32,
  asUint32Slice,
} from "./dataTypeUtil.ts";

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

describe("asUint32", () => {
  it("keeps uint32 values above 65535 intact (no uint16 truncation)", () => {
    // Two label ids: one small, one that would alias/vanish through uint16.
    const src = new Uint32Array([7, 70000, 0xffffffff, 65536]);
    const out = asUint32(src.buffer, "uint32");
    expect(out).toBeInstanceOf(Uint32Array);
    expect(Array.from(out)).toEqual([7, 70000, 0xffffffff, 65536]);
    // 70000 & 0xFFFF === 4464 (a different colour); 65536 & 0xFFFF === 0
    // (would vanish). Confirm the raw value, pre-mask, is preserved here.
    expect(out[1]).toBe(70000);
    expect(out[3]).toBe(65536);
  });

  it("widens uint16 label data to uint32 without loss", () => {
    const src = new Uint16Array([0, 1, 65535]);
    const out = asUint32(src.buffer, "uint16");
    expect(Array.from(out)).toEqual([0, 1, 65535]);
  });

  it("widens uint8 label data to uint32", () => {
    const src = new Uint8Array([0, 5, 255]);
    const out = asUint32(src.buffer, "uint8");
    expect(Array.from(out)).toEqual([0, 5, 255]);
  });

  it("throws on a uint32 buffer whose byteLength is not a multiple of 4", () => {
    expect(() => asUint32(new ArrayBuffer(6), "uint32")).toThrowError(/byteLength/);
  });
});

describe("asUint32Slice", () => {
  it("extracts a uint32 slice with large ids intact", () => {
    // 4 uint32 = 16 bytes. Slice offset=1 length=2 → [70000, 0xffffffff].
    const src = new Uint32Array([1, 70000, 0xffffffff, 3]);
    const out = asUint32Slice(src.buffer, "uint32", 1, 2);
    expect(Array.from(out)).toEqual([70000, 0xffffffff]);
  });

  it("widens a uint16 slice to uint32", () => {
    const src = new Uint16Array([10, 20, 30, 40]);
    const out = asUint32Slice(src.buffer, "uint16", 1, 2);
    expect(Array.from(out)).toEqual([20, 30]);
  });

  it("throws when a uint32 slice exceeds the buffer", () => {
    // 8-byte buf = 2 uint32; offset=1 length=2 → needs 3 uint32 = 12 bytes.
    expect(() => asUint32Slice(new ArrayBuffer(8), "uint32", 1, 2)).toThrowError(/byteLength/);
  });
});
