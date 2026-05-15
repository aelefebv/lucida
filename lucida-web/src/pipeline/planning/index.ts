/**
 * Planning domain — types and runtime functions for the chunk planning pipeline.
 *
 * This module defines the full input/output contract for the planning step:
 *   PlanningSnapshot  ->  RequestPlan
 *
 * Currently implements:
 *   - assignModes()  — three-tier per-well mode assignment + LOD range
 *   - createSyntheticSnapshot() / createSyntheticEntity() — re-exported from
 *     `./synthetic.ts` for backward compat with existing test imports.
 */

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { AssetCatalogSnapshot } from "../assetCatalog.ts";
import { snapshotHasProxy } from "../assetCatalog.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  FAR_THRESHOLD_PX,
  type PlanningConfig,
} from "./config.ts";

// Re-export so callers can `import { PlanningConfig, ... } from "./planning/index.ts"`.
// The default-value constants live in `./config.ts` (the leaf module) so
// `DEFAULT_PLANNING_CONFIG` can read them without a circular import; we
// re-export them here under their historical public names.
export {
  DEFAULT_PLANNING_CONFIG,
  mergeConfig,
  type PlanningConfig,
  FAR_THRESHOLD_PX,
  DETAIL_THRESHOLD_PX,
  HYSTERESIS_PX,
  MINIMAP_LANE_OFFSET,
  OVERVIEW_LANE_OFFSET,
  PREFETCH_LANE_OFFSET,
  PROXY_LANE_OFFSET,
  DETAIL_LANE_OFFSET,
  PREFETCH_DEPTH,
  IMPORTANCE_WEIGHT,
  DISTANCE_WEIGHT,
  WELL_PROXY_PRIORITY_BUMP,
} from "./config.ts";

/**
 * Backwards-compat alias for the legacy constant. Many tests still import
 * `PROMOTE_THRESHOLD_PX`; map it onto the new far threshold so the value
 * still means "below this we use the proxy/coarse representation".
 */
export const PROMOTE_THRESHOLD_PX = FAR_THRESHOLD_PX;

// ---------------------------------------------------------------------------
// EntitySnapshot — discriminated union (PRD #563 / Slice 5)
// ---------------------------------------------------------------------------

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
  importance: number;
  /** Layout placement position. */
  position: [number, number];
  levels: LevelGeometry[];
}

/**
 * A standalone image entity (non-plate datasets). Treated as its own
 * one-entry "well" by {@link groupByWell} so the rest of the planner is
 * uniform. No `parentId` field — top-level entity by construction.
 */
export interface ImageSnapshot extends BaseEntitySnapshot {
  kind: "Image";
}

/**
 * A well entity on a plate. Top-level — no `parentId`. {@link groupByWell}
 * pairs it with its constituent {@link FieldSnapshot}s by id; promotion
 * may downgrade the well to `well-as-proxy` (rendered as one synthetic
 * cube) or leave it at field-mode (each field rendered separately).
 */
export interface WellSnapshot extends BaseEntitySnapshot {
  kind: "Well";
}

/**
 * A field entity belonging to a well on a plate. `parentId` is required
 * and non-null by contract: a field without a parent is a producer
 * invariant violation worth surfacing rather than silently coercing.
 *
 * PRD #563 / Slice 5: `parentId: string` is enforced at the type level.
 * Consumers that read it narrow on `kind === "Field"` first; the post-
 * narrow access has no `?? null` fallback.
 */
export interface FieldSnapshot extends BaseEntitySnapshot {
  kind: "Field";
  /**
   * Parent well's entity id. Required and non-null for {@link FieldSnapshot}
   * — `groupByWell` keys field grouping off this id. PRD #563 / Slice 5:
   * the previous `parentId: string | null` on the flat type is now
   * per-variant; only fields carry one.
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

// ---------------------------------------------------------------------------
// SelectionState
// ---------------------------------------------------------------------------

export interface SelectionState {
  t: number;
  c: number;
  z: number;
  visibleChannels: number[];
  renderMode: "slice" | "volume";
  interactionState: "idle" | "panning" | "zooming" | "scrubbing";
}

// ---------------------------------------------------------------------------
// Cache / worker snapshots
// ---------------------------------------------------------------------------

export interface CacheStateSnapshot {
  /** entityId -> set of chunk keys currently cached. */
  cached: Map<string, Set<string>>;
  /** entityId -> set of chunk keys currently being fetched. */
  inFlight: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// AssetCatalogSnapshot
// ---------------------------------------------------------------------------

// Re-exported from `./assetCatalog.ts` so consumers of the planning
// snapshot don't need a separate import. S3 wires the snapshot through
// the orchestrator with `byEntity` empty; S6 makes Planning consume it.
export type { AssetCatalogSnapshot, ProxyKind } from "../assetCatalog.ts";

// ---------------------------------------------------------------------------
// MinimapChunkCoord  (canonical home — Slice 5)
// ---------------------------------------------------------------------------

/**
 * Lightweight chunk coordinate carried inside {@link PlanningSnapshot.minimapPending}.
 *
 * Slice 5 of PRD #545 promoted minimap to its own dedicated lane and
 * consolidated this type here (it was previously duplicated between
 * `pipeline/orchestrator.ts` and `pipeline/planning/snapshot.ts`).
 * Both producers now import this single definition.
 *
 * The orchestrator (and the minimap path that fills its
 * `pendingFetch` map) populates one of these per missing minimap
 * chunk; {@link emitMinimapLane} translates them into
 * {@link ChunkRequest}s at {@link MINIMAP_LANE_OFFSET}.
 */
export interface MinimapChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  /** Canonical chunk key, equivalent to {@link chunkKey}'s output. */
  key: string;
}

// ---------------------------------------------------------------------------
// PlanningSnapshot  (full input)
// ---------------------------------------------------------------------------

