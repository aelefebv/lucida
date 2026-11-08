// Decompress (Raw / LZ4 / Zstd), then lay samples out for upload: uint8,
// uint16 and uint32 as they are, every other numeric type as float32 values
// (see `dataTypeUtil.ts`).

import { extractDataType, type WireFormat } from "../../manifestTypes.ts";

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
}

interface DecodeResponse {
  id: number;
  data: ArrayBuffer;
  error?: undefined;
}

interface DecodeError {
  id: number;
  data?: undefined;
  error: string;
}

function decompressLz4(src: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(src);

  // 4-byte LE uncompressed size, then LZ4 block data.
  const uncompressedSize =
    input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24);

  const dst = new Uint8Array(uncompressedSize);
  let sIdx = 4;
  let dIdx = 0;

  while (sIdx < input.length) {
    const token = input[sIdx++];
    let literalLen = token >> 4;
    if (literalLen === 15) {
      let b: number;
      do {
        b = input[sIdx++];
        literalLen += b;
      } while (b === 255);
    }

    dst.set(input.subarray(sIdx, sIdx + literalLen), dIdx);
    sIdx += literalLen;
    dIdx += literalLen;

    if (sIdx >= input.length) break;

    const offset = input[sIdx] | (input[sIdx + 1] << 8);
    sIdx += 2;

    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b: number;
      do {
        b = input[sIdx++];
        matchLen += b;
      } while (b === 255);
    }

    let matchPos = dIdx - offset;
    for (let i = 0; i < matchLen; i++) {
      dst[dIdx++] = dst[matchPos++];
    }
  }

  return dst.buffer;
}

let fzstdModule: typeof import("fzstd") | null = null;

async function decompressZstd(src: ArrayBuffer): Promise<ArrayBuffer> {
  if (!fzstdModule) {
    fzstdModule = await import("fzstd");
  }
  // fzstd returns a view into a larger buffer with a 12-byte prefix;
  // slice to the decoded range so downstream readers don't see garbage.
  const decoded = fzstdModule.decompress(new Uint8Array(src));
  return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
}

function decompress(bytes: ArrayBuffer, wireFormat: WireFormat): ArrayBuffer | Promise<ArrayBuffer> {
  if ("Lz4" in wireFormat) return decompressLz4(bytes);
  if ("Zstd" in wireFormat) return decompressZstd(bytes);
  return bytes; // Raw
}

/** The float32 NaN every decoded NaN becomes. */
const CANONICAL_NAN_BITS = 0x7fc00000;

/**
 * Rewrite every NaN as one bit pattern. A float texel holds the value's bits,
 * and one NaN pattern, all ones, is the shader's sentinel for "nothing
 * resident", which would hand the sample to a coarser level.
 */
function canonicalizeNaN(values: Float32Array): void {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  for (let i = 0; i < bits.length; i++) {
    if ((bits[i] & 0x7fffffff) > 0x7f800000) bits[i] = CANONICAL_NAN_BITS;
  }
}

function asFloat32(
  buf: ArrayBuffer,
  dataType: string,
  Source: Float64ArrayConstructor | Int8ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor,
): ArrayBuffer {
  const width = Source.BYTES_PER_ELEMENT;
  if (buf.byteLength % width !== 0) {
    throw new Error(`${dataType} buffer byteLength ${buf.byteLength} is not a multiple of ${width}`);
  }
  const values = Float32Array.from(new Source(buf));
  canonicalizeNaN(values);
  return values.buffer;
}

function normalize(buf: ArrayBuffer, dataType: string): ArrayBuffer {
  switch (dataType.toLowerCase()) {
    case "uint8":
      // Conversion to u16 happens at GPU upload to avoid doubling memory here.
      return buf;
    case "uint16":
      return buf;
    case "uint32":
      // Label ids are kept at full 32-bit width and uploaded to an
      // r32uint atlas. Narrowing to u16 here would collapse distinct ids
      // above 65535 onto one value.
      return buf;
    case "bool": {
      const src = new Uint8Array(buf);
      const dst = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) dst[i] = src[i] ? 255 : 0;
      return dst.buffer;
    }
    case "float32": {
      if (buf.byteLength % 4 !== 0) {
        throw new Error(`float32 buffer byteLength ${buf.byteLength} is not a multiple of 4`);
      }
      canonicalizeNaN(new Float32Array(buf));
      return buf;
    }
    // Float32 holds every int8 and int16 exactly; float64 and int32 round
    // to the nearest float32, the precision the viewer draws them at.
    case "float64":
      return asFloat32(buf, dataType, Float64Array);
    case "int8":
      return asFloat32(buf, dataType, Int8Array);
    case "int16":
      return asFloat32(buf, dataType, Int16Array);
    case "int32":
      return asFloat32(buf, dataType, Int32Array);
    default:
      throw new Error(`unsupported data type: ${dataType}`);
  }
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, bytes, wireFormat } = e.data;
  try {
    const decompressed = await decompress(bytes, wireFormat);
    const data = normalize(decompressed, extractDataType(wireFormat));
    (self as unknown as Worker).postMessage({ id, data } satisfies DecodeResponse, [data]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id, error: message } satisfies DecodeError);
  }
};

// Re-exported for direct testing (imported as a module, not a worker).
export { decompressLz4, decompressZstd, normalize };
export type { DecodeRequest, DecodeResponse, DecodeError };
