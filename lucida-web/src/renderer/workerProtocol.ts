/** Discriminated-union message types for main <-> render worker communication. */

import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
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
  tier: ResidencyTier;
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

/**
 * A batch of PRE-SLICED uint32 label planes for one label overlay member,
 * routed to the r32uint label pool and drawn categorically. Each
 * `chunk.data` is a single 2D Z-plane of `chunkY*chunkX` ids (the delivery
 * path extracts it from the 3D chunk, so ~64 KB crosses the wire, not the
 * full ~8 MB 3D chunk — critical so a whole label lands within one upload
 * budget). `chunk.dataType` is `"Uint32"`; ids are never narrowed to 16
 * bits. `level`/`t`/`c` are informational; `chunk.z` is the plane's own
 * (already-resolved) index and is unused by the writer.
 */
export interface LabelSliceChunkDataMessage {
  type: "labelSliceChunkData";
  epochs: SceneEpochs;
  /** Label overlay member id (the label image id, possibly source-scoped). */
  memberId: string;
  /**
   * Owning dataset id (the `ctx.datasets` key / `removeLayerResources` id).
   * Stamped on the label slice pool so dataset removal can free it — the pool
   * is keyed by {@link memberId} (the label image id), which removal never sees.
   */
  datasetId: string;
  chunks: Chunk[];
  level: number;
  t: number;
  c: number;
  levelWidth: number;
  levelHeight: number;
  chunkX: number;
  chunkY: number;
}

