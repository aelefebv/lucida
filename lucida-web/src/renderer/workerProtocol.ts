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
 * shape is identical across all three callers; one `Chunk` type rather
 * than two parallel `SliceChunk` / `VolumeChunk` interfaces.
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
  tier?: "detail" | "coarse";
  /**
   * Worker-side member id (the per-channel chunk owner). Format:
   * `imageId` for single-channel layers, `imageId:chN` for
   * multi-channel composites. Not a dataset id.
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
  tier?: "detail" | "coarse";
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
   * Per-entity id retained for compatibility and inspection. For field
   * entries this is the field's entity id; for `well-as-proxy` entries
   * this is the well's entity id. Proxy binding is selected from the
   * member id because proxy residency is scoped by `(entity, t, c)`.
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
 * Asymmetry rationale: re-issuing a render is cheap and the next
 * viewEpoch will fire one anyway; dropping a stale chunk avoids
 * permanently writing wrong-epoch voxels into the atlas.
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

/**
 * Shared fields across both {@link ColdStateActiveEntry} variants. Not
 * exported — consumers should use the discriminated union below and
 * narrow via `entry.kind`.
 */
interface ColdStateActiveEntryBase {
  entityId: string;
  /** Layout placement in full-resolution voxel coordinates. */
  layoutPositionVox?: [number, number];
  targetLod: number;
  detailOwnedLodRange: [number, number]; // [finest, coarsest]
  detailLevel?: number;
  coarseLevel?: number | null;
  wantedLodLevels?: number[];
  levels: Array<{
    level: number;
    chunkShape: [number, number, number]; // [Z, Y, X]
    gridShape: [number, number, number];  // chunks per axis
    levelDims: [number, number, number];  // [Z, Y, X] voxel dimensions
  }>;
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
   * Precomputed column-major model matrix mapping the entity's
   * `[0,1]^3` unit cube to world space. The orchestrator derives this
   * from `scene.member_model_matrix` for field entries and synthesises
   * it from the well AABB for `well-as-proxy` entries (see
   * `synthesizeWellRosterEntry` in tickCoordinator.ts). The worker writes
   * this straight into the descriptor buffer; render messages do not
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
 * Per-entity cold-state record. Discriminated union on `kind`:
 *
 *   - `kind: "field"` — an image member with a real `imageId` and
 *     (usually) chunks to upload. `mode` distinguishes whether the
 *     worker should serve the proxy alongside the chunks
 *     (`fields-with-proxy-fallback`) or rely on chunks only
 *     (`fields-with-detail`). Invisible entries from the planner also
 *     surface as `field` with `mode: "fields-with-detail"` so the
 *     worker doesn't try to fetch proxies for them.
 *   - `kind: "well-as-proxy"` — a synthesised well-level entry with no
 *     backing image; the worker renders the well's proxy directly.
 *     `imageId` is intentionally absent (`?: never`) — use `entityId`
 *     as the routing key throughout the pipeline.
 *
 * `kind` lets TypeScript narrow the variant without the `imageId === ""`
 * sentinel. `mode` is retained for backward compat (logging, debug,
 * existing inspection paths); future work can drop it once every
 * consumer routes through `kind`.
 */
export type ColdStateActiveEntry =
  | (ColdStateActiveEntryBase & {
      kind: "field";
      /** Image member id from the planner. Always a non-empty string. */
      imageId: string;
      mode: "fields-with-detail" | "fields-with-proxy-fallback";
      /**
       * Parent well id for field entries (so the worker can map a
       * field's descriptor back to its parent's wellProxyHandle).
       * `null` for fields that don't belong to a well. The orchestrator
       * always emits a string or null — never `undefined`.
       */
      parentWellId: string | null;
    })
  | (ColdStateActiveEntryBase & {
      kind: "well-as-proxy";
      /**
       * Well-as-proxy entries have no backing image — use the well's
       * `entityId` as the routing key throughout the pipeline.
       * Declared `?: never` so the type system rejects any consumer
       * that tries to read it.
       */
      imageId?: never;
      mode: "well-as-proxy";
      /** Wells have no parent well. */
      parentWellId: null;
    });

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
  /**
   * Explicit scene mode. Do not infer this from `visibleChannels.length`:
   * multi-channel mode can legitimately have one visible channel, and
   * residency/member keys must still use the multi-channel shape.
   */
  multiChannel: boolean;
  visibleChannels: number[];
  visibleRegion: VisibleRegion;
  /** Per-tier render radius as visible-region half-diagonal multipliers. */
  renderRadiusView?: {
    detail: number;
    coarse: number;
  };
  /** Budget-admitted proxy residency keys: `${datasetId}|${entityId}|${kind}|${t}|${c}`. */
  desiredProxyKeys?: string[];
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

export type ChunkFeedbackReason =
  | "evicted"
  | "stale"
  | "wrong-slice"
  | "missing-pool"
  | "missing-entity-meta"
  | "missing-lod-meta"
  | "radius-filter"
  | "atlas-policy";

export interface ChunksEvictedMessage {
  type: "chunksEvicted";
  /**
   * Worker-side member id (the per-channel chunk owner). Format:
   * `imageId` for single-channel layers, `imageId:chN` for
   * multi-channel composites. Not a dataset id.
   */
  memberId: string;
  /**
   * Chunks that should be eligible for delivery again. Usually these
   * were present and got evicted by closer chunks; stale-epoch and
   * wrong-slice deliveries also use this path because they should clear
   * optimistic sent state without entering the rejection tracker.
   */
  keys: string[];
  /** Chunks from the batch rejected by residency policy (atlas full + too far). */
  skipped?: string[];
  /** Observability-only reason for this feedback batch. */
  reason?: ChunkFeedbackReason;
}

/** A chunk that the worker is missing from its atlas. */
export type MissingChunk = {
  kind: "chunk";
  datasetId: string;
  tier?: "detail" | "coarse";
  entityId: string;
  /**
   * Worker-side member id that owns the missing chunk. Single-channel
   * mode uses bare image ids; multi-channel mode uses `imageId:chN`.
   */
  memberId: string;
  /** Channel index parsed from the wanted-set member/channel loop. */
  c: number;
  chunkKey: string;
};

/**
 * A proxy asset that the worker is missing from its proxy atlas.
 *
 * `datasetId` is included so the main thread can clear CpuCache's
 * proxy-sent delivery state by composite key. Populated from
 * `coldState.datasetId` in `wantedSet.computeWantedSet`.
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
  datasetId: string;
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