export interface PlanningSnapshot {
  /**
   * Dataset identifier this snapshot pertains to. Carried on the
   * snapshot so the planner can stamp it onto every emitted
   * {@link ChunkRequest} and {@link ProxyRequest} at emit time —
   * removing the orchestrator's post-`plan()` mutation loops that
   * previously back-filled it. Required as of PRD #563 / Slice 1.
   */
  datasetId: string;
  epochs: SceneEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  /**
   * Asset catalog snapshot for promotion. The orchestrator passes
   * `ctx.assetCatalog.snapshot()` (always non-null since S3); Planning
   * S6 consults it to decide whether `well-as-proxy` /
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
   * Slice 5 of PRD #545 wires this through the planning snapshot so
   * {@link emitMinimapLane} can emit them at {@link MINIMAP_LANE_OFFSET},
   * the highest priority in the system. Empty map ⇒ no minimap work
   * this tick (planning emits no minimap requests).
   */
  minimapPending: Map<string, MinimapChunkCoord[]>;
}

// ---------------------------------------------------------------------------
// PlanningState  (carry-forward seam)
// ---------------------------------------------------------------------------

/**
 * Carry-forward state that survives across planning ticks. Distinct
 * from {@link PlanningSnapshot} (the world this tick) and
 * {@link PlanningConfig} (the tunables). The caller stores the opaque
 * pointer returned in {@link RequestPlan.nextState} and threads it into
 * the next call to {@link plan}.
 *
 * v1 contains a single field — the previous tick's active set — used by
 * {@link buildPrevModeByWell} to drive promotion-mode hysteresis. The
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

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

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
   * Proxy assets to fetch alongside chunks. Populated by S6 promotion.
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
   * next {@link plan} call; it never inspects or constructs the
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
   * Dataset id this request belongs to. Required as of PRD #563 /
   * Slice 1: the planner stamps this at emit time from
   * {@link PlanningSnapshot.datasetId} so the orchestrator no longer
   * needs to back-fill it via post-`plan()` mutation loops.
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
   * Which planning lane produced this request. Slice 5 of PRD #545
   * added the `"minimap"` lane (highest priority — fetched first).
   * The CPU cache and GPU upload paths route per-lane (see
   * [[cpu-cache]] for the eviction-tier mapping).
   */
  lane: "minimap" | "detail" | "proxy" | "prefetch" | "overview";
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
 * S6 populates these from the three-tier promotion: `WellProxy3D` for
 * wells in `well-as-proxy` and as a parent fallback for
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
 * {@link chooseEntityMode} from the well's projected diagonal (max of
 * constituent fields, in pixels):
 *
 *   - `fields-with-proxy-fallback` (mid range)  — request real field detail
 *     chunks but also fetch `FieldProxy3D` per visible field and the
 *     parent's `WellProxy3D` as a fast fallback while detail loads.
 *   - `fields-with-detail`        (> {@link DETAIL_THRESHOLD_PX})  — real
 *     field detail chunks only; proxy is a stand-in fallback that the
 *     worker uses when chunks are missing.
 *
 * The third tier — well-as-proxy (< {@link FAR_THRESHOLD_PX}) — no
 * longer lives on this type. It's a separate {@link ActiveSetEntry}
 * variant ({@link WellAsProxyEntry}) discriminated by `kind`. PRD #563
 * / Slice 4: per-variant invariants (no LOD bookkeeping for
 * well-as-proxy, no proxy bookkeeping for invisible) are now
 * compile-time enforced rather than JSDoc'd.
 */
export type EntityMode =
  | "fields-with-proxy-fallback"
  | "fields-with-detail";

/**
 * The full per-well decision space — what {@link chooseEntityMode} and
 * {@link degradeForCatalog} return before the variant split. Includes
 * `well-as-proxy` because the per-well decision step still discriminates
 * on it before {@link assignModes} translates each result into the
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
 * (per-variant invariants compile-time enforced — PRD #563 / Slice 4
 * extends [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]]
 * from "carry-forward state is explicit" to "per-variant invariants are
 * compile-time enforced").
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
 * one asset that gets fetched at {@link PROXY_LANE_OFFSET}).
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
 * Distinct from a `fields-with-detail` field entry — the previous
 * encoding conflated them under `mode: "fields-with-detail"`, which
 * was a real footgun for `if (entry.mode === "fields-with-detail")`
 * checks. PRD #563 / Slice 4 splits them cleanly.
 */
export interface InvisibleEntry {
  kind: "invisible";
  entityId: string;
  imageId: string;
  /** The entity's coarsest LOD (= `levels.length - 1`, or 0 if empty). */
  coarsestLod: number;
}

// ---------------------------------------------------------------------------
// assignModes()
// ---------------------------------------------------------------------------

/**
 * Decide a {@link ResolvedMode} for the given projected diagonal,
 * applying symmetric ±`config.hysteresisPx` hysteresis around both the
 * far and medium thresholds.
 *
 * Outside the bands the natural mode is forced. Inside a band the
 * previous mode wins as long as it's adjacent to the natural choice.
 *
 * Returns the broader {@link ResolvedMode} (which still includes
 * `"well-as-proxy"`) — the per-well decision step works on this set
 * before {@link assignModes} translates each result into the matching
 * {@link ActiveSetEntry} variant. PRD #563 / Slice 4: {@link EntityMode}
 * narrows to the two field-mode values, so `chooseEntityMode` returns
 * the wider union.
 *
 * The `config` parameter defaults to {@link DEFAULT_PLANNING_CONFIG} so
 * call sites that don't care about live tunables (most tests) keep
 * working unchanged.
 */
