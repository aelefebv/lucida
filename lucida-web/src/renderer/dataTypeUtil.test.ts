import { describe, it, expect } from "vitest";
import {
  asUint32Slice,
  atlasTexels,
  datasetSampleFormat,
  decodedValues,
  drawnAtFloat32Precision,
  isUint32,
  sampleFormatOf,
  texelValues,
} from "./dataTypeUtil.ts";
import type { DatasetManifest } from "../manifestTypes.ts";

describe("sampleFormatOf", () => {
  it("keeps the unsigned types whose values fit 16 bits as u16 texels", () => {
    expect(sampleFormatOf("uint8")).toBe("u16");
    expect(sampleFormatOf("Uint16")).toBe("u16");
  });

  it("draws every other numeric type as float32", () => {
    for (const t of ["Uint32", "Int8", "int16", "Int32", "Float32", "float64", "Int64", "uint64", "Float16"]) {
      expect(sampleFormatOf(t)).toBe("f32");
    }
  });

  it("refuses a type with no layout, naming it", () => {
    expect(() => sampleFormatOf("complex64")).toThrowError("unsupported data type: complex64");
  });
});

describe("datasetSampleFormat", () => {
  const manifest = (...types: string[]) =>
    ({ images: types.map((data_type) => ({ multiscale: { data_type } })) }) as unknown as DatasetManifest;

  it("is f32 once any image needs it, so the dataset's shared atlases hold every image", () => {
    expect(datasetSampleFormat(manifest("Uint16", "Uint8"))).toBe("u16");
    expect(datasetSampleFormat(manifest("Uint16", "Float32"))).toBe("f32");
    expect(datasetSampleFormat(undefined)).toBe("u16");
  });
});

describe("drawnAtFloat32Precision", () => {
  it("names the types a float32 can't hold every value of", () => {
    expect(["Float64", "Int32", "Uint32", "Int64", "Uint64"].every(drawnAtFloat32Precision)).toBe(true);
    expect(["Uint8", "Uint16", "Int8", "Int16", "Float32", "Float16"].some(drawnAtFloat32Precision)).toBe(false);
  });
});

describe("atlasTexels", () => {
  it("widens uint8 for a u16 atlas", () => {
    const out = atlasTexels(new Uint8Array([0, 7, 255]).buffer, "uint8", "u16");
    expect(out).toBeInstanceOf(Uint16Array);
    expect(Array.from(out)).toEqual([0, 7, 255]);
  });

  it("throws on an odd-length uint16 buffer", () => {
    expect(() => atlasTexels(new ArrayBuffer(3), "uint16", "u16")).toThrowError(/byteLength/);
  });

  it("throws when offset + length runs past the chunk", () => {
    expect(() => atlasTexels(new ArrayBuffer(8), "uint16", "u16", 3, 2)).toThrowError(/exceeds/);
  });

  it("holds decoded float32 samples as their bits, read back exactly", () => {
    const values = [-5, 0.25, 500.5, 2 ** 100];
    const texels = atlasTexels(new Float32Array(values).buffer, "Int16", "f32");
    expect(texels).toBeInstanceOf(Uint32Array);
    expect(Array.from(texelValues(texels, "f32"))).toEqual(values);
  });

  it("converts uint32 intensities to float32, not to two u16 halves", () => {
    const texels = atlasTexels(new Uint32Array([70000, 3, 16777216]).buffer, "Uint32", "f32", 1, 2);
    expect(Array.from(texelValues(texels, "f32"))).toEqual([3, 16777216]);
  });

  it("refuses to narrow float data into a u16 atlas", () => {
    expect(() => atlasTexels(new Float32Array([1.5]).buffer, "Float32", "u16")).toThrowError(/u16 atlas/);
  });
});

describe("decodedValues", () => {
  it("views each decoded layout as its values", () => {
    expect(decodedValues(new Uint8Array([1, 2]).buffer, "uint8")).toBeInstanceOf(Uint8Array);
    expect(decodedValues(new Uint16Array([1]).buffer, "uint16")).toBeInstanceOf(Uint16Array);
    expect(decodedValues(new Uint32Array([1]).buffer, "Uint32")).toBeInstanceOf(Uint32Array);
    expect(decodedValues(new Float32Array([1]).buffer, "Float64")).toBeInstanceOf(Float32Array);
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
