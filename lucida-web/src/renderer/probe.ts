/**
 * Which resident texel the renderer draws under one canvas point, worked out
 * on the CPU from the last frame's message, the descriptors' sources and the
 * pools' indirection mirrors. Pure and GPU-free, so the readout reads exactly
 * the sample, level and position the shaders pick.
 *
 * The arithmetic follows `slice.wgsl` and `volume.wgsl` step for step; a change
 * to how either locates a sample must change this too.
 */

import type { SliceRenderMultiPassMessage, VolumeRenderMultiPassMessage } from "./workerProtocol.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";
import type { SampleFormat } from "./dataTypeUtil.ts";
import { INDIRECTION_FAILED, INDIRECTION_MISS } from "./remap.ts";

/** What locating a sample needs of a pool. Slice pools have no `slotsZ`. */
export interface ProbeAtlas {
  indirectionData: ArrayLike<number>;
  slotsX: number;
  slotsY: number;
  slotsZ?: number;
  format: SampleFormat;
}

/** One source a descriptor names, with the pool its draw binds, or null where it binds none. */
export interface ProbeSource<A extends ProbeAtlas> {
  meta: LodIndirectionMeta;
  atlas: A | null;
}

/** Where the renderer's sample under a point comes from. */
export type SampleLocation<A extends ProbeAtlas> =
  | { kind: "resident"; level: number; atlas: A; texel: [number, number, number] }
  | { kind: "failed"; level: number }
  | { kind: "missing" };

/**
 * The sample the renderer draws at a member-local position: the level
 * sources finest first, then the coarse source, as `sampleEntityValue` and
 * `sampleWithFallback` walk them. `pos` is `[u, v]` in a slice pool and
 * `[x, y, z]` in the unit cube in a volume pool, whose Y runs up.
 */
export function locateSample<A extends ProbeAtlas>(
  levels: readonly ProbeSource<A>[],
  coarse: ProbeSource<A> | null,
  pos: readonly number[],
  mode: "slice" | "volume",
): SampleLocation<A> {
  for (const source of coarse ? [...levels, coarse] : levels) {
    const hit = sampleSource(source, pos, mode);
    if (hit) return hit;
  }
  return { kind: "missing" };
}

function sampleSource<A extends ProbeAtlas>(
  { meta, atlas }: ProbeSource<A>,
  pos: readonly number[],
  mode: "slice" | "volume",
): SampleLocation<A> | null {
  // An unbound slot reads slot dims of zero in the shader, which misses.
  if (!atlas || atlas.slotsX === 0 || atlas.slotsY === 0) return null;
  const [levelZ, levelY, levelX] = meta.levelDims;
  const [chunkZ, chunkY, chunkX] = meta.chunkDims;
  const [, gridY, gridX] = meta.gridDims;
  const x = texelIndex(pos[0], levelX);
  if (mode === "slice") {
    const y = texelIndex(pos[1], levelY);
    const cell = meta.offset + Math.floor(y / chunkY) * gridX + Math.floor(x / chunkX);
    const slot = atlas.indirectionData[cell] ?? INDIRECTION_MISS;
    if (slot === INDIRECTION_MISS) return null;
    if (slot === INDIRECTION_FAILED) return { kind: "failed", level: meta.level };
    return {
      kind: "resident",
      level: meta.level,
      atlas,
      texel: [(slot % atlas.slotsX) * chunkX + (x % chunkX), Math.floor(slot / atlas.slotsX) * chunkY + (y % chunkY), 0],
    };
  }
  const slotsZ = atlas.slotsZ ?? 0;
  if (slotsZ === 0) return null;
  const y = texelIndex(1 - pos[1], levelY);
  const z = texelIndex(pos[2], levelZ);
  const cell = meta.offset
    + Math.floor(z / chunkZ) * gridY * gridX
    + Math.floor(y / chunkY) * gridX
    + Math.floor(x / chunkX);
  const slot = atlas.indirectionData[cell] ?? INDIRECTION_MISS;
  if (slot === INDIRECTION_MISS) return null;
  if (slot === INDIRECTION_FAILED) return { kind: "failed", level: meta.level };
  return {
    kind: "resident",
    level: meta.level,
    atlas,
    texel: [
      (slot % atlas.slotsX) * chunkX + (x % chunkX),
      (Math.floor(slot / atlas.slotsX) % atlas.slotsY) * chunkY + (y % chunkY),
      Math.floor(slot / (atlas.slotsX * atlas.slotsY)) * chunkZ + (z % chunkZ),
    ],
  };
}

