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
import { SLICE_UNIFORM_OFFSETS, SLICE_UNIFORM_SIZE } from "../sliceRenderer.ts";
import { VOLUME_UNIFORM_OFFSETS, VOLUME_UNIFORM_SIZE } from "../volumeRenderer.ts";
import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_LEVEL_SOURCES_OFFSET,
  DESCRIPTOR_MAX_LEVEL_SOURCES,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  OFFSET_CHANNEL_MASK,
  OFFSET_COARSE_SOURCE,
  OFFSET_COLORMAP_LUT_INDEX,
  OFFSET_COLORMAP_MODE,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_LABEL_OPACITY,
  OFFSET_LEVEL_SOURCES,
  OFFSET_LEVEL_SOURCE_COUNT,
  OFFSET_TILE_PROXY_DIMS,
  OFFSET_TILE_PROXY_POOL_INDEX,
  OFFSET_TILE_PROXY_SLOT_INDEX,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
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
  SOURCE_OFFSET_POOL_INDEX,
  SOURCE_OFFSET_VALID,
  levelSourceOffset,
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
  // `<>` brackets (so `array<ChunkTierSource, 4>` stays one field), and
  // parse `name: type`.
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

/** `array<ChunkTierSource, N>` → N, or null for any other type. */
function levelSourceArrayLength(type: string): number | null {
  const m = type.match(/^array<\s*ChunkTierSource\s*,\s*(\d+)\s*>$/);
  return m ? Number(m[1]) : null;
}

/** `array<T, N>` → `[T, N]`, or null for any other type. */
function fixedArray(type: string): [string, number] | null {
  const m = type.match(/^array<\s*([^,>\s]+)\s*,\s*(\d+)\s*>$/);
  return m ? [m[1], Number(m[2])] : null;
}

function fieldSize(type: string): number {
  if (type === "u32" || type === "f32" || type === "i32") return 4;
  if (type === "mat4x4f" || type === "mat4x4<f32>") return 64;
  if (type.startsWith("vec3")) return 12;
  if (type.startsWith("vec4")) return 16;
  const arr = fixedArray(type);
  if (arr) {
    // Array stride is the element size rounded up to its alignment; the
    // two element types here (vec4, ChunkTierSource) are already 16-aligned.
    const [elem, count] = arr;
    return fieldSize(elem) * count;
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

function structSize(fields: WgslField[]): number {
  const offsets = computeOffsets(fields);
  const last = fields[fields.length - 1];
  const end = offsets[last.name] + fieldSize(last.type);
  // Struct alignment is the max member alignment (16 here).
  return Math.ceil(end / 16) * 16;
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

  it("slice.wgsl and volume.wgsl declare an identical ChunkTierSource struct", () => {
    expect(extractStruct(sliceSrc, "ChunkTierSource"))
      .toBe(extractStruct(volumeSrc, "ChunkTierSource"));
  });

  it("neither shader carries the legacy LodInfo array any more", () => {
    for (const src of [sliceSrc, volumeSrc]) {
      expect(src).not.toMatch(/struct\s+LodInfo/);
      expect(src).not.toMatch(/\blods\b/);
      expect(src).not.toMatch(/\blodCount\b/);
      expect(src).not.toMatch(/\blodParams\b/);
    }
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
    expect(offsets.levelSourceCount).toBe(OFFSET_LEVEL_SOURCE_COUNT);
    expect(offsets.colormapMode).toBe(OFFSET_COLORMAP_MODE);
    expect(offsets.labelOpacity).toBe(OFFSET_LABEL_OPACITY);
    expect(offsets.levelSources).toBe(OFFSET_LEVEL_SOURCES);
    expect(offsets.levelSources).toBe(DESCRIPTOR_LEVEL_SOURCES_OFFSET);
    expect(offsets.coarseSource).toBe(OFFSET_COARSE_SOURCE);
    expect(structSize(fields)).toBe(DESCRIPTOR_ENTRY_SIZE);
  });

  it("the level source array is bounded by DESCRIPTOR_MAX_LEVEL_SOURCES in both shaders", () => {
    for (const src of [sliceSrc, volumeSrc]) {
      const fields = parseFields(extractStruct(src, "EntityDescriptor"));
      const levelSources = fields.find((f) => f.name === "levelSources");
      expect(levelSources).toBeDefined();
      expect(levelSourceArrayLength(levelSources!.type)).toBe(DESCRIPTOR_MAX_LEVEL_SOURCES);
    }
    for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
      expect(levelSourceOffset(i)).toBe(OFFSET_LEVEL_SOURCES + i * DESCRIPTOR_TIER_SOURCE_SIZE);
    }
    expect(levelSourceOffset(DESCRIPTOR_MAX_LEVEL_SOURCES)).toBe(OFFSET_COARSE_SOURCE);
  });

  it("each renderer's uniform writer offsets and buffer size match its shader's Uniforms struct", () => {
    const sliceFields = parseFields(extractStruct(sliceSrc, "Uniforms"));
    expect(computeOffsets(sliceFields)).toEqual(SLICE_UNIFORM_OFFSETS);
    expect(structSize(sliceFields)).toBe(SLICE_UNIFORM_SIZE);
    const volumeFields = parseFields(extractStruct(volumeSrc, "Uniforms"));
    expect(computeOffsets(volumeFields)).toEqual(VOLUME_UNIFORM_OFFSETS);
    expect(structSize(volumeFields)).toBe(VOLUME_UNIFORM_SIZE);
  });

  it("both shaders carry one slot-dims entry per level pool binding in their Uniforms", () => {
    for (const src of [sliceSrc, volumeSrc]) {
      const fields = parseFields(extractStruct(src, "Uniforms"));
      const slotDims = fields.find((f) => f.name === "levelAtlasSlotDims");
      expect(fixedArray(slotDims?.type ?? "")).toEqual(["vec4u", DESCRIPTOR_MAX_LEVEL_SOURCES]);
    }
  });

  it("both shaders bind one level texture and one indirection buffer per level source slot", () => {
    for (const src of [sliceSrc, volumeSrc]) {
      for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
        expect(src).toMatch(new RegExp(`@binding\\(\\d+\\)\\s+var\\s+levelTex${i}\\b`));
        expect(src).toMatch(new RegExp(`@binding\\(\\d+\\)\\s+var<storage,\\s*read>\\s+levelIndirection${i}\\b`));
      }
      expect(src).not.toMatch(new RegExp(`\\blevelTex${DESCRIPTOR_MAX_LEVEL_SOURCES}\\b`));
    }
  });

  it("WGSL ChunkTierSource field offsets match TS SOURCE_OFFSET_* constants", () => {
    const fields = parseFields(extractStruct(volumeSrc, "ChunkTierSource"));
    const offsets = computeOffsets(fields);

    expect(offsets.valid).toBe(SOURCE_OFFSET_VALID);
    expect(offsets.level).toBe(SOURCE_OFFSET_LEVEL);
    expect(offsets.indirectionOffset).toBe(SOURCE_OFFSET_INDIRECTION_OFFSET);
    expect(offsets.poolIndex).toBe(SOURCE_OFFSET_POOL_INDEX);
    expect(offsets.gridDims).toBe(SOURCE_OFFSET_GRID_DIMS);
    expect(offsets.chunkDims).toBe(SOURCE_OFFSET_CHUNK_DIMS);
    expect(offsets.levelDims).toBe(SOURCE_OFFSET_LEVEL_DIMS);
    expect(structSize(fields)).toBe(DESCRIPTOR_TIER_SOURCE_SIZE);
  });
});
