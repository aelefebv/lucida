/**
 * Per-session worker renderer state, threaded through
 * {@link WorkerCtx.state} so handlers don't reach for module globals.
 * Renderer singletons and persistent GPU resources (LUT cache, offscreen
 * pool, dummy textures) stay at module scope in `gpu.worker.ts`. Created
 * on `init`, dropped on `destroy`; pool GPU resources are freed
 * separately by the per-mode `destroyAll*Resources` helpers.
 */

import type { SceneEpochs } from "../../pipeline/epochs.ts";
import type {
  CanvasColors,
  ColdStateMessage,
  GpuErrorKind,
  GpuMemoryReport,
  PoolMode,
  SliceRenderMultiPassMessage,
  VolumeRenderMultiPassMessage,
} from "../workerProtocol.ts";
import type { AtlasState, LabelVolumePool } from "../volume/atlas.ts";
import type { SliceAtlasState, LabelSlicePool } from "../slice/atlas.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { EntitySource } from "../entitySources.ts";
import type { PendingFrameCapture } from "./captureFrame.ts";
import type { WantedChunkIndex } from "../wantedChunks.ts";
import { CEILING_BUDGETS } from "../../deviceBudget.ts";
import { createMinimapRendererState, type MinimapRendererState } from "../minimapHandlers.ts";
import type { ViewResources } from "./viewResources.ts";
import type { ViewIndirection } from "../viewIndirection.ts";
import { CameraRefs } from "../cameraRefs.ts";

/** GPU errors of one kind folded into the next report while the last one's spacing runs. */
export interface GpuErrorReport {
  timer: ReturnType<typeof setTimeout> | null;
  folded: number;
  message: string;
}

/**
 * What the worker keeps of one view's draw of one dataset: the cold state it
 * was last sent for that view, and what its sections, wanted chunks and
 * descriptors were built from. A view draws from the dataset's pools of its
 * mode, which every view of that mode shares, through indirection of its own
 * (`viewIndirection.ts`).
 */
export interface ViewDraw {
  datasetId: string;
  view: number;
  mode: PoolMode;
  /**
   * The view's most recent cold state. A display, selection or view-move
   * update patches it and rebuilds from it, so the active set is never sent
   * again for those.
   */
  cold: ColdStateMessage;
  /**
   * The index of {@link cold}'s wanted chunks. Replaced, never changed in
   * place: eviction's order compares it by identity.
   */
  wanted: WantedChunkIndex;
  /**
   * memberId → (`sourceKey(tier, level)` → pool key): the pool each section
   * the view lays out for a member lives in. Uploads route by it, since the
   * detail tier holds several levels per member and levels with different
   * chunk shapes live in different pools.
   */
  routes: Map<string, Map<string, string>>;
  /**
   * memberId → the target level of the view's cold state. Eviction takes a
   * resident chunk finer than every view's target first. Absent for a member
   * with no chunk levels. Replaced, never changed in place, like
   * {@link wanted}.
   */
  targetLevels: ReadonlyMap<string, number>;
  /** The sections {@link cold} laid out, by member. */
  sources: Map<string, EntitySource[]>;
  /** The view's entity descriptor buffer and index maps, rebuilt on each cold state. */
  descriptor: EntityDescriptorIndex | null;
}

/**
 * Per-session worker state. A dataset's pools of one mode are shared by every
 * view that draws it in that mode; what each view draws through them is a
 * {@link ViewDraw}, kept by `datasetViewKey` (`poolKeys.ts`).
 */
export interface RendererState {
  /** memberId → datasetId (canonical: imageId or imageId:chN). */
  memberToDataset: Map<string, string>;
  /** Per dataset and view, what the view draws of the dataset. */
  draws: Map<string, ViewDraw>;

  /**
   * The one GPU budget every holder counts against, fitted to the device at
   * init and halved, down to its floor, whenever the device runs out of
   * memory under it (`worker/gpuBudget.ts`).
   */
  gpuTotalBytes: number;
  /** poolKey → volume atlas pool state. */
  volumeAtlases: Map<string, AtlasState>;
  /** poolKey → slice atlas pool state. */
  sliceAtlases: Map<string, SliceAtlasState>;
  /**
   * memberId → r32uint label overlay slice pool. Separate from
   * {@link sliceAtlases} (r16uint intensity) because label ids need full
   * 32-bit storage and render through the categorical shader path.
   */
  labelSlicePools: Map<string, LabelSlicePool>;
  /**
   * memberId → r32uint label overlay volume pool, the 3D counterpart of
   * {@link labelSlicePools}. Feeds the first-hit categorical surface drawn
   * over the intensity volume.
   */
  labelVolumePools: Map<string, LabelVolumePool>;
  /**
   * Datasets no view plans, from `datasetUnplanned` until the page sends a
   * cold state for one of their views. Re-applying a retained cold state, for
   * a failed-chunk list or a new device, leaves a dataset here.
   */
  unplannedDatasets: Set<string>;

