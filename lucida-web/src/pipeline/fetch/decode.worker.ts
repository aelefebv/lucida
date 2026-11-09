// Undo the storage codecs a chunk still carries, then lay samples out for
// upload: uint8, uint16 and uint32 as they are, every other numeric type as
// float32 values (see `dataTypeUtil.ts`).

import type * as Core from "lucida-core";
import { extractDataType, type WireFormat } from "../../manifestTypes.ts";
import { reportWorkerErrors } from "../../pageErrors.ts";

reportWorkerErrors();

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  /** The codec list of bytes still in the codecs the chunk was stored in. */
  codecs?: Uint8Array;
  /** What the chunk decodes to, from its level's metadata. */
  decodedBytes?: number;
}

/**
 * When this worker took the request up and when it finished, as
 * `performance.timeOrigin + performance.now()`: a clock the page shares, so
 * the page can tell the decode itself from the wait around it.
 */
interface DecodeTiming {
  startedAtMs: number;
  doneAtMs: number;
}

interface DecodeResponse extends DecodeTiming {
  id: number;
  data: ArrayBuffer;
  error?: undefined;
}

interface DecodeError extends DecodeTiming {
  id: number;
  data?: undefined;
  error: string;
}

function sharedNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * The codec lists of the two compressed per-image wire formats, as an encoded
 * frame would carry them (`lucida_protocol::codec::write_codecs`).
 */
const ZSTD_CODECS = new Uint8Array([3]);
const LZ4_CODECS = new Uint8Array([4]);

let core: Promise<typeof Core> | null = null;

/**
 * The WASM module's decoders, instantiated in this worker on the first
 * encoded chunk, so a page served only decoded frames never loads them here.
 */
function codecModule(): Promise<typeof Core> {
  core ??= import("lucida-core").then(async (module) => {
    await module.default();
    return module;
  });
  return core;
}

/**
 * `bytes` decoded through `codecs` to exactly `decodedBytes`, or an error. The
 * size is the bound: an unknown one is refused, because a chunk that could
 * decode to anything would let a hostile source make the page allocate
 * without limit.
 */
function decodeCodecs(
  core: typeof Core,
  bytes: ArrayBuffer,
  codecs: Uint8Array,
  decodedBytes: number | undefined,
): ArrayBuffer {
  // The module takes the size as a 32-bit length, so one past that would
  // wrap rather than bound anything.
  if (
    decodedBytes === undefined ||
    !Number.isInteger(decodedBytes) ||
    decodedBytes < 0 ||
    decodedBytes > 0xffff_ffff
  ) {
    throw new Error("an encoded chunk whose level gives no decoded size");
  }
  const out = core.decode_chunk(codecs, new Uint8Array(bytes), decodedBytes);
  return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
    ? (out.buffer as ArrayBuffer)
    : (out.slice().buffer as ArrayBuffer);
}

/** The codecs a request's bytes are still in, or null for decoded bytes. */
function codecsOf({ wireFormat, codecs }: DecodeRequest): Uint8Array | null {
  if (codecs) return codecs;
  if ("Lz4" in wireFormat) return LZ4_CODECS;
  if ("Zstd" in wireFormat) return ZSTD_CODECS;
  return null;
}

/**
 * The request's bytes with their codecs undone. `core` is the loaded module,
 * which bytes still in codecs need.
 */
function decompress(request: DecodeRequest, core: typeof Core | null): ArrayBuffer {
  const codecs = codecsOf(request);
  if (!codecs) return request.bytes;
  if (!core) throw new Error("the codec module is not loaded");
  return decodeCodecs(core, request.bytes, codecs, request.decodedBytes);
}