/** `u32(clamp(i32(f * dim), 0, dim - 1))`, in the shader's float32. */
function texelIndex(f: number, dim: number): number {
  return Math.min(Math.max(Math.trunc(Math.fround(Math.fround(f) * dim)), 0), dim - 1);
}

/**
 * The sample-index position under a member-local position, at level 0 of an
 * entity `dims` (`[Z, Y, X]`) samples big. The volume's Y runs up.
 */
export function levelZeroPosition(
  pos: readonly number[],
  dims: readonly [number, number, number],
  mode: "slice" | "volume",
): [number, number, number] {
  const [depth, height, width] = dims;
  const x = texelIndex(pos[0], width);
  if (mode === "slice") return [x, texelIndex(pos[1], height), 0];
  return [x, texelIndex(1 - pos[1], height), texelIndex(pos[2], depth)];
}

/** A slice layer member under the point, at its member-local UV. */
export interface SliceHit {
  memberId: string;
  uv: [number, number];
}

/** Words per aggregate quad record (`SliceAggregateParams.quads`). */
const QUAD_STRIDE_WORDS = 8;

/**
 * The intensity members a slice frame drew under the canvas point `(fx, fy)`,
 * given as fractions of the canvas, each at the UV its fragment sampled.
 * The point lands on the render pixel it falls in, and that pixel's center is
 * what the shader sampled. `memberOfIndex` names an aggregate quad's member.
 */
export function sliceHits(
  msg: SliceRenderMultiPassMessage,
  fx: number,
  fy: number,
  memberOfIndex: (datasetMemberId: string, entityIndex: number) => string | undefined,
): SliceHit[] {
  const px = pixelCenter(fx, msg.canvasW);
  const py = pixelCenter(fy, msg.canvasH);
  const hits: SliceHit[] = [];
  for (const layer of msg.layers) {
    if (layer.isLabel) continue;
    // Layer-local level-0 sample coordinates, as `buildSliceUniformData`'s transform gives them.
    const u = ((px - msg.canvasW / 2) / msg.zoom + msg.cx - (layer.offsetX ?? 0)) / layer.dataW;
    const v = ((py - msg.canvasH / 2) / msg.zoom + msg.cy - (layer.offsetY ?? 0)) / layer.dataH;
    const agg = layer.aggregate;
    if (!agg) {
      if (inUnit(u) && inUnit(v)) hits.push({ memberId: layer.datasetId, uv: [u, v] });
      continue;
    }
    const f32 = new Float32Array(agg.quads);
    const u32 = new Uint32Array(agg.quads);
    const count = Math.min(agg.count, Math.floor(u32.length / QUAD_STRIDE_WORDS));
    for (let r = 0; r < count; r++) {
      const at = r * QUAD_STRIDE_WORDS;
      const [rx, ry, rw, rh] = [f32[at], f32[at + 1], f32[at + 2], f32[at + 3]];
      if (!(rw > 0 && rh > 0)) continue;
      const mu = (u - rx) / rw;
      const mv = (v - ry) / rh;
      if (!inUnit(mu) || !inUnit(mv)) continue;
      const memberId = memberOfIndex(agg.poolMemberId, u32[at + 4]);
      if (memberId !== undefined) hits.push({ memberId, uv: [mu, mv] });
      // Members of one batch never overlap.
      break;
    }
  }
  return hits;
}

