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

/** GPU errors of one kind folded into the next report while the last one's spacing runs. */
export interface GpuErrorReport {
  timer: ReturnType<typeof setTimeout> | null;
  folded: number;
  message: string;
}

export interface RendererState {
  /** memberId → datasetId (canonical: imageId or imageId:chN). */
  memberToDataset: Map<string, string>;
  /**
   * memberId → (`sourceKey(tier, level)` → pool key): the pool each
   * indirection section a member holds lives in. Chunk uploads and the
   * wanted set route by (member, tier, level) through this map, since
   * the detail tier holds several levels per member and levels with
   * different chunk shapes live in different pools.
   */
  memberSourcePools: Map<string, Map<string, string>>;
  /** Per-dataset sections snapshot captured during the most recent cold state. */
  currentSourcesByDataset: Map<string, Map<string, EntitySource[]>>;

  /** dataset → entity descriptor buffer + index maps (rebuilt fresh on each cold state). */
  descriptorBuffersByDataset: Map<string, EntityDescriptorIndex>;

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

  /** memberId → last known ray-volume hit in entity-local [0,1]^3 (volume mode). */
  rayHitPerEntity: Map<string, [number, number, number]>;
  /** memberId → last known viewport center in entity-local [0,1]^2 (slice mode). */
  cameraUVPerEntity: Map<string, [number, number]>;
  /**
   * memberId → target level from the most recent cold state. Eviction
   * takes a resident chunk finer than it first. Absent for a
   * member with no chunk levels.
   */
  targetLevelByMember: Map<string, number>;

  /** Current scene epochs (replaced on every cold state). */
  currentEpochs: SceneEpochs | null;
  /** Last cold-state message (replaced on every cold state). */
  currentColdState: ColdStateMessage | null;
  /** The last viewport frame drawn, which a probe reads what is under a point from. */
  lastFrame: SliceRenderMultiPassMessage | VolumeRenderMultiPassMessage | null;
  /**
   * Per-dataset most-recent cold-state message. A display-only update
   * (`coldStateDisplay`) patches this dataset's entry and rebuilds its
   * descriptor buffer from it, so display edits get the full active set
   * without re-sending it. Cleared on dataset removal.
   */
  coldStateByDataset: Map<string, ColdStateMessage>;
  /** Per-dataset index of its latest cold state's wanted chunks. */
  wantedByDataset: Map<string, WantedChunkIndex>;
  /** dataset → imageId → chunk keys the source failed for good, as the page last listed them. */
  failedByDataset: Map<string, Map<string, ReadonlySet<string>>>;
  /**
   * What each chunk pool's indirection was last remapped for, by pool object,
   * so a pool created or replaced since always remaps. See `applyColdState`.
   */
  remappedFor: WeakMap<object, RemapInputs>;

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
}

/** What a pool's indirection remap reads besides its slots and sections. */
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
    memberSourcePools: new Map(),
    currentSourcesByDataset: new Map(),
    descriptorBuffersByDataset: new Map(),
    volumeAtlases: new Map(),
    sliceAtlases: new Map(),
    labelSlicePools: new Map(),
    labelVolumePools: new Map(),
    rayHitPerEntity: new Map(),
    cameraUVPerEntity: new Map(),
    targetLevelByMember: new Map(),
    currentEpochs: null,
    currentColdState: null,
    lastFrame: null,
    coldStateByDataset: new Map(),
    wantedByDataset: new Map(),
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
  };
}