export function chooseEntityMode(
  prevMode: ResolvedMode | null,
  projectedDiagonalPx: number,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): ResolvedMode {
  const farUpper = config.farThresholdPx + config.hysteresisPx;
  const farLower = config.farThresholdPx - config.hysteresisPx;
  const medUpper = config.detailThresholdPx + config.hysteresisPx;
  const medLower = config.detailThresholdPx - config.hysteresisPx;

  // Clearly past the thresholds: natural choice wins.
  if (projectedDiagonalPx < farLower) return "well-as-proxy";
  if (projectedDiagonalPx > medUpper) return "fields-with-detail";
  if (projectedDiagonalPx >= farUpper && projectedDiagonalPx <= medLower) {
    return "fields-with-proxy-fallback";
  }

  // In a hysteresis band — keep prev mode if it's a sensible neighbor.
  if (prevMode === "well-as-proxy" && projectedDiagonalPx < farUpper) {
    return "well-as-proxy";
  }
  if (prevMode === "fields-with-detail" && projectedDiagonalPx > medLower) {
    return "fields-with-detail";
  }
  if (prevMode === "fields-with-proxy-fallback") {
    // Already in the middle band — only flip when clearly past.
    return "fields-with-proxy-fallback";
  }
  return prevMode ?? "fields-with-proxy-fallback";
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

/**
 * Group visible field entities by their parent well, also surfacing
 * standalone {@link EntitySnapshot}s with `kind === "Image"` (which are
 * treated as their own one-entry "well" so the rest of the pipeline is
 * uniform).
 *
 * `kind === "Well"` entries are grouped with their fields; if a well is
 * visible but has no visible fields, it still appears as a group with
 * `fields: []`.
 *
 * Exported so the orchestrator can reuse the same well-grouping rule
 * when building the render-layer roster (see ADR 0025).
 */
export function groupByWell(entities: EntitySnapshot[]): WellGroup[] {
  const groups = new Map<string, WellGroup>();

  for (const entity of entities) {
    if (!entity.visible) continue;

    if (entity.kind === "Well") {
      const wellId = entity.entityId;
      let group = groups.get(wellId);
      if (!group) {
        group = {
          wellId,
          wellEntity: entity,
          fields: [],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        };
        groups.set(wellId, group);
      } else {
        group.wellEntity = entity;
        group.projectedDiagonalPx = Math.max(
          group.projectedDiagonalPx,
          entity.projectedDiagonalPx,
        );
      }
      continue;
    }

    if (entity.kind === "Field") {
      // PRD #563 / Slice 5: `FieldSnapshot.parentId` is `string`
      // (non-null by construction). The previous orphan-field branch
      // (`parentId === null`) is removed — a field without a parent
      // is now a producer invariant violation.
      const wellId = entity.parentId;
      let group = groups.get(wellId);
      if (!group) {
        group = {
          wellId,
          wellEntity: null,
          fields: [entity],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        };
        groups.set(wellId, group);
      } else {
        group.fields.push(entity);
        group.projectedDiagonalPx = Math.max(
          group.projectedDiagonalPx,
          entity.projectedDiagonalPx,
        );
      }
      continue;
    }

    // kind === "Image": treat as singleton group (its own "well") so
    // non-plate datasets keep working transparently.
    const wellId = `__image__${entity.entityId}`;
    groups.set(wellId, {
      wellId,
      wellEntity: null,
      fields: [entity],
      projectedDiagonalPx: entity.projectedDiagonalPx,
    });
  }

  return [...groups.values()];
}

/**
 * Build the prev-mode lookup keyed by well id.
 *
 * Indexes the previous active set by well id (for `well-as-proxy`
 * entries — `entityId` IS the wellId) or by parent well id (for field
 * entries) so both lookups land on the same `prevMode`. Returns a
 * fresh `Map`. Invisible entries are skipped — they had no promotion
 * decision to remember.
 *
 * Returns the broader {@link ResolvedMode} (since
 * `well-as-proxy` is no longer part of {@link EntityMode}). The map's
 * value still keys back into {@link chooseEntityMode}'s `prevMode`
 * argument.
 *
 * Pure helper — extracted from `assignModes` so the per-tick
 * mode-decision flow reads as `prev = buildPrevModeByWell(...);
 * desired = chooseEntityMode(prev, ...)`.
 */
export function buildPrevModeByWell(
  prev: ActiveSetEntry[],
  entities: EntitySnapshot[],
): Map<string, ResolvedMode> {
  const prevModeByWell = new Map<string, ResolvedMode>();
  // Build a map from (entityId → wellId) so we can resolve where a
  // field-mode entry's mode "belongs". For `well-as-proxy` entries
  // entityId IS the wellId.
  const fieldEntityToWell = new Map<string, string>();
  for (const entity of entities) {
    // PRD #563 / Slice 5: narrowing on `kind === "Field"` gives us a
    // {@link FieldSnapshot} with `parentId: string` (non-null). The
    // previous `&& entity.parentId` guard is unnecessary.
    if (entity.kind === "Field") {
      fieldEntityToWell.set(entity.entityId, entity.parentId);
    }
  }
  for (const p of prev) {
    if (p.kind === "well-as-proxy") {
      prevModeByWell.set(p.entityId, "well-as-proxy");
    } else if (p.kind === "field") {
      const wellId = fieldEntityToWell.get(p.entityId);
      if (wellId !== undefined) {
        // Same-well field-mode entries always agree on mode, so
        // first-write-wins is fine.
        if (!prevModeByWell.has(wellId)) {
          prevModeByWell.set(wellId, p.mode);
        }
      }
    }
    // p.kind === "invisible" — skip; invisible entries had no
    // promotion decision to remember.
  }
  return prevModeByWell;
}

/**
 * Catalog-aware tier degrade.
 *
 * Steps the desired mode down by exactly one tier when the chosen mode
 * requires a proxy that the catalog does not advertise. Tier order is
 * `well-as-proxy → fields-with-proxy-fallback → fields-with-detail`;
 * tier-skipping is forbidden (see ADR 0024 for the rationale).
 *
 * Each step increments `stats.catalogDegradations` by 1 if `stats` is
 * non-null. A well that degrades twice (e.g. all the way from
 * `well-as-proxy` to `fields-with-detail`) increments by 2.
 *
 * Operates on the broader {@link ResolvedMode} so the per-well decision
 * step (which still discriminates on `well-as-proxy`) keeps a single
 * call site. {@link assignModes} translates the post-degrade value
 * into the matching {@link ActiveSetEntry} variant.
 */
export function degradeForCatalog(
  desired: ResolvedMode,
  group: WellGroup,
  catalog: AssetCatalogSnapshot | null,
  stats: PlanStats | null,
): ResolvedMode {
  const wellHasProxy =
    catalog !== null && snapshotHasProxy(catalog, group.wellId, "WellProxy3D");
  const anyFieldHasProxy =
    catalog !== null &&
    group.fields.some((f) => snapshotHasProxy(catalog, f.entityId, "FieldProxy3D"));

  let mode: ResolvedMode = desired;
  if (mode === "well-as-proxy" && !wellHasProxy) {
    mode = "fields-with-proxy-fallback";
    if (stats) stats.catalogDegradations++;
  }
  if (
    mode === "fields-with-proxy-fallback" &&
    !anyFieldHasProxy &&
    !wellHasProxy
  ) {
    mode = "fields-with-detail";
    if (stats) stats.catalogDegradations++;
  }
  return mode;
}

/**
 * Decide each entity's promotion mode and compute its LOD range.
 *
 * Three-tier per-well decision (S6):
 *   - Group fields by parent well (or treat plain Images as singletons).
 *   - For each group, pick a {@link EntityMode} from the group's projected
 *     diagonal with hysteresis against the previous active set.
 *   - Catalog-aware degrade: if the chosen mode requires a proxy that
 *     isn't advertised, fall through to the next finer mode.
 *   - Emit one `ActiveSetEntry` per well (`well-as-proxy`) or one per
 *     visible field (field modes).
 */
export function assignModes(
  entities: EntitySnapshot[],
  previousActiveSet: ActiveSetEntry[],
  catalog: AssetCatalogSnapshot | null = null,
  stats: PlanStats | null = null,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): ActiveSetEntry[] {
  const prevModeByWell = buildPrevModeByWell(previousActiveSet, entities);

  const out: ActiveSetEntry[] = [];

  for (const group of groupByWell(entities)) {
    const prev = prevModeByWell.get(group.wellId) ?? null;
    const desired = chooseEntityMode(prev, group.projectedDiagonalPx, config);
    const mode = degradeForCatalog(desired, group, catalog, stats);

    // We need wellHasProxy as the `wellProxyAvailable` flag on field
    // entries. `degradeForCatalog` recomputes it internally; we
    // recompute here too because we need the value, not just the
    // post-degrade mode. Cheap to recheck.
    const wellHasProxy =
      catalog !== null && snapshotHasProxy(catalog, group.wellId, "WellProxy3D");

    if (mode === "well-as-proxy") {
      out.push(makeWellAsProxyEntry(group));
      continue;
    }

    // Field-mode (proxy-fallback or detail). One entry per visible
    // field. `wellEntity` (if visible) is intentionally NOT emitted as
    // its own entry: the well's geometry is represented by its fields.
    // `mode` here is narrowed to {@link EntityMode} because the
    // `well-as-proxy` arm short-circuits above.
    for (const field of group.fields) {
      out.push(makeFieldEntry(field, mode, wellHasProxy, catalog));
    }
  }

  // Pass-through: invisible entities still need to appear so that
  // downstream consumers (CpuCache eviction tier, debug panels, etc.)
  // can see them. PRD #563 / Slice 4: invisibles are now their own
  // dedicated `InvisibleEntry` variant — no longer conflated with
  // `mode: "fields-with-detail"` field entries. They contribute no
  // chunk requests (the planner's lane emitters skip them).
  for (const entity of entities) {
    if (entity.visible) continue;
    out.push(makeInvisibleEntry(entity));
  }

  return out;
}

function makeWellAsProxyEntry(group: WellGroup): WellAsProxyEntry {
  return {
    kind: "well-as-proxy",
    entityId: group.wellId,
  };
}

function makeFieldEntry(
  entity: EntitySnapshot,
  mode: EntityMode,
  wellProxyAvailable: boolean,
  catalog: AssetCatalogSnapshot | null,
): FieldEntry {
  // PRD #545 dropped the legacy `+2` LOD buffer: planning now hands
  // the caller exactly one level. The orchestrator no longer filters
  // the request stream to the target level either, so a buffered range
  // would have queued chunks the cache could never use.
  const targetLod = entity.idealTargetLod;
  const coarsestDetailLod = targetLod;
  const fieldProxyAvailable =
    catalog !== null && snapshotHasProxy(catalog, entity.entityId, "FieldProxy3D");

  return {
    kind: "field",
    entityId: entity.entityId,
    imageId: entity.imageId,
    mode,
    targetLod,
    coarsestDetailLod,
    detailOwnedLodRange: [targetLod, coarsestDetailLod],
    proxyKind: "FieldProxy3D",
    proxyAvailable: fieldProxyAvailable,
    wellProxyAvailable,
  };
}

function makeInvisibleEntry(entity: EntitySnapshot): InvisibleEntry {
  const coarsest = Math.max(entity.levels.length - 1, 0);
  return {
    kind: "invisible",
    entityId: entity.entityId,
    imageId: entity.imageId,
    coarsestLod: coarsest,
  };
}

// ---------------------------------------------------------------------------
// Synthetic test helpers
// ---------------------------------------------------------------------------

// Re-exported from `./synthetic.ts` so callers that still import from
// the planning entry point keep working without churn.
export {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
} from "./synthetic.ts";

// ---------------------------------------------------------------------------
// chunkKey()
// ---------------------------------------------------------------------------

/** Canonical chunk key: "level/t/c/z/y/x". */
export function chunkKey(
  level: number,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): string {
  return `${level}/${t}/${c}/${z}/${y}/${x}`;
}

// ---------------------------------------------------------------------------
// chunkOutsideFrustum()
// ---------------------------------------------------------------------------

/**
 * Test whether a chunk AABB is fully outside any frustum half-plane.
 *
 * Uses the p-vertex method: for each plane [a, b, c, d], test the AABB corner
 * most aligned with the plane normal.  If that corner is on the negative side,
 * the entire chunk is outside.
 */
export function chunkOutsideFrustum(
  cmin: [number, number, number],
  cmax: [number, number, number],
  planes: [number, number, number, number][],
): boolean {
  for (const plane of planes) {
    const px = plane[0] >= 0 ? cmax[0] : cmin[0];
    const py = plane[1] >= 0 ? cmax[1] : cmin[1];
    const pz = plane[2] >= 0 ? cmax[2] : cmin[2];
    if (plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// chunkWorldDims()
// ---------------------------------------------------------------------------

/**
 * Per-axis world size of a chunk at a given LOD, expressed in level-0
 * voxel units. Returns `[x, y, z]`. Used by both spatial enumeration
 * (`iterateGridCells`) and distance scoring (`chunkDistanceFromCenter`)
 * so they agree on the same conversion.
 *
 * Indexing follows the 5-D layout: `[T, C, Z, Y, X]` → indices 4 (X),
 * 3 (Y), 2 (Z).
 */
export function chunkWorldDims(
  geo: LevelGeometry,
  level0: LevelGeometry,
): [number, number, number] {
  const scaleX = level0.shape[4] / geo.shape[4];
  const scaleY = level0.shape[3] / geo.shape[3];
  const scaleZ = level0.shape[2] / geo.shape[2];
  return [
    geo.chunk_shape[4] * scaleX,
    geo.chunk_shape[3] * scaleY,
    geo.chunk_shape[2] * scaleZ,
  ];
}

// ---------------------------------------------------------------------------
// iterateChunks() / iterateChunksAtLodRange()
// ---------------------------------------------------------------------------

/**
 * Enumerate chunk grid cells for a promoted entity, applying spatial culling
 * and cache filtering.  Iterates all LOD levels in the entry's owned range,
 * all visible channels, and the spatial grid cells that overlap the visible
 * region.
 *
 * Ported from Rust `visible_chunks()` in lucida-core/src/chunk.rs.
 *
 * Accepts the full {@link ActiveSetEntry} union so callers don't have to
 * pre-narrow. Short-circuits to an empty list for non-field entries:
 *   - `well-as-proxy` — the well is served by a single proxy asset,
 *     not by chunk requests.
 *   - `invisible` — pass-through entry; no chunk requests apply.
 *
 * Returned `ChunkRequest`s are placeholders: `priority` is `0`, `lane`
 * is `"detail"`, and `datasetId` is stamped from the caller-supplied
 * arg (defaults to the empty string for synthetic test snapshots that
 * don't model dataset ownership). The caller (`plan()`) finalises
 * `priority`/`lane` per lane before they leave the planner.
 *
 * Thin wrapper around {@link iterateChunksAtLodRange}: short-circuits
 * for non-field entries and reads the LOD range from the field entry.
 */
export function iterateChunks(
  entity: EntitySnapshot,
  entry: ActiveSetEntry,
  visibleRegion: VisibleRegion,
  selection: SelectionState,
  stats: PlanStats | null = null,
  datasetId = "",
): ChunkRequest[] {
  if (entry.kind !== "field") return [];
  return iterateChunksAtLodRange(
    entity,
    entry.detailOwnedLodRange,
    visibleRegion,
    selection,
    stats,
    datasetId,
  );
}

/**
 * Spatial enumeration primitive. Iterates the LOD range from coarsest
 * down to finest, all visible channels, and pushes one
 * {@link ChunkRequest} per surviving grid cell.
 *
 * This is the form used directly by the overview lane (which doesn't
 * need an `ActiveSetEntry` to supply the range — it always wants the
 * coarsest level). The detail/prefetch lanes call {@link iterateChunks}
 * which forwards the range from the active-set entry.
 */
export function iterateChunksAtLodRange(
  entity: EntitySnapshot,
  lodRange: [number, number],
  visibleRegion: VisibleRegion,
  selection: SelectionState,
  stats: PlanStats | null = null,
  datasetId = "",
): ChunkRequest[] {
  const requests: ChunkRequest[] = [];

  if (entity.levels.length === 0) {
    return requests;
  }

  const [finest, coarsest] = lodRange;

  // Iterate from coarsest (seed) down to finest (target).
  for (let level = coarsest; level >= finest; level--) {
    const levelGeo = entity.levels[level];
    if (levelGeo === undefined) continue;

    const level0 = entity.levels[0];
    if (level0 === undefined) continue;

    for (const c of selection.visibleChannels) {
      iterateGridCells(
        entity,
        visibleRegion,
        selection,
        levelGeo,
        level0,
        level,
        c,
        requests,
        stats,
        datasetId,
      );
    }
  }

  return requests;
}

/**
 * Iterate the spatial grid cells for one (level, channel) pair, pushing
 * matching ChunkRequests into `out`.
 *
 * Decomposes into named primitives:
 *   - {@link clipGridCellsToRegion}: reduces the full grid to the
 *     index range that overlaps the visible region; mutates `stats`
 *     for `considered`/`afterXyBounds`/`afterZRange`.
 *   - {@link cellSurvivesFrustum}: per-cell frustum test.
 *   - {@link makeChunkRequest}: emit a placeholder ChunkRequest.
 */
function iterateGridCells(
  entity: EntitySnapshot,
  region: VisibleRegion,
  selection: SelectionState,
  levelGeo: LevelGeometry,
  level0: LevelGeometry,
  level: number,
  c: number,
  out: ChunkRequest[],
  stats: PlanStats | null = null,
  datasetId = "",
): void {
  const [chunkWorldX, chunkWorldY, chunkWorldZ] = chunkWorldDims(
    levelGeo,
    level0,
  );

  const clip = clipGridCellsToRegion(
    entity,
    region,
    levelGeo,
    level0,
    chunkWorldX,
    chunkWorldY,
    chunkWorldZ,
    stats,
  );
  if (clip === null) return;

  const { colStart, colEnd, rowStart, rowEnd, zStart, zEnd } = clip;

  for (let iz = zStart; iz < zEnd; iz++) {
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        if (
          !cellSurvivesFrustum(
            entity,
            region,
            col,
            row,
            iz,
            chunkWorldX,
            chunkWorldY,
            chunkWorldZ,
          )
        ) {
          continue;
        }
        if (stats) stats.culling.afterFrustum++;

        out.push(
          makeChunkRequest(entity, datasetId, level, selection.t, c, iz, row, col),
        );
      }
    }
  }
}

interface ClippedGridRange {
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
  zStart: number;
  zEnd: number;
}

/**
 * Clip the level's full chunk grid to the visible region, returning the
 * index-space range to iterate, or `null` if there is no overlap.
 *
 * Side effect: increments `stats.culling.considered`,
 * `stats.culling.afterXyBounds`, and `stats.culling.afterZRange`. The
 * mutation pattern is preserved exactly so the Slice 1 characterization
 * tests still pass.
 */
function clipGridCellsToRegion(
  entity: EntitySnapshot,
  region: VisibleRegion,
  levelGeo: LevelGeometry,
  level0: LevelGeometry,
  chunkWorldX: number,
  chunkWorldY: number,
  chunkWorldZ: number,
  stats: PlanStats | null,
): ClippedGridRange | null {
  // 5D indices: [T=0, C=1, Z=2, Y=3, X=4]
  const fullX = level0.shape[4];
  const fullY = level0.shape[3];

  // Max grid index (exclusive).
  const maxCol = levelGeo.grid_shape[4];
  const maxRow = levelGeo.grid_shape[3];
  const maxZ = levelGeo.grid_shape[2];

  // Whole-grid count is "considered" — every cell at this (level, channel)
  // that could have been emitted before culling.
  const totalCells = maxCol * maxRow * maxZ;
  if (stats) stats.culling.considered += totalCells;

  // Offset visible region by entity position to get local coords.
  const localMinX = region.xyBounds[0] - entity.position[0];
  const localMinY = region.xyBounds[1] - entity.position[1];
  const localMaxX = region.xyBounds[2] - entity.position[0];
  const localMaxY = region.xyBounds[3] - entity.position[1];

  // Early-out: no overlap at all.
  if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) {
    return null;
  }

  const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
  const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
  const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
  const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));

  const zStart = Math.max(0, Math.floor(region.zRange[0] / chunkWorldZ));
  const zEnd = Math.min(maxZ, Math.max(0, Math.ceil(region.zRange[1] / chunkWorldZ)));

  if (stats) {
    const colsKept = Math.max(0, colEnd - colStart);
    const rowsKept = Math.max(0, rowEnd - rowStart);
    const zsKept = Math.max(0, zEnd - zStart);
    stats.culling.afterXyBounds += colsKept * rowsKept * maxZ;
    stats.culling.afterZRange += colsKept * rowsKept * zsKept;
  }

  return { colStart, colEnd, rowStart, rowEnd, zStart, zEnd };
}

