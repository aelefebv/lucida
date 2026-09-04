/**
 * Planning types and interfaces. Leaf module so siblings can import
 * without circular dependencies. See ADR 0029.
 */

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { AssetCatalogSnapshot } from "../assetCatalog.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type { VisibleRegion } from "../viewport.ts";

/**
 * Shared shape across every {@link EntitySnapshot} variant. Holds the
 * tiles that don't depend on the entity's `kind`. The variants
 * specialise the discriminator and add `parentId` for {@link TileSnapshot}.
 *
 * Conservative form: `levels` lives on the base because all three
 * variants still carry it (even {@link GroupSnapshot}, despite
 * `group-as-proxy` never iterating group chunks). The aggressive form
 * stripping `levels` from {@link GroupSnapshot} is deferred indefinitely;
 * see ADR `0026-discriminated-active-set-and-entity-types.md`.
 */
export interface BaseEntitySnapshot {
  entityId: string;
  imageId: string;
  visible: boolean;
  projectedDiagonalPx: number;
  projectedAreaPx2: number;
  centroidWorld: [number, number, number];
  idealTargetLod: number;
  /**
   * Source pyramid level selected for the detail tier. Defaults to level
   * 0 unless the dataset settings carry an explicit lower-resolution
   * override. Generated coarse levels are not valid detail choices.
   */
  detailLevel: number;
  /**
   * Pyramid level selected for the coarse tier. Null means this image
   * has no currently usable coarse level. The first bridge only emits
   * source-backed coarse chunks; generated coarse levels become usable
   * once readiness metadata marks them available.
   */
  coarseLevel: number | null;
  importance: number;
  /**
   * Layout placement position, in voxel coordinates. Distinct from
   * {@link centroidWorld}: `layoutPositionVox` is grid placement
   * (voxel-space, set by the layout); `centroidWorld` is the entity's
   * intrinsic spatial center (world-space). They're different things in
   * different frames.
   */
  layoutPositionVox: [number, number];
  levels: LevelGeometry[];
}

/**
 * A standalone image entity (non-collection datasets). Treated as its own
 * one-entry "group" by `groupMembers` so the rest of the planner is
 * uniform. No `parentId` tile — top-level entity by construction.
 */
export interface ImageSnapshot extends BaseEntitySnapshot {
  kind: "Image";
}

/**
 * A group entity on a collection. Top-level — no `parentId`. `groupMembers`
 * pairs it with its constituent {@link TileSnapshot}s by id; promotion
 * may downgrade the group to `group-as-proxy` (rendered as one synthetic
 * cube) or leave it at tile-mode (each tile rendered separately).
 */
export interface GroupSnapshot extends BaseEntitySnapshot {
  kind: "Group";
}

/**
 * A tile entity belonging to a group on a collection. `parentId` is required
 * and non-null by contract: a tile without a parent is a producer
 * invariant violation worth surfacing rather than silently coercing.
 *
 * Consumers that read `parentId` narrow on `kind === "Tile"` first; the
 * post-narrow access has no `?? null` fallback.
 */
export interface TileSnapshot extends BaseEntitySnapshot {
  kind: "Tile";
  /**
   * Parent group's entity id. Required and non-null for {@link TileSnapshot}
   * — `groupMembers` keys tile grouping off this id. Only tiles carry
   * a `parentId`; group/image variants don't.
   */
  parentId: string;
}

/**
 * Discriminated union of the three entity kinds. The previous flat
 * `EntitySnapshot` interface (with `parentId: string | null`) is
 * replaced; consumers narrow on `kind` before reading variant-specific
 * tiles. Cited [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
 * extended from "carry-forward state is explicit" to "per-variant
 * invariants are compile-time enforced."
 */
export type EntitySnapshot = ImageSnapshot | GroupSnapshot | TileSnapshot;

