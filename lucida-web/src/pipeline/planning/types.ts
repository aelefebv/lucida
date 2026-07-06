/**
 * Planning types and interfaces. Leaf module so siblings can import
 * without circular dependencies. See ADR 0029.
 */

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { AssetCatalogSnapshot } from "../assetCatalog.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";

/**
 * Shared shape across every {@link EntitySnapshot} variant. Holds the
 * fields that don't depend on the entity's `kind`. The variants
 * specialise the discriminator and add `parentId` for {@link FieldSnapshot}.
 *
 * Conservative form: `levels` lives on the base because all three
 * variants still carry it (even {@link WellSnapshot}, despite
 * `well-as-proxy` never iterating well chunks). The aggressive form
 * stripping `levels` from {@link WellSnapshot} is deferred indefinitely;
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
 * one-entry "well" by `groupByWell` so the rest of the planner is
 * uniform. No `parentId` field — top-level entity by construction.
 */
export interface ImageSnapshot extends BaseEntitySnapshot {
  kind: "Image";
}

/**
 * A well entity on a collection. Top-level — no `parentId`. `groupByWell`
 * pairs it with its constituent {@link FieldSnapshot}s by id; promotion
 * may downgrade the well to `well-as-proxy` (rendered as one synthetic
 * cube) or leave it at field-mode (each field rendered separately).
 */
export interface WellSnapshot extends BaseEntitySnapshot {
  kind: "Well";
}

/**
 * A field entity belonging to a well on a collection. `parentId` is required
 * and non-null by contract: a field without a parent is a producer
 * invariant violation worth surfacing rather than silently coercing.
 *
 * Consumers that read `parentId` narrow on `kind === "Field"` first; the
 * post-narrow access has no `?? null` fallback.
 */
export interface FieldSnapshot extends BaseEntitySnapshot {
  kind: "Field";
  /**
   * Parent well's entity id. Required and non-null for {@link FieldSnapshot}
   * — `groupByWell` keys field grouping off this id. Only fields carry
   * a `parentId`; well/image variants don't.
   */
  parentId: string;
}

/**
 * Discriminated union of the three entity kinds. The previous flat
 * `EntitySnapshot` interface (with `parentId: string | null`) is
 * replaced; consumers narrow on `kind` before reading variant-specific
 * fields. Cited [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
 * extended from "carry-forward state is explicit" to "per-variant
 * invariants are compile-time enforced."
 */
export type EntitySnapshot = ImageSnapshot | WellSnapshot | FieldSnapshot;

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
   * Asset catalog snapshot for promotion. The orchestrator passes
   * `ctx.assetCatalog.snapshot()` (always non-null); Planning consults
   * it to decide whether `well-as-proxy` /
   * `fields-with-proxy-fallback` are reachable for each well.
   *
   * `null` is still accepted for callers that want to opt out — e.g.
   * tests and `createSyntheticSnapshot`. Treated as an empty catalog →
   * no proxies available → all wells degrade to `fields-with-detail`.
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
 * v1 contains a single field — the previous tick's active set — used by
 * `buildPrevModeByWell` to drive promotion-mode hysteresis. The
 * container exists so future state (per-well stickiness counters,
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
   * Promotion decisions: one entry per visible well (`well-as-proxy`)
   * or per visible field (field modes), plus invisible-entity
   * pass-throughs. Carries the resolved {@link EntityMode}, LOD range,
   * and proxy availability flags consumed by orchestrator delivery.
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
   * if no work happened); cost is negligible. Consumers (DebugPanel,
   * tests) read it post-hoc to surface decision rationale (catalog
   * degradations) and culling effectiveness.
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
 * calls (detail + prefetch + overview lanes) and across all entities.
 */
