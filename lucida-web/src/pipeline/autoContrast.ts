/**
 * Auto-contrast limits fitted from a defined statistic over a defined set of
 * samples, so one view gets one set of limits whatever order its data
 * arrives in.
 *
 * Where the coarse level is the source's, the fit reads, per dataset and
 * channel, the chunks the view wants at each visible member's coarse
 * level. Where it is generated, the fit reads the server's histogram of the
 * source samples under each member's generated level at the view's
 * timepoint, which no pan or zoom changes. A generated level's own values
 * are max-pooled, which lifts every percentile, so they only stand in until
 * the histograms arrive. The minimap's textures are never read.
 *
 * The statistic is the 0.1st and 99.9th percentiles: of a fixed lattice of
 * each chunk's in-bounds samples, or of every sample a histogram counts.
 * Both are order statistics of a multiset, so no arrival order changes them.
 */

import type { DatasetManifest, ImageSpec, LevelGeometry } from "../manifestTypes.ts";
import type { ChunkRequest, RequestPlan } from "./planning/types.ts";
import type { LaneOutstanding } from "./fetch/types.ts";
import { LANES } from "./fetch/types.ts";
import type { HistogramBin } from "./generatedAvailability.ts";
import { decodedValues } from "../renderer/dataTypeUtil.ts";

export const LOW_QUANTILE = 0.001;
export const HIGH_QUANTILE = 0.999;

/** Samples read from one chunk at most: a 64 × 64 plane whole, a 64³ block one in 64. */
export const CHUNK_SAMPLES = 4096;

/** Values one fit selects from at most. A wider fit thins every chunk's lattice alike. */
const FIT_SAMPLES = 1 << 20;

/**
 * A chunk's lattice of finite samples with their smallest and largest value,
 * kept with it, so a fit over many chunks reads each chunk's bounds once
 * rather than every sample again.
 */
export interface Lattice {
  values: Float32Array;
  min: number;
  max: number;
}

/** `values` as a lattice. They must be finite, as {@link chunkSamples} returns them. */
export function lattice(values: Float32Array): Lattice {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { values, min, max };
}

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

/** What the fitter reads of the server's generated levels. */
export interface FitHistograms {
  /** One timepoint and channel's source histogram under a generated level, once the server sent it. */
  histogram(
    datasetId: string,
    imageId: string,
    levelIndex: number,
    t: number,
    c: number,
  ): { readonly bins: readonly HistogramBin[] } | undefined;
}

/** What the fitter reads of the CPU cache. */
export interface FitCache {
  /** A resident chunk's decoded samples, from either tier. */
  cachedSamples(entityId: string, chunkKey: string): { data: ArrayBuffer; dataType: string } | undefined;
  laneOutstanding(out: LaneOutstanding): LaneOutstanding;
  /** Whether the server is still generating the chunk. */
  awaitsServer(req: ChunkRequest): boolean;
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
export function fitValues(parts: readonly Lattice[]): Omit<ChannelFit, "provisional"> | null {
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const part of parts) {
    if (part.values.length === 0) continue;
    total += part.values.length;
    if (part.min < min) min = part.min;
    if (part.max > max) max = part.max;
  }
  if (total === 0) return null;
  const thin = Math.ceil(total / FIT_SAMPLES);
  let n = 0;
  for (const part of parts) n += Math.ceil(part.values.length / thin);
  const [low, high] = selectRanks(
    parts.map((part) => part.values),
    thin,
    Math.floor(LOW_QUANTILE * (n - 1)),
    Math.ceil(HIGH_QUANTILE * (n - 1)),
  );
  return {
    limits: high > low ? { min: low, max: high } : { min, max },
    range: { min, max },
  };
}

/** One count per value of a sample key's top 16 bits; reused, since a fit runs to completion. */
const keyCounts = new Uint32Array(1 << 16);

/**
 * A finite float's bits, as an unsigned key in the float's order: a positive
 * float's bits with the sign set, a negative float's bits all flipped. Zero
 * and negative zero get neighbouring keys, so either can stand for a rank
 * that falls on zeros.
 */
function orderedKey(bits: number): number {
  return ((bits & 0x80000000) !== 0 ? ~bits : bits | 0x80000000) >>> 0;
}

