/** Discriminated-union message types for main <-> render worker communication. */

import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { VisibleRegion } from "../pipeline/viewport.ts";

/** Atlas budget for the fixed-size 3D volume atlas (per dataset). */
export const VOLUME_ATLAS_BUDGET = 512 * 1024 * 1024; // 512 MB

/** Atlas budget for the fixed-size 2D slice atlas (per dataset). */
export const SLICE_ATLAS_BUDGET = 64 * 1024 * 1024; // 64 MB

// --- Main -> Worker ---

export interface InitMessage {
  type: "init";
  canvas: OffscreenCanvas;
}

export interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
}

/**
 * A single chunk payload carried by `sliceChunkData`,
 * `volumeChunkData`, and `minimapUploadOverviewChunksForLayer`. The
 * shape is identical across all three callers (previously two parallel
 * `SliceChunk` / `VolumeChunk` interfaces); folded into one `Chunk`
 * type per the dechaos contract scan (Pass 5 finding: "structurally
 * identical, fold or discriminate"). The `chunks: Chunk[]` array shape
 * on the envelope messages is unchanged — that's a wire-protocol
 * contract change tracked separately (see issue #620 discussion).
 */
export interface Chunk {
  data: ArrayBuffer;
  dataType: string;
  x: number;
  y: number;
  z: number;
  key: string;
}

export interface SliceChunkDataMessage {
  type: "sliceChunkData";
  epochs: SceneEpochs;
  /**
   * Worker-side member id (the per-channel chunk owner). Format:
   * `imageId` for single-channel layers, `imageId:chN` for
   * multi-channel composites. Previously named `datasetId`; renamed
   * per dechaos Pass 5 Contract Issue 3 — the field never carried a
   * dataset id at any call site.
   */
  memberId: string;
  chunks: Chunk[];
  level: number;
  z: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  fullResDepth: number;
  levelDepth: number;
  fullResZ: number;
}

export interface VolumeChunkDataMessage {
  type: "volumeChunkData";
  epochs: SceneEpochs;
  /** See {@link SliceChunkDataMessage.memberId}. */
  memberId: string;
  chunks: Chunk[];
  level: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  levelDepth: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
}

/**
 * A generated proxy asset delivered to the worker. Carries the compact
 * `[Z, Y, X]` u16 voxel buffer plus identifying metadata.
 */
export interface ProxyAssetDataMessage {
  type: "proxyAssetData";
  epochs: SceneEpochs;
  datasetId: string;
  entityId: string;
  imageId: string;
  kind: "WellProxy3D" | "FieldProxy3D";
  t: number;
  c: number;
  /** `[Z, Y, X]` voxel counts. */
  dims: [number, number, number];
  dataType: "u16";
  /** Raw u16 voxels (little-endian), `Z*Y*X*2` bytes. */
  data: ArrayBuffer;
}

// Multi-pass render messages

export interface VolumeLayerParams {
  datasetId: string;
  blendMode: "alpha" | "additive" | "max";
  renderMode: "translucent" | "max_intensity";
  scissorRect?: [number, number, number, number];
  /**
   * Per-entity id used by the worker to look up the proxy descriptor
   * (`proxyDescriptorsByEntity`). For field entries this is the field's
   * entity id; for `well-as-proxy` entries this is the well's entity id.
   * Optional for backward compat — when absent, the worker has no proxy
   * binding for this layer.
   */
  entityId?: string;
  /**
   * Index into the per-dataset entity descriptor buffer. Required for
   * the worker to resolve descriptor + display state.
   */
  entityIndex: number;
}

/**
 * Multi-pass volume render request.
 *
 * **Stale-tolerant**: the worker draws with whatever state it has at
 * draw time. Render messages do not run through `isStaleDelivery` —
 * the latest geometry/material state simply renders against the most
 * recent residency. Contrast with chunk + proxy data messages, which
 * carry `epochs` for stale-rejection (`isStaleDelivery` drops a
 * delivery whose epoch is older than the worker's current view of the
 * world).
 *
 * Asymmetry rationale (dechaos Pass 5 Contract Issue 13): re-issuing a
 * render is cheap and the next viewEpoch will fire one anyway; dropping
 * a stale chunk avoids permanently writing wrong-epoch voxels into the
 * atlas.
 */
export interface VolumeRenderMultiPassMessage {
  type: "volumeRenderMultiPass";
  epochs: SceneEpochs;
  layers: VolumeLayerParams[];
  invViewProj: Float32Array;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
  /** Unscaled device-pixel dimensions for cursor sizing (immune to renderScale). */
  fullW: number;
  fullH: number;
  viewProj?: Float32Array;
  camForward?: Float32Array;
  clipDistance?: number;
  clipMode?: number;
}

