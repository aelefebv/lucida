import { describe, expect, it } from "vitest";
import {
  assertChunkBufferLength,
  chunkFormatFor,
  createChunkContract,
  normalizeChunkBytes,
  validateDatasetChunkAdmission,
  type ChunkRole,
  type ChunkSourceDType,
} from "./chunkContract.ts";
import { asUint16, asUint16Slice, asUint32, asUint32Slice } from "./renderer/dataTypeUtil.ts";
import type { DatasetManifest, FetchSource } from "./manifestTypes.ts";

interface PixelCase {
  role: ChunkRole;
  sourceDtype: ChunkSourceDType;
  source: number[];
  expected: number[];
}

const PIXEL_CASES: PixelCase[] = [
  { role: "intensity", sourceDtype: "uint8", source: [0, 1, 127, 255], expected: [0, 1, 127, 255] },
  { role: "intensity", sourceDtype: "uint16", source: [0, 1, 32768, 65535], expected: [0, 1, 32768, 65535] },
  { role: "intensity", sourceDtype: "float32", source: [-1, 0.5, 1, Number.NaN], expected: [0, 32768, 65535, 0] },
  { role: "label", sourceDtype: "uint8", source: [0, 1, 200, 255], expected: [0, 1, 200, 255] },
  { role: "label", sourceDtype: "uint16", source: [0, 1, 32768, 65535], expected: [0, 1, 32768, 65535] },
  { role: "label", sourceDtype: "uint32", source: [0, 92801, 158337, 4_294_967_295], expected: [0, 92801, 158337, 4_294_967_295] },
];

function sourceBuffer(dtype: ChunkSourceDType, values: number[]): ArrayBuffer {
  switch (dtype) {
    case "uint8": return new Uint8Array(values).buffer;
    case "uint16": return new Uint16Array(values).buffer;
    case "uint32": return new Uint32Array(values).buffer;
    case "float32": return new Float32Array(values).buffer;
    case "float64": return new Float64Array(values).buffer;
  }
}

describe("chunk pixel contract", () => {
  it.each(PIXEL_CASES)(
    "is pixel-accurate for 2D $role/$sourceDtype",
    ({ role, sourceDtype, source, expected }) => {
      const contract = createChunkContract({
        datasetId: "ds",
        imageId: "image",
        channel: 2,
        role,
        sourceDtype,
        shape: [1, 2, 2],
      });
      const normalized = normalizeChunkBytes(sourceBuffer(sourceDtype, source), contract);
      const gpuPixels = role === "intensity"
        ? asUint16Slice(normalized, contract.dtype, 0, 4)
        : asUint32Slice(normalized, 0, 4);
      expect(Array.from(gpuPixels)).toEqual(expected);
      expect(normalized.byteLength).toBe(contract.expectedBytes);
    },
  );

  it.each(PIXEL_CASES)(
    "is pixel-accurate for 3D $role/$sourceDtype",
    ({ role, sourceDtype, source, expected }) => {
      const sourceVoxels = [...source, ...source];
      const contract = createChunkContract({
        datasetId: "ds",
        imageId: "image",
        channel: 2,
        role,
        sourceDtype,
        shape: [2, 2, 2],
      });
      const normalized = normalizeChunkBytes(sourceBuffer(sourceDtype, sourceVoxels), contract);
      const gpuVoxels = role === "intensity"
        ? asUint16(normalized, contract.dtype)
        : asUint32(normalized);
      expect(Array.from(gpuVoxels)).toEqual([...expected, ...expected]);
      expect(normalized.byteLength).toBe(contract.expectedBytes);
    },
  );

  it("rejects short and oversized decompressed source buffers exactly", () => {
    const contract = createChunkContract({
      datasetId: "ds",
      imageId: "image",
      channel: 0,
      role: "intensity",
      sourceDtype: "uint16",
      shape: [1, 2, 2],
    });
    expect(() => normalizeChunkBytes(new ArrayBuffer(7), contract)).toThrow(/expected exactly 8/);
    expect(() => normalizeChunkBytes(new ArrayBuffer(9), contract)).toThrow(/expected exactly 8/);
    expect(() => assertChunkBufferLength(new ArrayBuffer(7), contract, "decoded"))
      .toThrow(/expected exactly 8/);
  });

  it("rejects unsupported advertised role/dtype combinations", () => {
    expect(() => chunkFormatFor("intensity", "uint32")).toThrow(/Uint32 intensity/);
    expect(() => chunkFormatFor("intensity", "float64")).toThrow(/Float64 intensity/);
    expect(() => chunkFormatFor("label", "float32")).toThrow(/unsigned integer/);
    expect(() => chunkFormatFor("label", "float64")).toThrow(/unsigned integer/);
  });
});

function admittedFixture(dtype: string): { manifest: DatasetManifest; fetch: FetchSource } {
  const manifest: DatasetManifest = {
    dataset_id: "ds",
    name: "fixture",
    kind: "Single",
    entities: [{ id: "entity", kind: "Image", parent: null, labels: {} }],
    transforms: [],
    images: [{
      image_id: "image",
      owner: "entity",
      multiscale: {
        axes: [],
        data_type: dtype,
        levels: [{
          level_index: 0,
          shape: [1, 1, 1, 2, 2],
          chunk_shape: [1, 1, 1, 2, 2],
          grid_shape: [1, 1, 1, 1, 1],
          scale: [1, 1, 1, 1, 1],
        }],
      },
    }],
    source_layouts: [],
    default_layout_id: null,
  };
  return {
    manifest,
    fetch: { Proxied: { images: [{ image_id: "image", wire_format: { Raw: { data_type: dtype } } }] } },
  };
}

describe("browser chunk admission", () => {
  it.each(["Uint8", "Uint16", "Float32"])("admits supported intensity %s", (dtype) => {
    const { manifest, fetch } = admittedFixture(dtype);
    expect(() => validateDatasetChunkAdmission(manifest, fetch)).not.toThrow();
  });

  it.each(["Uint32", "Float64"])("rejects unsupported intensity %s", (dtype) => {
    const { manifest, fetch } = admittedFixture(dtype);
    expect(() => validateDatasetChunkAdmission(manifest, fetch)).toThrow(/not supported/);
  });

  it("makes categorical id 0 and packed T/C chunks explicit admission failures", () => {
    const { manifest, fetch } = admittedFixture("Uint16");
    const labelImage = structuredClone(manifest.images[0]);
    labelImage.image_id = "label";
    labelImage.multiscale.data_type = "Uint8";
    manifest.labels = [{
      name: "regions",
      source_image_id: "image",
      image: labelImage,
      colors: [{ value: 0, rgba: [255, 0, 0, 255] }],
    }];
    fetch.Proxied.images.push({ image_id: "label", wire_format: { Raw: { data_type: "Uint8" } } });
    expect(() => validateDatasetChunkAdmission(manifest, fetch)).toThrow(/reserved background id 0/);

    manifest.labels[0].colors = [{ value: 1, rgba: [255, 0, 0, 255] }];
    manifest.images[0].multiscale.levels[0].chunk_shape[1] = 2;
    expect(() => validateDatasetChunkAdmission(manifest, fetch)).toThrow(/packs T\/C voxels/);
  });

  it("rejects a label image id that duplicates an intensity image id", () => {
    const { manifest, fetch } = admittedFixture("Uint16");
    manifest.labels = [{
      name: "duplicate",
      source_image_id: "image",
      image: structuredClone(manifest.images[0]),
    }];

    expect(() => validateDatasetChunkAdmission(manifest, fetch)).toThrow(
      "Duplicate manifest image image",
    );
  });
});
