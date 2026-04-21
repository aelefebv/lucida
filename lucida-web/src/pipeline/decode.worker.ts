/**
 * Codec-agnostic decode worker.
 *
 * Two steps per request:
 *   1. Decompress: Raw (no-op) / LZ4 / Zstd
 *   2. Normalize: interpret as dataType, produce GPU-ready Uint16Array buffer
 */

import type { WireFormat } from "../manifestTypes.ts";

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  dataType: string;
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

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

function decompressLz4(src: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(src);

  // Wire format: 4-byte LE uncompressed size, then LZ4 block data
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
  // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
  // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app). See #438.
  return fzstdModule.decompress(new Uint8Array(src)).buffer as ArrayBuffer;
}

function decompress(bytes: ArrayBuffer, wireFormat: WireFormat): ArrayBuffer | Promise<ArrayBuffer> {
  if ("Lz4" in wireFormat) return decompressLz4(bytes);
  if ("Zstd" in wireFormat) return decompressZstd(bytes);
  return bytes; // Raw
}

// ---------------------------------------------------------------------------
// Pixel-format normalization → GPU-ready Uint16
// ---------------------------------------------------------------------------

function normalize(buf: ArrayBuffer, dataType: string): ArrayBuffer {
  switch (dataType.toLowerCase()) {
    case "uint8":
      // Pass through raw uint8 data — conversion to uint16 happens at GPU upload
      // to avoid doubling memory in the decode worker.
      return buf;
    case "bool": {
      const src = new Uint8Array(buf);
      const dst = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) dst[i] = src[i] ? 255 : 0;
      return dst.buffer;
    }
    case "uint16":
    default:
      return buf;
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, bytes, wireFormat, dataType } = e.data;
  try {
    const decompressed = await decompress(bytes, wireFormat);
    const data = normalize(decompressed, dataType);
    (self as unknown as Worker).postMessage({ id, data } satisfies DecodeResponse, [data]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id, error: message } satisfies DecodeError);
  }
};

// Re-export for direct testing (imported as a module, not as a worker)
export { decompressLz4, normalize };
export type { DecodeRequest, DecodeResponse, DecodeError };
