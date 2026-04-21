/**
 * Planning domain — types and runtime functions for the chunk planning pipeline.
 *
 * This module defines the full input/output contract for the planning step:
 *   PlanningSnapshot  ->  RequestPlan
 *
 * Currently implements:
 *   - promote()  — three-tier per-well promotion + LOD range assignment
 *   - createSyntheticSnapshot() / createSyntheticEntity() — test helpers
 */

import type { LevelGeometry } from "../manifestTypes.ts";
import type { AssetCatalogSnapshot } from "./assetCatalog.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Far threshold (px). Below this, a well promotes to `well-as-proxy`.
 * Replaces the legacy two-tier `PROMOTE_THRESHOLD_PX = 80`; same value.
 */
export const FAR_THRESHOLD_PX = 80;

/** Medium/Detail threshold (px). Above this, fields use real detail chunks. */
export const MEDIUM_THRESHOLD_PX = 150;

/** Hysteresis band (px) on either side of each threshold. */
export const HYSTERESIS_PX = 5;

/**
 * Backwards-compat alias for the legacy constant. Many tests still import
 * `PROMOTE_THRESHOLD_PX`; map it onto the new far threshold so the value
 * still means "below this we use the proxy/coarse representation".
 */
export const PROMOTE_THRESHOLD_PX = FAR_THRESHOLD_PX;

/**
 * Backwards-compat alias for the legacy demote threshold. Kept as an
 * export but no longer participates in promotion logic — three-tier
 * promotion uses {@link FAR_THRESHOLD_PX} / {@link MEDIUM_THRESHOLD_PX}
 * with {@link HYSTERESIS_PX}-band hysteresis instead.
 */
export const DEMOTE_THRESHOLD_PX = 40;

/** Priority lane offset for overview requests (lowest urgency). */
export const OVERVIEW_LANE_OFFSET = 2000;

/** Priority lane offset for runway (prefetch) requests. */
export const RUNWAY_LANE_OFFSET = 1000;

/** Priority lane offset for proxy requests (between detail and overview). */
export const PROXY_LANE_OFFSET = 500;

/** Priority lane offset for detail requests (highest urgency). */
export const DETAIL_LANE_OFFSET = 0;

/** Number of future timepoints to prefetch in the runway lane. */
export const RUNWAY_DEPTH = 2;

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

export interface PlanningEpochs {
  content: number;
  layout: number;
  view: number;
  selection: number;
  /**
   * Bumped by `apply_asset_catalog_delta` (catalog membership change).
   * The orchestrator reads it from `wasmScene.asset_epoch()` each tick.
   * Stays 0 until S5 starts publishing real proxy availability.
   */
  asset: number;
  /** Bumped when Planning produces a new request plan. */
  request: number;
}

// ---------------------------------------------------------------------------
// VisibleRegion
// ---------------------------------------------------------------------------

export interface VisibleRegion {
  /** [minX, minY, maxX, maxY] in voxel coordinates. */
  xyBounds: [number, number, number, number];
  /** [start, end) voxel Z range. */
  zRange: [number, number];
  /** Screen pixels per voxel. */
  effectiveZoom: number;
  sortCenter: [number, number, number] | null;
  /** Six frustum half-planes, or null for 2-D views. */
  frustumPlanes: [number, number, number, number][] | null;
}

// ---------------------------------------------------------------------------
// EntitySnapshot
// ---------------------------------------------------------------------------

export interface EntitySnapshot {
  entityId: string;
  imageId: string;
  kind: "Image" | "Well" | "Field";
  visible: boolean;
  projectedDiagonalPx: number;
  projectedAreaPx2: number;
  centroidWorld: [number, number, number];
  idealTargetLod: number;
  importance: number;
  numLevels: number;
  levels: LevelGeometry[];
  /** Layout placement position. */
  position: [number, number];
  /**
   * Parent entity id (`Field.parent === wellId`), or `null` for top-level
   * entities (`Image`, `Well`). Used by S6 promotion to group fields by
   * their parent well so all fields of a well agree on a single
   * {@link WellMode}.
   *
   * Optional in the type for backward compat with synthetic test
   * snapshots that don't model plates; treat `undefined` as `null`.
   */
  parentId?: string | null;
}

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