/**
 * Per-cell frustum test. Returns `true` if the cell should be emitted.
 *
 * Frustum planes are in the first member's coordinate system, so we
 * offset chunk coords by entity position before testing.
 */
function cellSurvivesFrustum(
  entity: EntitySnapshot,
  region: VisibleRegion,
  col: number,
  row: number,
  iz: number,
  chunkWorldX: number,
  chunkWorldY: number,
  chunkWorldZ: number,
): boolean {
  if (region.frustumPlanes === null) return true;
  const cmin: [number, number, number] = [
    col * chunkWorldX + entity.position[0],
    row * chunkWorldY + entity.position[1],
    iz * chunkWorldZ,
  ];
  const cmax: [number, number, number] = [
    (col + 1) * chunkWorldX + entity.position[0],
    (row + 1) * chunkWorldY + entity.position[1],
    (iz + 1) * chunkWorldZ,
  ];
  return !chunkOutsideFrustum(cmin, cmax, region.frustumPlanes);
}

/**
 * Build a placeholder {@link ChunkRequest} for a surviving (level,
 * channel, z, y, x) cell. `priority`/`lane` are stamped by the caller
 * per lane; `datasetId` is plumbed through from
 * {@link PlanningSnapshot.datasetId} so every emitted request leaves
 * the planner fully addressed.
 *
 * NOTE: cached chunks are NOT filtered here. They flow through
 * `submit()` so the cache can refresh their priority and
 * lastSeenTick — eviction relies on those signals to spare
 * still-wanted chunks. Dedup against the cache happens in
 * `CpuCache.submit`.
 */
