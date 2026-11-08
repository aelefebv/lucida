/** Discriminated-union message types for main <-> render worker communication. */

import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { VisibleRegion } from "../pipeline/viewport.ts";
import type { SampleFormat } from "./dataTypeUtil.ts";

export interface InitMessage {
  type: "init";
  canvas: OffscreenCanvas;
  /**
   * The page's reading of the device's memory, in GiB, or null when unknown.
   * The page reads it because only it can tell a touch-only device that
   * reports none; the worker fits its atlas budgets from it.
   */
  deviceMemoryGiB?: number | null;
}

export interface ResizeMessage {
  type: "resize";
  width: number;
  height: number;
}

/** An sRGB color with straight alpha, channels in 0..1. */
export type RgbaColor = readonly [number, number, number, number];

/**
 * The colors the renderer draws that are not data. The worker cannot read
 * styles, so the page resolves them from theme tokens and sends them again
 * whenever the appearance changes.
 */
export interface CanvasColors {
  /** Beneath every layer, in the viewport, the minimap, and thumbnails. */
  background: RgbaColor;
  /** The frame inside each collection member's footprint. */
  tileBorder: RgbaColor;
}

export interface CanvasColorsMessage {
  type: "canvasColors";
  colors: CanvasColors;
}

/**
 * A single chunk payload carried by `sliceChunkData`, `volumeChunkData`,
 * and `minimapUploadOverviewChunksForLayer`.
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
 * A batch of pre-sliced uint32 label planes for one label overlay member,
 * routed to the r32uint label pool and drawn categorically. Each
 * `chunk.data` is one 2D Z-plane of `chunkY*chunkX` ids, cut from the 3D
 * chunk so ~64 KB crosses the wire instead of ~8 MB and a whole label fits
 * one upload budget. `chunk.dataType` is `"Uint32"`; ids are never narrowed
 * to 16 bits. `level`/`t`/`c` are informational; the writer ignores `chunk.z`.
 */
