/**
 * Which resident texel the renderer draws under one canvas point, worked out
 * on the CPU from the last frame's message, the descriptors' sources and the
 * pools' indirection mirrors; in 3D, which texels a ray's march reads and
 * which of them its pixel is drawn from. Pure and GPU-free, so the readout
 * reads exactly the sample, level and position the shaders pick.
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
  return answeringSource(levels, coarse, pos, mode).location;
}

/** {@link locateSample}, with the source that answered: the finest one bound when none did. */
function answeringSource<A extends ProbeAtlas>(
  levels: readonly ProbeSource<A>[],
  coarse: ProbeSource<A> | null,
  pos: readonly number[],
  mode: "slice" | "volume",
): { location: SampleLocation<A>; source: ProbeSource<A> | null } {
  for (const source of coarse ? [...levels, coarse] : levels) {
    const location = sampleSource(source, pos, mode);
    if (location) return { location, source };
  }
  return { location: { kind: "missing" }, source: levels[0] ?? coarse };
}

/** An unbound slot reads slot dims of zero in the shader, which misses everywhere. */
function readable<A extends ProbeAtlas>({ atlas }: ProbeSource<A>, mode: "slice" | "volume"): boolean {
  return !!atlas && atlas.slotsX !== 0 && atlas.slotsY !== 0 && (mode === "slice" || (atlas.slotsZ ?? 0) !== 0);
}