function makeChunkRequest(
  entity: EntitySnapshot,
  datasetId: string,
  level: number,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): ChunkRequest {
  return {
    datasetId,
    entityId: entity.entityId,
    imageId: entity.imageId,
    level,
    t,
    c,
    z,
    y,
    x,
    lane: "detail",
    priority: 0,
    chunkKey: chunkKey(level, t, c, z, y, x),
  };
}

// ---------------------------------------------------------------------------
// computePriority()
// ---------------------------------------------------------------------------

/**
 * Compute a numeric priority for a chunk request.
 *
 * Lower values = more urgent.  The lane offset separates the lanes
 * (detail < proxy < prefetch < overview), while importance and distance
 * provide intra-lane ordering. Both coefficients live on
 * {@link PlanningConfig} so they can be twisted live.
 */
function computePriority(
  laneOffset: number,
  importance: number,
  distanceFromCenter: number,
  config: PlanningConfig,
): number {
  return (
    laneOffset +
    (1.0 - importance) * config.importanceWeight +
    distanceFromCenter * config.distanceWeight
  );
}

// ---------------------------------------------------------------------------
// Lane emission helpers
// ---------------------------------------------------------------------------

/**
 * Minimap lane — promoted to its own dedicated highest-priority lane
 * by Slice 5 of PRD #545. For every {@link EntitySnapshot} in
 * `entities`, look up `minimapPending.get(entity.imageId)` and emit
 * one {@link ChunkRequest} per coord with `priority = config.minimapLaneOffset`
 * directly (no importance / distance terms — minimap chunks are
 * per-dataset, not per-entity-importance).
 *
 * Cited in ADR 0023. Mutates `out`.
 */
