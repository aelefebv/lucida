/**
 * Helpers for converting raw chunk buffers (uint8 or uint16) into
 * GPU-ready Uint16Array data for r16uint textures.
 */

function isUint8(dataType: string): boolean {
  return dataType === "uint8" || dataType === "Uint8";
}

/** True for uint32 label data (4 bytes/voxel, kept full-width). */
export function isUint32(dataType: string): boolean {
  return dataType === "uint32" || dataType === "Uint32";
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
 * View a whole uint32 label chunk buffer as a `Uint32Array`. Label ids are
 * kept at full 32-bit width (never narrowed), so the 3D volume label pool
 * writes the entire chunk without the per-plane extraction the 2D path uses.
 * Mirrors {@link asUint16}'s whole-buffer contract but at 4 bytes per voxel.
 */
export function asUint32(buf: ArrayBuffer): Uint32Array {
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `asUint32: buffer byteLength ${buf.byteLength} is not a multiple of 4 ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint32Array(buf);
}

/**
 * Extract a Z-slice from a uint32 label chunk as a `Uint32Array` view.
 * Label ids are kept at full 32-bit width — never narrowed to 16 bits,
 * which would collapse distinct ids above 65535. Mirrors
 * {@link asUint16Slice}'s bounds check but at 4 bytes per voxel.
 */
export function asUint32Slice(
  buf: ArrayBuffer,
  offset: number,
  length: number,
): Uint32Array {
  const requiredBytes = offset * 4 + length * 4;
  if (requiredBytes > buf.byteLength) {
    throw new Error(
      `asUint32Slice: requested offset=${offset} length=${length} ` +
      `(${requiredBytes} bytes) exceeds buffer byteLength ${buf.byteLength} ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `asUint32Slice: buffer byteLength ${buf.byteLength} is not a multiple of 4 ` +
      `(server likely returned a compressed or wrong-shape chunk)`,
    );
  }
  return new Uint32Array(buf, offset * 4, length);
}
