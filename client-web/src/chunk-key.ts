export type ChunkAssetKind = "tile2d" | "brick3d" | "preview2d";

export type ChunkKey = {
  sourceId: string;
  generationSeq: number;
  assetKind: ChunkAssetKind;
  lod: number;
  t: number;
  z: number;
  channelBlock: number;
  y: number;
  x: number;
};

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`chunk key field \`${label}\` must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`chunk key field \`${label}\` exceeds safe integer range`);
  }
  return parsed;
}

function parseAssetKind(value: string): ChunkAssetKind {
  if (value === "tile2d" || value === "brick3d" || value === "preview2d") {
    return value;
  }
  throw new Error(`unsupported chunk asset kind \`${value}\``);
}

function requireField(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new Error(`missing chunk key field \`${label}\``);
  }
  return value;
}

function requirePart(parts: readonly string[], index: number): string {
  const value = parts[index];
  if (value === undefined) {
    throw new Error(`missing chunk path segment at index ${index.toString()}`);
  }
  return value;
}

export function formatChunkKeyCanonical(key: ChunkKey): string {
  return `asset=${key.assetKind};source=${key.sourceId};gen=${key.generationSeq};lod=${key.lod};t=${key.t};z=${key.z};cb=${key.channelBlock};y=${key.y};x=${key.x}`;
}

export function parseChunkKeyCanonical(value: string): ChunkKey {
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const pieces = part.split("=");
    if (pieces.length !== 2) {
      throw new Error("chunk key part must be key=value");
    }
    const key = requirePart(pieces, 0);
    const partValue = requirePart(pieces, 1);
    fields.set(key, partValue);
  }

  return {
    sourceId: requireField(fields.get("source"), "source"),
    generationSeq: parseInteger(requireField(fields.get("gen"), "gen"), "gen"),
    assetKind: parseAssetKind(requireField(fields.get("asset"), "asset")),
    lod: parseInteger(requireField(fields.get("lod"), "lod"), "lod"),
    t: parseInteger(requireField(fields.get("t"), "t"), "t"),
    z: parseInteger(requireField(fields.get("z"), "z"), "z"),
    channelBlock: parseInteger(requireField(fields.get("cb"), "cb"), "cb"),
    y: parseInteger(requireField(fields.get("y"), "y"), "y"),
    x: parseInteger(requireField(fields.get("x"), "x"), "x"),
  };
}

export function formatChunkKeyPath(key: ChunkKey): string {
  return `/v1/${key.assetKind}/${key.sourceId}/gen/${key.generationSeq}/lod/${key.lod}/t/${key.t}/z/${key.z}/cb/${key.channelBlock}/y/${key.y}/x/${key.x}`;
}

export function parseChunkKeyPath(path: string): ChunkKey {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length !== 17) {
    throw new Error(
      `chunk path must have 17 segments but had ${parts.length.toString()}`,
    );
  }
  if (
    parts[0] !== "v1" ||
    parts[3] !== "gen" ||
    parts[5] !== "lod" ||
    parts[7] !== "t" ||
    parts[9] !== "z" ||
    parts[11] !== "cb" ||
    parts[13] !== "y" ||
    parts[15] !== "x"
  ) {
    throw new Error("chunk path segments do not match canonical layout");
  }

  return {
    assetKind: parseAssetKind(requirePart(parts, 1)),
    sourceId: requirePart(parts, 2),
    generationSeq: parseInteger(requirePart(parts, 4), "gen"),
    lod: parseInteger(requirePart(parts, 6), "lod"),
    t: parseInteger(requirePart(parts, 8), "t"),
    z: parseInteger(requirePart(parts, 10), "z"),
    channelBlock: parseInteger(requirePart(parts, 12), "cb"),
    y: parseInteger(requirePart(parts, 14), "y"),
    x: parseInteger(requirePart(parts, 16), "x"),
  };
}