function emitMinimapLane(
  minimapPending: Map<string, MinimapChunkCoord[]>,
  entities: EntitySnapshot[],
  datasetId: string,
  config: PlanningConfig,
  out: ChunkRequest[],
): void {
  if (minimapPending.size === 0) return;
  for (const entity of entities) {
    const pending = minimapPending.get(entity.imageId);
    if (!pending) continue;
    for (const coord of pending) {
      out.push({
        datasetId,
        entityId: entity.entityId,
        imageId: entity.imageId,
        level: coord.level,
        t: coord.t,
        c: coord.c,
        z: coord.z,
        y: coord.y,
        x: coord.x,
        lane: "minimap",
        priority: config.minimapLaneOffset,
        chunkKey: coord.key,
      });
    }
  }
}

/**
 * Detail lane — for each active entry, push detail chunks (field modes)
 * or a single proxy request per visible channel (`well-as-proxy`).
 *
 * Also emits the per-field FieldProxy3D fallback for field-mode entries
 * whose proxy is advertised, and a parent `WellProxy3D` (deduped per
 * `(wellId, t, c)`) when the entry is in `fields-with-proxy-fallback`
 * and the parent well's proxy is advertised.
 *
 * Mutates `allRequests`, `proxyRequests`, and `wellProxyEmitted`.
 */
