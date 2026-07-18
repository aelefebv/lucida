/** Canonical decoder for Lucida's sole binary WebSocket frame.
 *
 * Layout: `[client_id: u32 LE][key_len: u16 LE][UTF-8 composite key][payload]`.
 * The Rust encoder and this decoder consume the same committed golden fixture.
 */

export interface DecodedChunkFrame {
  clientId: number;
  key: string;
  payload: ArrayBuffer;
}

export type ChunkFrameDecodeResult =
  | { ok: true; frame: DecodedChunkFrame }
  | {
      ok: false;
      reason: "truncated_header" | "truncated_key" | "invalid_utf8_key";
    };

export const CHUNK_FRAME_HEADER_BYTES = 6;

const utf8 = new TextEncoder();

/** Exact server outbox charge for one binary chunk response. */
export function chunkFrameByteLength(
  datasetId: string,
  imageId: string,
  chunkKey: string,
  payloadBytes: number,
): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error(`Chunk payload byte length must be a non-negative safe integer, got ${payloadBytes}`);
  }
  const keyBytes = utf8.encode(`${datasetId}/${imageId}/${chunkKey}`).byteLength;
  if (keyBytes > 0xffff) {
    throw new Error(`Chunk frame key is ${keyBytes} bytes; maximum is ${0xffff}`);
  }
  const total = CHUNK_FRAME_HEADER_BYTES + keyBytes + payloadBytes;
  if (!Number.isSafeInteger(total)) throw new Error("Chunk frame byte length exceeds the safe integer range");
  return total;
}

export function decodeChunkFrame(buffer: ArrayBuffer): ChunkFrameDecodeResult {
  if (buffer.byteLength < CHUNK_FRAME_HEADER_BYTES) {
    return { ok: false, reason: "truncated_header" };
  }
  const view = new DataView(buffer);
  const clientId = view.getUint32(0, true);
  const keyLength = view.getUint16(4, true);
  const keyEnd = CHUNK_FRAME_HEADER_BYTES + keyLength;
  if (buffer.byteLength < keyEnd) {
    return { ok: false, reason: "truncated_key" };
  }
  let key: string;
  try {
    key = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(buffer, CHUNK_FRAME_HEADER_BYTES, keyLength),
    );
  } catch {
    return { ok: false, reason: "invalid_utf8_key" };
  }
  return {
    ok: true,
    frame: {
      clientId,
      key,
      payload: buffer.slice(keyEnd),
    },
  };
}
