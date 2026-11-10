/**
 * Planning types and interfaces. Leaf module so siblings can import
 * without circular dependencies.
 */

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { SliceCut, SpatialAxis } from "../../renderer/slicePlane.ts";

/**
 * Fields shared by every {@link EntitySnapshot} variant. `levels` stays
 * on the base, {@link GroupSnapshot} included, even though a group never
 * iterates its own chunks, so readers of `levels` need not narrow on `kind`.
 */
export interface BaseEntitySnapshot {
  entityId: string;
  imageId: string;
  visible: boolean;
  projectedDiagonalPx: number;
  projectedAreaPx2: number;
  centroidWorld: [number, number, number];
  /**
   * The level the detail tier requests: the dataset's level pin if set,
   * otherwise the core's choice in `lucida-core/src/target_level.rs`, the
   * coarsest level with at least one sample under every device pixel,
   * held across a boundary by hysteresis. Always a source level, never a
   * generated coarse level. The core resolves it and the browser copies
   * it. It is in the quantized set the view-query delta tracks, so a move
   * arrives as a `changed` record. Memory pressure is not an input.
   */
  targetLevel: number;
  /**
   * True when {@link targetLevel} is the dataset's level pin rather than
   * the screen's choice. A pinned target never moves with the zoom, so
   * the prefetch lane requests no neighboring level for the entity.
   */
  levelPinned: boolean;
  /**
   * The levels the image's source stores, ascending: every index of
   * {@link levels} except the generated coarse levels. Target levels and
   * the prefetch lane's level step stay inside this set.
   */
  sourceLevels: number[];
  /**
   * Level the coarse tier holds, or null when the image has no usable
   * coarse level. A generated coarse level is usable only once readiness
   * metadata marks it available.
   */
  coarseLevel: number | null;
  importance: number;
  /**
   * Layout grid placement, in voxel coordinates. Not the same as
   * {@link centroidWorld}, which is the entity's own center in world space.
   */
  layoutPositionVox: [number, number];
  levels: LevelGeometry[];
}

/**
 * A standalone image entity (non-collection datasets). `groupMembers`
 * treats it as a one-entry group so the rest of the planner is uniform.
 */
export interface ImageSnapshot extends BaseEntitySnapshot {
  kind: "Image";
}

/**
 * A group entity on a collection. `groupMembers` pairs it with its
 * {@link TileSnapshot}s by id.
 */
export interface GroupSnapshot extends BaseEntitySnapshot {
  kind: "Group";
}

/**
 * A tile entity in a collection group. `parentId` is required: a tile
 * without a parent is a producer bug to surface, not to coerce.
 */
export interface TileSnapshot extends BaseEntitySnapshot {
  kind: "Tile";
  /** Parent group's entity id. `groupMembers` groups tiles by it. */
  parentId: string;
}

export type EntitySnapshot = ImageSnapshot | GroupSnapshot | TileSnapshot;

/** One layer's selectors: the scene's t and z clamped into the layer, and the channels it shows. */
export interface SelectionState {
  t: number;
  z: number;
  /**
   * Where the slice view cuts this layer: along Z at `z` for an XY view, or
   * along Y or X at that axis position clamped into the layer.
   */
  cut: SliceCut;
  visibleChannels: number[];
  renderMode: "slice" | "volume";
  interactionState: "idle" | "panning" | "zooming" | "scrubbing";
}

export interface CacheStateSnapshot {
  /** entityId -> set of chunk keys currently cached. */
  cached: Map<string, Set<string>>;
  /** entityId -> set of chunk keys currently being fetched. */
  inFlight: Map<string, Set<string>>;
}

/**
 * One missing minimap chunk in {@link PlanningSnapshot.minimapPending}.
 * `emitMinimapLane` turns each into a {@link ChunkRequest} at
 * `MINIMAP_LANE_OFFSET`.
 */
export interface MinimapChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  /** Canonical chunk key, equivalent to `chunkKey`'s output. */
  key: string;
}

export interface PlanningSnapshot {
  /**
   * The planner stamps it onto every emitted {@link ChunkRequest}; the
   * orchestrator does not back-fill it.
   */
  datasetId: string;
  epochs: SceneEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  /**
   * Minimap chunks not yet on the GPU minimap atlas, keyed by
   * `EntitySnapshot.imageId`. An empty map means no minimap requests
   * this tick.
   */
  minimapPending: Map<string, MinimapChunkCoord[]>;
}

/**
 * Carry-forward state between planning ticks. Anything that survives a tick
 * goes here, never in the snapshot, a module global, or a cache inside the
 * planner. The caller stores {@link RequestPlan.nextState} and passes it to
 * the next `plan` call without reading it. It holds the previous active
 * set, which the dev-mode validator checks and the cold-state delta diffs
 * against, and the zoom memory the prefetch lane reads to pick the next
 * level.
 */
export interface PlanningState {
  previousActiveSet: ActiveSetEntry[];
  /**
   * `visibleRegion.effectiveZoom` as the previous plan saw it, or `null`
   * before the first plan. The core reports device pixels per level-0
   * sample here in both view modes, so a change in it is a change in
   * the measure the target level is chosen from.
   */
  previousEffectiveZoom: number | null;
  /**
   * Direction of the last zoom change the planner observed, or `null`
   * until it observes one. Kept across plans whose zoom is unchanged, so
   * a pan or a scrub after a zoom still prefetches in the zoom's
   * direction.
   */
  zoomDirection: ZoomDirection | null;
  /**
   * `selection.cut` as the previous plan saw it, or `null` before the first
   * plan. A move of a few planes from it along the same axis is a step,
   * after which the slice view fetches the whole chunks its plane lies in.
   */
  previousCut: SliceCut | null;
}