function emitDetailLane(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  entityById: Map<string, EntitySnapshot>,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  proxyRequests: ProxyRequest[],
  wellProxyEmitted: Set<string>,
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    if (entry.kind === "well-as-proxy") {
      // Single proxy request per visible channel; no chunks.
      // `imageId: ""` matches the `well-as-proxy` convention from the
      // pre-discrimination shape — wells have no single owning image.
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId,
          entityId: entry.entityId,
          imageId: "",
          kind: "WellProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + 0,
        });
      }
      continue;
    }

    // Invisible entries contribute neither chunks nor proxies.
    if (entry.kind === "invisible") continue;

    // Narrowed: entry is FieldEntry below this point.
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    // Field-mode entries: emit chunk requests at detail priority.
    const chunks = iterateChunks(
      entity,
      entry,
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "detail";
      req.priority = computePriority(
        config.detailLaneOffset,
        entity.importance,
        dist,
        config,
      );
      allRequests.push(req);
    }

    // Field proxy fallback (per visible channel).
    if (entry.proxyAvailable && entry.proxyKind === "FieldProxy3D") {
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId,
          entityId: entry.entityId,
          imageId: entry.imageId,
          kind: "FieldProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + 1,
        });
      }
    }

    // Parent-well proxy (only for proxy-fallback mode, deduped per
    // (wellId, t, c)). At `fields-with-detail` zoom the chunk path is
    // expected to keep up — no extra parent fetch.
    //
    // PRD #563 / Slice 5: only `FieldSnapshot` carries a `parentId`.
    // Narrow on `kind === "Field"` before reading it; the post-narrow
    // access is non-null. Field-mode active entries map to Field
    // entities (image-mode datasets have no parent well to fall back
    // to), so a non-Field here is a producer invariant violation we
    // skip silently.
    if (
      entry.mode === "fields-with-proxy-fallback" &&
      entry.wellProxyAvailable &&
      entity.kind === "Field"
    ) {
      const wellId = entity.parentId;
      for (const c of snapshot.selection.visibleChannels) {
        const dedupKey = `${wellId}|${snapshot.selection.t}|${c}`;
        if (wellProxyEmitted.has(dedupKey)) continue;
        wellProxyEmitted.add(dedupKey);
        proxyRequests.push({
          datasetId,
          entityId: wellId,
          imageId: "",
          kind: "WellProxy3D",
          t: snapshot.selection.t,
          c,
          priority: config.proxyLaneOffset + config.wellProxyPriorityBump,
        });
      }
    }
  }
}

/**
 * Prefetch lane — for each field-mode active entry, emit chunks for the
 * next `config.prefetchDepth` timepoints (bounded by the entity's max T).
 *
 * Mutates `allRequests`.
 */
function emitPrefetchLane(
  activeSet: ActiveSetEntry[],
  snapshot: PlanningSnapshot,
  entityById: Map<string, EntitySnapshot>,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entry of activeSet) {
    // Only field entries get prefetch — well-as-proxy needs no chunks
    // and invisible entries contribute none.
    if (entry.kind !== "field") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;
    if (entity.levels.length === 0) continue;

    const maxT = entity.levels[0]?.grid_shape[0] ?? 0;
    for (let dt = 1; dt <= config.prefetchDepth; dt++) {
      const nextT = snapshot.selection.t + dt;
      if (nextT >= maxT) break;
      const prefetchSelection: SelectionState = {
        ...snapshot.selection,
        t: nextT,
      };

      const chunks = iterateChunks(
        entity,
        entry,
        snapshot.visibleRegion,
        prefetchSelection,
        stats,
        datasetId,
      );
      for (const req of chunks) {
        const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
        req.lane = "prefetch";
        req.priority = computePriority(
          config.prefetchLaneOffset + dt * 100,
          entity.importance,
          dist,
          config,
        );
        allRequests.push(req);
      }
    }
  }
}

/**
 * Overview lane — for every entity in the snapshot (visible or not),
 * iterate the coarsest LOD's chunks via {@link iterateChunksAtLodRange}.
 * No active-set entry needed; the overview range is always
 * `[coarsest, coarsest]`. Removes the previous synthetic-entry
 * workaround that was in step 5 of `plan()`.
 *
 * Mutates `allRequests`.
 */
