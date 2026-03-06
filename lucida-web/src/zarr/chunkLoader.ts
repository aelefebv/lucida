import type { CodecMeta } from "./metadata.ts";
import { decompressLz4Async } from "./lz4Client.ts";

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
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const path = `${level}/c/${t}/${c}/${z}/${y}/${x}`;
  const file = fileIndex.get(path);
  if (!file) throw new Error(`Missing chunk: ${path}`);

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let buf = await file.arrayBuffer();

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const hasLz4 = codecs.some((c) => c.name === "numcodecs/lz4");
  if (hasLz4) {
    buf = await decompressLz4Async(buf);
  }

  return buf;
}
