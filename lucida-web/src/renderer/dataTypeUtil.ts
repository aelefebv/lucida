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
  if (buf.byteLength % 2 !== 0) {
    throw new Error(
      `asUint16: buffer byteLength ${buf.byteLength} is not a multiple of 2 ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
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
  const requiredBytes = offset * 2 + length * 2;
  if (requiredBytes > buf.byteLength) {
    throw new Error(
      `asUint16Slice: requested offset=${offset} length=${length} ` +
      `(${requiredBytes} bytes) exceeds buffer byteLength ${buf.byteLength} ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint16Array(buf, offset * 2, length);
}
