import type {
  DatasetManifest,
  GeneratedLevelInfo,
  ImageSpec,
  LevelGeometry,
} from "../manifestTypes.ts";
import type { FailureDescriptor } from "../failureContract.ts";

export type GeneratedChunkStatus =
  | "pending"
  | "unavailable"
  | "failed_transient"
  | "failed_permanent"
  | "ready";

export interface GeneratedLevelSummary {
  total_chunks: number;
  ready_chunks: number;
  pending_chunks: number;
  failed_chunks: number;
}

export interface WireGeneratedLevelAvailability {
  image_id: string;
  info: GeneratedLevelInfo;
  level: LevelGeometry;
  /** Telemetry only; per-chunk status is authoritative. */
  summary?: GeneratedLevelSummary | null;
}

export interface WireGeneratedChunkStatusUpdate {
  image_id: string;
  level_index: number;
  key: string;
  status: GeneratedChunkStatus;
  failure?: FailureDescriptor | null;
  message?: string | null;
}

export interface WireGeneratedAvailabilitySnapshot {
  levels?: WireGeneratedLevelAvailability[];
  chunks?: WireGeneratedChunkStatusUpdate[];
}

export interface WireGeneratedAvailabilityDelta {
  levels?: WireGeneratedLevelAvailability[];
  chunks?: WireGeneratedChunkStatusUpdate[];
}

export type WireGeneratedAvailabilityByDataset = Record<string, WireGeneratedAvailabilitySnapshot>;

interface DatasetAvailability {
  levels: Map<string, CatalogEntry<WireGeneratedLevelAvailability>>;
  chunks: Map<string, CatalogEntry<WireGeneratedChunkStatusUpdate>>;
  chunkCounts: GeneratedStatusCounts;
  summaryCounts: GeneratedStatusCounts;
}

interface CatalogEntry<T> {
  value: T;
  globalKey: string;
}

export const MAX_GENERATED_CATALOG_LEVELS = 4_096;
export const MAX_GENERATED_CATALOG_CHUNKS = 65_536;

export interface GeneratedAvailabilityCatalogLimits {
  /** Hard process-wide retention limit across every open dataset. */
  maxLevels?: number;
  /** Hard process-wide retention limit across every open dataset. */
  maxChunks?: number;
}

export interface GeneratedAvailabilityCatalogStats {
  datasets: number;
  retainedLevels: number;
  retainedChunks: number;
  levelWrites: number;
  chunkWrites: number;
  levelEvictions: number;
  chunkEvictions: number;
}

export interface GeneratedAvailabilitySnapshot {
  levels: WireGeneratedLevelAvailability[];
  chunks: WireGeneratedChunkStatusUpdate[];
}

export interface GeneratedStatusCounts {
  levels: number;
  totalChunks: number;
  ready: number;
  pending: number;
  unavailable: number;
  failed: number;
  failedTransient: number;
  failedPermanent: number;
}

export interface GeneratedStatusCountsByDataset {
  datasetId: string;
  counts: GeneratedStatusCounts;
}

export class GeneratedAvailabilityCatalog {
  private readonly byDataset = new Map<string, DatasetAvailability>();
  /**
   * Map insertion order is the global LRU. The catalog is diagnostic/runtime
   * metadata, not the chunk byte cache: an omitted status safely means
   * "pending" and a later delta repopulates it. Bounding this index therefore
   * prevents a long multi-dataset session from retaining one object per
   * generated chunk forever without weakening readiness correctness.
   */
  private readonly levelOrder = new Map<string, { datasetId: string; localKey: string }>();
  private readonly chunkOrder = new Map<string, { datasetId: string; localKey: string }>();
  private readonly maxLevels: number;
  private readonly maxChunks: number;
  private levelWrites = 0;
  private chunkWrites = 0;
  private levelEvictions = 0;
  private chunkEvictions = 0;

  constructor(limits: GeneratedAvailabilityCatalogLimits = {}) {
    this.maxLevels = normalizedLimit(limits.maxLevels, MAX_GENERATED_CATALOG_LEVELS);
    this.maxChunks = normalizedLimit(limits.maxChunks, MAX_GENERATED_CATALOG_CHUNKS);
  }

  applySnapshot(datasetId: string, snapshot: WireGeneratedAvailabilitySnapshot): void {
    this.removeDataset(datasetId);
    const state = emptyDatasetAvailability();
    this.byDataset.set(datasetId, state);
    this.applyDeltaToState(datasetId, state, snapshot);
  }