export interface WorkerWantedSetSnapshot {
  /** entityId -> set of chunk keys the GPU worker reports as missing. */
  missing: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// AssetCatalogSnapshot
// ---------------------------------------------------------------------------

// Re-exported from `./assetCatalog.ts` so consumers of the planning
// snapshot don't need a separate import. S3 wires the snapshot through
// the orchestrator with `byEntity` empty; S6 makes Planning consume it.
export type { AssetCatalogSnapshot, ProxyKind } from "./assetCatalog.ts";

// ---------------------------------------------------------------------------
// PlanningSnapshot  (full input)
// ---------------------------------------------------------------------------

export interface PlanningSnapshot {
  epochs: PlanningEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  cacheState: CacheStateSnapshot;
  workerWantedSet: WorkerWantedSetSnapshot;
  previousActiveSet: ActiveSetEntry[];
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
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface RequestPlan {
  requests: ChunkRequest[];
  activeSet: ActiveSetEntry[];
  epochs: PlanningEpochs;
  /**
   * Proxy assets to fetch alongside chunks. Populated by S6 promotion.
   * Always defined — empty array when no entries use a proxy mode.
   * CpuCache routes these to `ContentSource.fetchProxy`.
   */
  proxyRequests: ProxyRequest[];
  /**
   * Counters accumulated during this plan run. Always present; cost is
   * negligible (a few integer adds per grid cell). Consumers (DebugPanel,
   * tests) read it post-hoc to surface decision rationale (catalog
   * degradations) and culling effectiveness.
   */
  stats: PlanStats;
}

/**
 * Per-plan accumulator. Counters are summed across all `iterateChunks`
 * calls (detail + runway + overview lanes) and across all entities.
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
  /** Actual dataset ID (set by orchestrator; falls back to entityId if unset). */
  datasetId?: string;
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  lane: "overview" | "detail" | "runway";
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
 * Per-well promotion mode, selected by {@link chooseWellMode} from the
 * well's projected diagonal (max of constituent fields, in pixels):
 *
 *   - `well-as-proxy`            (< {@link FAR_THRESHOLD_PX})  — render the
 *     well from a single `WellProxy3D` asset; no field chunks.
 *   - `fields-with-proxy-fallback` (mid range)  — request real field detail
 *     chunks but also fetch `FieldProxy3D` per visible field and the
 *     parent's `WellProxy3D` as a fast fallback while detail loads.
 *   - `fields-with-detail`        (> {@link MEDIUM_THRESHOLD_PX})  — real
 *     field detail chunks only; proxy is a stand-in fallback that the
 *     worker uses when chunks are missing.
 */
export type WellMode =
  | "well-as-proxy"
  | "fields-with-proxy-fallback"
  | "fields-with-detail";

export interface ActiveSetEntry {
  /**
   * For `well-as-proxy`: the well's entity id.
   * For field modes: the field's entity id.
   */
  entityId: string;
  /**
   * For `well-as-proxy`: empty string — the well has no single owning
   * image. Downstream code that iterates chunks short-circuits for
   * `well-as-proxy` entries before reading this field.
   *
   * For field modes: the field's owning image id (matches
   * `EntitySnapshot.imageId`).
   */
  imageId: string;
  /** Promotion mode. See {@link WellMode}. */
  mode: WellMode;
  targetLod: number;
  seedDetailLod: number;
  /** [finest, coarsest] inclusive. */
  detailOwnedLodRange: [number, number];
  /**
   * Which proxy kind (if any) this entry would prefer. For
   * `well-as-proxy` this is always `WellProxy3D` (the entry IS the
   * proxy); for field modes it's `FieldProxy3D` if available; otherwise
   * `undefined`.
   */
  proxyKind?: "WellProxy3D" | "FieldProxy3D";
  /**
   * True if the entry's preferred proxy is known to be in the catalog.
   * Field-mode entries set this from the field's catalog entry.
   * `well-as-proxy` entries are always `true` (we only chose the mode
   * because the well's proxy was advertised).
   */
  proxyAvailable: boolean;
  /**
   * For field-mode entries: whether the parent well's `WellProxy3D` is
   * advertised. Drives the secondary lower-priority well-proxy request
   * in `fields-with-proxy-fallback` and the parent-fallback hint in
   * `fields-with-detail`.
   *
   * For `well-as-proxy` entries: same as `proxyAvailable` (true).
   */
  wellProxyAvailable: boolean;
}

// ---------------------------------------------------------------------------
// promote()
// ---------------------------------------------------------------------------

/**
 * Decide a {@link WellMode} for the given projected diagonal, applying
 * symmetric ±{@link HYSTERESIS_PX} hysteresis around both the far and
 * medium thresholds.
 *
 * Outside the bands the natural mode is forced. Inside a band the
 * previous mode wins as long as it's adjacent to the natural choice.
 */
export function chooseWellMode(
  prevMode: WellMode | null,
  projectedDiagonalPx: number,
): WellMode {
  const farUpper = FAR_THRESHOLD_PX + HYSTERESIS_PX; // 85
  const farLower = FAR_THRESHOLD_PX - HYSTERESIS_PX; // 75
  const medUpper = MEDIUM_THRESHOLD_PX + HYSTERESIS_PX; // 155
  const medLower = MEDIUM_THRESHOLD_PX - HYSTERESIS_PX; // 145

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

interface WellGroup {
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
 */
function groupByWell(entities: EntitySnapshot[]): WellGroup[] {
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
      const wellId = entity.parentId ?? null;
      if (wellId === null) {
        // Field with no parent — fall back to a singleton group keyed on
        // the field id so it gets a sensible mode.
        const k = `__no-parent__${entity.entityId}`;
        groups.set(k, {
          wellId: entity.entityId,
          wellEntity: null,
          fields: [entity],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        });
        continue;
      }

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
 * Decide each entity's promotion mode and compute its LOD range.
 *
 * Three-tier per-well decision (S6):
 *   - Group fields by parent well (or treat plain Images as singletons).
 *   - For each group, pick a {@link WellMode} from the group's projected
 *     diagonal with hysteresis against the previous active set.
 *   - Catalog-aware degrade: if the chosen mode requires a proxy that
 *     isn't advertised, fall through to the next finer mode.
 *   - Emit one `ActiveSetEntry` per well (`well-as-proxy`) or one per
 *     visible field (field modes).
 */
export function promote(
  entities: EntitySnapshot[],
  previousActiveSet: ActiveSetEntry[],
  catalog: AssetCatalogSnapshot | null = null,
  stats: PlanStats | null = null,
): ActiveSetEntry[] {
  // Index previous active set by well id (for `well-as-proxy`) or by
  // parent well id (for field-mode entries) so both lookups land on the
  // same `prevMode`.
  const prevModeByWell = new Map<string, WellMode>();
  // Build a map from (entityId → wellId) so we can resolve where a
  // field-mode entry's mode "belongs". For `well-as-proxy` entries
  // entityId IS the wellId.
  const fieldEntityToWell = new Map<string, string>();
  for (const entity of entities) {
    if (entity.kind === "Field" && entity.parentId) {
      fieldEntityToWell.set(entity.entityId, entity.parentId);
    }
  }
  for (const prev of previousActiveSet) {
    if (prev.mode === "well-as-proxy") {
      prevModeByWell.set(prev.entityId, prev.mode);
    } else {
      const wellId = fieldEntityToWell.get(prev.entityId);
      if (wellId !== undefined) {
        // Same-well field-mode entries always agree on mode, so
        // first-write-wins is fine.
        if (!prevModeByWell.has(wellId)) {
          prevModeByWell.set(wellId, prev.mode);
        }
      }
    }
  }

  const out: ActiveSetEntry[] = [];

  for (const group of groupByWell(entities)) {
    const prev = prevModeByWell.get(group.wellId) ?? null;
    let desired = chooseWellMode(prev, group.projectedDiagonalPx);

    // Catalog-aware degrade. We always inspect the well's catalog entry
    // and the constituent fields' entries; both are needed to know which
    // modes are reachable.
    const wellHasProxy =
      catalog !== null && catalogHas(catalog, group.wellId, "WellProxy3D");
    const anyFieldHasProxy =
      catalog !== null &&
      group.fields.some((f) => catalogHas(catalog, f.entityId, "FieldProxy3D"));

    if (desired === "well-as-proxy" && !wellHasProxy) {
      desired = "fields-with-proxy-fallback";
      if (stats) stats.catalogDegradations++;
    }
    if (
      desired === "fields-with-proxy-fallback" &&
      !anyFieldHasProxy &&
      !wellHasProxy
    ) {
      desired = "fields-with-detail";
      if (stats) stats.catalogDegradations++;
    }

    if (desired === "well-as-proxy") {
      out.push(makeWellAsProxyEntry(group));
      continue;
    }

    // Field-mode (proxy-fallback or detail). One entry per visible
    // field. `wellEntity` (if visible) is intentionally NOT emitted as
    // its own entry: the well's geometry is represented by its fields.
    for (const field of group.fields) {
      out.push(makeFieldEntry(field, desired, wellHasProxy, catalog));
    }
  }

  // Pass-through: invisible entities still need to appear so that
  // downstream consumers (CpuCache eviction tier, debug panels, etc.)
  // can see them. Mirror the legacy behaviour by emitting them in
  // `fields-with-detail` at the coarsest level (no chunk requests will
  // be generated because `iterateChunks` early-outs on empty visible
  // region overlap, but they remain in the active set for symmetry).
  for (const entity of entities) {
    if (entity.visible) continue;
    out.push(makeInvisibleEntry(entity));
  }

  return out;
}

function catalogHas(
  catalog: AssetCatalogSnapshot,
  entityId: string,
  kind: "WellProxy3D" | "FieldProxy3D",
): boolean {
  return catalog.byEntity.get(entityId)?.kinds.has(kind) ?? false;
}

function makeWellAsProxyEntry(group: WellGroup): ActiveSetEntry {
  return {
    entityId: group.wellId,
    imageId: "",
    mode: "well-as-proxy",
    // The well-proxy is a single asset; LOD bookkeeping is mostly
    // unused for this mode but we publish defensible defaults.
    targetLod: 0,
    seedDetailLod: 0,
    detailOwnedLodRange: [0, 0],
    proxyKind: "WellProxy3D",
    proxyAvailable: true,
    wellProxyAvailable: true,
  };
}

function makeFieldEntry(
  entity: EntitySnapshot,
  mode: WellMode,
  wellProxyAvailable: boolean,
  catalog: AssetCatalogSnapshot | null,
): ActiveSetEntry {
  // Geometric: same logic the legacy `makeDetailEntry` used.
  const targetLod = entity.idealTargetLod;
  const seedDetailLod = Math.min(targetLod + 2, entity.numLevels - 1);
  const fieldProxyAvailable =
    catalog !== null && catalogHas(catalog, entity.entityId, "FieldProxy3D");

  return {
    entityId: entity.entityId,
    imageId: entity.imageId,
    mode,
    targetLod,
    seedDetailLod,
    detailOwnedLodRange: [targetLod, seedDetailLod],
    proxyKind: "FieldProxy3D",
    proxyAvailable: fieldProxyAvailable,
    wellProxyAvailable,
  };
}

function makeInvisibleEntry(entity: EntitySnapshot): ActiveSetEntry {
  const coarsest = Math.max(entity.numLevels - 1, 0);
  return {
    entityId: entity.entityId,
    imageId: entity.imageId,
    mode: "fields-with-detail",
    targetLod: coarsest,
    seedDetailLod: coarsest,
    detailOwnedLodRange: [coarsest, coarsest],
    proxyKind: undefined,
    proxyAvailable: false,
    wellProxyAvailable: false,
  };
}

// ---------------------------------------------------------------------------
// Synthetic test helpers
// ---------------------------------------------------------------------------

/** Create a valid {@link EntitySnapshot} with sensible defaults, merged with overrides. */
export function createSyntheticEntity(
  overrides?: Partial<EntitySnapshot>,
): EntitySnapshot {
  return {
    entityId: "entity-0",
    imageId: "image-0",
    kind: "Image",
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    importance: 1,
    numLevels: 5,
    levels: [],
    position: [0, 0],
    parentId: null,
    ...overrides,
  };
}

/** Create a valid {@link PlanningSnapshot} with sensible defaults, merged with overrides. */
export function createSyntheticSnapshot(
  overrides?: Partial<PlanningSnapshot>,
): PlanningSnapshot {
  return {
    epochs: {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
      asset: 0,
      request: 0,
    },
    entities: [],
    visibleRegion: {
      xyBounds: [0, 0, 1024, 1024],
      zRange: [0, 1],
      effectiveZoom: 1,
      sortCenter: null,
      frustumPlanes: null,
    },
    selection: {
      t: 0,
      c: 0,
      z: 0,
      visibleChannels: [0],
      renderMode: "slice",
      interactionState: "idle",
    },
    cacheState: { cached: new Map(), inFlight: new Map() },
    workerWantedSet: { missing: new Map() },
    previousActiveSet: [],
    assetCatalog: null,
    ...overrides,
  };
}

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
// iterateChunks()
// ---------------------------------------------------------------------------

/**
 * Enumerate chunk grid cells for a promoted entity, applying spatial culling
 * and cache filtering.  Iterates all LOD levels in the entry's owned range,
 * all visible channels, and the spatial grid cells that overlap the visible
 * region.
 *
 * Ported from Rust `visible_chunks()` in lucida-core/src/chunk.rs.
 *
 * For `well-as-proxy` entries this returns an empty list — the well is
 * served by a single proxy asset, not by chunk requests.
 */
export function iterateChunks(
  entity: EntitySnapshot,
  entry: ActiveSetEntry,
  visibleRegion: VisibleRegion,
  selection: SelectionState,
  cacheState: CacheStateSnapshot,
  stats: PlanStats | null = null,
): ChunkRequest[] {
  const requests: ChunkRequest[] = [];

  if (entry.mode === "well-as-proxy") return requests;
  if (entity.levels.length === 0) {
    return requests;
  }

  const [finest, coarsest] = entry.detailOwnedLodRange;
  const cachedSet = cacheState.cached.get(entity.entityId);

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
        cachedSet,
        requests,
        stats,
      );
    }
  }

  return requests;
}

/**
 * Iterate the spatial grid cells for one (level, channel) pair, pushing
 * matching ChunkRequests into `out`.
 */
function iterateGridCells(
  entity: EntitySnapshot,
  region: VisibleRegion,
  selection: SelectionState,
  levelGeo: LevelGeometry,
  level0: LevelGeometry,
  level: number,
  c: number,
  cachedSet: Set<string> | undefined,
  out: ChunkRequest[],
  stats: PlanStats | null = null,
): void {
  // 5D indices: [T=0, C=1, Z=2, Y=3, X=4]
  const levelX = levelGeo.shape[4];
  const levelY = levelGeo.shape[3];
  const levelZ = levelGeo.shape[2];

  const chunkX = levelGeo.chunk_shape[4];
  const chunkY = levelGeo.chunk_shape[3];
  const chunkZ = levelGeo.chunk_shape[2];

  const fullX = level0.shape[4];
  const fullY = level0.shape[3];
  const fullZ = level0.shape[2];

  // Per-axis scale: how many full-res voxels per level voxel.
  const scaleX = fullX / levelX;
  const scaleY = fullY / levelY;
  const scaleZ = fullZ / levelZ;

  const chunkWorldX = chunkX * scaleX;
  const chunkWorldY = chunkY * scaleY;
  const chunkWorldZ = chunkZ * scaleZ;

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
    return;
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

  for (let iz = zStart; iz < zEnd; iz++) {
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        // Frustum culling in global voxel space.
        // Frustum planes are in the first member's coordinate system, so
        // we must offset chunk coords by entity position before testing.
        if (region.frustumPlanes !== null) {
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
          if (chunkOutsideFrustum(cmin, cmax, region.frustumPlanes)) {
            continue;
          }
        }
        if (stats) stats.culling.afterFrustum++;

        const key = chunkKey(level, selection.t, c, iz, row, col);

        // Skip already-cached chunks.
        if (cachedSet !== undefined && cachedSet.has(key)) {
          continue;
        }

        out.push({
          entityId: entity.entityId,
          imageId: entity.imageId,
          level,
          t: selection.t,
          c,
          z: iz,
          y: row,
          x: col,
          lane: "detail",
          priority: 0,
          chunkKey: key,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// computePriority()
// ---------------------------------------------------------------------------

/**
 * Compute a numeric priority for a chunk request.
 *
 * Lower values = more urgent.  The lane offset separates the lanes
 * (detail < proxy < runway < overview), while importance and distance
 * provide intra-lane ordering.
 */
function computePriority(
  laneOffset: number,
  importance: number,
  distanceFromCenter: number,
): number {
  return laneOffset + (1.0 - importance) * 500 + distanceFromCenter * 10;
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

/**
 * Top-level pure planning function.
 *
 * Composes promotion, chunk iteration, and three-lane scheduling into a
 * single {@link RequestPlan}.
 */
export function plan(snapshot: PlanningSnapshot): RequestPlan {
  const stats = emptyPlanStats();

  // Step 1: Promote (three-tier, S6).
  const activeSet = promote(
    snapshot.entities,
    snapshot.previousActiveSet,
    snapshot.assetCatalog,
    stats,
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

  // Default datasetId for proxy requests. The orchestrator overrides
  // both chunk and proxy requests with the real dataset id after
  // `plan()` returns; we leave the empty string here so synthetic test
  // snapshots still produce well-formed values.
  const defaultDatasetId = "";

  // Step 3: Detail / proxy lane (per active entry).
  for (const entry of activeSet) {
    if (entry.mode === "well-as-proxy") {
      // Single proxy request per visible channel; no chunks.
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId: defaultDatasetId,
          entityId: entry.entityId,
          imageId: entry.imageId,
          kind: "WellProxy3D",
          t: snapshot.selection.t,
          c,
          priority: PROXY_LANE_OFFSET + 0,
        });
      }
      continue;
    }

    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;

    // Field-mode entries: emit chunk requests at detail priority.
    const chunks = iterateChunks(
      entity,
      entry,
      snapshot.visibleRegion,
      snapshot.selection,
      snapshot.cacheState,
      stats,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "detail";
      req.priority = computePriority(DETAIL_LANE_OFFSET, entity.importance, dist);
      allRequests.push(req);
    }

    // Field proxy fallback (per visible channel).
    if (entry.proxyAvailable && entry.proxyKind === "FieldProxy3D") {
      for (const c of snapshot.selection.visibleChannels) {
        proxyRequests.push({
          datasetId: defaultDatasetId,
          entityId: entry.entityId,
          imageId: entry.imageId,
          kind: "FieldProxy3D",
          t: snapshot.selection.t,
          c,
          priority: PROXY_LANE_OFFSET + 1,
        });
      }
    }

    // Parent-well proxy (only for proxy-fallback mode, deduped per
    // (wellId, t, c)). At `fields-with-detail` zoom the chunk path is
    // expected to keep up — no extra parent fetch.
    if (
      entry.mode === "fields-with-proxy-fallback" &&
      entry.wellProxyAvailable &&
      entity.parentId
    ) {
      const wellId = entity.parentId;
      for (const c of snapshot.selection.visibleChannels) {
        const dedupKey = `${wellId}|${snapshot.selection.t}|${c}`;
        if (wellProxyEmitted.has(dedupKey)) continue;
        wellProxyEmitted.add(dedupKey);
        proxyRequests.push({
          datasetId: defaultDatasetId,
          entityId: wellId,
          imageId: "",
          kind: "WellProxy3D",
          t: snapshot.selection.t,
          c,
          priority: PROXY_LANE_OFFSET + 100,
        });
      }
    }
  }

  // Step 4: Runway lane — for field-mode entries only.
  for (const entry of activeSet) {
    if (entry.mode === "well-as-proxy") continue;
    const entity = entityById.get(entry.entityId);
    if (entity === undefined) continue;
    if (entity.levels.length === 0) continue;

    const maxT = entity.levels[0]?.grid_shape[0] ?? 0;
    for (let dt = 1; dt <= RUNWAY_DEPTH; dt++) {
      const nextT = snapshot.selection.t + dt;
      if (nextT >= maxT) break;
      const runwaySelection: SelectionState = {
        ...snapshot.selection,
        t: nextT,
      };

      const chunks = iterateChunks(
        entity,
        entry,
        snapshot.visibleRegion,
        runwaySelection,
        snapshot.cacheState,
        stats,
      );
      for (const req of chunks) {
        const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
        req.lane = "runway";
        req.priority = computePriority(
          RUNWAY_LANE_OFFSET + dt * 100,
          entity.importance,
          dist,
        );
        allRequests.push(req);
      }
    }
  }

  // Step 5: Overview lane.
  for (const entity of snapshot.entities) {
    if (entity.levels.length === 0) continue;

    const coarsest = Math.max(entity.numLevels - 1, 0);
    const overviewEntry: ActiveSetEntry = {
      entityId: entity.entityId,
      imageId: entity.imageId,
      mode: "fields-with-detail",
      targetLod: coarsest,
      seedDetailLod: coarsest,
      detailOwnedLodRange: [coarsest, coarsest],
      proxyKind: undefined,
      proxyAvailable: false,
      wellProxyAvailable: false,
    };

    const chunks = iterateChunks(
      entity,
      overviewEntry,
      snapshot.visibleRegion,
      snapshot.selection,
      snapshot.cacheState,
      stats,
    );
    for (const req of chunks) {
      const dist = chunkDistanceFromCenter(req, snapshot.visibleRegion, entity);
      req.lane = "overview";
      req.priority = computePriority(OVERVIEW_LANE_OFFSET, entity.importance, dist);
      allRequests.push(req);
    }
  }

  // Step 6: Merge and sort by priority (ascending — lower = more urgent).
  allRequests.sort((a, b) => a.priority - b.priority);
  proxyRequests.sort((a, b) => a.priority - b.priority);

  // Step 7: Epoch propagation.
  const epochs: PlanningEpochs = {
    ...snapshot.epochs,
    request: snapshot.epochs.request + 1,
  };

  // Step 8: Return.
  return { requests: allRequests, activeSet, epochs, proxyRequests, stats };
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

  // Compute chunk world size at this level.
  const level0 = entity.levels[0];
  const geo = entity.levels[req.level];
  let cwX = 1;
  let cwY = 1;
  let cwZ = 1;
  if (geo !== undefined && level0 !== undefined) {
    cwX = geo.chunk_shape[4] * (level0.shape[4] / geo.shape[4]);
    cwY = geo.chunk_shape[3] * (level0.shape[3] / geo.shape[3]);
    cwZ = geo.chunk_shape[2] * (level0.shape[2] / geo.shape[2]);
  }

  const dx = (req.x + 0.5) * cwX - centerX;
  const dy = (req.y + 0.5) * cwY - centerY;
  const dz = (req.z + 0.5) * cwZ - centerZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