export interface SliceLayerParams {
  datasetId: string;
  dataW: number;
  dataH: number;
  blendMode: "alpha" | "additive" | "max";
  /** Member position offset in voxels along X (default 0). */
  offsetX?: number;
  /** Member position offset in voxels along Y (default 0). */
  offsetY?: number;
  /** See {@link VolumeLayerParams.entityId}. */
  entityId?: string;
  /** See {@link VolumeLayerParams.entityIndex}. */
  entityIndex: number;
}

/**
 * Multi-pass slice render request.
 *
 * **Stale-tolerant**: see {@link VolumeRenderMultiPassMessage} — same
 * contract. The worker draws with the latest residency at draw time;
 * `epochs` is informational only on this message (no stale-rejection).
 */
export interface SliceRenderMultiPassMessage {
  type: "sliceRenderMultiPass";
  epochs: SceneEpochs;
  layers: SliceLayerParams[];
  zoom: number;
  cx: number;
  cy: number;
  canvasW: number;
  canvasH: number;
}

export interface MinimapLayerParams {
  datasetId: string;
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  contrastMin: number;
  contrastMax: number;
  gamma: number;
}

export interface MinimapInitMessage {
  type: "minimapInit";
  canvas: OffscreenCanvas;
}

export interface MinimapRenderMessage {
  type: "minimapRender";
  layers: MinimapLayerParams[];
  invViewProj: Float32Array;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
}

export interface MinimapDestroyMessage {
  type: "minimapDestroy";
}

export interface MinimapSetOverviewForLayerMessage {
  type: "minimapSetOverviewForLayer";
  datasetId: string;
  data: ArrayBuffer;
  width: number;
  height: number;
  depth: number;
  t: number;
  c: number;
}

export interface MinimapUploadOverviewChunksForLayerMessage {
  type: "minimapUploadOverviewChunksForLayer";
  datasetId: string;
  chunks: Chunk[];
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  levelDepth: number;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
}

export interface RemoveLayerResourcesMessage {
  type: "removeLayerResources";
  datasetId: string;
}

export interface UpdateCursorDataMessage {
  type: "updateCursorData";
  data: ArrayBuffer;
  count: number;
}

export interface DestroyMessage {
  type: "destroy";
}

// --- Cold state (main → worker, per epoch change) ---

export interface ColdStateActiveEntry {
  entityId: string;
  imageId: string;
  targetLod: number;
  detailOwnedLodRange: [number, number]; // [finest, coarsest]
  levels: Array<{
    level: number;
    chunkShape: [number, number, number]; // [Z, Y, X]
    gridShape: [number, number, number];  // chunks per axis
    levelDims: [number, number, number];  // [Z, Y, X] voxel dimensions
  }>;
  /**
   * Promotion mode for this entry (set by Planning, propagated by the
   * orchestrator). The worker uses this to decide which proxy
   * residency rules apply when computing the wanted-set.
   */
  mode: "well-as-proxy" | "fields-with-proxy-fallback" | "fields-with-detail";
  /**
   * Which proxy kind (if any) this entry would prefer. For
   * `well-as-proxy` this is `WellProxy3D`; for field modes it's
   * `FieldProxy3D` if the catalog advertises it.
   */
  proxyKind?: "WellProxy3D" | "FieldProxy3D";
  /** Catalog says the preferred proxy is fetchable. */
  proxyAvailable: boolean;
  /**
   * Catalog says the parent well's `WellProxy3D` is fetchable. For
   * `well-as-proxy` entries equals `proxyAvailable`; for field entries
   * this drives the secondary parent-well-proxy request.
   */
  wellProxyAvailable: boolean;
  /**
   * Parent well id for field entries (so the worker can map a field's
   * descriptor back to its parent's wellProxyHandle). `null` for
   * non-field entries. The orchestrator always emits a string or null
   * — never `undefined` — so the field is non-optional.
   */
  parentWellId: string | null;
  /**
   * Precomputed column-major model matrix mapping the entity's
   * `[0,1]^3` unit cube to world space. The orchestrator derives this
   * from `scene.member_model_matrix` for field entries and synthesises
   * it from the well AABB for `well-as-proxy` entries (see
   * `synthesizeWellRosterEntry` in orchestrator.ts). The worker writes
   * this directly into the descriptor buffer; render messages no longer
   * carry per-frame model matrices.
   */
  modelMatrix: Float32Array;
  /** Inverse of {@link modelMatrix}. */
  invModelMatrix: Float32Array;
  /**
   * Per-channel display state, keyed by channel index. Iteration yields
   * one descriptor entry per (entry, channel), so the worker indexes
   * this map by `cold.visibleChannels[ch]` for each yielded
   * combination. Single-channel mode populates the lone active channel;
   * multi-channel composite populates each visible channel with its own
   * contrast/gamma/opacity/colormap. Display-state changes bump
   * `epochs.selection`, which re-runs the orchestrator and re-emits
   * cold state — this map is the worker's sole source of display state
   * for the descriptor buffer.
   */
  displayStateByChannel: Record<number, ColdStateDisplayState>;
}

