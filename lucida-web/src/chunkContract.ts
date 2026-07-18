/**
 * The renderer's one chunk-pixel contract.
 *
 * A contract is created while planning from admitted manifest metadata and is
 * then carried unchanged through fetch, decode, CPU residency, upload, and the
 * render worker.  `sourceDtype` describes decompressed source bytes; `dtype`
 * and `expectedBytes` describe the canonical buffer handed to WebGPU.
 */

import { Axis } from "./axes.ts";
import {
  extractDataType,
  manifestChunkImages,
  type DatasetManifest,
  type FetchSource,
  type ImageSpec,
  type LevelGeometry,
} from "./manifestTypes.ts";

export type ChunkRole = "intensity" | "label";
export type ChunkSourceDType = "uint8" | "uint16" | "uint32" | "float32" | "float64";
export type ChunkGpuDType = "uint16" | "uint32";
export type ChunkNormalization =
  | "uint8_to_uint16"
  | "identity_uint16"
  | "float32_unit_to_uint16"
  | "uint8_to_uint32"
  | "uint16_to_uint32"
  | "identity_uint32";

export interface ChunkContract {
  datasetId: string;
  imageId: string;
  channel: number;
  role: ChunkRole;
  sourceDtype: ChunkSourceDType;
  /** Canonical GPU element type after role-aware normalization. */
  dtype: ChunkGpuDType;
  /** Nominal spatial chunk shape `[Z, Y, X]`. T/C chunking is admitted as 1. */
  shape: [number, number, number];
  /** Exact decompressed source-buffer length. */
  sourceExpectedBytes: number;
  /** Exact canonical decoded-buffer length handed to WebGPU. */
  expectedBytes: number;
  normalization: ChunkNormalization;
}

interface ChunkFormat {
  dtype: ChunkGpuDType;
  sourceBytesPerVoxel: number;
  gpuBytesPerVoxel: number;
  normalization: ChunkNormalization;
}

export const LABEL_BACKGROUND_ID = 0;
export const LABEL_ID_MAX = 0xffff_ffff;

export function parseChunkSourceDType(value: string): ChunkSourceDType {
  switch (value.toLowerCase()) {
    case "uint8": return "uint8";
    case "uint16": return "uint16";
    case "uint32": return "uint32";
    case "float32": return "float32";
    case "float64": return "float64";
    default: throw new Error(`Unsupported chunk source dtype: ${value}`);
  }
}

/** Role-aware support matrix. Unsupported combinations fail at admission. */
export function chunkFormatFor(
  role: ChunkRole,
  sourceDtype: ChunkSourceDType,
): ChunkFormat {
  if (role === "intensity") {
    switch (sourceDtype) {
      case "uint8":
        return {
          dtype: "uint16",
          sourceBytesPerVoxel: 1,
          gpuBytesPerVoxel: 2,
          normalization: "uint8_to_uint16",
        };
      case "uint16":
        return {
          dtype: "uint16",
          sourceBytesPerVoxel: 2,
          gpuBytesPerVoxel: 2,
          normalization: "identity_uint16",
        };
      case "float32":
        return {
          dtype: "uint16",
          sourceBytesPerVoxel: 4,
          gpuBytesPerVoxel: 2,
          normalization: "float32_unit_to_uint16",
        };
      case "uint32":
        throw new Error("Uint32 intensity chunks are not supported by the web renderer");
      case "float64":
        throw new Error("Float64 intensity chunks are not supported by the web renderer");
    }
  }

  switch (sourceDtype) {
    case "uint8":
      return {
        dtype: "uint32",
        sourceBytesPerVoxel: 1,
        gpuBytesPerVoxel: 4,
        normalization: "uint8_to_uint32",
      };
    case "uint16":
      return {
        dtype: "uint32",
        sourceBytesPerVoxel: 2,
        gpuBytesPerVoxel: 4,
        normalization: "uint16_to_uint32",
      };
    case "uint32":
      return {
        dtype: "uint32",
        sourceBytesPerVoxel: 4,
        gpuBytesPerVoxel: 4,
        normalization: "identity_uint32",
      };
    case "float32":
    case "float64":
      throw new Error("Label chunks require an unsigned integer source dtype");
  }
}