  applyDelta(datasetId: string, delta: WireGeneratedAvailabilityDelta): void {
    let state = this.byDataset.get(datasetId);
    if (!state) {
      state = emptyDatasetAvailability();
      this.byDataset.set(datasetId, state);
    }
    this.applyDeltaToState(datasetId, state, delta);
  }

  removeDataset(datasetId: string): void {
    const state = this.byDataset.get(datasetId);
    if (state) {
      for (const entry of state.levels.values()) this.levelOrder.delete(entry.globalKey);
      for (const entry of state.chunks.values()) this.chunkOrder.delete(entry.globalKey);
    }
    this.byDataset.delete(datasetId);
  }

  snapshot(datasetId: string): GeneratedAvailabilitySnapshot {
    const state = this.byDataset.get(datasetId);
    if (!state) return { levels: [], chunks: [] };
    return {
      levels: Array.from(state.levels.values(), (entry) => cloneLevelAvailability(entry.value)),
      chunks: Array.from(state.chunks.values(), (entry) => cloneChunkStatus(entry.value)),
    };
  }

  statusFor(
    datasetId: string,
    imageId: string,
    levelIndex: number,
    key: string,
  ): WireGeneratedChunkStatusUpdate | null {
    const entry = this.byDataset.get(datasetId)?.chunks.get(chunkKey(imageId, levelIndex, key));
    if (!entry) return null;
    this.touch(this.chunkOrder, entry.globalKey);
    return cloneChunkStatus(entry.value);
  }

  statusCounts(datasetId: string): GeneratedStatusCounts {
    return statusCountsForState(this.byDataset.get(datasetId));
  }

  statusCountsByDataset(): GeneratedStatusCountsByDataset[] {
    return Array.from(this.byDataset.entries())
      .map(([datasetId, state]) => ({ datasetId, counts: statusCountsForState(state) }))
      .sort((a, b) => a.datasetId.localeCompare(b.datasetId));
  }

  mergeManifest(datasetId: string, manifest: DatasetManifest): DatasetManifest {
    return mergeGeneratedAvailabilityIntoManifest(manifest, this.snapshot(datasetId));
  }

  /** Deterministic capacity/operation telemetry used by scale regression tests. */
  stats(): GeneratedAvailabilityCatalogStats {
    return {
      datasets: this.byDataset.size,
      retainedLevels: this.levelOrder.size,
      retainedChunks: this.chunkOrder.size,
      levelWrites: this.levelWrites,
      chunkWrites: this.chunkWrites,
      levelEvictions: this.levelEvictions,
      chunkEvictions: this.chunkEvictions,
    };
  }

  private applyDeltaToState(
    datasetId: string,
    state: DatasetAvailability,
    delta: WireGeneratedAvailabilitySnapshot | WireGeneratedAvailabilityDelta,
  ): void {
    for (const level of delta.levels ?? []) {
      const localKey = levelKey(level.image_id, level.info.level_index);
      const existing = state.levels.get(localKey);
      if (existing) {
        subtractLevelSummary(state.summaryCounts, existing.value);
        this.levelOrder.delete(existing.globalKey);
      }
      const value = cloneLevelAvailability(level);
      const globalKey = catalogKey(datasetId, localKey);
      state.levels.set(localKey, { value, globalKey });
      addLevelSummary(state.summaryCounts, value);
      this.levelOrder.set(globalKey, { datasetId, localKey });
      this.levelWrites++;
      this.evictLevelsToLimit();
    }
    for (const chunk of delta.chunks ?? []) {
      const localKey = chunkKey(chunk.image_id, chunk.level_index, chunk.key);
      const existing = state.chunks.get(localKey);
      if (existing) {
        subtractChunkStatus(state.chunkCounts, existing.value.status);
        this.chunkOrder.delete(existing.globalKey);
      }
      const value = cloneChunkStatus(chunk);
      const globalKey = catalogKey(datasetId, localKey);
      state.chunks.set(localKey, { value, globalKey });
      addChunkStatus(state.chunkCounts, value.status);
      this.chunkOrder.set(globalKey, { datasetId, localKey });
      this.chunkWrites++;
      this.evictChunksToLimit();
    }
  }

