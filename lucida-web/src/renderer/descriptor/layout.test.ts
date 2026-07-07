/**
 * WGSL ↔ TS layout lock test.
 *
 * Parses the `EntityDescriptor` struct declaration from both `slice.wgsl`
 * and `volume.wgsl`, computes the implied byte offsets using WGSL's
 * host-shareable / std140-ish alignment rules, and asserts agreement with
 * the named constants in `./layout.ts`. Also asserts both shaders declare
 * an identical `EntityDescriptor` struct.
 *
 * Shader sources are loaded via Vite's `?raw` import — the same mechanism
 * the production renderers use — so this test is self-contained and
 * doesn't need `node:fs`.
 */

import { describe, it, expect } from "vitest";
import sliceSrc from "../slice.wgsl?raw";
import volumeSrc from "../volume.wgsl?raw";
import {
  DESCRIPTOR_LOD_INFO_SIZE,
  DESCRIPTOR_LODS_OFFSET,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  LOD_OFFSET_CHUNK_DIMS,
  LOD_OFFSET_GRID_DIMS,
  LOD_OFFSET_INDIRECTION_OFFSET,
  LOD_OFFSET_LEVEL,
  LOD_OFFSET_LEVEL_DIMS,
  OFFSET_CHANNEL_MASK,
  OFFSET_COARSE_SOURCE,
  OFFSET_COLORMAP_LUT_INDEX,
  OFFSET_COLORMAP_MODE,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_DETAIL_SOURCE,
  OFFSET_LABEL_OPACITY,
  OFFSET_TILE_PROXY_DIMS,
  OFFSET_TILE_PROXY_POOL_INDEX,
  OFFSET_TILE_PROXY_SLOT_INDEX,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LOD_COUNT,
  OFFSET_LODS,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_GROUP_PROXY_DIMS,
  OFFSET_GROUP_PROXY_POOL_INDEX,
  OFFSET_GROUP_PROXY_SLOT_INDEX,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_VALID,
} from "./layout.ts";

// ---------------------------------------------------------------------------
// WGSL struct parsing — calculator-grade, not a real parser.
// ---------------------------------------------------------------------------

interface WgslField { name: string; type: string }

function extractStruct(src: string, structName: string): string {
  // Match `struct Name { ... };` with non-greedy body capture.
  const re = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\};`);
  const m = src.match(re);
  if (!m) throw new Error(`struct ${structName} not found`);
  return m[1].trim();
}

function parseFields(body: string): WgslField[] {
  // Strip `//` line comments, then split on `,` / `;` outside of any
  // `<>` brackets (so `array<LodInfo, 8>` stays one field), and parse
  // `name: type`.
  const noComments = body.replace(/\/\/[^\n]*/g, "");
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of noComments) {
    if (ch === "<") { depth++; buf += ch; continue; }
    if (ch === ">") { depth--; buf += ch; continue; }
    if (depth === 0 && (ch === "," || ch === ";")) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  const out: WgslField[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\w+)\s*:\s*(.+?)$/s);
    if (!m) throw new Error(`unparsable field: '${trimmed}'`);
    out.push({ name: m[1], type: m[2].trim() });
  }
  return out;
}

function fieldSize(type: string): number {
  if (type === "u32" || type === "f32" || type === "i32") return 4;
  if (type === "mat4x4f" || type === "mat4x4<f32>") return 64;
  if (type.startsWith("vec3")) return 12;
  if (type.startsWith("vec4")) return 16;
  if (type.startsWith("array<")) {
    // array<LodInfo, 8> — only used as the final `lods` field. Stride
    // matches DESCRIPTOR_LOD_INFO_SIZE (= sizeof(LodInfo) under WGSL).
    const m = type.match(/^array<\s*([^,>\s]+)\s*,\s*(\d+)\s*>$/);
    if (!m) throw new Error(`unsupported array type: ${type}`);
    const innerName = m[1];
    const count = Number(m[2]);
    if (innerName !== "LodInfo") {
      throw new Error(`unsupported array element type: ${innerName}`);
    }
    return DESCRIPTOR_LOD_INFO_SIZE * count;
  }
  if (type === "ChunkTierSource") return DESCRIPTOR_TIER_SOURCE_SIZE;
  throw new Error(`unknown type: ${type}`);
}

function tileAlign(type: string): number {
  if (type === "u32" || type === "f32" || type === "i32") return 4;
  if (type === "mat4x4f" || type === "mat4x4<f32>") return 16;
  if (type.startsWith("vec3")) return 16; // WGSL host-shareable
  if (type.startsWith("vec4")) return 16;
  if (type.startsWith("array<")) return 16;
  if (type === "ChunkTierSource") return 16;
  throw new Error(`unknown align: ${type}`);
}