export interface SelectionState {
  t: number;
  c: number;
  z: number;
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

// Re-exported so planning consumers don't need a separate import.
export type { AssetCatalogSnapshot, ProxyKind } from "../assetCatalog.ts";

/**
 * Lightweight chunk coordinate carried inside {@link PlanningSnapshot.minimapPending}.
 *
 * Canonical home for this type: the orchestrator and `pipeline/planning/snapshot.ts`
 * both import this single definition.
 *
 * The orchestrator (and the minimap path that fills its
 * `pendingFetch` map) populates one of these per missing minimap
 * chunk; `emitMinimapLane` translates them into
 * {@link ChunkRequest}s at `MINIMAP_LANE_OFFSET`.
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
   * Dataset identifier this snapshot pertains to. Carried on the
   * snapshot so the planner can stamp it onto every emitted
   * {@link ChunkRequest} and {@link ProxyRequest} at emit time —
   * the orchestrator does not back-fill it after `plan()`.
   */
  datasetId: string;
  epochs: SceneEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  /**
   * Asset catalog snapshot. The planner no longer reads it; the proxy
   * residency planner still does, until ADR 0043 §C deletes the
   * proxy-asset path as a whole. `null` is accepted for callers that opt
   * out, such as tests and `createSyntheticSnapshot`.
   */
  assetCatalog: AssetCatalogSnapshot | null;
  /**
   * Per-image minimap chunks the renderer needs. Keyed by
   * `EntitySnapshot.imageId`; each value is the list of pending
   * coords the minimap path produced this tick (chunks not yet on
   * the GPU's minimap atlas).
   *
   * `emitMinimapLane` reads this and emits requests at
   * `MINIMAP_LANE_OFFSET`, the highest priority in the system.
   * Empty map ⇒ no minimap work this tick (planning emits no
   * minimap requests).
   */
  minimapPending: Map<string, MinimapChunkCoord[]>;
}

/**
 * Carry-forward state that survives across planning ticks. Distinct
 * from {@link PlanningSnapshot} (the world this tick) and
 * `PlanningConfig` (the tunables). The caller stores the opaque
 * pointer returned in {@link RequestPlan.nextState} and threads it into
 * the next call to `plan`.
 *
 * Today it carries one field, the previous tick's active set, which the
 * dev-mode validator checks and the cold-state delta diffs against. The
 * container exists so future state (per-entity level hysteresis,
 * anticipation hints, planner state machines) can be added without
 * churning {@link PlanningSnapshot}'s contract.
 *
 * Cited [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
 * and ADR `0027-planning-state-as-the-carry-forward-seam.md`.
 */
export interface PlanningState {
  previousActiveSet: ActiveSetEntry[];
}

export interface RequestPlan {
  /**
   * All chunk requests across detail/prefetch/overview lanes, sorted
   * ascending by `priority` (lower = more urgent). Fresh array per
   * `plan()` call; safely mutable by the caller.
   */
  requests: ChunkRequest[];
  /**
   * The active set: one entry per visible tile, plus invisible-entity
   * pass-throughs. Carries the {@link EntityMode}, the levels each
   * residency tier holds, and the proxy availability flags consumed by
   * orchestrator delivery.
   */
  activeSet: ActiveSetEntry[];
  epochs: SceneEpochs;
  /**
   * Proxy assets to fetch alongside chunks. Populated by promotion.
   * Always defined — empty array when no entries use a proxy mode.
   * Sorted ascending by `priority`. CpuCache routes these to
   * `ContentSource.fetchProxy`.
   */
  proxyRequests: ProxyRequest[];
  /**
   * Counters accumulated during this plan run. Always present (zeroed
   * if no work happened); cost is negligible. Consumers (the trace's
   * per-tick counters in `traceTick.ts`, tests) read it post-hoc to
   * surface decision rationale (catalog degradations) and culling
   * effectiveness.
   */
  stats: PlanStats;
  /**
   * Opaque carry-forward state for the next tick. The caller stores
   * this pointer and passes it back as the `state` argument to the
   * next `plan` call; it never inspects or constructs the
   * contents itself. Today this is `{ previousActiveSet: activeSet }`;
   * future planner-internal state (stickiness counters, anticipation
   * hints) drops in here without touching the caller.
   *
   * Cited ADR `0027-planning-state-as-the-carry-forward-seam.md`.
   */
  nextState: PlanningState;
}

/**
 * Per-plan accumulator. Counters are summed across all `iterateChunks`
 * calls (detail, prefetch, and coarse lanes) and across all entities.
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
  /**
   * Dataset id this request belongs to. The planner stamps this at
   * emit time from {@link PlanningSnapshot.datasetId}; the
   * orchestrator does not back-fill it after `plan()`.
   */
  datasetId: string;
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  /**
   * Which planning lane produced this request. `"minimap"` is the
   * highest priority — fetched first. The CPU cache and GPU upload
   * paths route per-lane.
   */
  lane: "minimap" | "detail" | "coarse" | "prefetch" | "overview";
  /** Residency tier this request fills. */
  tier: ResidencyTier;
  priority: number;
  /** Canonical key: "level/t/c/z/y/x" */
  chunkKey: string;
}

/**
 * A request to fetch a proxy asset for an entity. Mirrors
 * `lucida_protocol::AssetRequest` on the wire and is consumed by
 * [`CpuCache.submit`] which routes it to
 * [`ContentSource.fetchProxy`].
 *
 * The planner no longer emits these, because every tile entry it builds
 * has `proxyAvailable: false`. The type and its consumers stay until ADR
 * 0043 §C deletes the proxy-asset path as a whole.
 */