/**
 * The values of ranks `lowRank` and `highRank`, counted from 0, among every
 * `thin`th value of `parts`: the ones a selection from a copy of them would
 * find. One pass counts them by their key's top 16 bits, which names the
 * bucket each rank falls in; a second takes those buckets' values, and a
 * selection inside each finds the rank. On a collection that is two passes
 * over a bounded sample and a selection over a few thousand values, where a
 * selection over the whole sample cost several times as much.
 */
function selectRanks(
  parts: readonly Float32Array[],
  thin: number,
  lowRank: number,
  highRank: number,
): [number, number] {
  const words = parts.map((part) => new Uint32Array(part.buffer, part.byteOffset, part.length));
  keyCounts.fill(0);
  for (const w of words) {
    for (let i = 0; i < w.length; i += thin) keyCounts[orderedKey(w[i]) >>> 16]++;
  }
  let below = 0;
  let lowBucket = -1;
  let lowAt = 0;
  let highBucket = -1;
  let highAt = 0;
  for (let bucket = 0; bucket < keyCounts.length; bucket++) {
    const count = keyCounts[bucket];
    if (lowBucket < 0 && lowRank < below + count) {
      lowBucket = bucket;
      lowAt = lowRank - below;
    }
    if (highRank < below + count) {
      highBucket = bucket;
      highAt = highRank - below;
      break;
    }
    below += count;
  }
  const lows = new Float32Array(keyCounts[lowBucket]);
  const highs = highBucket === lowBucket ? lows : new Float32Array(keyCounts[highBucket]);
  let nLow = 0;
  let nHigh = 0;
  parts.forEach((part, p) => {
    const w = words[p];
    for (let i = 0; i < w.length; i += thin) {
      const bucket = orderedKey(w[i]) >>> 16;
      if (bucket === lowBucket) lows[nLow++] = part[i];
      else if (bucket === highBucket) highs[nHigh++] = part[i];
    }
  });
  return [selectNth(lows, lowAt), selectNth(highs, highAt)];
}

/**
 * The limits and range of every sample in `histograms`, by the percentiles
 * {@link fitValues} takes, or `null` when they count none. Each limit is
 * the near edge of the bin its percentile falls in, the smallest sample for
 * the low limit and the largest for the high one, so a limit is a sample
 * value and never clips more than the percentile does. Bins of two
 * histograms can share a range; walking them by their smallest sample puts
 * a percentile within one bin of where merging them would.
 */