function checkedProduct(values: readonly number[], label: string): number {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must contain positive safe integers`);
    }
    product *= value;
    if (!Number.isSafeInteger(product)) {
      throw new Error(`${label} exceeds the safe integer range`);
    }
  }
  return product;
}

export function createChunkContract(args: {
  datasetId: string;
  imageId: string;
  channel: number;
  role: ChunkRole;
  sourceDtype: ChunkSourceDType | string;
  shape: readonly number[];
}): ChunkContract {
  if (!args.datasetId) throw new Error("Chunk contract requires a dataset id");
  if (!args.imageId) throw new Error("Chunk contract requires an image id");
  if (!Number.isSafeInteger(args.channel) || args.channel < 0) {
    throw new Error(`Invalid chunk channel: ${args.channel}`);
  }
  if (args.shape.length !== 3) {
    throw new Error(`Chunk shape must have exactly three spatial axes, got ${args.shape.length}`);
  }
  const shape = [...args.shape] as [number, number, number];
  const voxelCount = checkedProduct(shape, "Chunk shape");
  const sourceDtype = parseChunkSourceDType(args.sourceDtype);
  const format = chunkFormatFor(args.role, sourceDtype);
  const sourceExpectedBytes = checkedProduct(
    [voxelCount, format.sourceBytesPerVoxel],
    "Source chunk byte length",
  );
  const expectedBytes = checkedProduct(
    [voxelCount, format.gpuBytesPerVoxel],
    "Decoded chunk byte length",
  );
  return {
    datasetId: args.datasetId,
    imageId: args.imageId,
    channel: args.channel,
    role: args.role,
    sourceDtype,
    dtype: format.dtype,
    shape,
    sourceExpectedBytes,
    expectedBytes,
    normalization: format.normalization,
  };
}

export function chunkContractForLevel(args: {
  datasetId: string;
  image: ImageSpec;
  level: LevelGeometry;
  channel: number;
  role: ChunkRole;
}): ChunkContract {
  return createChunkContract({
    datasetId: args.datasetId,
    imageId: args.image.image_id,
    channel: args.channel,
    role: args.role,
    sourceDtype: args.image.multiscale.data_type,
    shape: [
      args.level.chunk_shape[Axis.Z],
      args.level.chunk_shape[Axis.Y],
      args.level.chunk_shape[Axis.X],
    ],
  });
}

/** Derive a smaller payload contract (used for a pre-sliced label plane). */
export function chunkContractWithShape(
  contract: ChunkContract,
  shape: readonly number[],
): ChunkContract {
  return createChunkContract({
    datasetId: contract.datasetId,
    imageId: contract.imageId,
    channel: contract.channel,
    role: contract.role,
    sourceDtype: contract.sourceDtype,
    shape,
  });
}

export function assertChunkBufferLength(
  bytes: ArrayBuffer,
  contract: ChunkContract,
  stage: "source" | "decoded" | "worker",
): void {
  const expected = stage === "source"
    ? contract.sourceExpectedBytes
    : contract.expectedBytes;
  if (bytes.byteLength !== expected) {
    throw new Error(
      `${stage} chunk ${contract.datasetId}/${contract.imageId}/ch${contract.channel} ` +
        `has ${bytes.byteLength} bytes; expected exactly ${expected} for ` +
        `${contract.role} ${contract.sourceDtype}->${contract.dtype} ` +
        `${contract.shape.join("x")}`,
    );
  }
}

/** Normalize one exact decompressed source chunk into its canonical GPU type. */
export function normalizeChunkBytes(
  bytes: ArrayBuffer,
  contract: ChunkContract,
): ArrayBuffer {
  assertChunkBufferLength(bytes, contract, "source");
  let normalized: ArrayBuffer;
  switch (contract.normalization) {
    case "uint8_to_uint16": {
      const src = new Uint8Array(bytes);
      const dst = new Uint16Array(src.length);
      dst.set(src);
      normalized = dst.buffer;
      break;
    }
    case "identity_uint16":
      normalized = bytes;
      break;
    case "float32_unit_to_uint16": {
      const src = new Float32Array(bytes);
      const dst = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) {
        const value = src[i];
        dst[i] = Number.isFinite(value)
          ? Math.round(Math.min(1, Math.max(0, value)) * 65535)
          : 0;
      }
      normalized = dst.buffer;
      break;
    }
    case "uint8_to_uint32": {
      const src = new Uint8Array(bytes);
      const dst = new Uint32Array(src.length);
      dst.set(src);
      normalized = dst.buffer;
      break;
    }
    case "uint16_to_uint32": {
      const src = new Uint16Array(bytes);
      const dst = new Uint32Array(src.length);
      dst.set(src);
      normalized = dst.buffer;
      break;
    }
    case "identity_uint32":
      normalized = bytes;
      break;
  }
  assertChunkBufferLength(normalized, contract, "decoded");
  return normalized;
}

/**
 * Validate the manifest + fetch descriptor as the browser's admission unit.
 * The server runs the matching protocol validator before success/broadcast;
 * this mirror fail-closes restored or old payloads before pipeline setup.
 */
export function validateDatasetChunkAdmission(
  manifest: DatasetManifest,
  fetch: FetchSource,
): void {
  const expected = new Map<string, { image: ImageSpec; role: ChunkRole }>();
  for (const [labelIndex, label] of (manifest.labels ?? []).entries()) {
    for (const [colorIndex, color] of (label.colors ?? []).entries()) {
      if (!Number.isSafeInteger(color.value) || color.value < 0 || color.value > LABEL_ID_MAX) {
        throw new Error(`labels[${labelIndex}].colors[${colorIndex}].value must fit uint32`);
      }
      if (color.value === LABEL_BACKGROUND_ID) {
        throw new Error(
          `labels[${labelIndex}].colors[${colorIndex}].value uses reserved background id 0`,
        );
      }
    }
  }
  for (const { image, role } of manifestChunkImages(manifest)) {
    if (expected.has(image.image_id)) {
      throw new Error(`Duplicate manifest image ${image.image_id}`);
    }
    expected.set(image.image_id, { image, role });
  }

  const seen = new Set<string>();
  for (const [index, spec] of fetch.Proxied.images.entries()) {
    if (seen.has(spec.image_id)) {
      throw new Error(`fetch.images[${index}].image_id duplicates ${spec.image_id}`);
    }
    seen.add(spec.image_id);
    const entry = expected.get(spec.image_id);
    if (!entry) throw new Error(`fetch.images[${index}].image_id is not in the manifest`);
    const sourceDtype = parseChunkSourceDType(entry.image.multiscale.data_type);
    const wireDtype = parseChunkSourceDType(extractDataType(spec.wire_format));
    if (sourceDtype !== wireDtype) {
      throw new Error(`fetch.images[${index}] wire dtype differs from manifest dtype`);
    }
    chunkFormatFor(entry.role, sourceDtype);
    for (const [levelIndex, level] of entry.image.multiscale.levels.entries()) {
      if (level.chunk_shape.length !== 5 || level.shape.length !== 5) {
        throw new Error(`${spec.image_id} level ${levelIndex} must use canonical TCZYX geometry`);
      }
      if (level.chunk_shape[Axis.T] !== 1 || level.chunk_shape[Axis.C] !== 1) {
        throw new Error(
          `${spec.image_id} level ${levelIndex} packs T/C voxels that the renderer cannot address`,
        );
      }
      if (entry.role === "label" && level.shape[Axis.C] !== 1) {
        throw new Error(`${spec.image_id} label level ${levelIndex} must have exactly one channel`);
      }
      createChunkContract({
        datasetId: manifest.dataset_id,
        imageId: spec.image_id,
        channel: 0,
        role: entry.role,
        sourceDtype,
        shape: [
          level.chunk_shape[Axis.Z],
          level.chunk_shape[Axis.Y],
          level.chunk_shape[Axis.X],
        ],
      });
    }
  }
  for (const imageId of expected.keys()) {
    if (!seen.has(imageId)) throw new Error(`Manifest image ${imageId} has no fetch descriptor`);
  }
}

export function chunkContractsEqual(a: ChunkContract, b: ChunkContract): boolean {
  return a.datasetId === b.datasetId &&
    a.imageId === b.imageId &&
    a.channel === b.channel &&
    a.role === b.role &&
    a.sourceDtype === b.sourceDtype &&
    a.dtype === b.dtype &&
    a.normalization === b.normalization &&
    a.sourceExpectedBytes === b.sourceExpectedBytes &&
    a.expectedBytes === b.expectedBytes &&
    a.shape[0] === b.shape[0] &&
    a.shape[1] === b.shape[1] &&
    a.shape[2] === b.shape[2];
}