export interface LabelSliceChunkDataMessage {
  type: "labelSliceChunkData";
  epochs: SceneEpochs;
  /** Label overlay member id (the label image id, possibly source-scoped). */
  memberId: string;
  /**
   * Owning dataset id (the `ctx.datasets` key / `removeLayerResources` id).
   * Stamped on the label slice pool so dataset removal can free it, because
   * the pool is keyed by {@link memberId}, which removal never sees.
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
 * A batch of whole 3D uint32 label chunks for one label overlay member,
 * routed to the r32uint label volume pool and drawn categorically. The 3D
 * first-hit surface needs the full volume, so unlike
 * {@link LabelSliceChunkDataMessage} each `chunk.data` is the entire 3D chunk
 * (~8 MB for a 128³ tile). `chunk.dataType` is `"Uint32"`; ids are never
 * narrowed to 16 bits. `chunk.x/y/z` place the chunk in the single-tile texture.
 */
export interface LabelVolumeChunkDataMessage {
  type: "labelVolumeChunkData";
  epochs: SceneEpochs;
  /** Label overlay member id (the label image id). */
  memberId: string;
  /** See {@link LabelSliceChunkDataMessage.datasetId}. */
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

export interface VolumeLayerParams {
  datasetId: string;
  blendMode: "alpha" | "additive" | "max";
  renderMode: "translucent" | "max_intensity";
  scissorRect?: [number, number, number, number];
  /**
   * The tile's entity id, or the group's for `group-as-proxy` entries. For
   * inspection only: proxy binding comes from the member id, because proxy
   * residency is scoped by `(entity, t, c)`.
   */
  entityId?: string;
  /** Index into the per-dataset entity descriptor buffer. */
  entityIndex: number;
  /**
   * Categorical label overlay marker. When true the layer is drawn from
   * the r32uint label volume pool via the categorical first-hit path (a
   * colored surface over the translucent intensity volume), using a
   * transient descriptor rather than the cold-state entity buffer.
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
 * Stale-tolerant: the worker draws with whatever residency it has, and
 * render messages skip `isStaleDelivery`. Chunk and proxy data messages are
 * stale-rejected by `epochs` instead. Re-issuing a render is cheap and the
 * next view epoch sends one anyway, while a stale chunk would write
 * wrong-epoch voxels into the atlas for good.
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
  /** See {@link SliceRenderMultiPassMessage.pixelRatio}. */
  pixelRatio?: number;
  /** Echoed in the frame's {@link FrameDoneMessage}. */
  frameSeq?: number;
}

/**
 * Batched member draw for one aggregate slice layer.
 *
 * A wide collection at overview zoom has tens of thousands of visible
 * members a few device pixels each, so members below the pass budget's size
 * threshold fold into one render pass with one quad per member. The quads
 * are the candidate set, in roster order. At draw time the worker drops
 * members with nothing resident in any tier (the per-member skip rule),
 * groups the rest by pool binding set so no member samples another pool's
 * indirection, and reads each quad's descriptor entry in-shader so display
 * state stays current.
 */
export interface SliceAggregateParams {
  /**
   * Member id used to resolve the descriptor buffer and colormap for
   * the whole batch. Members of one (dataset, channel) share both by
   * construction, so any batched member works; the builder uses the
   * first.
   */
  poolMemberId: string;
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
  /** See {@link VolumeLayerParams.opacity}. */
  opacity?: number;
  /** See {@link VolumeLayerParams.labelColors}. */
  labelColors?: { value: number; rgba: [number, number, number, number] }[];
  /**
   * Batched member quads for an aggregate layer. When present the
   * worker renders the whole batch in one pass (one instanced draw)
   * instead of one pass per member; `datasetId`, `offsetX/offsetY`,
   * `dataW/dataH` describe the batch's union extent, and per-member
   * geometry + descriptor indices ride in {@link SliceAggregateParams}.
   * Absent for ordinary per-member layers.
   */
  aggregate?: SliceAggregateParams;
  /**
   * Consecutive layers with the same group draw into one offscreen target in
   * one render pass and composite once: one group per (dataset, channel),
   * whose members never overlap and share a blend mode. A layer without one
   * draws alone.
   */
  passGroup?: number;
}

/**
 * Multi-pass slice render request. Stale-tolerant like
 * {@link VolumeRenderMultiPassMessage}: `epochs` is informational here and
 * never rejects the message.
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
  /**
   * Render-target pixels per CSS pixel. Screen-space patterns use it to keep
   * one size on screen at any device pixel ratio or render scale. Defaults to 1.
   */
  pixelRatio?: number;
  /** Echoed in the frame's {@link FrameDoneMessage}. */
  frameSeq?: number;
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
  /** How the overview texture holds samples: the dataset's format. */
  sampleFormat: SampleFormat;
}

/**
 * Off-screen render of one Explore-panel candidate thumbnail. Uses the
 * minimap's overview texture, transient descriptor, and layer params, drawn
 * to a {@link size}px target from the candidate view's camera, so a
 * thumbnail matches the minimap. Stale-tolerant: layers without a resident
 * overview are skipped (possibly all, giving a cleared tile) and the panel
 * re-requests.
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

/**
 * Destroy the worker's GPU device, as a driver reset or a crashed GPU process
 * would lose it. A test hook: the worker recovers the way it does from a real
 * loss.
 */
export interface LoseDeviceMessage {
  type: "loseDevice";
}

/**
 * Ask the worker for the frame on its canvas as a PNG, for the trace
 * bundle. `id` correlates the {@link FrameCapturedMessage} reply. The
 * worker takes the frame from inside the next frame it renders, because
 * reading a WebGPU canvas after its frame is presented was refused on a
 * hardware host, so the sender asks the render loop for a frame as well. A
 * worker that renders none answers after a wait, from the canvas as
 * presented.
 */
export interface CaptureFrameMessage {
  type: "captureFrame";
  id: number;
}

/**
 * Fields shared by both {@link ColdStateActiveEntry} variants. Not
 * exported; narrow the union on `kind` instead.
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
   * Column-major model matrix from the entity's `[0,1]^3` unit cube to
   * world space. Group-as-proxy entries synthesise it from the group AABB
   * (see `synthesizeGroupRosterEntry`). The worker writes it straight into
   * the descriptor buffer; render messages carry no per-frame model matrices.
   */
  modelMatrix: Float32Array;
  /** Inverse of {@link modelMatrix}. */
  invModelMatrix: Float32Array;
  /**
   * Per-channel display state, keyed by channel index; the worker indexes it
   * by `cold.visibleChannels[ch]` for each (entry, channel) it yields. This
   * is the worker's only source of display state for the descriptor buffer.
   */
  displayStateByChannel: Record<number, ColdStateDisplayState>;
}