export interface ProxyRequest {
  datasetId: string;
  entityId: string;
  imageId: string;
  kind: "GroupProxy3D" | "TileProxy3D";
  t: number;
  c: number;
  /** Lower = more urgent. Same scale as `ChunkRequest.priority`. */
  priority: number;
}

/**
 * Per-tile mode carried on {@link TileEntry}. The planner emits
 * `tiles-with-detail` for every visible tile, because the tier model
 * renders from chunks alone. `tiles-with-proxy-fallback` (chunks plus a proxy asset
 * while detail loads) belongs to the proxy-asset path, which the planner
 * no longer drives; the cold-state and worker consumers still accept it
 * until ADR 0043 §C deletes that path as a whole.
 */
export type EntityMode =
  | "tiles-with-proxy-fallback"
  | "tiles-with-detail";

/**
 * One active-set entry per visible tile, plus pass-through entries for
 * invisible entities. Discriminated by `kind`
 * so each variant can declare only the tiles that make sense for it
 * (per-variant invariants compile-time enforced — see
 * [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]).
 *
 * Three variants:
 *   - {@link GroupAsProxyEntry} (`kind: "group-as-proxy"`) — a group
 *     rendered from its proxy asset; the planner no longer produces it
 *     (ADR 0043 §C).
 *   - {@link TileEntry} (`kind: "tile"`) — one per visible tile; carries
 *     the levels each residency tier holds and the proxy availability
 *     flags.
 *   - {@link InvisibleEntry} (`kind: "invisible"`) — one per invisible
 *     entity, carrying just the coarsest level for downstream eviction.
 *
 * Consumers narrow on `kind` before reading variant-specific tiles.
 */
export type ActiveSetEntry = GroupAsProxyEntry | TileEntry | InvisibleEntry;

/**
 * Active-set entry for a group rendered as a single `GroupProxy3D`
 * asset — no tile chunks. Carries only the group's id; level bookkeeping
 * and proxy availability flags are implicit (the group-proxy IS the
 * one asset that gets fetched at `PROXY_LANE_OFFSET`).
 */
export interface GroupAsProxyEntry {
  kind: "group-as-proxy";
  /** The group's entity id. */
  entityId: string;
}

/**
 * Active-set entry for a visible tile — one per visible tile of a group.
 * Carries the tile's owning image id, the levels each residency tier
 * holds, and the proxy availability flags that drive fallback request
 * emission.
 */
export interface TileEntry {
  kind: "tile";
  /** The tile's entity id. */
  entityId: string;
  /** The tile's owning image id (matches `EntitySnapshot.imageId`). */
  imageId: string;
  /** Per-tile mode. See {@link EntityMode}. */
  mode: EntityMode;
  /**
   * Levels the detail tier requests for this entity, the target level
   * first. The one description of the detail tier's levels from the
   * planner through cold state to the worker. Today it holds one level:
   * the dataset's level pin, or level 0 when none is set. The worker
   * reads `detailLevels[0]` as the target: it keeps sections for the
   * target and the coarser levels under it, and never samples a level
   * finer than it.
   */
  detailLevels: number[];
  /**
   * Level the coarse tier holds for this entity, or `null` when the
   * image has no coarse level that is at least as coarse as the detail
   * level.
   */
  coarseLevel: number | null;
  /**
   * Which proxy kind this entry would prefer, if any. Always
   * `TileProxy3D` when set; `undefined` if the catalog has no tile
   * proxy advertised for this entity.
   */
  proxyKind?: "TileProxy3D";
  /**
   * True if the entry's preferred proxy is known to be in the catalog
   * (the tile's `TileProxy3D`).
   */
  proxyAvailable: boolean;
  /**
   * Whether the parent group's `GroupProxy3D` is advertised. Drives the
   * secondary lower-priority group-proxy request in
   * `tiles-with-proxy-fallback` and the parent-fallback hint in
   * `tiles-with-detail`.
   */
  groupProxyAvailable: boolean;
}

/**
 * Active-set entry for an invisible entity — pass-through so the CPU
 * cache eviction tier mapping can still see it.
 * Carries only enough to identify the entity and its coarsest level
 * (the level its cold-state entry lists); no tier levels or proxy
 * fields, since invisibles don't request chunks or proxies.
 *
 * Distinct from a `tiles-with-detail` tile entry: keeping invisibles
 * as their own variant prevents `if (entry.mode === "tiles-with-detail")`
 * checks from accidentally including invisible entities.
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