/** {@link decompress}, loading the module first when the bytes need it. */
async function decode(request: DecodeRequest): Promise<ArrayBuffer> {
  return decompress(request, codecsOf(request) ? await codecModule() : null);
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

/**
 * Halves as float32 values. Every half is exactly a float32, so nothing is
 * rounded; the bits are rebuilt by hand because `Float16Array` is not in every
 * browser lucida runs in.
 */
function halvesAsFloat32(buf: ArrayBuffer): ArrayBuffer {
  if (buf.byteLength % 2 !== 0) {
    throw new Error(`float16 buffer byteLength ${buf.byteLength} is not a multiple of 2`);
  }
  const halves = new Uint16Array(buf);
  const bits = new Uint32Array(halves.length);
  for (let i = 0; i < halves.length; i++) bits[i] = halfToFloatBits(halves[i]);
  const values = new Float32Array(bits.buffer);
  canonicalizeNaN(values);
  return bits.buffer;
}

function halfToFloatBits(half: number): number {
  const sign = (half & 0x8000) << 16;
  const exponent = (half >> 10) & 0x1f;
  let mantissa = half & 0x3ff;
  if (exponent === 0x1f) return (sign | 0x7f800000 | (mantissa << 13)) >>> 0;
  if (exponent !== 0) return (sign | ((exponent + 112) << 23) | (mantissa << 13)) >>> 0;
  if (mantissa === 0) return sign >>> 0;
  // A subnormal half is a normal float32: shift its leading one into place.
  let shift = 0;
  while ((mantissa & 0x400) === 0) {
    mantissa <<= 1;
    shift++;
  }
  return (sign | ((113 - shift) << 23) | ((mantissa & 0x3ff) << 13)) >>> 0;
}

/**
 * 64-bit integers as the nearest float32, the precision the viewer draws them
 * at. Read as two 32-bit words, so no BigInt is made per sample.
 */
function wideIntegersAsFloat32(buf: ArrayBuffer, dataType: string, signed: boolean): ArrayBuffer {
  if (buf.byteLength % 8 !== 0) {
    throw new Error(`${dataType} buffer byteLength ${buf.byteLength} is not a multiple of 8`);
  }
  const words = new Uint32Array(buf);
  const values = new Float32Array(words.length / 2);
  for (let i = 0; i < values.length; i++) {
    let low = words[2 * i];
    let high = words[2 * i + 1];
    const negative = signed && high >= 0x80000000;
    if (negative) {
      // The magnitude, by two's complement negation. -2^63's is 2^63.
      low = (~low + 1) >>> 0;
      high = (~high + (low === 0 ? 1 : 0)) >>> 0;
    }
    const magnitude = wideMagnitude(high, low);
    values[i] = negative ? -magnitude : magnitude;
  }
  return values.buffer;
}

/**
 * The unsigned 64-bit integer `high * 2^32 + low` as a double that a float32
 * rounds to the integer's nearest float32. Past 26 significant bits the
 * dropped bits fold into one sticky bit, because a double rounding them first
 * could land on a tie the integer is not, and round the float32 the wrong way.
 */
function wideMagnitude(high: number, low: number): number {
  if (high === 0) return low;
  const drop = 32 - Math.clz32(high) + 6;
  let kept: number;
  let sticky: boolean;
  if (drop < 32) {
    kept = high * 2 ** (32 - drop) + (low >>> drop);
    sticky = (low & ((1 << drop) - 1)) !== 0;
  } else {
    const fromHigh = drop - 32;
    kept = fromHigh === 0 ? high : high >>> fromHigh;
    sticky = low !== 0 || (fromHigh > 0 && (high & ((1 << fromHigh) - 1)) !== 0);
  }
  return (sticky ? kept + 1 - (kept % 2) : kept) * 2 ** drop;
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
    case "float16":
      return halvesAsFloat32(buf);
    case "int64":
      return wideIntegersAsFloat32(buf, dataType, true);
    case "uint64":
      return wideIntegersAsFloat32(buf, dataType, false);
    default:
      throw new Error(`unsupported data type: ${dataType}`);
  }
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  let startedAtMs = sharedNow();
  const request = e.data;
  const { id, wireFormat } = request;
  try {
    // Loading the module is setup, not decoding, so the decode starts once
    // it is in hand: a worker's first encoded chunk would otherwise carry it.
    const core = codecsOf(request) ? await codecModule() : null;
    startedAtMs = sharedNow();
    const decompressed = decompress(request, core);
    const data = normalize(decompressed, extractDataType(wireFormat));
    (self as unknown as Worker).postMessage(
      { id, data, startedAtMs, doneAtMs: sharedNow() } satisfies DecodeResponse,
      [data],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage(
      { id, error: message, startedAtMs, doneAtMs: sharedNow() } satisfies DecodeError,
    );
  }
};

// Re-exported for direct testing (imported as a module, not a worker).
export { decode, normalize };
export type { DecodeRequest, DecodeResponse, DecodeError, DecodeTiming };