/**
 * Per-entity cold-state record, discriminated on `kind`:
 *
 *   - `"tile"`: an image member with a real `imageId`. `mode` says whether
 *     the worker serves the proxy alongside chunks
 *     (`tiles-with-proxy-fallback`) or chunks only (`tiles-with-detail`).
 *     Invisible planner entries also arrive as `tiles-with-detail`, so the
 *     worker fetches no proxies for them.
 *   - `"group-as-proxy"`: a synthesised group entry with no backing image;
 *     the worker renders the group's proxy. Route by `entityId`.
 *
 * Narrow on `kind`. `mode` overlaps it and is kept for logging and
 * inspection paths that read it.
 */
export type ColdStateActiveEntry =
  | (ColdStateActiveEntryBase & {
      kind: "tile";
      /** Image member id from the planner. Always a non-empty string. */
      imageId: string;
      mode: "tiles-with-detail" | "tiles-with-proxy-fallback";
      /**
       * Levels the detail tier requests, target level first (the planner's
       * `TileEntry.detailLevels`). The worker allocates detail sections for
       * the target and the next coarser levels (see
       * `entitySources.detailTierLevels`), reports missing chunks at these
       * levels, and samples the target first, then coarser resident levels,
       * never a finer one.
       */
      detailLevels: number[];
      /** Level the coarse tier holds for this entity, or `null` for none. */
      coarseLevel: number | null;
      /**
       * Parent group id, so the worker can map a tile's descriptor to its
       * parent's groupProxyHandle. A string or `null`, never `undefined`.
       */
      parentGroupId: string | null;
    })
  | (ColdStateActiveEntryBase & {
      kind: "group-as-proxy";
      /**
       * No backing image; route by `entityId`. `?: never` makes the compiler
       * reject any read.
       */
      imageId?: never;
      mode: "group-as-proxy";
      /** Groups have no parent group. */
      parentGroupId: null;
    });

/** The tile variant of {@link ColdStateActiveEntry}, the entries that carry chunks. */
export type ColdStateTileEntry = Extract<ColdStateActiveEntry, { kind: "tile" }>;

/**
 * Per-channel display state in cold state. The worker writes these fields
 * into the GPU `EntityDescriptor` and resolves `colormapName` to a LUT
 * texture binding per draw; the descriptor's `colormapLutIndex` is
 * informational, not authoritative.
 *
 * `channelMask` has one bit per active channel but is not authoritative:
 * the `imageId:chN` member id already encodes channel selection.
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
   * the default when absent), `1` = categorical label overlay (integer id →
   * distinct color, id 0 transparent).
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
  /**
   * The chunks the planner delivers for this view: its detail and coarse
   * lanes. The worker admits, keeps, and reports against these keys, so it
   * never wants a chunk the planner will not send.
   */
  wantedChunks: WantedMemberChunks[];
  activeSet: ColdStateActiveEntry[];
  viewMode: "slice" | "volume";
  /** How this dataset's atlases hold samples, and so how its descriptors read them. */
  sampleFormat: SampleFormat;
}

/** The chunks the planner wants for one member in one tier. */
export interface WantedMemberChunks {
  /** See {@link SliceChunkDataMessage.memberId}. */
  memberId: string;
  tier: ResidencyTier;
  chunkKeys: string[];
}

/**
 * Camera-ray pick coordinates for chunk eviction priority, sent once per
 * dataset when `epochs.view` advances. CPU-side residency only; the shader
 * never reads them. The worker stores them in `rayHitPerEntity` for
 * `findEvictionSlot`'s distance metric.
 */
export interface ViewHotStateMessage {
  type: "viewHotState";
  epochs: SceneEpochs;
  datasetId: string;
  /** Per-entity ray-pick local coords for chunk eviction prioritization. */
  rayHitsByEntity: Array<[entityId: string, hit: [number, number, number]]>;
}

/**
 * Display-only update (contrast, gamma, colormap, opacity) for a dataset
 * whose geometry, active set, and residency are unchanged. The worker swaps
 * these values into the dataset's most recent {@link ColdStateMessage} and
 * rebuilds the descriptor buffer without re-ingesting cold state, so the
 * result is byte-identical to a full cold state with the same values. Keyed
 * like {@link ColdStateActiveEntryBase.displayStateByChannel}.
 */
