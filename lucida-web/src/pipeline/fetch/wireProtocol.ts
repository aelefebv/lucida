/**
 * Wire-protocol helpers — pure binary-format codecs.
 *
 * No transport, no state. `parseProxyHeader` decodes the 64-byte
 * little-endian record that fronts every binary proxy frame;
 * `proxyResponseKey` composes the canonical key the bridge uses to
 * route frames back to the originating request. Both pair with their
 * Rust counterparts in `lucida_proxy::header` and `handler.rs` — the
 * two MUST stay in lockstep.
 */

import type { ProxyKind } from "../assetCatalog.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed proxy header. Mirrors the Rust `ProxyHeader` after the binary
 * 64-byte little-endian record is decoded — see
 * `lucida_proxy::header::write_header` for the canonical layout.
 */
export interface ProxyHeaderJs {
  algorithmVersion: number;
  sourceContentHash: Uint8Array; // 32 bytes
  /** `[Z, Y, X]` voxel counts. */
  dims: [number, number, number];
  dtype: "u16";
}

// ---------------------------------------------------------------------------
// Proxy header parsing
// ---------------------------------------------------------------------------

/**
 * Parse a 64-byte proxy header out of `buffer` starting at `offset`.
 * Layout (little-endian, exactly mirrors `lucida_proxy::header`):
 *
 * ```text
 *  0..4    magic              "LPRX"
 *  4..8    algorithm version  u32
 *  8..20   dims [Z, Y, X]     u32 × 3
 * 20..24   dtype code         u32
 * 24..56   source hash        u8 × 32
 * 56..64   reserved
 * ```
 */
export function parseProxyHeader(buffer: ArrayBuffer, offset = 0): ProxyHeaderJs {
  if (buffer.byteLength < offset + 64) {
    throw new Error(`Proxy header truncated: need 64 bytes, got ${buffer.byteLength - offset}`);
  }
  const view = new DataView(buffer, offset, 64);

  // Magic check.
  if (
    view.getUint8(0) !== 0x4c /* 'L' */ ||
    view.getUint8(1) !== 0x50 /* 'P' */ ||
    view.getUint8(2) !== 0x52 /* 'R' */ ||
    view.getUint8(3) !== 0x58 /* 'X' */
  ) {
    throw new Error("Bad proxy header magic");
  }

  const algorithmVersion = view.getUint32(4, true);
  const dims: [number, number, number] = [
    view.getUint32(8, true),
    view.getUint32(12, true),
    view.getUint32(16, true),
  ];
  const dtypeCode = view.getUint32(20, true);
  if (dtypeCode !== 0) {
    throw new Error(`Unknown proxy dtype code: ${dtypeCode}`);
  }
  // Copy out the 32-byte hash so callers can hold it independently of `buffer`.
  const sourceContentHash = new Uint8Array(32);
  sourceContentHash.set(new Uint8Array(buffer, offset + 24, 32));

  return {
    algorithmVersion,
    sourceContentHash,
    dims,
    dtype: "u16",
  };
}

/**
 * Compose the proxy response key. Mirrors the server's
 * `proxy_response_key` (handler.rs); the two MUST stay in lockstep so the
 * client can route binary frames back to the right pending request.
 */
export function proxyResponseKey(
  entityId: string,
  kind: ProxyKind,
  t: number,
  c: number,
): string {
  return `proxy/${entityId}/${kind}/T${t.toString().padStart(5, "0")}_C${c.toString().padStart(3, "0")}`;
}
