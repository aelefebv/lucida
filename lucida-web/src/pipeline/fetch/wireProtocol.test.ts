// Cross-language contract with `lucida_proxy::header::write_header`
// and the Rust server's `proxy_response_key` (handler.rs).

import { describe, it, expect } from "vitest";
import { parseProxyHeader, proxyResponseKey } from "./wireProtocol.ts";
import { extractDataType, type WireFormat } from "../../manifestTypes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a 64-byte proxy header buffer with optional field overrides. */
function makeHeaderBuffer(overrides?: {
  magic?: [number, number, number, number];
  algorithmVersion?: number;
  dims?: [number, number, number];
  dtypeCode?: number;
  hash?: Uint8Array;
}): ArrayBuffer {
  const buf = new ArrayBuffer(64);
  const view = new DataView(buf);
  const magic = overrides?.magic ?? [0x4c, 0x50, 0x52, 0x58]; // "LPRX"
  view.setUint8(0, magic[0]);
  view.setUint8(1, magic[1]);
  view.setUint8(2, magic[2]);
  view.setUint8(3, magic[3]);
  view.setUint32(4, overrides?.algorithmVersion ?? 1, true);
  const dims = overrides?.dims ?? [16, 32, 64];
  view.setUint32(8, dims[0], true);
  view.setUint32(12, dims[1], true);
  view.setUint32(16, dims[2], true);
  view.setUint32(20, overrides?.dtypeCode ?? 0, true);
  if (overrides?.hash) {
    new Uint8Array(buf, 24, 32).set(overrides.hash);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// parseProxyHeader
// ---------------------------------------------------------------------------

describe("parseProxyHeader", () => {
  it("decodes a well-formed header into the expected JS shape", () => {
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash[i] = i + 1;
    const buf = makeHeaderBuffer({
      algorithmVersion: 7,
      dims: [10, 20, 30],
      hash,
    });

    const parsed = parseProxyHeader(buf, 0);

    expect(parsed.algorithmVersion).toBe(7);
    expect(parsed.dims).toEqual([10, 20, 30]);
    expect(parsed.dtype).toBe("u16");
    expect(parsed.sourceContentHash).toEqual(hash);
  });

  it("respects the offset parameter when reading from a larger buffer", () => {
    const outer = new ArrayBuffer(128);
    const header = makeHeaderBuffer({ dims: [4, 5, 6] });
    new Uint8Array(outer, 32, 64).set(new Uint8Array(header));

    const parsed = parseProxyHeader(outer, 32);
    expect(parsed.dims).toEqual([4, 5, 6]);
  });

  it("copies the hash so callers can hold it after the source buffer changes", () => {
    const hash = new Uint8Array(32);
    hash[0] = 0xab;
    const buf = makeHeaderBuffer({ hash });
    const parsed = parseProxyHeader(buf, 0);

    // Mutate the source buffer at the hash bytes.
    new Uint8Array(buf, 24, 32).fill(0xff);

    expect(parsed.sourceContentHash[0]).toBe(0xab);
  });

  it("rejects truncated buffers", () => {
    const buf = new ArrayBuffer(63);
    expect(() => parseProxyHeader(buf, 0)).toThrow(/truncated/i);
  });

  it("rejects truncation when offset pushes past end", () => {
    const buf = new ArrayBuffer(64);
    expect(() => parseProxyHeader(buf, 1)).toThrow(/truncated/i);
  });

  it("rejects bad magic", () => {
    const buf = makeHeaderBuffer({ magic: [0x4c, 0x50, 0x52, 0x59] }); // "LPRY"
    expect(() => parseProxyHeader(buf, 0)).toThrow(/magic/i);
  });

  it("rejects unknown dtype codes", () => {
    const buf = makeHeaderBuffer({ dtypeCode: 1 });
    expect(() => parseProxyHeader(buf, 0)).toThrow(/dtype code: 1/i);
  });
});

// ---------------------------------------------------------------------------
// proxyResponseKey
// ---------------------------------------------------------------------------

describe("proxyResponseKey", () => {
  it("composes the canonical zero-padded form", () => {
    expect(proxyResponseKey("ent-1", "WellProxy3D", 0, 0)).toBe(
      "proxy/ent-1/WellProxy3D/T00000_C000",
    );
  });

  it("zero-pads T to 5 digits and C to 3 digits", () => {
    expect(proxyResponseKey("ent-7", "FieldProxy3D", 12, 3)).toBe(
      "proxy/ent-7/FieldProxy3D/T00012_C003",
    );
  });

  it("does not truncate large indices", () => {
    expect(proxyResponseKey("ent-x", "WellProxy3D", 999999, 9999)).toBe(
      "proxy/ent-x/WellProxy3D/T999999_C9999",
    );
  });
});

// ---------------------------------------------------------------------------
// extractDataType
// ---------------------------------------------------------------------------

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
