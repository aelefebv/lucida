/**
 * Auto-contrast limits fitted from a defined statistic over a defined set of
 * chunks, so one view gets one set of limits whatever order its chunks
 * arrive in.
 *
 * The fit reads, per dataset and channel, the chunks the view wants at each
 * visible member's coarsest source level: the coarse tier's level when the
 * source holds it, the target level when the coarse level is generated. A
 * generated level is max-pooled, which lifts every percentile, so it only
 * stands in until the fit's own chunks are resident. The minimap's textures
 * are never read.
 *
 * The statistic is the 0.1st and 99.9th percentiles of a fixed lattice of
 * each chunk's in-bounds samples. Both are order statistics of a multiset,
 * so no arrival order changes them.
 */

import type { DatasetManifest, ImageSpec, LevelGeometry } from "../manifestTypes.ts";
import type { ChunkRequest, RequestPlan } from "./planning/types.ts";
import type { LaneOutstanding } from "./fetch/types.ts";
import { LANES } from "./fetch/types.ts";
import { decodedValues } from "../renderer/dataTypeUtil.ts";

export const LOW_QUANTILE = 0.001;
export const HIGH_QUANTILE = 0.999;

/** Samples read from one chunk at most: a 64 × 64 plane whole, a 64³ block one in 64. */
export const CHUNK_SAMPLES = 4096;

/** Values one fit selects from at most. A wider fit thins every chunk's lattice alike. */
const FIT_SAMPLES = 1 << 20;

export interface ValueRange {
  min: number;
  max: number;
}

export interface ChannelFit {
  /** The contrast limits auto-contrast sets. */
  limits: ValueRange;
  /** The smallest and largest value read, which the contrast slider spans. */
  range: ValueRange;
  /** True while the fit stands in for one whose chunks are still arriving. */
  provisional: boolean;
}

export type AutoContrastListener = (datasetId: string, channel: number, fit: ChannelFit) => void;

/** What the fitter reads of the CPU cache. */
export interface FitCache {
  /** A resident chunk's decoded samples, from either tier. */
  cachedSamples(entityId: string, chunkKey: string): { data: ArrayBuffer; dataType: string } | undefined;
  laneOutstanding(out: LaneOutstanding): LaneOutstanding;
}

/**
 * A lattice over the chunk's in-bounds samples, as finite values. An edge
 * chunk arrives padded to the full chunk shape, and the padding is not data.
 * `chunk` and `extent` are `[z, y, x]`; a buffer shorter than `chunk` is read
 * as a flat run of samples.
 */
export function chunkSamples(
  values: ArrayLike<number>,
  chunk: readonly [number, number, number],
  extent: readonly [number, number, number],
): Float32Array {
  const [cz, cy, cx] = chunk;
  let [d, h, w] = extent.map((n) => Math.max(0, n));
  let strideZ = cy * cx;
  let strideY = cx;
  if (values.length < cz * cy * cx) {
    [d, h, w] = [1, 1, values.length];
    strideZ = 0;
    strideY = 0;
  }
  // The smallest step that keeps the lattice within budget, found by counting
  // rather than by a root, so the same chunk always gets the same lattice.
  let step = 1;
  while (Math.ceil(d / step) * Math.ceil(h / step) * Math.ceil(w / step) > CHUNK_SAMPLES) step++;
  const out = new Float32Array(Math.ceil(d / step) * Math.ceil(h / step) * Math.ceil(w / step));
  let n = 0;
  for (let z = 0; z < d; z += step) {
    for (let y = 0; y < h; y += step) {
      const row = z * strideZ + y * strideY;
      for (let x = 0; x < w; x += step) {
        const v = values[row + x];
        if (Number.isFinite(v)) out[n++] = v;
      }
    }
  }
  return out.subarray(0, n);
}

/**
 * The limits and range of the values in `parts`, or `null` when they hold
 * none. Limits whose percentiles meet, as in mostly-constant data, widen to
 * the range.
 */
export function fitValues(parts: readonly Float32Array[]): Omit<ChannelFit, "provisional"> | null {
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const part of parts) {
    total += part.length;
    for (let i = 0; i < part.length; i++) {
      const v = part[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (total === 0) return null;
  const thin = Math.ceil(total / FIT_SAMPLES);
  const values = new Float32Array(Math.ceil(total / thin) + parts.length);
  let n = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += thin) values[n++] = part[i];
  }
  const selected = values.subarray(0, n);
  const low = selectNth(selected, Math.floor(LOW_QUANTILE * (n - 1)));
  const high = selectNth(selected, Math.ceil(HIGH_QUANTILE * (n - 1)));
  return {
    limits: high > low ? { min: low, max: high } : { min, max },
    range: { min, max },
  };
}

