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

const HEADER_BYTES = 6;

export function decodeChunkFrame(buffer: ArrayBuffer): ChunkFrameDecodeResult {
  if (buffer.byteLength < HEADER_BYTES) {
    return { ok: false, reason: "truncated_header" };
  }
  const view = new DataView(buffer);
  const clientId = view.getUint32(0, true);
  const keyLength = view.getUint16(4, true);
  const keyEnd = HEADER_BYTES + keyLength;
  if (buffer.byteLength < keyEnd) {
    return { ok: false, reason: "truncated_key" };
  }
  let key: string;
  try {
    key = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(buffer, HEADER_BYTES, keyLength),
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