/**
 * Where a volume frame's ray under `(fx, fy)` meets the plane-mode clip plane
 * inside one entity, in its unit cube, or null when the clip plane does not
 * cut the entity there. Only that cut face is a plane of samples: elsewhere a
 * ray composites many, and no one value is under the pointer.
 */
export function clipPlaneHit(
  msg: VolumeRenderMultiPassMessage,
  fx: number,
  fy: number,
  invModel: ArrayLike<number>,
): [number, number, number] | null {
  const clipDist = msg.clipDistance ?? 0;
  const forward = msg.camForward;
  if (!(clipDist > 0) || (msg.clipMode ?? 0) >= 0.5 || !forward) return null;
  const ndcX = (pixelCenter(fx, msg.canvasW) / msg.canvasW) * 2 - 1;
  const ndcY = 1 - (pixelCenter(fy, msg.canvasH) / msg.canvasH) * 2;
  const near = project(msg.invViewProj, [ndcX, ndcY, -1, 1]);
  const far = project(msg.invViewProj, [ndcX, ndcY, 1, 1]);
  const worldRo = near;
  const worldRd = normalize(sub(far, near));
  const ro = transform(invModel, [...worldRo, 1]);
  const rd = normalize(transform(invModel, [...worldRd, 0]));

  const [tNear, tFar] = intersectUnitCube(ro, rd);
  if (tNear >= tFar || tFar < 0) return null;
  const tStart = Math.max(tNear, 0);

  const normal: [number, number, number] = [forward[0], forward[1], forward[2]];
  const denom = dot(worldRd, normal);
  if (Math.abs(denom) <= 1e-6) return null;
  const eye: [number, number, number] = [msg.eye[0], msg.eye[1], msg.eye[2]];
  const planePoint = add(eye, scale(normal, clipDist));
  const tWorld = dot(sub(planePoint, worldRo), normal) / denom;
  if (!(tWorld > 0)) return null;
  const localHit = transform(invModel, [...add(worldRo, scale(worldRd, tWorld)), 1]);
  const localT = dot(sub(localHit, ro), rd) / dot(rd, rd);
  // The plane must be what starts the march: past the cube's entry, before its exit.
  if (!(localT > tStart) || localT >= tFar) return null;
  return add(ro, scale(rd, localT));
}

/** The center of the render pixel a fraction of the canvas falls in. */
function pixelCenter(fraction: number, size: number): number {
  return Math.min(Math.max(Math.floor(fraction * size), 0), Math.max(size - 1, 0)) + 0.5;
}

function inUnit(f: number): boolean {
  return f >= 0 && f <= 1;
}

type Vec3 = [number, number, number];

function project(m: ArrayLike<number>, p: [number, number, number, number]): Vec3 {
  const out = mul4(m, p);
  return [out[0] / out[3], out[1] / out[3], out[2] / out[3]];
}

function transform(m: ArrayLike<number>, p: [number, number, number, number]): Vec3 {
  const out = mul4(m, p);
  return [out[0], out[1], out[2]];
}

/** A column-major 4x4 matrix times a column vector. */
function mul4(m: ArrayLike<number>, [x, y, z, w]: [number, number, number, number]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
}

/** `intersectAABB` in volume.wgsl. */
function intersectUnitCube(ro: Vec3, rd: Vec3): [number, number] {
  let tNear = -Infinity;
  let tFar = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = (0 - ro[i]) / rd[i];
    const t1 = (1 - ro[i]) / rd[i];
    tNear = Math.max(tNear, Math.min(t0, t1));
    tFar = Math.min(tFar, Math.max(t0, t1));
  }
  return [tNear, tFar];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? scale(a, 1 / length) : a;
}

/** A texel read back from a pool, as the value it holds in data units. */
export function texelValue(bits: number, format: SampleFormat): number {
  if (format === "u16") return bits;
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  return view.getFloat32(0);
}
