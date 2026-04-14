/**
 * Helpers for converting raw chunk buffers (uint8 or uint16) into
 * GPU-ready Uint16Array data for r16uint textures.
 */

function isUint8(dataType: string): boolean {
  return dataType === "uint8" || dataType === "Uint8";
}

/** Convert a full buffer to Uint16Array, expanding uint8 if needed. */
export function asUint16(buf: ArrayBuffer, dataType: string): Uint16Array {
  if (isUint8(dataType)) {
    const src = new Uint8Array(buf);
    const dst = new Uint16Array(src.length);
    dst.set(src);
    return dst;
  }
  return new Uint16Array(buf);
}

/**
 * Extract a slice from a buffer and return as Uint16Array.
 * For uint8 data, only the slice region is expanded — much smaller than the full chunk.
 */
export function asUint16Slice(
  buf: ArrayBuffer,
  dataType: string,
  offset: number,
  length: number,
): Uint16Array {
  if (isUint8(dataType)) {
    const src = new Uint8Array(buf, offset, length);
    const dst = new Uint16Array(length);
    dst.set(src);
    return dst;
  }
  return new Uint16Array(buf, offset * 2, length);
}