/** Which way the last zoom change moved: toward level 0 or away from it. */
export type ZoomDirection = "in" | "out";

/** The state before the first plan: nothing held, no zoom seen. */
export function initialPlanningState(): PlanningState {
  return { previousActiveSet: [], previousEffectiveZoom: null, zoomDirection: null, previousCut: null };
}

export interface RequestPlan {
  /**
   * Every lane's chunk requests, sorted ascending by `priority` (lower
   * is more urgent). A fresh array, so the caller may mutate it.
   */
  requests: ChunkRequest[];
  /** One entry per visible tile, plus invisible-entity pass-throughs. */
  activeSet: ActiveSetEntry[];
  epochs: SceneEpochs;
  /**
   * Counters for this plan run, zeroed when no work happened. The
   * trace's per-tick counters (`traceTick.ts`) and tests read them.
   */
  stats: PlanStats;
  /**
   * Opaque carry-forward state. The caller passes it back as `state` on
   * the next `plan` call and never inspects or builds it.
   */
  nextState: PlanningState;
  /**
   * Requests capacity-aware admission left out because the budgets could
   * not hold them, per tier. Absent when nothing was admitted against a
   * capacity.
   */
  shortfall?: Record<ResidencyTier, number>;
  /** Detail budget the coarse tier took to hold what admission admitted. */
  coarseLoanBytes?: number;
}

/**
 * Per-plan accumulator. Counters are summed across the chunks each lane
 * reads (detail, every prefetch step, and coarse), across all entities and
 * channels.
 */
export interface PlanStats {
  /** Frustum / visible-region culling stages. */
  culling: PlanCullingStats;
}

export interface PlanCullingStats {
  /** Total grid cells inspected, before any culling. */
  considered: number;
  /** Cells inside the entity's local xy-bounds intersection. */
  afterXyBounds: number;
  /** Cells additionally inside the z-range. */
  afterZRange: number;
  /** Cells additionally surviving the frustum half-plane test. */
  afterFrustum: number;
}

/** Construct a fresh, zeroed PlanStats accumulator. */
export function emptyPlanStats(): PlanStats {
  return {
    culling: { considered: 0, afterXyBounds: 0, afterZRange: 0, afterFrustum: 0 },
  };
}

export interface ChunkRequest {
  /** Stamped by the planner from {@link PlanningSnapshot.datasetId}. */
  datasetId: string;
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  /** The CPU cache and GPU upload paths route per lane. */
  lane: "minimap" | "detail" | "coarse" | "prefetch" | "overview";
  /** Residency tier this request fills. */
  tier: ResidencyTier;
  priority: number;
  /** Canonical key: "level/t/c/z/y/x" */
  chunkKey: string;
  /**
   * The plane the slice view draws from this chunk, along the chunk's own
   * {@link planeAxis}. Resident means held whole or with this plane among
   * the planes held. Absent when the view draws the whole chunk, as the
   * volume view does.
   */
  plane?: number;
  /**
   * The planes to fetch when the chunk is not resident: a band around
   * {@link plane}, half-open along the chunk's {@link planeAxis}, so the
   * next few steps of the cut find their planes resident. Absent: fetch the
   * whole chunk.
   */
  planes?: readonly [number, number];
  /** The axis {@link plane} and {@link planes} lie along. Absent: Z. */
  planeAxis?: SpatialAxis;
}

/** One entry per visible tile, plus pass-through entries for invisible entities. */
export type ActiveSetEntry = TileEntry | InvisibleEntry;

/** Active-set entry for one visible tile. */
export interface TileEntry {
  kind: "tile";
  /** The tile's entity id. */
  entityId: string;
  /** The tile's owning image id (matches `EntitySnapshot.imageId`). */
  imageId: string;
  /**
   * Levels the detail tier requests, target level first; today only the
   * target. Cold state and the worker read the detail tier's levels from
   * here. The worker keeps sections for `detailLevels[0]` and the coarser
   * levels under it, and never samples a finer level.
   */
  detailLevels: number[];
  /**
   * Level the coarse tier holds for this entity, or `null` when the
   * image has no coarse level that is at least as coarse as the detail
   * level.
   */
  coarseLevel: number | null;
}

/**
 * Pass-through for an invisible entity so CPU cache eviction still sees
 * it. Carries only its coarsest level, the one its cold-state entry
 * lists. A separate variant keeps `kind === "tile"` checks from catching
 * invisible entities.
 */
export interface InvisibleEntry {
  kind: "invisible";
  entityId: string;
  imageId: string;
  /** The entity's coarsest level (= `levels.length - 1`, or 0 if empty). */
  coarsestLod: number;
}

export interface MemberGroup {
  /** The group's entity id. May be derived from `parentId` of tiles. */
  groupId: string;
  /**
   * The visible group entity if {@link EntitySnapshot.kind} === "Group"
   * was in `entities`, otherwise `null`.
   */
  groupEntity: EntitySnapshot | null;
  /** All visible tile entities whose `parentId === groupId`. */
  tiles: EntitySnapshot[];
}
