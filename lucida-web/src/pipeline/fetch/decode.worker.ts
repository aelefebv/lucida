// Decompress, validate exact source shape, then role-normalize to the GPU type.

import { extractDataType, type WireFormat } from "../../manifestTypes.ts";
import {
  normalizeChunkBytes,
  parseChunkSourceDType,
  type ChunkContract,
} from "../../chunkContract.ts";

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  wireFormat: WireFormat;
  contract: ChunkContract;
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

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, bytes, wireFormat, contract } = e.data;
  try {
    const wireDtype = parseChunkSourceDType(extractDataType(wireFormat));
    if (wireDtype !== contract.sourceDtype) {
      throw new Error(
        `Wire dtype ${wireDtype} differs from chunk contract ${contract.sourceDtype}`,
      );
    }
    const decompressed = await decompress(bytes, wireFormat);
    const data = normalizeChunkBytes(decompressed, contract);
    (self as unknown as Worker).postMessage({ id, data } satisfies DecodeResponse, [data]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id, error: message } satisfies DecodeError);
  }
};

// Re-exported for direct testing (imported as a module, not a worker).
export { decompressLz4, decompressZstd };
export type { DecodeRequest, DecodeResponse, DecodeError };