function computeOffsets(fields: WgslField[]): Record<string, number> {
  let off = 0;
  const out: Record<string, number> = {};
  for (const f of fields) {
    const al = tileAlign(f.type);
    off = Math.ceil(off / al) * al;
    out[f.name] = off;
    off += fieldSize(f.type);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntityDescriptor WGSL ↔ TS layout agreement", () => {
  it("loaded both shader sources via Vite's ?raw import", () => {
    expect(sliceSrc).toContain("struct EntityDescriptor");
    expect(volumeSrc).toContain("struct EntityDescriptor");
  });

  it("slice.wgsl and volume.wgsl declare an identical EntityDescriptor struct", () => {
    expect(extractStruct(sliceSrc, "EntityDescriptor"))
      .toBe(extractStruct(volumeSrc, "EntityDescriptor"));
  });

  it("slice.wgsl and volume.wgsl declare an identical LodInfo struct", () => {
    expect(extractStruct(sliceSrc, "LodInfo"))
      .toBe(extractStruct(volumeSrc, "LodInfo"));
  });

  it("slice.wgsl and volume.wgsl declare an identical ChunkTierSource struct", () => {
    expect(extractStruct(sliceSrc, "ChunkTierSource"))
      .toBe(extractStruct(volumeSrc, "ChunkTierSource"));
  });

  it("WGSL EntityDescriptor field offsets match TS layout constants", () => {
    const fields = parseFields(extractStruct(volumeSrc, "EntityDescriptor"));
    const offsets = computeOffsets(fields);

    expect(offsets.modelMatrix).toBe(OFFSET_MODEL_MATRIX);
    expect(offsets.invModelMatrix).toBe(OFFSET_INV_MODEL_MATRIX);
    expect(offsets.channelMask).toBe(OFFSET_CHANNEL_MASK);
    expect(offsets.tileProxyPoolIndex).toBe(OFFSET_TILE_PROXY_POOL_INDEX);
    expect(offsets.tileProxySlotIndex).toBe(OFFSET_TILE_PROXY_SLOT_INDEX);
    expect(offsets.groupProxyPoolIndex).toBe(OFFSET_GROUP_PROXY_POOL_INDEX);
    expect(offsets.groupProxySlotIndex).toBe(OFFSET_GROUP_PROXY_SLOT_INDEX);
    expect(offsets.tileProxyDims).toBe(OFFSET_TILE_PROXY_DIMS);
    expect(offsets.groupProxyDims).toBe(OFFSET_GROUP_PROXY_DIMS);
    expect(offsets.contrastMin).toBe(OFFSET_CONTRAST_MIN);
    expect(offsets.contrastMax).toBe(OFFSET_CONTRAST_MAX);
    expect(offsets.gamma).toBe(OFFSET_GAMMA);
    expect(offsets.opacity).toBe(OFFSET_OPACITY);
    expect(offsets.colormapLutIndex).toBe(OFFSET_COLORMAP_LUT_INDEX);
    expect(offsets.lodCount).toBe(OFFSET_LOD_COUNT);
    expect(offsets.colormapMode).toBe(OFFSET_COLORMAP_MODE);
    expect(offsets.labelOpacity).toBe(OFFSET_LABEL_OPACITY);
    expect(offsets.lods).toBe(OFFSET_LODS);
    expect(offsets.lods).toBe(DESCRIPTOR_LODS_OFFSET);
    expect(offsets.detailSource).toBe(OFFSET_DETAIL_SOURCE);
    expect(offsets.coarseSource).toBe(OFFSET_COARSE_SOURCE);
  });

  it("WGSL LodInfo field offsets match TS LOD_OFFSET_* constants", () => {
    const fields = parseFields(extractStruct(volumeSrc, "LodInfo"));
    const offsets = computeOffsets(fields);

    expect(offsets.level).toBe(LOD_OFFSET_LEVEL);
    expect(offsets.indirectionOffset).toBe(LOD_OFFSET_INDIRECTION_OFFSET);
    expect(offsets.gridDims).toBe(LOD_OFFSET_GRID_DIMS);
    expect(offsets.chunkDims).toBe(LOD_OFFSET_CHUNK_DIMS);
    expect(offsets.levelDims).toBe(LOD_OFFSET_LEVEL_DIMS);
  });

  it("WGSL ChunkTierSource field offsets match TS SOURCE_OFFSET_* constants", () => {
    const fields = parseFields(extractStruct(volumeSrc, "ChunkTierSource"));
    const offsets = computeOffsets(fields);

    expect(offsets.valid).toBe(SOURCE_OFFSET_VALID);
    expect(offsets.level).toBe(SOURCE_OFFSET_LEVEL);
    expect(offsets.indirectionOffset).toBe(SOURCE_OFFSET_INDIRECTION_OFFSET);
    expect(offsets.gridDims).toBe(SOURCE_OFFSET_GRID_DIMS);
    expect(offsets.chunkDims).toBe(SOURCE_OFFSET_CHUNK_DIMS);
    expect(offsets.levelDims).toBe(SOURCE_OFFSET_LEVEL_DIMS);
  });
});
