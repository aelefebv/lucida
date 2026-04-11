/**
 * Convert raw chunk buffers to Uint16Array, handling non-uint16 data types.
 * Handles both lowercase (legacy) and PascalCase (Rust serde DataType enum).
 */
export function bufferToUint16(buf: ArrayBuffer, dataType: string): Uint16Array {
  switch (dataType.toLowerCase()) {
    case "uint8": {
      const src = new Uint8Array(buf);
      const dst = new Uint16Array(src.length);
      dst.set(src);
      return dst;
    }
    case "bool": {
      const src = new Uint8Array(buf);
      const dst = new Uint16Array(src.length);
      for (let i = 0; i < src.length; i++) dst[i] = src[i] ? 255 : 0;
      return dst;
    }
    case "uint16":
    default:
      return new Uint16Array(buf);
  }
}