export interface VolumeChunkDataMessage {
  type: "volumeChunkData";
  epochs: SceneEpochs;
  tier: ResidencyTier;
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
 * A batch of WHOLE 3D uint32 label chunks for one label overlay member,
 * routed to the r32uint label VOLUME pool and drawn categorically. Unlike
 * {@link LabelSliceChunkDataMessage} (which pre-slices to a single ~64 KB
 * Z-plane), the 3D first-hit surface needs the full volume, so each
 * `chunk.data` is the entire 3D chunk (~8 MB for a 128³ tile). `chunk.dataType`
 * is `"Uint32"`; ids are never narrowed to 16 bits. `chunk.x/y/z` are the
 * chunk's grid coords, used to place it within the single-tile texture.
 */
export interface LabelVolumeChunkDataMessage {
  type: "labelVolumeChunkData";
  epochs: SceneEpochs;
  /** Label overlay member id (the label image id). */
  memberId: string;
  /**
   * Owning dataset id (the `ctx.datasets` key / `removeLayerResources` id).
   * Stamped on the label volume pool so dataset removal can free it — the pool
   * is keyed by {@link memberId} (the label image id), which removal never sees.
   */
  datasetId: string;
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
  kind: "GroupProxy3D" | "TileProxy3D";
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
   * Per-entity id retained for compatibility and inspection. For tile
   * entries this is the tile's entity id; for `group-as-proxy` entries
   * this is the group's entity id. Proxy binding is selected from the
   * member id because proxy residency is scoped by `(entity, t, c)`.
   */
  entityId?: string;
  /**
   * Index into the per-dataset entity descriptor buffer. Required for
   * the worker to resolve descriptor + display state.
   */
  entityIndex: number;
  /**
   * Categorical label overlay marker. When true the layer is drawn from
   * the r32uint label VOLUME pool via the categorical first-hit shader path
   * (a colored surface over the translucent intensity volume) using a
   * transient descriptor, not the cold-state entity buffer. Absent/false for
   * ordinary intensity layers.
   */
  isLabel?: boolean;
  /**
   * Overlay opacity for a label layer (0..1). Ignored for intensity layers,
   * whose opacity is carried by the descriptor. Defaults to ~0.5 so a label
   * is visible on open without hiding the volume underneath.
   */
  opacity?: number;
  /**
   * Declared `image-label.colors` for a label layer: exact rgba per id from
   * the OME metadata. Rendered verbatim for matching ids (via a small
   * shader-side palette), with the glasbey hash as the fallback for the
   * rest. Absent/empty → every id uses the hash.
   */
  labelColors?: { value: number; rgba: [number, number, number, number] }[];
  /**
   * Column-major model matrix (source member's `[0,1]^3` cube → world) and
   * its inverse, for a label layer only. A label overlays its source image's
   * physical extent, so it renders in the source's world placement; the
   * transient descriptor takes these directly (labels are outside cold
   * state, so the worker can't read them from the descriptor buffer).
   */
  modelMatrix?: Float32Array;
  invModelMatrix?: Float32Array;
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

/**
 * Batched member draw for one aggregate slice layer.
 *
 * A wide collection at overview zoom has tens of thousands of visible
 * members, each covering at most a few device pixels. Rendering one
 * offscreen pass per member makes the frame cost track member count, so
 * members below the pass budget's size threshold are folded into a
 * single layer: one render pass, one quad per member.
 *
 * The quads here are the CANDIDATE set, in roster order (their order is
 * the aggregate's internal draw order). At draw time the worker:
 *   - drops quads for members with nothing resident in any tier
 *     (detail metas, coarse metas, resident proxy) — the same skip rule
 *     the per-member path applies, so residency is judged where it
 *     lives (evictions included);
 *   - groups survivors by pool binding set (detail/coarse chunk pools +
 *     tile/group proxy pools) and issues one instanced draw per group
 *     with exactly those pools bound — members of heterogeneous chunk
 *     shapes/pyramid depths never sample another pool's indirection;
 *   - reads each quad's own descriptor entry in-shader, so display
 *     state (contrast/gamma/opacity/colormap) tracks the CURRENT
 *     descriptor build every frame, like the per-member passes.
 */
export interface SliceAggregateParams {
  /**
   * Member id used to resolve the descriptor buffer and colormap for
   * the whole batch. Members of one (dataset, channel) share both by
   * construction, so any batched member works; the builder uses the
   * first.
   */
  poolMemberId: string;
  /** Number of member quads in {@link quads}. */
  count: number;
  /**
   * Interleaved per-member records, 32 bytes each, matching the
   * shader's `MemberQuad` layout:
   *   - f32 ×4 — quad rect in layer UV: originX, originY, width, height
   *     (relative to the aggregate layer's `offsetX/offsetY` +
   *     `dataW/dataH` extent)
   *   - u32 — entity descriptor index for the member
   *   - u32 ×3 — padding (zero)
   */
  quads: ArrayBuffer;
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
  /**
   * Categorical label overlay marker. When true the layer is drawn from
   * the r32uint label atlas with the categorical shader path (integer id →
   * distinct color, id 0 transparent) instead of the intensity colormap
   * ramp. Absent/false for ordinary intensity layers.
   */
  isLabel?: boolean;
  /**
   * Overlay opacity for a label layer (0..1). Ignored for intensity
   * layers, whose opacity is carried by the descriptor. Defaults to ~0.5
   * so a label is visible on open without hiding the image underneath.
   */
  opacity?: number;
  /**
   * Declared `image-label.colors` for a label layer: exact rgba per id from
   * the OME metadata. Rendered verbatim for matching ids (via a small
   * shader-side palette), with the glasbey hash as the fallback for the
   * rest. Absent/empty → every id uses the hash.
   */
  labelColors?: { value: number; rgba: [number, number, number, number] }[];
  /**
   * Batched member quads for an aggregate layer. When present the
   * worker renders the whole batch in ONE pass (one instanced draw)
   * instead of one pass per member; `datasetId`, `offsetX/offsetY`,
   * `dataW/dataH` describe the batch's union extent, and per-member
   * geometry + descriptor indices ride in {@link SliceAggregateParams}.
   * Absent for ordinary per-member layers.
   */
  aggregate?: SliceAggregateParams;
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
  /** Active channel's colormap name (snake_case, e.g. "magenta"); the minimap
   * binds its own LUT so 2D matches 3D instead of rendering gray. */
  colormap: string;
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

/**
 * Off-screen render of a single Explore-panel candidate thumbnail.
 *
 * Mirrors {@link MinimapRenderMessage} — same coarse per-dataset overview
 * texture, same transient single-entity descriptor, same `renderTo` — but draws
 * to a tiny ({@link size}px) target from the candidate child view's camera and
 * returns one {@link ThumbnailResultMessage} carrying an `ImageBitmap`. The
 * `id` correlates the async reply (the main thread resolves a pending promise
 * by id); `layers` reuse the minimap's per-member model matrix + contrast +
 * colormap so a thumbnail matches the minimap/main view.
 *
 * Stale-tolerant like the other render messages: if the overview texture for a
 * layer isn't resident yet the worker simply renders whatever layers are
 * present (possibly none → a cleared tile), and the panel will re-request.
 */
export interface ThumbnailRenderMessage {
  type: "thumbnailRender";
  /** Correlates the {@link ThumbnailResultMessage} reply. */
  id: number;
  layers: MinimapLayerParams[];
  invViewProj: Float32Array;
  eye: Float32Array;
  /** Square edge length of the off-screen target in device pixels. */
  size: number;
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
 * Shared tiles across both {@link ColdStateActiveEntry} variants. Not
 * exported — consumers should use the discriminated union below and
 * narrow via `entry.kind`.
 */
interface ColdStateActiveEntryBase {
  entityId: string;
  /** Layout placement in full-resolution voxel coordinates. */
  layoutPositionVox?: [number, number];
  levels: Array<{
    level: number;
    chunkShape: [number, number, number]; // [Z, Y, X]
    gridShape: [number, number, number];  // chunks per axis
    levelDims: [number, number, number];  // [Z, Y, X] voxel dimensions
  }>;
  /**
   * Which proxy kind (if any) this entry would prefer. For
   * `group-as-proxy` this is `GroupProxy3D`; for tile modes it's
   * `TileProxy3D` if the catalog advertises it.
   */
  proxyKind?: "GroupProxy3D" | "TileProxy3D";
  /** Catalog says the preferred proxy is fetchable. */
  proxyAvailable: boolean;
  /**
   * Catalog says the parent group's `GroupProxy3D` is fetchable. For
   * `group-as-proxy` entries equals `proxyAvailable`; for tile entries
   * this drives the secondary parent-group-proxy request.
   */
  groupProxyAvailable: boolean;
  /**
   * Precomputed column-major model matrix mapping the entity's
   * `[0,1]^3` unit cube to world space. The orchestrator derives this
   * from `scene.member_model_matrix` for tile entries and synthesises
   * it from the group AABB for `group-as-proxy` entries (see
   * `synthesizeGroupRosterEntry` in tickCoordinator.ts). The worker writes
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
 *   - `kind: "tile"` — an image member with a real `imageId` and
 *     (usually) chunks to upload. `mode` distinguishes whether the
 *     worker should serve the proxy alongside the chunks
 *     (`tiles-with-proxy-fallback`) or rely on chunks only
 *     (`tiles-with-detail`). Invisible entries from the planner also
 *     surface as `tile` with `mode: "tiles-with-detail"` so the
 *     worker doesn't try to fetch proxies for them.
 *   - `kind: "group-as-proxy"` — a synthesised group-level entry with no
 *     backing image; the worker renders the group's proxy directly.
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
      kind: "tile";
      /** Image member id from the planner. Always a non-empty string. */
      imageId: string;
      mode: "tiles-with-detail" | "tiles-with-proxy-fallback";
      /**
       * Levels the detail tier requests for this entity, the target level
       * first. This is the planner's `TileEntry.detailLevels`, carried
       * through unchanged. The worker reads `detailLevels[0]` as the
       * target level: it allocates a detail pool section for the target
       * and for the next coarser levels the pyramid has (see
       * `entitySources.detailTierLevels`), reports missing chunks at the
       * levels listed here, and samples the target first, then the
       * coarser resident levels, never a finer one.
       */
      detailLevels: number[];
      /** Level the coarse tier holds for this entity, or `null` for none. */
      coarseLevel: number | null;
      /**
       * Parent group id for tile entries (so the worker can map a
       * tile's descriptor back to its parent's groupProxyHandle).
       * `null` for tiles that don't belong to a group. The orchestrator
       * always emits a string or null — never `undefined`.
       */
      parentGroupId: string | null;
    })
  | (ColdStateActiveEntryBase & {
      kind: "group-as-proxy";
      /**
       * Group-as-proxy entries have no backing image — use the group's
       * `entityId` as the routing key throughout the pipeline.
       * Declared `?: never` so the type system rejects any consumer
       * that tries to read it.
       */
      imageId?: never;
      mode: "group-as-proxy";
      /** Groups have no parent group. */
      parentGroupId: null;
    });

/** The tile variant of {@link ColdStateActiveEntry}, the entries that carry chunks. */
export type ColdStateTileEntry = Extract<ColdStateActiveEntry, { kind: "tile" }>;

/**
 * Per-channel display state in cold state. The worker writes these
 * tiles into the GPU `EntityDescriptor` and resolves `colormapName` to
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
  /**
   * Shader color model: `0` = continuous colormap ramp (intensity images,
   * the default), `1` = categorical label overlay (integer id → distinct
   * color, id 0 transparent). Absent on states built before labels
   * existed; the descriptor writer defaults it to `0`.
   */
  colormapMode?: number;
  /** Overlay opacity applied in categorical mode. Defaults to `1`. */
  labelOpacity?: number;
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

/**
 * Display-only update for a dataset whose geometry, active set, and
 * residency are unchanged (a contrast / gamma / colormap / opacity edit).
 *
 * Carries just the per-channel display state — no active set, no matrices,
 * no LOD geometry — so the sender builds it in O(visible-channels) and the
 * worker re-applies it to the resident entity descriptor buffer without
 * re-ingesting cold state (no pool/atlas/indirection work). The descriptor
 * is rebuilt from the dataset's most recent {@link ColdStateMessage} with
 * these values swapped in, so the result is byte-identical to a full cold
 * state carrying the same display values.
 *
 * Keyed by channel index exactly like
 * {@link ColdStateActiveEntryBase.displayStateByChannel}; the worker indexes
 * it by `visibleChannels[ch]` per yielded (entry, channel) combination.
 */
export interface ColdStateDisplayMessage {
  type: "coldStateDisplay";
  datasetId: string;
  displayStateByChannel: Record<number, ColdStateDisplayState>;
}

/**
 * Selection-scrub update for a dataset whose visible set, per-entity geometry,
 * LOD, matrices, and display state are all unchanged — only the current
 * timepoint (T) and/or Z-plane moved.
 *
 * `currentT` / `currentZ` are top-level scalars on {@link ColdStateMessage},
 * never part of a per-entity descriptor, so a pure scrub carries just the new
 * selection scalars, the new visible region, and the budget-admitted proxy
 * keys for that selection — no active set, no matrices, no LOD geometry. The
 * worker re-points the dataset's most recent {@link ColdStateMessage} at the
 * new selection and re-ingests it (repacking the atlas indirection for the new
 * plane/timepoint), so the result is identical to a full cold state at the new
 * T / Z without the sender building or re-transmitting the O(active-set)
 * descriptor array.
 */
export interface ColdStateSelectionMessage {
  type: "coldStateSelection";
  datasetId: string;
  currentT: number;
  currentZ: number;
  visibleRegion: VisibleRegion;
  /** Budget-admitted proxy residency keys for the new selection. */
  desiredProxyKeys: string[];
  epochs: SceneEpochs;
}

/**
 * View-move update for a dataset whose active set genuinely changed (a 2D pan,
 * a 2D/3D zoom, or a 3D orbit): tiles scroll in/out and LODs change, but only
 * the camera moved — the timepoint, Z-plane, channel set, per-channel display
 * state, and layout are all unchanged.
 *
 * Rather than re-transmitting the whole O(active-set) descriptor array, this
 * carries only the delta against the dataset's most recent {@link ColdStateMessage}:
 *
 *   - `upserts` — descriptors for entities that are new to the active set or
 *     whose view-dependent fields (detail levels, coarse level, mode, proxy
 *     flags) changed. Built by the exact same `buildColdActiveEntry` path a full cold
 *     state uses, so they are byte-identical to what a full rebuild would emit.
 *   - `removedEntityIds` — entities that left the active set.
 *   - `activeSetOrder` — the full new active-set order, as entity ids. The
 *     worker reorders its patched active set to match, so the descriptor-buffer
 *     entity indices agree with the main thread's by construction.
 *
 * The worker patches its retained cold state (remove removed ids, upsert
 * changed/added by entity id, reorder to `activeSetOrder`) and re-runs the same
 * `applyColdState` a full cold state uses — so the visible result is identical
 * to a full rebuild at the new view, including releasing resources for entities
 * that left. An entity whose view-dependent fields are unchanged keeps its
 * retained descriptor: its model matrix, LOD geometry, and display state are all
 * view-independent (the caller only emits a delta when nothing but the camera
 * moved), so the retained descriptor is exactly what a fresh build would produce.
 */
export interface ColdStateDeltaMessage {
  type: "coldStateDelta";
  datasetId: string;
  epochs: SceneEpochs;
  currentT: number;
  currentZ: number;
  visibleRegion: VisibleRegion;
  /** Per-tier render radius as visible-region half-diagonal multipliers. */
  renderRadiusView?: {
    detail: number;
    coarse: number;
  };
  /** Budget-admitted proxy residency keys for the new view. */
  desiredProxyKeys?: string[];
  /** Entity ids that left the active set since the retained cold state. */
  removedEntityIds: string[];
  /** Descriptors for entities new to the active set or whose descriptor changed. */
  upserts: ColdStateActiveEntry[];
  /** The full new active-set order, as entity ids, so worker/main agree on indices. */
  activeSetOrder: string[];
}

export type MainToWorkerMessage =
  | InitMessage
  | ResizeMessage
  | SliceChunkDataMessage
  | LabelSliceChunkDataMessage
  | VolumeChunkDataMessage
  | LabelVolumeChunkDataMessage
  | ProxyAssetDataMessage
  | VolumeRenderMultiPassMessage
  | SliceRenderMultiPassMessage
  | MinimapInitMessage
  | MinimapRenderMessage
  | MinimapDestroyMessage
  | MinimapUploadOverviewChunksForLayerMessage
  | ThumbnailRenderMessage
  | RemoveLayerResourcesMessage
  | UpdateCursorDataMessage
  | DestroyMessage
  | ColdStateMessage
  | ColdStateDisplayMessage
  | ColdStateSelectionMessage
  | ColdStateDeltaMessage
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

/**
 * Reply to a {@link ThumbnailRenderMessage}, correlated by `id`. `bitmap` is the
 * rendered tile as a transferable `ImageBitmap`, or `null` when nothing could be
 * drawn (no resident overview for any layer yet) so the panel can fall back to
 * the label-only row. The main thread resolves the matching pending promise.
 */
export interface ThumbnailResultMessage {
  type: "thumbnailResult";
  id: number;
  bitmap: ImageBitmap | null;
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
  tier: ResidencyTier;
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
  proxyKind: "GroupProxy3D" | "TileProxy3D";
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

/** A closed range of levels; `min === max` for a single level. */
export interface LevelRange {
  min: number;
  max: number;
}

/**
 * Which level one image-bearing entity's visible pixels come from, as the
 * worker last computed it from the chunk positions its wanted set walks.
 * `targetLevel` is the level pin or the level the screen calls for;
 * `displayed` spans the finest and coarsest level the renderer samples
 * for those positions today: the target level once resident, else the
 * coarser resident sections, else the coarse tier. Every position is
 * served by exactly one level, so `min === max` means the whole visible
 * footprint comes from one level. `displayed` is `null` when no visible
 * position has any resident level yet. `visible` is false when none of
 * the entity's target-level chunks lies in the visible region, in which
 * case `displayed` is `null` too.
 */
export interface EntityLevelReport {
  entityId: string;
  targetLevel: number;
  visible: boolean;
  displayed: LevelRange | null;
}

/**
 * Posted alongside every {@link WantedSetDeltaMessage}: the wanted set walks
 * the visible target-level chunks, and this is what those same chunks say
 * about which level is on screen. Feeds the layer panel's level readout.
 */
export interface EntityLevelsMessage {
  type: "entityLevels";
  datasetId: string;
  entities: EntityLevelReport[];
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ErrorMessage
  | IntensityRangeMessage
  | ThumbnailResultMessage
  | ChunksEvictedMessage
  | WantedSetDeltaMessage
  | EntityLevelsMessage;