  private evictLevelsToLimit(): void {
    while (this.levelOrder.size > this.maxLevels) {
      const oldest = this.levelOrder.entries().next().value;
      if (!oldest) return;
      const [globalKey, location] = oldest;
      this.levelOrder.delete(globalKey);
      const state = this.byDataset.get(location.datasetId);
      const entry = state?.levels.get(location.localKey);
      if (!state || !entry || entry.globalKey !== globalKey) continue;
      subtractLevelSummary(state.summaryCounts, entry.value);
      state.levels.delete(location.localKey);
      this.levelEvictions++;
    }
  }

  private evictChunksToLimit(): void {
    while (this.chunkOrder.size > this.maxChunks) {
      const oldest = this.chunkOrder.entries().next().value;
      if (!oldest) return;
      const [globalKey, location] = oldest;
      this.chunkOrder.delete(globalKey);
      const state = this.byDataset.get(location.datasetId);
      const entry = state?.chunks.get(location.localKey);
      if (!state || !entry || entry.globalKey !== globalKey) continue;
      subtractChunkStatus(state.chunkCounts, entry.value.status);
      state.chunks.delete(location.localKey);
      this.chunkEvictions++;
    }
  }

  private touch<T>(order: Map<string, T>, key: string): void {
    const value = order.get(key);
    if (!value) return;
    order.delete(key);
    order.set(key, value);
  }
}

export function mergeGeneratedAvailabilityIntoManifest(
  manifest: DatasetManifest,
  availability: GeneratedAvailabilitySnapshot | WireGeneratedAvailabilitySnapshot,
): DatasetManifest {
  // Callers treat the returned manifest as an independent snapshot, so this
  // deep-copies the whole thing up front (O(images)) rather than sharing
  // untouched sub-objects with the input.
  const next = cloneManifest(manifest);
  // Image id → image, first occurrence winning, so applying L availability
  // levels is O(images + L) instead of an O(images) scan per level.
  const imageById = new Map<string, ImageSpec>();
  for (const image of next.images) {
    if (!imageById.has(image.image_id)) imageById.set(image.image_id, image);
  }
  for (const generated of availability.levels ?? []) {
    const image = imageById.get(generated.image_id);
    if (!image) continue;
    upsertLevelGeometry(image, generated.level);
    upsertGeneratedLevelInfo(image, generated.info);
    if ((generated.info.role ?? "coarse") === "coarse") {
      image.multiscale.coarse_level_index = generated.info.level_index;
    }
  }
  return next;
}

function emptyDatasetAvailability(): DatasetAvailability {
  return {
    levels: new Map(),
    chunks: new Map(),
    chunkCounts: emptyStatusCounts(),
    summaryCounts: emptyStatusCounts(),
  };
}

function emptyStatusCounts(levels = 0): GeneratedStatusCounts {
  return {
    levels,
    totalChunks: 0,
    ready: 0,
    pending: 0,
    unavailable: 0,
    failed: 0,
    failedTransient: 0,
    failedPermanent: 0,
  };
}

function statusCountsForState(state: DatasetAvailability | undefined): GeneratedStatusCounts {
  if (!state) return emptyStatusCounts();
  const source = state.chunks.size > 0 ? state.chunkCounts : state.summaryCounts;
  return { ...source, levels: state.levels.size };
}

function levelKey(imageId: string, levelIndex: number): string {
  return tupleKey(imageId, String(levelIndex));
}

function chunkKey(imageId: string, levelIndex: number, key: string): string {
  return tupleKey(imageId, String(levelIndex), key);
}

function catalogKey(datasetId: string, localKey: string): string {
  return tupleKey(datasetId, localKey);
}

