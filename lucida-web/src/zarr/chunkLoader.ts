/** Load a single chunk from the file index. */
export async function loadChunk(
  fileIndex: Map<string, File>,
  level: string,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): Promise<ArrayBuffer> {
  const path = `${level}/c/${t}/${c}/${z}/${y}/${x}`;
  const file = fileIndex.get(path);
  if (!file) throw new Error(`Missing chunk: ${path}`);
  return file.arrayBuffer();
}
