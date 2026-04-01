import type { AxisInfo, CodecMeta } from "./metadata.ts";
import { decompressLz4Async } from "./lz4Client.ts";
import { decompress as decompressZstd } from "fzstd";

/** Build the on-disk chunk path using only axes that actually exist. */
function buildChunkPath(
  level: string, t: number, c: number, z: number, y: number, x: number,
  axes: AxisInfo[],
): string {
  const allDims: [string, number][] = [["t", t], ["c", c], ["z", z], ["y", y], ["x", x]];
  const axisNames = new Set(axes.map(a => a.name));
  const coords = allDims.filter(([name]) => axisNames.has(name)).map(([, v]) => v);
  return `${level}/c/${coords.join("/")}`;
}

/** Load a single chunk from the file index, applying codec decompression. */
export async function loadChunk(
  fileIndex: Map<string, File>,
  level: string,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
  codecs: CodecMeta[],
  axes: AxisInfo[],
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const path = buildChunkPath(level, t, c, z, y, x, axes);
  const file = fileIndex.get(path);
  if (!file) throw new Error(`Missing chunk: ${path}`);

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let buf = await file.arrayBuffer();

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const hasZstd = codecs.some((c) => c.name === "zstd");
  const hasLz4 = codecs.some((c) => c.name === "numcodecs/lz4");
  if (hasZstd) {
    const dec = decompressZstd(new Uint8Array(buf));
    buf = dec.buffer.slice(dec.byteOffset, dec.byteOffset + dec.byteLength);
  } else if (hasLz4) {
    buf = await decompressLz4Async(buf);
  }

  return buf;
}

export { buildChunkPath };