export function fitHistograms(
  histograms: readonly { readonly bins: readonly HistogramBin[] }[],
): Omit<ChannelFit, "provisional"> | null {
  const bins = histograms.flatMap((h) => h.bins).filter((bin) => bin[2] > 0);
  bins.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  let total = 0;
  let max = -Infinity;
  for (const [, binMax, count] of bins) {
    total += count;
    if (binMax > max) max = binMax;
  }
  if (total === 0) return null;
  const lowRank = Math.floor(LOW_QUANTILE * (total - 1));
  const highRank = Math.ceil(HIGH_QUANTILE * (total - 1));
  let below = 0;
  let low: number | null = null;
  let high = max;
  for (const [binMin, binMax, count] of bins) {
    below += count;
    if (low === null && lowRank < below) low = binMin;
    if (highRank < below) {
      high = binMax;
      break;
    }
  }
  const range = { min: bins[0][0], max };
  return { limits: low !== null && high > low ? { min: low, max: high } : range, range };
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

/** One generated level's histogram the fit reads, short of the channel. */
interface HistogramRef {
  imageId: string;
  level: number;
  t: number;
}

/** One channel's chunks: the ones the fit reads, and the ones that stand in before it can. */
interface ChannelChunks {
  fit: ChunkRequest[];
  fitKey: string;
  standIn: ChunkRequest[];
  standInKey: string;
  /**
   * The histograms the fit reads in place of `fit`, when every member the
   * channel shows has a generated coarse level; empty otherwise. `fit` then
   * holds the target level's chunks, read only if no histogram comes.
   */
  histograms: HistogramRef[];
  histogramKey: string;
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
 * Fits each visible channel's contrast limits as its chunks become resident,
 * or its histograms arrive.
 *
 * Before a channel has limits, the coarse tier stands in once it is
 * resident. Once every chunk or histogram the fit reads is in, the fit
 * settles. If some never come and the view has nothing left to fetch, as
 * when it settles covering less, the fit reads the ones that did. A view
 * change that changes what the fit reads keeps the limits until the new fit
 * settles, so the limits move at most twice per view: once when the
 * stand-in gives way, and once when the fit settles. A channel whose
 * histograms are still missing once its view is idle reads its resident
 * target-level chunks in the meantime, one more provisional step.
 */
export class AutoContrastFitter {
  private readonly chunks = new Map<string, DatasetChunks>();
  private readonly states = new Map<string, Map<number, ChannelState>>();
  private readonly lattices = new WeakMap<ArrayBuffer, Lattice>();
  private readonly outstanding = emptyLaneOutstanding();

  update(
    plans: ReadonlyMap<string, RequestPlan>,
    datasets: ReadonlyMap<string, { manifest: DatasetManifest }>,
    cache: FitCache,
    histograms: FitHistograms,
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
        const byHistogram = wanted.histograms.length > 0;
        if (state.fitted === `settled ${byHistogram ? wanted.histogramKey : wanted.fitKey}`) continue;
        const isFetching = () => (fetching ??= this.viewFetching(cache));
        const choice = byHistogram
          ? histogramInput(datasetId, channel, wanted, state, cache, histograms, isFetching)
          : chunkInput(wanted, state, cache, isFetching);
        if (choice === null || choice.input === state.fitted) continue;
        state.fitted = choice.input;

        const values = "histograms" in choice ? fitHistograms(choice.histograms) : this.fit(choice.chunks, manifest, cache);
        if (!values) continue;
        const fit: ChannelFit = { ...values, provisional: choice.provisional };
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
    const parts: Lattice[] = [];
    for (const req of read) {
      const entry = cache.cachedSamples(req.entityId, req.chunkKey);
      if (!entry) continue;
      let part = this.lattices.get(entry.data);
      if (!part) {
        const geometry = chunkGeometry(images.get(req.imageId), req);
        try {
          part = lattice(chunkSamples(decodedValues(entry.data, entry.dataType), geometry.chunk, geometry.extent));
        } catch {
          continue;
        }
        this.lattices.set(entry.data, part);
      }
      parts.push(part);
    }
    return fitValues(parts);
  }
}

/** What one fit reads, and the input key that says whether it has been read. */
type FitInput = { input: string; provisional: boolean } & (
  | { chunks: ChunkRequest[] }
  | { histograms: { readonly bins: readonly HistogramBin[] }[] }
);

function residentOf(reqs: readonly ChunkRequest[], cache: FitCache): ChunkRequest[] {
  return reqs.filter((req) => cache.cachedSamples(req.entityId, req.chunkKey));
}

/** The coarse tier, while the channel has no limits yet and all of it is resident. */
function standInInput(wanted: ChannelChunks, state: ChannelState, cache: FitCache): FitInput | null {
  if (state.last !== null || wanted.standIn.length === 0) return null;
  const held = residentOf(wanted.standIn, cache);
  if (held.length !== wanted.standIn.length) return null;
  return { input: `stand-in ${wanted.standInKey}`, chunks: held, provisional: true };
}

function chunkInput(
  wanted: ChannelChunks,
  state: ChannelState,
  cache: FitCache,
  fetching: () => boolean,
): FitInput | null {
  const resident = residentOf(wanted.fit, cache);
  if (resident.length > 0 && resident.length === wanted.fit.length) {
    return { input: `settled ${wanted.fitKey}`, chunks: resident, provisional: false };
  }
  if (resident.length > 0 && !fetching()) {
    return { input: `covered ${chunkSetKey(resident)}`, chunks: resident, provisional: false };
  }
  return standInInput(wanted, state, cache);
}

function histogramInput(
  datasetId: string,
  channel: number,
  wanted: ChannelChunks,
  state: ChannelState,
  cache: FitCache,
  source: FitHistograms,
  fetching: () => boolean,
): FitInput | null {
  const sent = wanted.histograms.flatMap((ref) => {
    const histogram = source.histogram(datasetId, ref.imageId, ref.level, ref.t, channel);
    return histogram ? [{ ref, histogram }] : [];
  });
  const histograms = sent.map((s) => s.histogram);
  if (sent.length === wanted.histograms.length) {
    return { input: `settled ${wanted.histogramKey}`, histograms, provisional: false };
  }
  // A histogram comes with the last chunk of its timepoint and channel, so
  // while the server still makes chunks the view wants, it is on its way.
  const generating = (req: ChunkRequest) => cache.awaitsServer(req);
  const idle = (): boolean => !fetching() && !wanted.fit.some(generating) && !wanted.standIn.some(generating);
  if (sent.length > 0 && idle()) {
    const key = histogramSetKey(sent.map((s) => s.ref));
    return { input: `covered ${key}`, histograms, provisional: false };
  }
  // None sent with the view idle means the server left the rest of the
  // timepoint and channel to background fill, which may never reach it, or
  // failed. The source's own samples beat the max-pooled stand-in or no
  // limits, and they hold through pans until a histogram comes.
  const standingIn = state.last === null || (state.fitted?.startsWith("stand-in ") ?? false);
  if (sent.length === 0 && standingIn && idle()) {
    const resident = residentOf(wanted.fit, cache);
    if (resident.length > 0) {
      return { input: `fallback ${chunkSetKey(resident)}`, chunks: resident, provisional: true };
    }
  }
  return standInInput(wanted, state, cache);
}

function emptyLaneOutstanding(): LaneOutstanding {
  const zero = () => Object.fromEntries(LANES.map((lane) => [lane, 0])) as LaneOutstanding["pending"];
  return {
    inFlight: zero(),
    pending: zero(),
    pendingTotal: 0,
    pendingUnclassified: false,
    pendingScanCap: 0,
  };
}

function sameRange(a: ValueRange, b: ValueRange): boolean {
  return a.min === b.min && a.max === b.max;
}

/** Each channel's fit and stand-in chunks, and histograms, out of one plan. */
function channelChunks(plan: RequestPlan, manifest: DatasetManifest): Map<number, ChannelChunks> {
  const generated = new Map<string, Set<number>>();
  // Image id → its coarse level, where the server generates it.
  const generatedCoarse = new Map<string, number>();
  for (const image of manifest.images) {
    const levels = new Set((image.multiscale.generated_levels ?? []).map((level) => level.level_index));
    generated.set(image.image_id, levels);
    const coarse = image.multiscale.coarse_level_index;
    if (coarse !== null && coarse !== undefined && levels.has(coarse)) generatedCoarse.set(image.image_id, coarse);
  }
  const fitLevel = new Map<string, number>();
  for (const entry of plan.activeSet) {
    if (entry.kind !== "tile") continue;
    const coarse = entry.coarseLevel;
    const sourceCoarse = coarse !== null && !generated.get(entry.imageId)?.has(coarse);
    fitLevel.set(entry.entityId, sourceCoarse ? coarse : entry.detailLevels[0]);
  }

  interface Gathered {
    fit: Map<string, ChunkRequest>;
    standIn: Map<string, ChunkRequest>;
    histograms: Map<string, HistogramRef> | null;
  }
  const byChannel = new Map<number, Gathered>();
  for (const req of plan.requests) {
    if (req.lane !== "detail" && req.lane !== "coarse") continue;
    let channel = byChannel.get(req.c);
    if (!channel) {
      channel = { fit: new Map(), standIn: new Map(), histograms: new Map() };
      byChannel.set(req.c, channel);
    }
    // The tiers can want one chunk each, so a chunk is counted once.
    const key = `${req.entityId}/${req.chunkKey}`;
    if (req.level === fitLevel.get(req.entityId)) channel.fit.set(key, req);
    if (req.lane === "coarse") channel.standIn.set(key, req);
    // Histograms and lattices weigh samples differently, so a channel with
    // any source coarse member reads lattices throughout.
    const level = generatedCoarse.get(req.imageId);
    if (level === undefined) channel.histograms = null;
    else channel.histograms?.set(`${req.imageId}|${level}|${req.t}`, { imageId: req.imageId, level, t: req.t });
  }

  const out = new Map<number, ChannelChunks>();
  for (const [c, { fit, standIn, histograms }] of byChannel) {
    const fitChunks = [...fit.values()];
    const standInChunks = [...standIn.values()];
    const refs = histograms ? [...histograms.values()] : [];
    out.set(c, {
      fit: fitChunks,
      fitKey: chunkSetKey(fitChunks),
      standIn: standInChunks,
      standInKey: chunkSetKey(standInChunks),
      histograms: refs,
      histogramKey: histogramSetKey(refs),
    });
  }
  return out;
}

/** A key for a set of histograms, the same in any order. */
function histogramSetKey(refs: readonly HistogramRef[]): string {
  return refs
    .map((ref) => `${ref.imageId}|${ref.level}|${ref.t}`)
    .sort()
    .join(",");
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