/**
 * Per-channel display state in cold state. The worker writes these
 * fields into the GPU `EntityDescriptor` and resolves `colormapName` to
 * a CPU-side LUT texture binding per draw (the descriptor's
 * `colormapLutIndex` is informational, not authoritative).
 *
 * `channelMask` is a single-bit-per-active-channel flag used as a
 * forward-compatibility marker; the existing `imageId:chN` memberId
 * encoding fully captures channel selection.
 */
export interface ColdStateDisplayState {
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  opacity: number;
  colormapName: string;
  channelMask: number;
}

export interface ColdStateMessage {
  type: "coldState";
  epochs: SceneEpochs;
  datasetId: string;
  currentT: number;
  currentZ: number;
  visibleChannels: number[];
  visibleRegion: VisibleRegion;
  activeSet: ColdStateActiveEntry[];
  viewMode: "slice" | "volume";
}

/**
 * Per-viewEpoch hot-state delivery of camera-ray pick coordinates for
 * chunk eviction prioritization. Residency-only (CPU-side) — never
 * read by the shader. The orchestrator emits one message per dataset
 * when `epochs.view` advances; the worker writes each entry into
 * `rayHitPerEntity` so subsequent chunk-data messages can use it for
 * `findFarthestSlot`'s distance metric.
 */
export interface ViewHotStateMessage {
  type: "viewHotState";
  epochs: SceneEpochs;
  datasetId: string;
  /** Per-entity ray-pick local coords for chunk eviction prioritization. */
  rayHitsByEntity: Array<[entityId: string, hit: [number, number, number]]>;
}

export type MainToWorkerMessage =
  | InitMessage
  | ResizeMessage
  | SliceChunkDataMessage
  | VolumeChunkDataMessage
  | ProxyAssetDataMessage
  | VolumeRenderMultiPassMessage
  | SliceRenderMultiPassMessage
  | MinimapInitMessage
  | MinimapRenderMessage
  | MinimapDestroyMessage
  | MinimapSetOverviewForLayerMessage
  | MinimapUploadOverviewChunksForLayerMessage
  | RemoveLayerResourcesMessage
  | UpdateCursorDataMessage
  | DestroyMessage
  | ColdStateMessage
  | ViewHotStateMessage;

// --- Worker -> Main ---

export interface ReadyMessage {
  type: "ready";
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface IntensityRangeMessage {
  type: "intensityRange";
  datasetId: string;
  min: number;
  max: number;
}

export interface ChunksEvictedMessage {
  type: "chunksEvicted";
  /**
   * Worker-side member id (the per-channel chunk owner). Format:
   * `imageId` for single-channel layers, `imageId:chN` for
   * multi-channel composites. Previously named `datasetId`; renamed
   * per dechaos Pass 5 Contract Issue 3.
   */
  memberId: string;
  /** Chunks removed from the atlas (were present, got evicted by closer chunks). */
  keys: string[];
  /** Chunks from the batch that were not inserted (too far, wrong Z, etc.). */
  skipped?: string[];
}

/** A chunk that the worker is missing from its atlas. */
export type MissingChunk = {
  kind: "chunk";
  entityId: string;
  chunkKey: string;
};

/**
 * A proxy asset that the worker is missing from its proxy atlas.
 *
 * `datasetId` is included so the orchestrator can clear its
 * `DeliveryTracker` proxy-delivered entry by composite key without
 * scanning `_lastProxyRequests`. Populated from `coldState.datasetId`
 * in `wantedSet.computeWantedSet`.
 */
export type MissingProxy = {
  kind: "proxy";
  datasetId: string;
  entityId: string;
  proxyKind: "WellProxy3D" | "FieldProxy3D";
  t: number;
  c: number;
};

export interface WantedSetDeltaMessage {
  type: "wantedSetDelta";
  epochs: SceneEpochs;
  /**
   * Discriminated union over chunks and proxies. Existing chunk
   * consumers should match on `kind === "chunk"` to extract `chunkKey`;
   * the orchestrator uses proxy entries to know which proxies to
   * re-deliver from CpuCache.
   */
  missing: Array<MissingChunk | MissingProxy>;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ErrorMessage
  | IntensityRangeMessage
  | ChunksEvictedMessage
  | WantedSetDeltaMessage;
