// @vitest-environment happy-dom
// `self.onmessage` is exercised through DecodePool integration tests;
// these tests pin the pure helpers it composes.

import { describe, it, expect } from "vitest";
import {
  decompressLz4,
  decompressZstd,
  normalize,
} from "./decode.worker.ts";

// LZ4 — minimum-effort literal-only fixture

describe("decompressLz4", () => {
  it("round-trips a literal-only LZ4 block", () => {
    // Format: 4-byte LE uncompressed size, token byte, literals.
    // Token 0x50 = literal_length 5, no match. Loop exits via the
    // `if (sIdx >= input.length) break;` after consuming literals.
    const fixture = new Uint8Array([
      0x05, 0x00, 0x00, 0x00, // uncompressed size = 5
      0x50,                    // token: 5 literals, no match
      0x10, 0x20, 0x30, 0x40, 0x50,
    ]);
    const out = new Uint8Array(decompressLz4(fixture.buffer));
    expect(Array.from(out)).toEqual([0x10, 0x20, 0x30, 0x40, 0x50]);
  });

  it("decompresses a literal-with-back-reference block", () => {
    // Encode: literal [0xAA, 0xBB, 0xCC, 0xDD] then a 4-byte match
    // back-referencing offset 4 (the start of dst). Output is 8 bytes:
    // [AA, BB, CC, DD, AA, BB, CC, DD].
    //
    // Token 0x40 = literal_length 4, match_length nibble 0 (encodes
    // matchLen = 0 + 4 = 4 — the LZ4 minimum match length).
    const fixture = new Uint8Array([
      0x08, 0x00, 0x00, 0x00, // uncompressed size = 8
      0x40,                    // token: 4 literals, 4-byte match
      0xAA, 0xBB, 0xCC, 0xDD, // literals
      0x04, 0x00,              // match offset = 4 (LE)
    ]);
    const out = new Uint8Array(decompressLz4(fixture.buffer));
    expect(Array.from(out)).toEqual([
      0xAA, 0xBB, 0xCC, 0xDD,
      0xAA, 0xBB, 0xCC, 0xDD,
    ]);
  });
});

// Zstd — round-trip via fzstd

describe("decompressZstd", () => {
  it("round-trips a buffer compressed by fzstd", async () => {
    // fzstd is decompress-only. Use a precomputed Zstd frame for a known
    // input — the bytes below decode to the literal sequence [1..16].
    // Generated via `zstd -1` on the input.
    const compressed = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x10, 0x81, 0x00, 0x00, 0x01, 0x02,
      0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
      0x0e, 0x0f, 0x10,
    ]);
    const out = new Uint8Array(await decompressZstd(compressed.buffer));
    expect(Array.from(out)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });
});

// normalize — uint8 / bool / uint16 dispatch