function emitOverviewLane(
  entities: EntitySnapshot[],
  snapshot: PlanningSnapshot,
  stats: PlanStats,
  allRequests: ChunkRequest[],
  config: PlanningConfig,
): void {
  const datasetId = snapshot.datasetId;
  for (const entity of entities) {
    if (entity.levels.length === 0) continue;

    const coarsest = Math.max(entity.levels.length - 1, 0);
    const chunks = iterateChunksAtLodRange(
      entity,
      [coarsest, coarsest],
      snapshot.visibleRegion,
      snapshot.selection,
      stats,
      datasetId,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "overview";
      req.priority = computePriority(
        config.overviewLaneOffset,
        entity.importance,
        dist,
        config,
      );
      allRequests.push(req);
    }
  }
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

/**
 * Top-level pure planning function. Composes promotion, chunk
 * iteration, and three-lane scheduling into a single {@link RequestPlan}.
 *
 * Three-way decomposition (PRD #563 / Slice 3):
 *   - `snapshot` — the world this tick (entities, region, selection, …).
 *   - `state` — opaque carry-forward state from the previous tick (the
 *     pointer the caller stored from the previous {@link RequestPlan.nextState}).
 *   - `config` — planning tunables (live-twistable from the debug panel).
 *
 * Postconditions:
 *   - `requests` and `proxyRequests` are sorted ascending by `priority`
 *     (lower value = more urgent).
 *   - All output objects are freshly allocated; the caller may mutate
 *     them. Every request carries `datasetId` from
 *     {@link PlanningSnapshot.datasetId} (PRD #563 / Slice 1: planner
 *     stamps at emit time, no orchestrator post-`plan()` mutation).
 *   - `epochs.request` is the input epoch + 1; other epoch fields are
 *     forwarded unchanged so consumers can detect plan freshness.
 *   - `stats` reflects work done in this call only — no carry-forward.
 *   - `nextState` is the opaque carry-forward state for the next tick.
 *     v1: `{ previousActiveSet: activeSet }`. The caller stores it and
 *     hands it back unchanged on the next call.
 */
export function plan(
  snapshot: PlanningSnapshot,
  state: PlanningState,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): RequestPlan {
  const stats = emptyPlanStats();

  // Step 1: Promote (three-tier, S6).
  const activeSet = assignModes(
    snapshot.entities,
    state.previousActiveSet,
    snapshot.assetCatalog,
    stats,
    config,
  );

  // Step 2: Build entity lookup.
  const entityById = new Map<string, EntitySnapshot>();
  for (const entity of snapshot.entities) {
    entityById.set(entity.entityId, entity);
  }

  const allRequests: ChunkRequest[] = [];
  const proxyRequests: ProxyRequest[] = [];

  // Track well-proxy requests we've already emitted (one per
  // (wellId, t, c)) so multiple fields-with-proxy-fallback fields of
  // the same well don't each push a duplicate parent-well request.
  const wellProxyEmitted = new Set<string>();

  // Step 3: Minimap lane — promoted to highest priority by Slice 5
  // (PRD #545 / ADR 0023). Emitted before detail so the minimap
  // appears within ~1s of dataset open instead of after detail
  // finishes.
  emitMinimapLane(
    snapshot.minimapPending,
    snapshot.entities,
    snapshot.datasetId,
    config,
    allRequests,
  );

  // Step 4: Detail / proxy lane (per active entry).
  emitDetailLane(
    activeSet,
    snapshot,
    entityById,
    stats,
    allRequests,
    proxyRequests,
    wellProxyEmitted,
    config,
  );

  // Step 5: Prefetch lane — for field-mode entries only.
  emitPrefetchLane(activeSet, snapshot, entityById, stats, allRequests, config);

  // Step 6: Overview lane.
  emitOverviewLane(snapshot.entities, snapshot, stats, allRequests, config);

  // Step 7: Merge and sort by priority (ascending — lower = more urgent).
  allRequests.sort((a, b) => a.priority - b.priority);
  proxyRequests.sort((a, b) => a.priority - b.priority);

  // Step 8: Epoch propagation.
  const epochs: SceneEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  // Step 9: Return. `nextState` is the opaque pointer the caller will
  // hand back on the next tick — today derived from `activeSet`, but
  // future planner-internal state lands here without churning callers.
  const nextState: PlanningState = { previousActiveSet: activeSet };
  return { requests: allRequests, activeSet, epochs, proxyRequests, stats, nextState };
}

// ---------------------------------------------------------------------------
// chunkDistanceFromCenter()
// ---------------------------------------------------------------------------

/**
 * Compute distance from a chunk's world-space center to the view center.
 *
 * Uses the visible region's sortCenter if available, otherwise the visible
 * region midpoint — offset by entity position to get local coordinates.
 * Converts grid indices to world-voxel positions using per-level chunk
 * world sizes so that distance is comparable across LODs.
 */
function chunkDistanceFromCenter(
  req: ChunkRequest,
  region: VisibleRegion,
  entity: EntitySnapshot,
): number {
  // View center in local (entity-relative) voxel coords.
  let centerX: number;
  let centerY: number;
  let centerZ: number;

  if (region.sortCenter !== null) {
    centerX = region.sortCenter[0] - entity.position[0];
    centerY = region.sortCenter[1] - entity.position[1];
    centerZ = region.sortCenter[2];
  } else {
    centerX =
      (region.xyBounds[0] + region.xyBounds[2]) / 2 - entity.position[0];
    centerY =
      (region.xyBounds[1] + region.xyBounds[3]) / 2 - entity.position[1];
    centerZ = (region.zRange[0] + region.zRange[1]) / 2;
  }

  // Compute chunk world size at this level via the shared helper.
  const level0 = entity.levels[0];
  const geo = entity.levels[req.level];
  let cwX = 1;
  let cwY = 1;
  let cwZ = 1;
  if (geo !== undefined && level0 !== undefined) {
    [cwX, cwY, cwZ] = chunkWorldDims(geo, level0);
  }

  const dx = (req.x + 0.5) * cwX - centerX;
  const dy = (req.y + 0.5) * cwY - centerY;
  const dz = (req.z + 0.5) * cwZ - centerZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
