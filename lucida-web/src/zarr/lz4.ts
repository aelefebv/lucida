/**
 * Minimal LZ4 block decompressor for chunks produced by lz4_flex::compress_prepend_size.
 *
 * Wire format: 4-byte little-endian uncompressed size, then LZ4 block compressed data.
 */
export function decompressLz4(src: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(src);

  // Read 4-byte LE uncompressed size
  const uncompressedSize =
    input[0] | (input[1] << 8) | (input[2] << 16) | (input[3] << 24);

  const dst = new Uint8Array(uncompressedSize);
  let sIdx = 4; // skip size prefix
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

    // Copy literals
    dst.set(input.subarray(sIdx, sIdx + literalLen), dIdx);
    sIdx += literalLen;
    dIdx += literalLen;

    if (sIdx >= input.length) break; // last sequence has no match

    // 2-byte LE match offset
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

    // Copy match (may overlap, so copy byte-by-byte)
    let matchPos = dIdx - offset;
    for (let i = 0; i < matchLen; i++) {
      dst[dIdx++] = dst[matchPos++];
    }
  }

  return dst.buffer;
}
