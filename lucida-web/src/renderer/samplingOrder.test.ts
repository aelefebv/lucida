/**
 * Sampling order across resident levels, asserted at two seams:
 *
 *   1. A TS port of the shaders' per-sample chain reads the SAME
 *      descriptor bytes `serializeEntityDescriptor` writes and the same
 *      per-pool indirection tables the worker fills, and returns the
 *      value the shader would: the finest resident level not finer than
 *      the target, then coarser resident levels, then the coarse tier,
 *      then a miss. Every returned value is one level's sample, never a
 *      blend, which is what a level-index fixture makes visible.
 *   2. The WGSL sources visit the level sources before the coarse source
 *      and consult proxy assets only outside that chain.
 *
 * WGSL cannot run under vitest; the live DPR2 check on the level-index
 * fixture is the end-to-end proof, this test pins the contract the
 * shader math and the descriptor bytes share.
 */

import { describe, expect, it } from "vitest";
import sliceSrc from "./slice.wgsl?raw";
import volumeSrc from "./volume.wgsl?raw";
import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_MAX_LEVEL_SOURCES,
  DESCRIPTOR_SENTINEL_INDEX,
  OFFSET_COARSE_SOURCE,
  OFFSET_LEVEL_SOURCE_COUNT,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_POOL_INDEX,
  SOURCE_OFFSET_VALID,
  levelSourceOffset,
} from "./descriptor/layout.ts";
import { serializeEntityDescriptor } from "./descriptorBuffer.ts";
import { selectEntitySources, type EntitySource } from "./entitySources.ts";
import type { ColdStateActiveEntry } from "./workerProtocol.ts";

const MISS = DESCRIPTOR_SENTINEL_INDEX;

// ---------------------------------------------------------------------------
// A fake pool: an indirection table plus per-slot texel values.
// ---------------------------------------------------------------------------

interface FakePool {
  /** Slots per axis, as the uniform carries it. */
  slotsX: number;
  slotsY: number;
  indirection: Uint32Array;
  /** slot → the value every texel of that slot holds. */
  slotValue: Map<number, number>;
}

function makePool(entries: number, slotsX = 8, slotsY = 8): FakePool {
  return { slotsX, slotsY, indirection: new Uint32Array(entries).fill(MISS), slotValue: new Map() };
}

/** Make chunk cell `(x, y)` of a section resident with `value` in a fresh slot. */
function reside(pool: FakePool, sectionOffset: number, gridX: number, x: number, y: number, value: number): void {
  const slot = pool.slotValue.size;
  pool.indirection[sectionOffset + y * gridX + x] = slot;
  pool.slotValue.set(slot, value);
}

// ---------------------------------------------------------------------------
// TS port of the shaders' chain over the descriptor bytes.
// ---------------------------------------------------------------------------

interface SourceView {
  valid: number;
  level: number;
  indirectionOffset: number;
  poolIndex: number;
  gridDims: [number, number, number];
  chunkDims: [number, number, number];
  levelDims: [number, number, number];
}

function readSource(u32: Uint32Array, offsetBytes: number): SourceView {
  const b = offsetBytes / 4;
  const vec3 = (o: number): [number, number, number] => [u32[b + o / 4], u32[b + o / 4 + 1], u32[b + o / 4 + 2]];
  return {
    valid: u32[b + SOURCE_OFFSET_VALID / 4],
    level: u32[b + SOURCE_OFFSET_LEVEL / 4],
    indirectionOffset: u32[b + SOURCE_OFFSET_INDIRECTION_OFFSET / 4],
    poolIndex: u32[b + SOURCE_OFFSET_POOL_INDEX / 4],
    gridDims: vec3(SOURCE_OFFSET_GRID_DIMS),
    chunkDims: vec3(SOURCE_OFFSET_CHUNK_DIMS),
    levelDims: vec3(SOURCE_OFFSET_LEVEL_DIMS),
  };
}

/** `locateCell2D` + the indirection read + the texel load of one source. */
function sampleSource2D(source: SourceView, pool: FakePool | null, uv: [number, number]): number {
  if (source.valid === 0 || !pool || pool.slotsX === 0 || pool.slotsY === 0) return MISS;
  const [levelW, levelH] = source.levelDims;
  const [chunkW, chunkH] = source.chunkDims;
  const tx = Math.min(Math.max(Math.trunc(uv[0] * levelW), 0), levelW - 1);
  const ty = Math.min(Math.max(Math.trunc(uv[1] * levelH), 0), levelH - 1);
  const gridIdx = source.indirectionOffset + Math.trunc(ty / chunkH) * source.gridDims[0] + Math.trunc(tx / chunkW);
  const slot = pool.indirection[gridIdx];
  if (slot === MISS) return MISS;
  return pool.slotValue.get(slot) ?? MISS;
}

