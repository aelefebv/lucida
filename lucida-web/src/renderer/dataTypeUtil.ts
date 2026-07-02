/**
 * Helpers for converting raw chunk buffers (uint8 / uint16 / uint32) into
 * GPU-ready typed arrays. Intensity chunks target `r16uint` (via
 * {@link asUint16}/{@link asUint16Slice}); segmentation **label** chunks
 * target `r32uint` (via {@link asUint32}/{@link asUint32Slice}) because a
 * label id can exceed 65535 and must NOT be truncated through the uint16
 * path — a truncated id would tint the wrong colour (or, if it aliases to 0,
 * vanish into the transparent background).
 */

function isUint8(dataType: string): boolean {
  return dataType === "uint8" || dataType === "Uint8";
}

function isUint16(dataType: string): boolean {
  return dataType === "uint16" || dataType === "Uint16";
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

/**
 * Convert a full label chunk buffer to `Uint32Array`, widening uint8/uint16 if
 * the store handed back a narrower dtype. Crucially, a `uint32` buffer is
 * reinterpreted **without truncation** (unlike routing label data through the
 * uint16 path, which would drop the high 16 bits of any id > 65535).
 */
export function asUint32(buf: ArrayBuffer, dataType: string): Uint32Array {
  if (isUint8(dataType)) {
    const dst = new Uint32Array(new Uint8Array(buf));
    return dst;
  }
  if (isUint16(dataType)) {
    if (buf.byteLength % 2 !== 0) {
      throw new Error(
        `asUint32: uint16 buffer byteLength ${buf.byteLength} is not a multiple of 2 ` +
        `(server likely returned a compressed or wrong-shape chunk)`,
      );
    }
    return new Uint32Array(new Uint16Array(buf));
  }
  // Native uint32 (or an unrecognised >=4-byte dtype): reinterpret verbatim.
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `asUint32: buffer byteLength ${buf.byteLength} is not a multiple of 4 ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint32Array(buf);
}

/**
 * Extract a slice from a label chunk buffer and return it as `Uint32Array`.
 * For uint8/uint16 data only the requested slice region is widened (cheaper
 * than the whole chunk). uint32 data is a zero-copy view — the high bits of
 * large ids survive, so the label LUT is indexed by the true value.
 */
export function asUint32Slice(
  buf: ArrayBuffer,
  dataType: string,
  offset: number,
  length: number,
): Uint32Array {
  if (isUint8(dataType)) {
    const src = new Uint8Array(buf, offset, length);
    const dst = new Uint32Array(length);
    dst.set(src);
    return dst;
  }
  if (isUint16(dataType)) {
    const requiredBytes = offset * 2 + length * 2;
    if (requiredBytes > buf.byteLength) {
      throw new Error(
        `asUint32Slice: uint16 requested offset=${offset} length=${length} ` +
        `(${requiredBytes} bytes) exceeds buffer byteLength ${buf.byteLength} ` +
        `(server likely returned a compressed or wrong-shape chunk)`,
      );
    }
    const src = new Uint16Array(buf, offset * 2, length);
    const dst = new Uint32Array(length);
    dst.set(src);
    return dst;
  }
  const requiredBytes = offset * 4 + length * 4;
  if (requiredBytes > buf.byteLength) {
    throw new Error(
      `asUint32Slice: requested offset=${offset} length=${length} ` +
      `(${requiredBytes} bytes) exceeds buffer byteLength ${buf.byteLength} ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint32Array(buf, offset * 4, length);
}