/** The `k`th smallest value of `a`, reordering `a` in place. */
function selectNth(a: Float32Array, k: number): number {
  let left = 0;
  let right = a.length - 1;
  while (right > left) {
    const mid = (left + right) >>> 1;
    if (a[mid] < a[left]) swap(a, mid, left);
    if (a[right] < a[left]) swap(a, right, left);
    if (a[right] < a[mid]) swap(a, right, mid);
    const pivot = a[mid];
    let i = left;
    let j = right;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        swap(a, i, j);
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
  return a[k];
}

function swap(a: Float32Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** One channel's chunks: the ones the fit reads, and the ones that stand in before it can. */
interface ChannelChunks {
  fit: ChunkRequest[];
  fitKey: string;
  standIn: ChunkRequest[];
  standInKey: string;
}

interface DatasetChunks {
  plan: RequestPlan;
  manifest: DatasetManifest;
  byChannel: Map<number, ChannelChunks>;
}

interface ChannelState {
  /** What the last fit read, so the same chunks are not fitted twice. */
  fitted: string | null;
  /** The last fit handed out, or `null` before the first. */
  last: ChannelFit | null;
}

/**
 * Fits each visible channel's contrast limits as its chunks become resident.
 *
 * Before a channel has limits, the coarse tier stands in once it is
 * resident. Once every chunk the fit reads is resident, the fit settles. If
 * some never arrive and the view has nothing left to fetch, as when it
 * settles covering less, the fit reads the resident ones. A view change that
 * changes the chunks keeps the limits until the new chunks settle, so the
 * limits move at most twice per view: once when the stand-in gives way, and
 * once when the fit settles.
 */
export class AutoContrastFitter {
  private readonly chunks = new Map<string, DatasetChunks>();
  private readonly states = new Map<string, Map<number, ChannelState>>();
  private readonly lattices = new WeakMap<ArrayBuffer, Float32Array>();
  private readonly outstanding = emptyLaneOutstanding();

  update(
    plans: ReadonlyMap<string, RequestPlan>,
    datasets: ReadonlyMap<string, { manifest: DatasetManifest }>,
    cache: FitCache,
    emit: AutoContrastListener,
  ): void {
    let fetching: boolean | null = null;
    for (const [datasetId, plan] of plans) {
      const manifest = datasets.get(datasetId)?.manifest;
      if (!manifest) continue;
      let chunks = this.chunks.get(datasetId);
      if (!chunks || chunks.plan !== plan || chunks.manifest !== manifest) {
        chunks = { plan, manifest, byChannel: channelChunks(plan, manifest) };
        this.chunks.set(datasetId, chunks);
      }
      let states = this.states.get(datasetId);
      if (!states) {
        states = new Map();
        this.states.set(datasetId, states);
      }
      for (const [channel, wanted] of chunks.byChannel) {
        let state = states.get(channel);
        if (!state) {
          state = { fitted: null, last: null };
          states.set(channel, state);
        }
        const settled = `settled ${wanted.fitKey}`;
        if (state.fitted === settled) continue;

        const resident = wanted.fit.filter((req) => cache.cachedSamples(req.entityId, req.chunkKey));
        let input: string | null = null;
        let read = resident;
        let provisional = false;
        if (resident.length > 0 && resident.length === wanted.fit.length) {
          input = settled;
        } else if (resident.length > 0 && !(fetching ??= this.viewFetching(cache))) {
          input = `covered ${chunkSetKey(resident)}`;
        } else if (state.last === null && wanted.standIn.length > 0) {
          const standIn = wanted.standIn.filter((req) => cache.cachedSamples(req.entityId, req.chunkKey));
          if (standIn.length === wanted.standIn.length) {
            input = `stand-in ${wanted.standInKey}`;
            read = standIn;
            provisional = true;
          }
        }
        if (input === null || input === state.fitted) continue;
        state.fitted = input;

        const values = this.fit(read, manifest, cache);
        if (!values) continue;
        const fit: ChannelFit = { ...values, provisional };
        if (state.last && sameRange(state.last.limits, fit.limits) && sameRange(state.last.range, fit.range)) {
          continue;
        }
        state.last = fit;
        emit(datasetId, channel, fit);
      }
    }
  }

  /** Forget every fit handed out, so the next update hands out the current ones again. */
  reset(): void {
    this.states.clear();
  }

  forgetDataset(datasetId: string): void {
    this.chunks.delete(datasetId);
    this.states.delete(datasetId);
  }

  /** Whether the CPU cache still has chunks queued or in flight for the view's tiers. */
  private viewFetching(cache: FitCache): boolean {
    const out = cache.laneOutstanding(this.outstanding);
    return (
      out.pendingUnclassified ||
      out.pending.detail + out.pending.coarse + out.inFlight.detail + out.inFlight.coarse > 0
    );
  }

  private fit(
    read: readonly ChunkRequest[],
    manifest: DatasetManifest,
    cache: FitCache,
  ): Omit<ChannelFit, "provisional"> | null {
    const images = new Map(manifest.images.map((image) => [image.image_id, image]));
    const parts: Float32Array[] = [];
    for (const req of read) {
      const entry = cache.cachedSamples(req.entityId, req.chunkKey);
      if (!entry) continue;
      let lattice = this.lattices.get(entry.data);
      if (!lattice) {
        const geometry = chunkGeometry(images.get(req.imageId), req);
        try {
          lattice = chunkSamples(decodedValues(entry.data, entry.dataType), geometry.chunk, geometry.extent);
        } catch {
          continue;
        }
        this.lattices.set(entry.data, lattice);
      }
      parts.push(lattice);
    }
    return fitValues(parts);
  }
}

function emptyLaneOutstanding(): LaneOutstanding {
  const zero = () => Object.fromEntries(LANES.map((lane) => [lane, 0])) as LaneOutstanding["pending"];
  return {
    inFlight: zero(),
    pending: zero(),
    proxyInFlight: 0,
    proxyPending: 0,
    pendingTotal: 0,
    pendingUnclassified: false,
    pendingScanCap: 0,
  };
}

function sameRange(a: ValueRange, b: ValueRange): boolean {
  return a.min === b.min && a.max === b.max;
}

/** Each channel's fit and stand-in chunks out of one plan. */
function channelChunks(plan: RequestPlan, manifest: DatasetManifest): Map<number, ChannelChunks> {
  const generated = new Map<string, Set<number>>();
  for (const image of manifest.images) {
    generated.set(
      image.image_id,
      new Set((image.multiscale.generated_levels ?? []).map((level) => level.level_index)),
    );
  }
  const fitLevel = new Map<string, number>();
  for (const entry of plan.activeSet) {
    if (entry.kind !== "tile") continue;
    const coarse = entry.coarseLevel;
    const sourceCoarse = coarse !== null && !generated.get(entry.imageId)?.has(coarse);
    fitLevel.set(entry.entityId, sourceCoarse ? coarse : entry.detailLevels[0]);
  }

  const byChannel = new Map<number, { fit: Map<string, ChunkRequest>; standIn: Map<string, ChunkRequest> }>();
  for (const req of plan.requests) {
    if (req.lane !== "detail" && req.lane !== "coarse") continue;
    let channel = byChannel.get(req.c);
    if (!channel) {
      channel = { fit: new Map(), standIn: new Map() };
      byChannel.set(req.c, channel);
    }
    // The tiers can want one chunk each, so a chunk is counted once.
    const key = `${req.entityId}/${req.chunkKey}`;
    if (req.level === fitLevel.get(req.entityId)) channel.fit.set(key, req);
    if (req.lane === "coarse") channel.standIn.set(key, req);
  }

  const out = new Map<number, ChannelChunks>();
  for (const [c, { fit, standIn }] of byChannel) {
    const fitChunks = [...fit.values()];
    const standInChunks = [...standIn.values()];
    out.set(c, {
      fit: fitChunks,
      fitKey: chunkSetKey(fitChunks),
      standIn: standInChunks,
      standInKey: chunkSetKey(standInChunks),
    });
  }
  return out;
}

/**
 * A key for a set of chunks, the same in any order: a count and two
 * commutative folds of each chunk's hash. A plan lists its chunks by
 * priority, which moves with the camera even when the set does not.
 */
function chunkSetKey(chunks: readonly ChunkRequest[]): string {
  let sum = 0;
  let xor = 0;
  for (const req of chunks) {
    const h = fnv1a(req.chunkKey, fnv1a(req.entityId, 0x811c9dc5));
    sum = (sum + h) >>> 0;
    xor = (xor ^ h) >>> 0;
  }
  return `${chunks.length}:${sum}:${xor}`;
}

function fnv1a(text: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // A separator, so ("ab", "c") and ("a", "bc") hash apart.
  return Math.imul(h ^ 0x2f, 0x01000193) >>> 0;
}

/** The chunk shape and the part of it inside the level, both `[z, y, x]`. */
function chunkGeometry(
  image: ImageSpec | undefined,
  req: ChunkRequest,
): { chunk: [number, number, number]; extent: [number, number, number] } {
  const levels = image?.multiscale.levels ?? [];
  const level: LevelGeometry | undefined =
    levels.find((l) => l.level_index === req.level) ?? levels[req.level];
  if (!level) return { chunk: [0, 0, 0], extent: [0, 0, 0] };
  const [, , cz, cy, cx] = level.chunk_shape;
  const [, , sz, sy, sx] = level.shape;
  return {
    chunk: [cz, cy, cx],
    extent: [
      Math.min(cz, sz - req.z * cz),
      Math.min(cy, sy - req.y * cy),
      Math.min(cx, sx - req.x * cx),
    ],
  };
}