function tupleKey(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join("");
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function addLevelSummary(counts: GeneratedStatusCounts, level: WireGeneratedLevelAvailability): void {
  const summary = level.summary;
  if (!summary) return;
  counts.totalChunks += summary.total_chunks;
  counts.ready += summary.ready_chunks;
  counts.pending += summary.pending_chunks;
  counts.failed += summary.failed_chunks;
}

function subtractLevelSummary(
  counts: GeneratedStatusCounts,
  level: WireGeneratedLevelAvailability,
): void {
  const summary = level.summary;
  if (!summary) return;
  counts.totalChunks -= summary.total_chunks;
  counts.ready -= summary.ready_chunks;
  counts.pending -= summary.pending_chunks;
  counts.failed -= summary.failed_chunks;
}

function addChunkStatus(counts: GeneratedStatusCounts, status: GeneratedChunkStatus): void {
  counts.totalChunks++;
  switch (status) {
    case "ready":
      counts.ready++;
      break;
    case "pending":
      counts.pending++;
      break;
    case "unavailable":
      counts.unavailable++;
      break;
    case "failed_transient":
      counts.failedTransient++;
      counts.failed++;
      break;
    case "failed_permanent":
      counts.failedPermanent++;
      counts.failed++;
      break;
  }
}

function subtractChunkStatus(counts: GeneratedStatusCounts, status: GeneratedChunkStatus): void {
  counts.totalChunks--;
  switch (status) {
    case "ready":
      counts.ready--;
      break;
    case "pending":
      counts.pending--;
      break;
    case "unavailable":
      counts.unavailable--;
      break;
    case "failed_transient":
      counts.failedTransient--;
      counts.failed--;
      break;
    case "failed_permanent":
      counts.failedPermanent--;
      counts.failed--;
      break;
  }
}

function upsertLevelGeometry(image: ImageSpec, incoming: LevelGeometry): void {
  const idx = image.multiscale.levels.findIndex(
    (level, index) => (level.level_index ?? index) === incoming.level_index,
  );
  const clone = cloneLevelGeometry(incoming);
  if (idx >= 0) {
    image.multiscale.levels[idx] = clone;
    return;
  }
  const insertAt = incoming.level_index;
  if (insertAt >= 0 && insertAt <= image.multiscale.levels.length) {
    image.multiscale.levels.splice(insertAt, 0, clone);
  } else {
    image.multiscale.levels.push(clone);
  }
}

function upsertGeneratedLevelInfo(image: ImageSpec, incoming: GeneratedLevelInfo): void {
  const levels = image.multiscale.generated_levels ?? [];
  const idx = levels.findIndex((level) => level.level_index === incoming.level_index);
  const clone = cloneGeneratedLevelInfo(incoming);
  if (idx >= 0) {
    levels[idx] = clone;
  } else {
    levels.push(clone);
  }
  image.multiscale.generated_levels = levels;
}

function cloneManifest(manifest: DatasetManifest): DatasetManifest {
  return {
    ...manifest,
    entities: manifest.entities.map((entity) => ({ ...entity, labels: { ...entity.labels } })),
    transforms: manifest.transforms.map((edge) => ({
      ...edge,
      transform: { matrix: [...edge.transform.matrix] },
    })),
    images: manifest.images.map((image) => ({
      ...image,
      multiscale: {
        ...image.multiscale,
        axes: image.multiscale.axes.map((axis) => ({ ...axis })),
        levels: image.multiscale.levels.map(cloneLevelGeometry),
        generated_levels: image.multiscale.generated_levels?.map(cloneGeneratedLevelInfo) ?? [],
        pinned_axes: image.multiscale.pinned_axes?.map((axis) => ({ ...axis })) ?? [],
      },
    })),
    source_layouts: manifest.source_layouts.map((layout) => ({
      ...layout,
      placements: layout.placements.map((placement) => ({
        ...placement,
        position: [...placement.position] as [number, number],
      })),
    })),
  };
}

function cloneLevelAvailability(
  level: WireGeneratedLevelAvailability,
): WireGeneratedLevelAvailability {
  return {
    image_id: level.image_id,
    info: cloneGeneratedLevelInfo(level.info),
    level: cloneLevelGeometry(level.level),
    summary: level.summary ? { ...level.summary } : level.summary,
  };
}

function cloneGeneratedLevelInfo(info: GeneratedLevelInfo): GeneratedLevelInfo {
  return {
    level_index: info.level_index,
    role: info.role,
    provenance: info.provenance
      ? {
          generator: info.provenance.generator,
          config_id: info.provenance.config_id,
          source_content_id: info.provenance.source_content_id ?? null,
        }
      : undefined,
  };
}

function cloneLevelGeometry(level: LevelGeometry): LevelGeometry {
  return {
    level_index: level.level_index,
    shape: [...level.shape],
    chunk_shape: [...level.chunk_shape],
    grid_shape: [...level.grid_shape],
    scale: [...level.scale],
  };
}

function cloneChunkStatus(
  status: WireGeneratedChunkStatusUpdate,
): WireGeneratedChunkStatusUpdate {
  return {
    image_id: status.image_id,
    level_index: status.level_index,
    key: status.key,
    status: status.status,
    failure: status.failure ? { ...status.failure } : null,
    message: status.message ?? null,
  };
}