function sampleSource<A extends ProbeAtlas>(
  source: ProbeSource<A>,
  pos: readonly number[],
  mode: "slice" | "volume",
): SampleLocation<A> | null {
  const { meta, atlas } = source;
  if (!atlas || !readable(source, mode)) return null;
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

/**
 * A slice layer member under the point, at its member-local UV. A label
 * overlay's hit carries the entity whose image it overlays, and that image's
 * level-0 extent in samples its quad spans.
 */
export interface SliceHit {
  memberId: string;
  uv: [number, number];
  label?: { entityId: string | undefined; dataW: number; dataH: number; chunk?: { t: number; plane: number } };
}

/** Words per aggregate quad record (`SliceAggregateParams.quads`). */
const QUAD_STRIDE_WORDS = 8;

/**
 * The members and label overlays a slice frame drew under the canvas point
 * `(fx, fy)`, given as fractions of the canvas, each at the UV its fragment
 * sampled. The point lands on the render pixel it falls in, and that pixel's
 * center is what the shader sampled. `memberOfIndex` names an aggregate
 * quad's member.
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
    // Layer-local level-0 sample coordinates, as `buildSliceUniformData`'s transform gives them.
    const u = ((px - msg.canvasW / 2) / msg.zoom + msg.cx - (layer.offsetX ?? 0)) / layer.dataW;
    const v = ((py - msg.canvasH / 2) / msg.zoom + msg.cy - (layer.offsetY ?? 0)) / layer.dataH;
    if (layer.isLabel) {
      if (inUnit(u) && inUnit(v)) {
        const [dataW, dataH] = layer.labelSamples ?? [layer.dataW, layer.dataH];
        hits.push({
          memberId: layer.datasetId,
          uv: [u, v],
          label: { entityId: layer.entityId, dataW, dataH, chunk: layer.labelChunk },
        });
      }
      continue;
    }
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
  if (!((msg.clipDistance ?? 0) > 0) || (msg.clipMode ?? 0) >= 0.5 || !msg.camForward) return null;
  const ray = entityRay(msg, fx, fy, invModel);
  if (!ray) return null;
  const localT = clipPlaneT(msg, ray, invModel);
  // The plane must be what starts the march: past the cube's entry, before its exit.
  if (localT === null || !(localT > Math.max(ray.tNear, 0)) || localT >= ray.tFar) return null;
  return add(ray.ro, scale(ray.rd, localT));
}

/** The ray under a canvas point, in world space and in one entity's unit cube, as volume.wgsl's `fs` builds it. */
interface EntityRay {
  worldRo: Vec3;
  worldRd: Vec3;
  ro: Vec3;
  rd: Vec3;
  /** Where the ray enters and leaves the unit cube. */
  tNear: number;
  tFar: number;
}

/** The ray under `(fx, fy)` through one entity, or null where it misses the entity's cube. */
function entityRay(
  msg: VolumeRenderMultiPassMessage,
  fx: number,
  fy: number,
  invModel: ArrayLike<number>,
): EntityRay | null {
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
  return { worldRo, worldRd, ro, rd, tNear, tFar };
}

/** Where the plane-mode clip plane meets the ray, as the cube's ray parameter; null where it doesn't, ahead of the eye. */
function clipPlaneT(msg: VolumeRenderMultiPassMessage, ray: EntityRay, invModel: ArrayLike<number>): number | null {
  const forward = msg.camForward;
  if (!forward) return null;
  const normal: Vec3 = [forward[0], forward[1], forward[2]];
  const denom = dot(ray.worldRd, normal);
  if (Math.abs(denom) <= 1e-6) return null;
  const eye: Vec3 = [msg.eye[0], msg.eye[1], msg.eye[2]];
  const planePoint = add(eye, scale(normal, msg.clipDistance ?? 0));
  const tWorld = dot(sub(planePoint, ray.worldRo), normal) / denom;
  if (!(tWorld > 0)) return null;
  return localRayT(ray, invModel, add(ray.worldRo, scale(ray.worldRd, tWorld)));
}

/** Where the far side of the sphere-mode clip sphere meets the ray, as the cube's ray parameter; null where it doesn't, ahead of the eye. */
function clipSphereT(msg: VolumeRenderMultiPassMessage, ray: EntityRay, invModel: ArrayLike<number>): number | null {
  const radius = msg.clipDistance ?? 0;
  const oc = sub(ray.worldRo, [msg.eye[0], msg.eye[1], msg.eye[2]]);
  const a = dot(ray.worldRd, ray.worldRd);
  const b = 2 * dot(oc, ray.worldRd);
  const c = dot(oc, oc) - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const tWorld = (-b + Math.sqrt(disc)) / (2 * a);
  if (!(tWorld > 0)) return null;
  return localRayT(ray, invModel, add(ray.worldRo, scale(ray.worldRd, tWorld)));
}

function localRayT(ray: EntityRay, invModel: ArrayLike<number>, worldPoint: Vec3): number {
  const local = transform(invModel, [...worldPoint, 1]);
  return dot(sub(local, ray.ro), ray.rd) / dot(ray.rd, ray.rd);
}

/** The stretch of a ray a volume frame marches through one entity, in its unit cube. */
export interface MarchSpan {
  ro: Vec3;
  rd: Vec3;
  tStart: number;
  tEnd: number;
}

/**
 * What a volume frame marches of the ray under `(fx, fy)` through one entity:
 * from where the ray enters the cube, or leaves the clip plane or sphere if
 * that is later, to where it leaves the cube. Null where nothing is marched.
 */
export function marchSpan(
  msg: VolumeRenderMultiPassMessage,
  fx: number,
  fy: number,
  invModel: ArrayLike<number>,
): MarchSpan | null {
  const ray = entityRay(msg, fx, fy, invModel);
  if (!ray) return null;
  let tStart = Math.max(ray.tNear, 0);
  if ((msg.clipDistance ?? 0) > 0) {
    const clipT = (msg.clipMode ?? 0) < 0.5 ? clipPlaneT(msg, ray, invModel) : clipSphereT(msg, ray, invModel);
    if (clipT !== null) tStart = Math.max(tStart, clipT);
  }
  if (tStart >= ray.tFar) return null;
  return { ro: ray.ro, rd: ray.rd, tStart, tEnd: ray.tFar };
}

/** One sample a volume march reads: where, in the unit cube, and what answers there. */
export interface MarchStep<A extends ProbeAtlas> {
  pos: Vec3;
  location: SampleLocation<A>;
}

/**
 * The samples a volume march reads along `span`, in order, as volume.wgsl's
 * loops take them: each step is the answering level's own spacing, floored so
 * `steps` of them reach the end, and a miss steps on to the far side of the
 * chunk cell every source missed in. `steps` is 512 for a translucent or label
 * march and 256 for MIP. Which samples are read depends only on residency, so
 * they are known before any value is. The march runs in float32, as the
 * shader's does, so hundreds of steps don't drift off the shader's positions.
 */
export function marchSamples<A extends ProbeAtlas>(
  levels: readonly ProbeSource<A>[],
  coarse: ProbeSource<A> | null,
  span: MarchSpan,
  steps: number,
): MarchStep<A>[] {
  const f = Math.fround;
  const [ox, oy, oz] = span.ro.map(f);
  const [dx, dy, dz] = span.rd.map(f);
  const tEnd = f(span.tEnd);
  const minStep = f(f(tEnd - f(span.tStart)) / steps);
  const out: MarchStep<A>[] = [];
  let t = f(span.tStart);
  for (let i = 0; i < steps && t < tEnd; i++) {
    const pos: Vec3 = [f(ox + f(dx * t)), f(oy + f(dy * t)), f(oz + f(dz * t))];
    const { location, source } = answeringSource(levels, coarse, pos, "volume");
    out.push({ pos, location });
    // An entity that binds no tier has no level to step by, so it misses at the unit step.
    let step = source ? stepForDims(source.meta.levelDims) : 1;
    if (source && location.kind === "missing") {
      const rd: Vec3 = [dx, dy, dz];
      let skip = NO_CELL_EXIT;
      for (const s of coarse ? [...levels, coarse] : levels) {
        if (readable(s, "volume")) skip = Math.min(skip, cellExitDistance(s.meta, pos, rd));
      }
      step = Math.max(step, f(skip + CELL_EXIT_NUDGE));
    }
    t = f(t + Math.max(step, minStep));
  }
  return out;
}

/** volume.wgsl's `CELL_EXIT_NUDGE` and `NO_CELL_EXIT`. */
const CELL_EXIT_NUDGE = Math.fround(1e-5);
const NO_CELL_EXIT = Math.fround(1e30);

/** `cellExitDistance` in volume.wgsl, in float32. */
function cellExitDistance(meta: LodIndirectionMeta, pos: Vec3, rd: Vec3): number {
  const f = Math.fround;
  const [levelZ, levelY, levelX] = meta.levelDims;
  const [chunkZ, chunkY, chunkX] = meta.chunkDims;
  const axes: Array<[texel: number, dir: number, level: number, chunk: number]> = [
    [f(pos[0] * levelX), f(rd[0] * levelX), levelX, chunkX],
    [f(f(1 - pos[1]) * levelY), f(-rd[1] * levelY), levelY, chunkY],
    [f(pos[2] * levelZ), f(rd[2] * levelZ), levelZ, chunkZ],
  ];
  let exit = NO_CELL_EXIT;
  for (const [texel, dir, level, chunk] of axes) {
    // An axis the ray runs parallel to never bounds the exit.
    if (Math.abs(dir) < f(1e-12)) continue;
    const lo = Math.floor(Math.min(Math.max(Math.floor(texel), 0), level - 1) / chunk) * chunk;
    exit = Math.min(exit, f(f((dir > 0 ? lo + chunk : lo) - texel) / dir));
  }
  return Math.max(exit, 0);
}

/** `stepForDims` in volume.wgsl: two thirds of a sample along the densest axis. */
function stepForDims(dims: readonly number[]): number {
  return Math.fround(1 / Math.fround(Math.max(dims[0], dims[1], dims[2], 1) * 1.5));
}

/** What a march read at one sample: the value in data units, or why there is none. */
export type MarchedValue = number | "missing" | "failed";

/** The contrast window a member draws through. */
export interface DisplayWindow {
  contrastMin: number;
  contrastMax: number;
  gamma: number;
}

/** A translucent march records the pixel's depth at the first sample past this normalized value. */
const DEPTH_THRESHOLD = 0.01;

/** A MIP march stops once its maximum reaches this. */
const MIP_EARLY_OUT = 0.98;

/**
 * The index of the sample an intensity pixel is drawn from, or -1 where none
 * is. A translucent pixel blends many samples, so this is the first the shader
 * counts as the pixel's surface, where it records depth. A MIP pixel is its
 * brightest sample: the first to reach the maximum before the march stops
 * early. A u16 zero, a NaN, and a sample not resident add nothing. The window
 * is applied in float32, as the descriptor holds it.
 *
 * The translucent march's own early stop, at alpha 0.98, never comes first:
 * a sample under the threshold adds under 0.01 * 0.08 alpha, and its 512
 * steps stay far short.
 */
export function pickIntensitySample(
  values: readonly MarchedValue[],
  window: DisplayWindow,
  format: SampleFormat,
  mode: "translucent" | "max_intensity",
): number {
  const f = Math.fround;
  const min = f(window.contrastMin);
  const range = f(f(window.contrastMax) - min);
  const gamma = f(window.gamma);
  let best = -1;
  let maxVal = 0;
  for (let i = 0; i < values.length; i++) {
    if (mode === "max_intensity" && maxVal >= MIP_EARLY_OUT) break;
    const value = values[i];
    if (typeof value !== "number" || Number.isNaN(value) || (format === "u16" && value === 0)) continue;
    const normalized = f(Math.pow(Math.min(Math.max(f(f(value - min) / range), 0), 1), gamma));
    if (mode === "translucent") {
      if (normalized > DEPTH_THRESHOLD) return i;
    } else if (normalized > maxVal) {
      maxVal = normalized;
      best = i;
    }
  }
  return best;
}

/**
 * The index of the sample a label overlay draws, or -1 where it draws none:
 * the first id along the ray that isn't background, or the first failed
 * chunk, where the march stops and draws the hatch.
 */
export function pickLabelSample(values: readonly MarchedValue[]): number {
  return values.findIndex((value) => value === "failed" || (typeof value === "number" && value !== 0));
}

/**
 * A point in one unit cube carried into another through world space: `model`
 * takes it out of the first, `invModel` into the second. Column-major.
 */
export function betweenCubes(pos: readonly number[], model: ArrayLike<number>, invModel: ArrayLike<number>): Vec3 {
  return transform(invModel, [...transform(model, [pos[0], pos[1], pos[2], 1]), 1]);
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