export interface ColdStateDisplayMessage {
  type: "coldStateDisplay";
  datasetId: string;
  displayStateByChannel: Record<number, ColdStateDisplayState>;
}

/**
 * Selection-scrub update: only the current T and/or Z moved. `currentT` and
 * `currentZ` are not part of any per-entity descriptor, so the worker
 * re-points the dataset's most recent {@link ColdStateMessage} at the new
 * selection and re-ingests it. The result matches a full cold state at the
 * new T/Z without the sender rebuilding the O(active-set) descriptor array.
 */
export interface ColdStateSelectionMessage {
  type: "coldStateSelection";
  datasetId: string;
  currentT: number;
  currentZ: number;
  visibleRegion: VisibleRegion;
  /** Budget-admitted proxy residency keys for the new selection. */
  desiredProxyKeys: string[];
  /** Every wanted chunk at the new selection; see {@link ColdStateMessage.wantedChunks}. */
  wantedChunks: WantedMemberChunks[];
  epochs: SceneEpochs;
}

/**
 * View-move update (2D pan, zoom, 3D orbit) for a dataset whose active set
 * changed while T, Z, channels, display state, and layout did not. Carries
 * only the delta against the most recent {@link ColdStateMessage};
 * `upserts` come from the same `buildColdActiveEntry` a full cold state uses.
 *
 * The worker patches its retained cold state and re-runs `applyColdState`,
 * so the result is identical to a full rebuild. An entity absent from
 * `upserts` keeps its retained descriptor, which is safe because only the
 * camera moved.
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
  /**
   * The (member, tier) entries of {@link ColdStateMessage.wantedChunks} that
   * changed, each replacing the retained one. An entry with no keys removes
   * it.
   */
  wantedChunks: WantedMemberChunks[];
  /** Entity ids that left the active set since the retained cold state. */
  removedEntityIds: string[];
  /** Descriptors for entities new to the active set or whose descriptor changed. */
  upserts: ColdStateActiveEntry[];
  /** The full new active-set order, as entity ids, so worker/main agree on indices. */
  activeSetOrder: string[];
}

/**
 * Every chunk of one dataset the source failed for good, replacing the last
 * list. Failures arrive between cold states, so they travel apart from them.
 * The worker marks the ones its wanted set holds, so the shader draws them
 * hatched instead of falling through to a coarser level or to nothing.
 */
export interface FailedChunksMessage {
  type: "failedChunks";
  datasetId: string;
  images: Array<{ imageId: string; chunkKeys: string[] }>;
}

export type MainToWorkerMessage =
  | InitMessage
  | ResizeMessage
  | CanvasColorsMessage
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
  | FailedChunksMessage
  | ViewHotStateMessage
  | CaptureFrameMessage
  | LoseDeviceMessage;

export interface ReadyMessage {
  type: "ready";
}

/**
 * The pipelines built at bootstrap, the slice path's, have compiled. Sent
 * once, after `ready`. The page holds the minimap overlay's content draws
 * until then (Minimap.tsx). The volume renderer is built on first need and
 * is not part of this report.
 */
export interface PipelinesCompiledMessage {
  type: "pipelinesCompiled";
}

