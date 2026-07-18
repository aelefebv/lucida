// @vitest-environment happy-dom
// `self.onmessage` is exercised through DecodePool integration tests;
// these tests pin the pure helpers it composes.

import { describe, it, expect } from "vitest";
import {
  decompressLz4,
  decompressZstd,
} from "./decode.worker.ts";

// ---------------------------------------------------------------------------
// LZ4 — minimum-effort literal-only fixture
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zstd — round-trip via fzstd
// ---------------------------------------------------------------------------

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