describe("normalize", () => {
  it("uint8: returns input unchanged (conversion happens at GPU upload)", () => {
    const src = new Uint8Array([10, 20, 30, 40]).buffer;
    const out = normalize(src, "uint8");
    expect(out).toBe(src);
  });

  it("bool: expands each byte to a u16 (0 → 0, non-zero → 255)", () => {
    const src = new Uint8Array([0, 1, 0, 200, 255, 0]).buffer;
    const out = new Uint16Array(normalize(src, "bool"));
    expect(Array.from(out)).toEqual([0, 255, 0, 255, 255, 0]);
  });

  it("uint16: returns input unchanged", () => {
    const src = new Uint16Array([1000, 2000, 3000]).buffer;
    const out = normalize(src, "uint16");
    expect(out).toBe(src);
  });

  it("uint32: passes label bytes through without narrowing to u16", () => {
    // 92801 and 92801+65536 must survive as distinct 32-bit ids.
    const src = new Uint32Array([0, 92801, 92801 + 65536, 4_294_967_295]).buffer;
    const out = normalize(src, "uint32");
    expect(out).toBe(src);
    expect(Array.from(new Uint32Array(out))).toEqual([
      0, 92801, 92801 + 65536, 4_294_967_295,
    ]);
  });

  it("Uint32 (PascalCase, as serialized by the Rust DataType enum): passthrough", () => {
    const src = new Uint32Array([70000, 200000]).buffer;
    const out = normalize(src, "Uint32");
    expect(out).toBe(src);
  });

  it("float32: keeps every value, outside [0, 1] and infinite included", () => {
    const values = [-5, 0, 0.5, 1, 500.25, 2 ** 100, Infinity, -Infinity];
    const out = new Float32Array(normalize(new Float32Array(values).buffer, "Float32"));
    expect(Array.from(out)).toEqual(values);
  });

  it("float32: rewrites every NaN as one pattern, never the all-ones miss sentinel", () => {
    const bits = new Uint32Array([0xffffffff, 0x7f800001, 0xffc00000, 0x3f800000]);
    const out = new Uint32Array(normalize(bits.buffer, "float32"));
    expect(Array.from(out)).toEqual([0x7fc00000, 0x7fc00000, 0x7fc00000, 0x3f800000]);
  });

  it("float64: draws as the nearest float32", () => {
    const src = new Float64Array([-2.5, 1e6 + 0.25, 0.1, Number.NaN]).buffer;
    const out = new Float32Array(normalize(src, "Float64"));
    expect(out.length).toBe(4);
    expect(Array.from(out.subarray(0, 3))).toEqual([-2.5, Math.fround(1e6 + 0.25), Math.fround(0.1)]);
    expect(new Uint32Array(out.buffer)[3]).toBe(0x7fc00000);
  });

  it("signed integers: keep their values as float32", () => {
    expect(Array.from(new Float32Array(normalize(new Int8Array([-128, -1, 127]).buffer, "Int8"))))
      .toEqual([-128, -1, 127]);
    expect(Array.from(new Float32Array(normalize(new Int16Array([-32768, -2, 32767]).buffer, "Int16"))))
      .toEqual([-32768, -2, 32767]);
    expect(Array.from(new Float32Array(normalize(new Int32Array([-70000, 16777216]).buffer, "Int32"))))
      .toEqual([-70000, 16777216]);
  });

  it("float16: every half is its exact float32, subnormals and infinities included", () => {
    // 1, -2.5, 65504, the smallest subnormal, the largest subnormal, -0, -Infinity.
    const halves = new Uint16Array([0x3c00, 0xc100, 0x7bff, 0x0001, 0x03ff, 0x8000, 0xfc00]);
    const out = new Float32Array(normalize(halves.buffer, "Float16"));
    expect(Array.from(out)).toEqual([1, -2.5, 65504, 2 ** -24, 1023 * 2 ** -24, -0, -Infinity]);
    expect(Object.is(out[5], -0)).toBe(true);
  });

  it("float16: rewrites every NaN as the one float32 NaN", () => {
    const out = new Uint32Array(normalize(new Uint16Array([0x7e00, 0xfc01, 0x7fff]).buffer, "float16"));
    expect(Array.from(out)).toEqual([0x7fc00000, 0x7fc00000, 0x7fc00000]);
  });

  it("int64 and uint64: the nearest float32, signs and the high bit kept", () => {
    const signed = new BigInt64Array([-6000000000n, -1n, 9007199254740993n, -(2n ** 63n)]);
    expect(Array.from(new Float32Array(normalize(signed.buffer, "Int64"))))
      .toEqual([Math.fround(-6e9), -1, Math.fround(2 ** 53), -(2 ** 63)]);
    const unsigned = new BigUint64Array([2n ** 64n - 1n, 2n ** 63n + 2n ** 40n, 5n]);
    expect(Array.from(new Float32Array(normalize(unsigned.buffer, "uint64"))))
      .toEqual([2 ** 64, Math.fround(2 ** 63 + 2 ** 40), 5]);
  });

  it("int64 and uint64: round once, where a double would round a near-tie onto a tie", () => {
    // Just above halfway between two float32s at 2^60: the nearest is the
    // upper one, but a double drops the 1 and lands on the tie, which rounds
    // to even, the lower one.
    const upper = 2 ** 60 + 2 ** 37;
    const nearTie = 2n ** 60n + 2n ** 36n + 1n;
    expect(Array.from(new Float32Array(normalize(new BigUint64Array([nearTie]).buffer, "uint64")))).toEqual([upper]);
    expect(Array.from(new Float32Array(normalize(new BigInt64Array([-nearTie]).buffer, "int64")))).toEqual([-upper]);
    // Exact ties still round to even, and the high word alone rounds too.
    const tie = 2n ** 60n + 2n ** 36n;
    expect(Array.from(new Float32Array(normalize(new BigUint64Array([tie]).buffer, "uint64")))).toEqual([2 ** 60]);
    const highOnly = (2n ** 58n - 1n) << 6n;
    expect(Array.from(new Float32Array(normalize(new BigUint64Array([highOnly]).buffer, "uint64")))).toEqual([2 ** 64]);
    const exactWide = (2n ** 24n - 1n) << 33n;
    expect(Array.from(new Float32Array(normalize(new BigUint64Array([exactWide]).buffer, "uint64"))))
      .toEqual([(2 ** 24 - 1) * 2 ** 33]);
  });

  it("throws on a buffer that does not divide into samples", () => {
    expect(() => normalize(new ArrayBuffer(6), "float64")).toThrowError(/multiple of 8/);
    expect(() => normalize(new ArrayBuffer(12), "int64")).toThrowError(/multiple of 8/);
    expect(() => normalize(new ArrayBuffer(3), "float16")).toThrowError(/multiple of 2/);
  });

  it("refuses a data type it has no layout for, naming it", () => {
    expect(() => normalize(new ArrayBuffer(16), "complex128")).toThrowError("unsupported data type: complex128");
  });
});