/** `sampleEntityValue` from slice.wgsl, over a serialized entry. */
function sampleEntityValue(
  entry: Uint32Array,
  levelPools: FakePool[],
  coarsePool: FakePool | null,
  uv: [number, number],
): { value: number; from: "level" | "coarse" | "miss"; level: number | null } {
  const count = Math.min(entry[OFFSET_LEVEL_SOURCE_COUNT / 4], DESCRIPTOR_MAX_LEVEL_SOURCES);
  for (let i = 0; i < count; i++) {
    const source = readSource(entry, levelSourceOffset(i));
    const v = sampleSource2D(source, levelPools[source.poolIndex] ?? null, uv);
    if (v !== MISS) return { value: v, from: "level", level: source.level };
  }
  const coarse = readSource(entry, OFFSET_COARSE_SOURCE);
  const v = sampleSource2D(coarse, coarsePool, uv);
  if (v !== MISS) return { value: v, from: "coarse", level: coarse.level };
  return { value: MISS, from: "miss", level: null };
}

// ---------------------------------------------------------------------------
// Fixture: a level-index pyramid (every sample at level L reads L).
// ---------------------------------------------------------------------------

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Four halving levels of a 256² image with 64² chunks; level 3 is the coarse tier. */
const LEVELS = [
  { level: 0, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 4, 4] as [number, number, number], levelDims: [1, 256, 256] as [number, number, number] },
  { level: 1, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 2, 2] as [number, number, number], levelDims: [1, 128, 128] as [number, number, number] },
  { level: 2, chunkShape: [1, 64, 64] as [number, number, number], gridShape: [1, 1, 1] as [number, number, number], levelDims: [1, 64, 64] as [number, number, number] },
  { level: 3, chunkShape: [1, 32, 32] as [number, number, number], gridShape: [1, 1, 1] as [number, number, number], levelDims: [1, 32, 32] as [number, number, number] },
];

function entryWithTarget(target: number): ColdStateActiveEntry {
  return {
    kind: "tile",
    entityId: "e",
    imageId: "img",
    mode: "tiles-with-detail",
    detailLevels: [target],
    coarseLevel: 3,
    levels: LEVELS,
    proxyAvailable: false,
    groupProxyAvailable: false,
    parentGroupId: null,
    modelMatrix: identity(),
    invModelMatrix: identity(),
    displayStateByChannel: {},
  };
}

/** Sections for levels 0..2 in one detail pool (offsets 0, 16, 20) and level 3 in the coarse pool. */
function sections(): EntitySource[] {
  const meta = (lvl: number, offset: number) => {
    const l = LEVELS[lvl];
    return {
      level: lvl,
      gridDims: [l.gridShape[0], l.gridShape[1], l.gridShape[2]] as [number, number, number],
      chunkDims: l.chunkShape,
      levelDims: l.levelDims,
      offset,
    };
  };
  return [
    { tier: "detail", poolKey: "detail", meta: meta(0, 0) },
    { tier: "detail", poolKey: "detail", meta: meta(1, 16) },
    { tier: "detail", poolKey: "detail", meta: meta(2, 20) },
    { tier: "coarse", poolKey: "coarse", meta: meta(3, 0) },
  ];
}

function serialize(entry: ColdStateActiveEntry): Uint32Array {
  const buf = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
  serializeEntityDescriptor(
    buf, 0, entry, selectEntitySources(entry, sections()),
    { contrastMin: 0, contrastMax: 1, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 },
    new Map(), new Map(), [], new Map(),
  );
  return new Uint32Array(buf);
}

