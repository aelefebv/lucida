/**
 * How decoded chunk samples become atlas texels, and how texels read back as
 * the values they hold.
 */

import type { DatasetManifest } from "../manifestTypes.ts";
import type { SliceTextureFormat, SliceVoxels } from "./gpuContext.ts";

/**
 * How an image's samples sit in its atlases. `u16`: the integer itself in
 * `r16uint`. `f32`: a float32 value stored as its bits in `r32uint`, so both
 * bind as the shader's `texture_*d<u32>` and the shader bitcasts per the
 * entity descriptor's sample format.
 */
export type SampleFormat = "u16" | "f32";

/** The descriptor's `sampleFormat` code. Matches `SAMPLE_F32` in the shaders. */
export function sampleFormatCode(format: SampleFormat): number {
  return format === "f32" ? 1 : 0;
}

/** What a decoded chunk buffer holds per sample (see `decode.worker.ts`). */
type DecodedLayout = "u8" | "u16" | "u32" | "f32";

function decodedLayout(dataType: string): DecodedLayout {
  switch (dataType.toLowerCase()) {
    case "uint8": return "u8";
    case "uint16":
    case "bool": return "u16";
    case "uint32": return "u32";
    case "float16":
    case "float32":
    case "float64":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint64": return "f32";
    default: throw new Error(`unsupported data type: ${dataType}`);
  }
}

/** Every value of uint8 and uint16 is a u16 texel; every other type draws as float32. */
export function sampleFormatOf(dataType: string): SampleFormat {
  const layout = decodedLayout(dataType);
  return layout === "u8" || layout === "u16" ? "u16" : "f32";
}

/**
 * The one format every image of a dataset shares, since a dataset's atlases
 * are shared by its images: `f32` once any image needs it.
 */
export function datasetSampleFormat(manifest: DatasetManifest | undefined): SampleFormat {
  return manifest?.images.some((img) => sampleFormatOf(img.multiscale.data_type) === "f32")
    ? "f32"
    : "u16";
}

/**
 * True for the data types a float32 can't hold every value of, so they draw
 * at float32 precision: float64, and 32- and 64-bit integers past 2^24.
 */
export function drawnAtFloat32Precision(dataType: string): boolean {
  switch (dataType.toLowerCase()) {
    case "float64":
    case "int32":
    case "uint32":
    case "int64":
    case "uint64": return true;
    default: return false;
  }
}

/** Bytes one decoded sample takes in the page's cache (see `decode.worker.ts`). */
export function decodedBytesPerSample(dataType: string): number {
  const layout = decodedLayout(dataType);
  return layout === "u8" ? 1 : layout === "u16" ? 2 : 4;
}

export function atlasTextureFormat(format: SampleFormat): SliceTextureFormat {
  return format === "f32" ? "r32uint" : "r16uint";
}

export function bytesPerTexel(format: SampleFormat): number {
  return format === "f32" ? 4 : 2;
}

/** View a decoded chunk buffer as its values, one array element per sample. */
export function decodedValues(
  buf: ArrayBuffer,
  dataType: string,
): Uint8Array | Uint16Array | Uint32Array | Float32Array {
  const layout = decodedLayout(dataType);
  const width = layout === "u8" ? 1 : layout === "u16" ? 2 : 4;
  if (buf.byteLength % width !== 0) {
    throw new Error(
      `${dataType} chunk byteLength ${buf.byteLength} is not a multiple of ${width} ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  switch (layout) {
    case "u8": return new Uint8Array(buf);
    case "u16": return new Uint16Array(buf);
    case "u32": return new Uint32Array(buf);
    case "f32": return new Float32Array(buf);
  }
}

/**
 * Samples `offset .. offset + length` of a decoded chunk as texels for an
 * atlas of `format`. A view where the buffer already holds texels, a copy
 * where they must widen or convert.
 */
export function atlasTexels(
  buf: ArrayBuffer,
  dataType: string,
  format: SampleFormat,
  offset = 0,
  length?: number,
): SliceVoxels {
  const all = decodedValues(buf, dataType);
  const count = length ?? all.length - offset;
  if (offset < 0 || offset + count > all.length) {
    throw new Error(
      `atlasTexels: requested offset=${offset} length=${count} exceeds the ` +
      `${all.length} samples in a ${buf.byteLength}-byte ${dataType} chunk ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  const values = all.subarray(offset, offset + count);
  if (format === "u16") {
    if (values instanceof Uint16Array) return values;
    if (values instanceof Uint8Array) {
      const widened = new Uint16Array(count);
      widened.set(values);
      return widened;
    }
    throw new Error(`a u16 atlas cannot hold ${dataType} samples`);
  }
  const floats = values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
}

/** Read atlas texels back as the values they hold. */
export function texelValues(texels: SliceVoxels, format: SampleFormat): Uint16Array | Uint32Array | Float32Array {
  if (format === "u16") return texels;
  return new Float32Array(texels.buffer, texels.byteOffset, texels.length);
}

/** True for uint32 label data (4 bytes/voxel, kept full-width). */
export function isUint32(dataType: string): boolean {
  return dataType === "uint32" || dataType === "Uint32";
}

/**
 * View a whole uint32 label chunk buffer as a `Uint32Array`. Label ids are
 * kept at full 32-bit width (never narrowed), so the 3D volume label pool
 * writes the entire chunk without the per-plane extraction the 2D path uses.
 * Whole-buffer, at 4 bytes per voxel.
 */
export function asUint32(buf: ArrayBuffer): Uint32Array {
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `asUint32: buffer byteLength ${buf.byteLength} is not a multiple of 4 ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint32Array(buf);
}

/**
 * Extract a Z-slice from a uint32 label chunk as a `Uint32Array` view.
 * Ids keep their full 32 bits, since narrowing to 16 would collapse ids
 * above 65535.
 */
export function asUint32Slice(
  buf: ArrayBuffer,
  offset: number,
  length: number,
): Uint32Array {
  const requiredBytes = offset * 4 + length * 4;
  if (requiredBytes > buf.byteLength) {
    throw new Error(
      `asUint32Slice: requested offset=${offset} length=${length} ` +
      `(${requiredBytes} bytes) exceeds buffer byteLength ${buf.byteLength} ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `asUint32Slice: buffer byteLength ${buf.byteLength} is not a multiple of 4 ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint32Array(buf, offset * 4, length);
}
