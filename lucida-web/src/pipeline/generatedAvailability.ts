import type {
  DatasetManifest,
  GeneratedLevelInfo,
  ImageSpec,
  LevelGeometry,
} from "../manifestTypes.ts";

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
  levels: Map<string, WireGeneratedLevelAvailability>;
  chunks: Map<string, WireGeneratedChunkStatusUpdate>;
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

  applySnapshot(datasetId: string, snapshot: WireGeneratedAvailabilitySnapshot): void {
    const state = emptyDatasetAvailability();
    this.byDataset.set(datasetId, state);
    this.applyDeltaToState(state, snapshot);
  }

  applyDelta(datasetId: string, delta: WireGeneratedAvailabilityDelta): void {
    let state = this.byDataset.get(datasetId);
    if (!state) {
      state = emptyDatasetAvailability();
      this.byDataset.set(datasetId, state);
    }
    this.applyDeltaToState(state, delta);
  }

  removeDataset(datasetId: string): void {
    this.byDataset.delete(datasetId);
  }

  snapshot(datasetId: string): GeneratedAvailabilitySnapshot {
    const state = this.byDataset.get(datasetId);
    if (!state) return { levels: [], chunks: [] };
    return {
      levels: Array.from(state.levels.values()).map(cloneLevelAvailability),
      chunks: Array.from(state.chunks.values()).map(cloneChunkStatus),
    };
  }

  statusFor(
    datasetId: string,
    imageId: string,
    levelIndex: number,
    key: string,
  ): WireGeneratedChunkStatusUpdate | null {
    const status = this.byDataset.get(datasetId)?.chunks.get(chunkKey(imageId, levelIndex, key));
    return status ? cloneChunkStatus(status) : null;
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

  private applyDeltaToState(
    state: DatasetAvailability,
    delta: WireGeneratedAvailabilitySnapshot | WireGeneratedAvailabilityDelta,
  ): void {
    for (const level of delta.levels ?? []) {
      state.levels.set(levelKey(level.image_id, level.info.level_index), cloneLevelAvailability(level));
    }
    for (const chunk of delta.chunks ?? []) {
      state.chunks.set(
        chunkKey(chunk.image_id, chunk.level_index, chunk.key),
        cloneChunkStatus(chunk),
      );
    }
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
  return { levels: new Map(), chunks: new Map() };
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

  const counts = emptyStatusCounts(state.levels.size);
  if (state.chunks.size > 0) {
    for (const chunk of state.chunks.values()) {
      counts.totalChunks++;
      switch (chunk.status) {
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
    return counts;
  }

  for (const level of state.levels.values()) {
    const summary = level.summary;
    if (!summary) continue;
    counts.totalChunks += summary.total_chunks;
    counts.ready += summary.ready_chunks;
    counts.pending += summary.pending_chunks;
    counts.failed += summary.failed_chunks;
  }
  return counts;
}

function levelKey(imageId: string, levelIndex: number): string {
  return `${imageId}|${levelIndex}`;
}

function chunkKey(imageId: string, levelIndex: number, key: string): string {
  return `${imageId}|${levelIndex}|${key}`;
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
    message: status.message ?? null,
  };
}