describe("sampling order across three resident levels plus coarse", () => {
  // Residency is laid out per quadrant of the image so each UV probes a
  // different depth of the chain:
  //   top-left     (0.1, 0.1): levels 0, 1, 2 and coarse resident
  //   top-right    (0.9, 0.1): levels 1, 2 and coarse resident
  //   bottom-left  (0.1, 0.9): level 2 and coarse resident
  //   bottom-right (0.9, 0.9): only coarse resident
  // Level 2 and the coarse level are single-chunk levels, so residency
  // there covers every quadrant; the finer levels are filled per cell.
  function pools(): { detail: FakePool; coarse: FakePool } {
    const detail = makePool(21);
    // Level 0 (4×4 grid at offset 0): the top-left quadrant's four cells.
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) reside(detail, 0, 4, x, y, 0);
    // Level 1 (2×2 grid at offset 16): top-left and top-right cells.
    reside(detail, 16, 2, 0, 0, 1);
    reside(detail, 16, 2, 1, 0, 1);
    // Level 2 (1×1 grid at offset 20): the whole image.
    reside(detail, 20, 1, 0, 0, 2);
    const coarse = makePool(1);
    reside(coarse, 0, 1, 0, 0, 3);
    return { detail, coarse };
  }

  it("returns the finest resident level not finer than the target, then coarser levels, then coarse", () => {
    const { detail, coarse } = pools();
    const entry = serialize(entryWithTarget(0));
    expect(sampleEntityValue(entry, [detail], coarse, [0.1, 0.1])).toEqual({ value: 0, from: "level", level: 0 });
    expect(sampleEntityValue(entry, [detail], coarse, [0.9, 0.1])).toEqual({ value: 1, from: "level", level: 1 });
    expect(sampleEntityValue(entry, [detail], coarse, [0.1, 0.9])).toEqual({ value: 2, from: "level", level: 2 });
  });

  it("falls to the coarse tier where no level source is resident, and to a miss where nothing is", () => {
    const { detail, coarse } = pools();
    // Drop level 2's chunk so the bottom-right quadrant reaches the coarse tier.
    detail.indirection[20] = MISS;
    const entry = serialize(entryWithTarget(0));
    expect(sampleEntityValue(entry, [detail], coarse, [0.9, 0.9])).toEqual({ value: 3, from: "coarse", level: 3 });
    coarse.indirection[0] = MISS;
    expect(sampleEntityValue(entry, [detail], coarse, [0.9, 0.9])).toEqual({ value: MISS, from: "miss", level: null });
  });

  it("never samples a level finer than the target even when its chunks are resident", () => {
    const { detail, coarse } = pools();
    // Target 1: level 0's resident chunks in the top-left quadrant are
    // skipped in favour of level 1's.
    const entry = serialize(entryWithTarget(1));
    expect(sampleEntityValue(entry, [detail], coarse, [0.1, 0.1])).toEqual({ value: 1, from: "level", level: 1 });
    // Target 2: level 1 is skipped too.
    const entry2 = serialize(entryWithTarget(2));
    expect(sampleEntityValue(entry2, [detail], coarse, [0.9, 0.1])).toEqual({ value: 2, from: "level", level: 2 });
  });

  it("every sample is one level's integer value, never a blend", () => {
    const { detail, coarse } = pools();
    const entry = serialize(entryWithTarget(0));
    const seen = new Set<number>();
    for (let y = 0.05; y < 1; y += 0.1) {
      for (let x = 0.05; x < 1; x += 0.1) {
        const s = sampleEntityValue(entry, [detail], coarse, [x, y]);
        expect(Number.isInteger(s.value)).toBe(true);
        expect(s.value).toBeLessThanOrEqual(3);
        seen.add(s.value);
      }
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});

describe("the shaders visit the chain in the same order", () => {
  function body(src: string, fnName: string): string {
    const start = src.indexOf(`fn ${fnName}(`);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    return src.slice(start, end);
  }

  it("slice.wgsl samples level sources, then coarse, and proxies only outside the chunk-tier branch", () => {
    const chain = body(sliceSrc, "sampleEntityValue");
    const level = chain.indexOf("sampleLevel2D(");
    const coarse = chain.indexOf("sampleCoarse2D(");
    const proxy = chain.indexOf("sampleProxy2D(");
    expect(level).toBeGreaterThan(-1);
    expect(coarse).toBeGreaterThan(level);
    expect(proxy).toBeGreaterThan(coarse);
    // The level loop iterates the descriptor's level sources in order.
    expect(chain).toMatch(/for \(var i = 0u; i < count; i\+\+\)/);
    expect(chain).toMatch(/levelSources\[i\]/);
  });

  it("volume.wgsl samples level sources, then coarse, and steps by the answering level's spacing", () => {
    const chain = body(volumeSrc, "sampleWithFallback");
    const level = chain.indexOf("sampleLevelVolume(");
    const coarse = chain.indexOf("sampleCoarseVolume(");
    const proxy = chain.indexOf("sampleProxy(");
    expect(level).toBeGreaterThan(-1);
    expect(coarse).toBeGreaterThan(level);
    expect(proxy).toBeGreaterThan(coarse);
    // The step follows the sampled source's own level dims.
    expect(chain).toMatch(/out\.step = stepForDims\(activeEntity\.levelSources\[i\]\.levelDims\)/);
    expect(chain).toMatch(/out\.step = stepForDims\(activeEntity\.coarseSource\.levelDims\)/);
  });
});