  /** Per view, memberId → last known ray-volume hit in entity-local [0,1]^3 (volume mode). */
  rayHits: CameraRefs<[number, number, number]>;
  /** Per view, memberId → last known viewport center in entity-local [0,1]^2 (slice mode). */
  cameraUVs: CameraRefs<[number, number]>;

  /** Current scene epochs (replaced on every cold state). */
  currentEpochs: SceneEpochs | null;
  /** Last cold-state message (replaced on every cold state). */
  currentColdState: ColdStateMessage | null;
  /**
   * Per view, the last frame drawn of it, which a probe reads what is under
   * a point from.
   */
  lastFrames: Map<number, SliceRenderMultiPassMessage | VolumeRenderMultiPassMessage>;
  /** Per view, what it draws with, sized to its own pixels (`worker/viewResources.ts`). */
  viewResources: Map<number, ViewResources>;
  /** The newest viewport frame the page gave up on; a banded frame up to it stops at its next band. */
  abandonedFrameSeq: number;
  /** dataset → imageId → chunk keys the source failed for good, as the page last listed them. */
  failedByDataset: Map<string, Map<string, ReadonlySet<string>>>;
  /**
   * What each view's indirection over a pool was last remapped for, by
   * indirection object, so one created or replaced since always remaps. See
   * `applyColdState`.
   */
  remappedFor: WeakMap<ViewIndirection, RemapInputs>;

  /**
   * Captures the trace bundle asked for that no frame has answered yet.
   * The next frame handler takes them all, and a fallback timer takes
   * one that no frame reaches.
   */
  frameCaptures: PendingFrameCapture[];

  /** The GPU memory report the page last heard, so only a change is posted. */
  gpuMemoryPosted: GpuMemoryReport | null;
  /** The capacity report the page last heard, serialized, so only a change is posted. */
  gpuCapacityPosted: string | null;
  /**
   * Minimap overviews the GPU total had no room for: member → the selection
   * (`t/c/format`) refused. Refused until the selection changes or the
   * member is removed.
   */
  overviewsRefused: Map<string, string>;

  /** The last canvas colors and cursors the page sent, which a replacement device's renderers start from. */
  canvasColors: CanvasColors | null;
  cursors: { data: Float32Array; count: number } | null;
  /** Per kind, the GPU error reports waiting out their spacing. */
  gpuErrorReports: Map<GpuErrorKind, GpuErrorReport>;
  /** When each recent device loss happened, so a device that keeps failing is given up on. */
  deviceLosses: number[];
  /** No device could replace a lost one. */
  gpuFailed: boolean;
  /** The worker is tearing down, so a device lost now is not replaced. */
  closing: boolean;
  /** Label texture sizes, `${memberId}|${w}x${h}x${d}`, that ran out of memory and are not tried again. */
  labelSizesOutOfMemory: Set<string>;
  /** The minimap's and the explore thumbnails' textures, canvases and targets. */
  minimap: MinimapRendererState;
}

/** What a view's indirection remap reads besides the pool's slots and its sections. */
export interface RemapInputs {
  t: number;
  /** The slice plane; zero for a volume pool, which maps every Z. */
  z: number;
  /**
   * A render radius or failed-chunk marks shaped the result, and both move
   * with the view or the wanted set.
   */
  viewDependent: boolean;
}

/** Build an empty {@link RendererState}. Called once in `case "init"`. */
export function createInitialState(gpuTotalBytes: number = CEILING_BUDGETS.gpuTotalBytes): RendererState {
  return {
    gpuTotalBytes,
    memberToDataset: new Map(),
    draws: new Map(),
    volumeAtlases: new Map(),
    sliceAtlases: new Map(),
    labelSlicePools: new Map(),
    labelVolumePools: new Map(),
    unplannedDatasets: new Set(),
    rayHits: new CameraRefs(),
    cameraUVs: new CameraRefs(),
    currentEpochs: null,
    currentColdState: null,
    lastFrames: new Map(),
    viewResources: new Map(),
    abandonedFrameSeq: 0,
    failedByDataset: new Map(),
    remappedFor: new WeakMap(),
    frameCaptures: [],
    gpuMemoryPosted: null,
    gpuCapacityPosted: null,
    overviewsRefused: new Map(),
    canvasColors: null,
    cursors: null,
    gpuErrorReports: new Map(),
    deviceLosses: [],
    gpuFailed: false,
    closing: false,
    labelSizesOutOfMemory: new Set(),
    minimap: createMinimapRendererState(),
  };
}