export interface PlanStats {
  /** How many times catalog-aware promotion downgraded a well's mode. */
  catalogDegradations: number;
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
    catalogDegradations: 0,
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
   * paths route per-lane (see [[cpu-cache]] for the eviction-tier
   * mapping).
   */
  lane: "minimap" | "detail" | "coarse" | "prefetch" | "overview";
  /**
   * Canonical residency tier this request fills. Kept optional for
   * migration compatibility with older tests/helpers; the planner emits
   * it on every request.
   */
  tier?: "detail" | "coarse";
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
 * Populated from the three-tier promotion: `WellProxy3D` for wells in
 * `well-as-proxy` and as a parent fallback for
 * `fields-with-proxy-fallback`; `FieldProxy3D` for fields in
 * `fields-with-proxy-fallback` and `fields-with-detail`.
 */
export interface ProxyRequest {
  datasetId: string;
  entityId: string;
  imageId: string;
  kind: "WellProxy3D" | "FieldProxy3D";
  t: number;
  c: number;
  /** Lower = more urgent. Same scale as `ChunkRequest.priority`. */
  priority: number;
}

/**
 * Per-field promotion mode for visible field entries, selected by
 * `chooseEntityMode` from the well's projected diagonal (max of
 * constituent fields, in pixels):
 *
 *   - `fields-with-proxy-fallback` (mid range)  — request real field detail
 *     chunks but also fetch `FieldProxy3D` per visible field and the
 *     parent's `WellProxy3D` as a fast fallback while detail loads.
 *   - `fields-with-detail`        (> `DETAIL_THRESHOLD_PX`)  — real
 *     field detail chunks only; proxy is a stand-in fallback that the
 *     worker uses when chunks are missing.
 *
 * The third tier — well-as-proxy (< `FAR_THRESHOLD_PX`) — does not
 * live on this type. It's a separate {@link ActiveSetEntry} variant
 * ({@link WellAsProxyEntry}) discriminated by `kind`, so per-variant
 * invariants (no LOD bookkeeping for well-as-proxy, no proxy
 * bookkeeping for invisible) are compile-time enforced rather than
 * JSDoc'd.
 */
export type EntityMode =
  | "fields-with-proxy-fallback"
  | "fields-with-detail";

/**
 * The full per-well decision space — what `chooseEntityMode` and
 * `degradeForCatalog` return before the variant split. Includes
 * `well-as-proxy` because the per-well decision step still discriminates
 * on it before `assignModes` translates each result into the
 * matching {@link ActiveSetEntry} variant.
 *
 * Distinct from {@link EntityMode}, which is the narrower per-field
 * mode that lives only on {@link FieldEntry}.
 */
export type ResolvedMode = EntityMode | "well-as-proxy";

/**
 * Promotion decision for one visible well or visible field, plus
 * pass-through entries for invisible entities. Discriminated by `kind`
 * so each variant can declare only the fields that make sense for it
 * (per-variant invariants compile-time enforced — see
 * [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]).
 *
 * Three variants:
 *   - {@link WellAsProxyEntry} (`kind: "well-as-proxy"`) — one per
 *     well-as-proxy well; carries no LOD or imageId data.
 *   - {@link FieldEntry} (`kind: "field"`) — one per visible field in
 *     a field-mode well; carries LOD range, proxy availability flags.
 *   - {@link InvisibleEntry} (`kind: "invisible"`) — one per invisible
 *     entity, carrying just the coarsest LOD for downstream eviction.
 *
 * Consumers narrow on `kind` before reading variant-specific fields.
 */
export type ActiveSetEntry = WellAsProxyEntry | FieldEntry | InvisibleEntry;

/**
 * Active-set entry for a well rendered as a single `WellProxy3D`
 * asset — no field chunks. Carries only the well's id; LOD bookkeeping
 * and proxy availability flags are implicit (the well-proxy IS the
 * one asset that gets fetched at `PROXY_LANE_OFFSET`).
 */
export interface WellAsProxyEntry {
  kind: "well-as-proxy";
  /** The well's entity id. */
  entityId: string;
}

/**
 * Active-set entry for a visible field — one per visible field of a
 * well in a field-mode promotion. Carries the field's owning image
 * id, the planning LOD range, and proxy availability flags that drive
 * the fallback request emission.
 */
export interface FieldEntry {
  kind: "field";
  /** The field's entity id. */
  entityId: string;
  /** The field's owning image id (matches `EntitySnapshot.imageId`). */
  imageId: string;
  /** Per-field promotion mode. See {@link EntityMode}. */
  mode: EntityMode;
  targetLod: number;
  coarsestDetailLod: number;
  /** [finest, coarsest] inclusive. */
  detailOwnedLodRange: [number, number];
  /** Explicit detail tier level for the chunk-only coarse/detail path. */
  detailLevel?: number;
  /** Explicit coarse tier level for the chunk-only coarse/detail path. */
  coarseLevel?: number | null;
  /**
   * When present, worker wanted-set should only ask for these LODs even
   * if `detailOwnedLodRange` spans intermediate levels for shader
   * fallback ordering.
   */
  wantedLodLevels?: number[];
  /**
   * Which proxy kind this entry would prefer, if any. Always
   * `FieldProxy3D` when set; `undefined` if the catalog has no field
   * proxy advertised for this entity.
   */
  proxyKind?: "FieldProxy3D";
  /**
   * True if the entry's preferred proxy is known to be in the catalog
   * (the field's `FieldProxy3D`).
   */
  proxyAvailable: boolean;
  /**
   * Whether the parent well's `WellProxy3D` is advertised. Drives the
   * secondary lower-priority well-proxy request in
   * `fields-with-proxy-fallback` and the parent-fallback hint in
   * `fields-with-detail`.
   */
  wellProxyAvailable: boolean;
}

/**
 * Active-set entry for an invisible entity — pass-through so the CPU
 * cache eviction tier mapping and debug panels can still see it.
 * Carries only enough to identify the entity and its coarsest level
 * (used for overview-lane bookkeeping); no LOD range or proxy fields,
 * since invisibles don't request chunks or proxies.
 *
 * Distinct from a `fields-with-detail` field entry: keeping invisibles
 * as their own variant prevents `if (entry.mode === "fields-with-detail")`
 * checks from accidentally including invisible entities.
 */
export interface InvisibleEntry {
  kind: "invisible";
  entityId: string;
  imageId: string;
  /** The entity's coarsest LOD (= `levels.length - 1`, or 0 if empty). */
  coarsestLod: number;
}

export interface WellGroup {
  /** The well's entity id. May be derived from `parentId` of fields. */
  wellId: string;
  /**
   * The visible well entity if {@link EntitySnapshot.kind} === "Well"
   * was in `entities`, otherwise `null`.
   */
  wellEntity: EntitySnapshot | null;
  /** All visible field entities whose `parentId === wellId`. */
  fields: EntitySnapshot[];
  /** Max projectedDiagonalPx across well + fields. */
  projectedDiagonalPx: number;
}