export interface ErrorMessage {
  type: "error";
  message: string;
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

/**
 * Why the worker refused a chunk or stopped holding one. A refusal is
 * `stale`, `unwanted`, `wrong-slice`, a `missing-*` routing gap,
 * `atlas-policy`, or `upload-failed`; a loss is `evicted`, `freed`,
 * `out-of-memory`, `wrong-slice`, or `replaced` (a label cell rewritten in
 * place with another chunk, such as the next timepoint's).
 */
export type ChunkFeedbackReason =
  | "evicted"
  | "freed"
  | "replaced"
  | "stale"
  | "unwanted"
  | "wrong-slice"
  | "missing-pool"
  | "missing-entity-meta"
  | "missing-lod-meta"
  | "atlas-policy"
  | "upload-failed"
  | "out-of-memory";

/**
 * What the GPU reported: the device was lost, or an error no error scope
 * caught. The last three are the WebGPU `GPUError` subclasses.
 */
export type GpuErrorKind = "device-lost" | "out-of-memory" | "validation" | "internal";

/**
 * A GPU error, or a lost device. Reports of one kind are spaced out, so
 * `count` says how many errors this one stands for.
 */
export interface GpuErrorMessage {
  type: "gpuError";
  kind: GpuErrorKind;
  message: string;
  count: number;
}

/**
 * The worker replaced a lost device and rebuilt its pools empty, so nothing
 * the page sent before is resident. The cold states it held still apply.
 */
export interface GpuDeviceRestoredMessage {
  type: "gpuDeviceRestored";
}

/** The worker lost its device and could not get another. Nothing draws until the page reloads. */
export interface GpuFailedMessage {
  type: "gpuFailed";
  message: string;
}

/**
 * What one {@link ChunkResidencyMessage} reports:
 *
 *   - `held`: the chunks are written, or were already held as the current
 *     selection draws them.
 *   - `refused`: the chunks were not placed.
 *   - `lost`: chunks reported held earlier are held no longer: evicted, their
 *     pool freed, or cut from a plane the current Z no longer maps to.
 */
export type ChunkResidencyChange = "held" | "refused" | "lost";

/**
 * The worker's account of one member's chunks in one tier: the only source
 * of the page's residency mirror. The worker owns the slots, so the page
 * never assumes a chunk it sent is held. Every chunk delivery is answered
 * once, `held` or `refused`, and a held chunk is reported once more,
 * `lost`, when its slot stops holding it.
 */
export interface ChunkResidencyMessage {
  type: "chunkResidency";
  /** See {@link SliceChunkDataMessage.memberId}. */
  memberId: string;
  tier: ResidencyTier;
  change: ChunkResidencyChange;
  keys: string[];
  /** Absent for `held`. */
  reason?: ChunkFeedbackReason;
}

/** A wanted chunk the worker does not hold as the current selection draws it. */
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
  /** The member's channel. */
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

/**
 * What the worker wants and lacks for one dataset. Chunks come from the cold
 * state's {@link ColdStateMessage.wantedChunks}, proxies from its desired
 * proxy keys. A missing proxy is re-delivered. Every chunk loss is reported
 * on its own, so a missing chunk the page's residency mirror holds is a
 * disagreement between the two records.
 */
export interface WantedSetDeltaMessage {
  type: "wantedSetDelta";
  datasetId: string;
  epochs: SceneEpochs;
  missing: Array<MissingChunk | MissingProxy>;
}

/** A closed range of levels; `min === max` for a single level. */
export interface LevelRange {
  min: number;
  max: number;
}

/**
 * Which level one image-bearing entity's visible pixels come from, as the
 * worker last computed it from the planner's target-level chunks.
 * `targetLevel` is the level pin or the level the screen calls for;
 * `displayed` spans the finest and coarsest level the renderer samples
 * for those positions today: the target level once resident, else the
 * coarser resident sections, else the coarse tier. Every position is
 * served by exactly one level, so `min === max` means the whole visible
 * footprint comes from one level. `displayed` is `null` when no visible
 * position has any resident level yet. `visible` is false when the planner
 * wants none of the entity's target-level chunks, in which case `displayed`
 * is `null` too.
 */
export interface EntityLevelReport {
  entityId: string;
  targetLevel: number;
  visible: boolean;
  displayed: LevelRange | null;
}

/**
 * Posted alongside every {@link WantedSetDeltaMessage}: what the wanted
 * target-level chunks say about which level is on screen. Feeds the layer
 * panel's level readout.
 */
export interface EntityLevelsMessage {
  type: "entityLevels";
  datasetId: string;
  entities: EntityLevelReport[];
}

/**
 * The GPU pass time of one viewport frame, in microseconds on the GPU's own
 * clock: from the start of the frame's first render pass to the end of its
 * last, read back through timestamp queries. Posted once per frame whose
 * read-back landed, and never on a device without the `timestamp-query`
 * feature, so a frame with no message is unmeasured rather than free. The
 * minimap and thumbnail renders are not viewport frames and are never timed.
 */
export interface GpuPassTimeMessage {
  type: "gpuPassTime";
  gpuPassUs: number;
}

/**
 * What the render worker holds on the GPU against its one budget. `bytes` is
 * the sum of the five holder lines; colormaps and descriptor buffers, a few
 * KiB, are left out.
 */
export interface GpuMemoryReport {
  /** The device-fitted total, halved when the device runs out of memory under it. */
  budgetBytes: number;
  bytes: number;
  /** Chunk pools: textures and indirection buffers. */
  chunkBytes: number;
  labelBytes: number;
  proxyBytes: number;
  /** Viewport render targets and the depth texture. */
  targetBytes: number;
  /** Minimap overview textures and the minimap's and thumbnails' render targets. */
  minimapBytes: number;
  /** Chunk, label, and proxy atlases. */
  atlases: number;
  /** Chunk pool slots holding a chunk. */
  slotsHeld: number;
  /** Chunk pool slots allocated. */
  slots: number;
  /** Minimap overviews not drawn because the budget had no room for them. */
  overviewsRefused: number;
}

/** A changed {@link GpuMemoryReport}. Posted only when a number moves. */
export interface GpuMemoryMessage extends GpuMemoryReport {
  type: "gpuMemory";
}

/** One chunk pool's capacity, as admission counts it. */
export interface GpuPoolCapacity {
  /** `chunkTierPoolKey(datasetId, tier, channel, chunkDims, multiChannel)`. */
  poolKey: string;
  datasetId: string;
  tier: ResidencyTier;
  /** Bytes one slot holds. */
  slotBytes: number;
  /** Slots the pool has now. */
  slots: number;
  /** Slots the pool may grow to while the GPU total has room. */
  maxSlots: number;
}

/**
 * What the GPU total leaves the chunk pools, and each pool's slots, so the
 * page admits no more than they can hold together. Chunk pools hold at most
 * `budgetBytes - reservedBytes` between them.
 */
export interface GpuCapacityReport {
  budgetBytes: number;
  /** What the other holders take of the total now: label and proxy pools, render targets, minimap textures. */
  reservedBytes: number;
  pools: GpuPoolCapacity[];
}

/** A changed {@link GpuCapacityReport}: a pool created, grown, shrunk, or freed, or the total or reserve moved. */
export interface GpuCapacityMessage extends GpuCapacityReport {
  type: "gpuCapacity";
}

/**
 * Minimap overview textures the device could not allocate. The page uploads
 * these members' overviews again, under the budget the failure halved.
 */
export interface MinimapOverviewsLostMessage {
  type: "minimapOverviewsLost";
  memberIds: string[];
}

/**
 * A viewport frame's GPU work has finished. Posted for every frame on every
 * device, unlike {@link GpuPassTimeMessage}, so the page can time a frame
 * from dispatch to done on its own clock and lower the render resolution
 * when frames run long.
 */
export interface FrameDoneMessage {
  type: "frameDone";
  frameSeq: number;
}

/** Why a frame could not be read: the error's name and message, as the bundle's reason carries them. */
export interface CaptureFailure {
  name: string;
  message: string;
}

/**
 * Reply to a {@link CaptureFrameMessage}, correlated by `id`. `png` is the
 * frame encoded as PNG and transferred, or null when it could not be read,
 * in which case `failure` says what refused it. `width` and `height` are the
 * frame's device pixels either way.
 */
export interface FrameCapturedMessage {
  type: "frameCaptured";
  id: number;
  png: ArrayBuffer | null;
  width: number;
  height: number;
  failure: CaptureFailure | null;
}

/** A frame the render worker took, as the main thread resolves it. */
export interface CapturedFrame {
  png: ArrayBuffer;
  /** Device pixels. */
  width: number;
  height: number;
}

/**
 * What a capture request settles with: the frame, or the reason there is
 * none. Every path settles, so a bundle never waits on a frame that is not
 * coming.
 */
export type FrameCaptureResult =
  | { frame: CapturedFrame; reason: null }
  | { frame: null; reason: string };

export type WorkerToMainMessage =
  | ReadyMessage
  | PipelinesCompiledMessage
  | ErrorMessage
  | ThumbnailResultMessage
  | ChunkResidencyMessage
  | WantedSetDeltaMessage
  | EntityLevelsMessage
  | GpuPassTimeMessage
  | GpuMemoryMessage
  | GpuCapacityMessage
  | MinimapOverviewsLostMessage
  | FrameDoneMessage
  | FrameCapturedMessage
  | GpuErrorMessage
  | GpuDeviceRestoredMessage
  | GpuFailedMessage;
