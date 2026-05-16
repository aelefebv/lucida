/**
 * Planning domain — promotion-mode decision logic.
 *
 * Three-tier per-well decision:
 *   - Group fields by parent well (or treat plain Images as singletons).
 *   - For each group, pick a {@link ResolvedMode} from the group's
 *     projected diagonal with hysteresis against the previous active set.
 *   - Catalog-aware degrade: if the chosen mode requires a proxy that
 *     isn't advertised, fall through to the next finer mode.
 *   - Emit one {@link ActiveSetEntry} per well (`well-as-proxy`) or one
 *     per visible field (field modes).
 *
 * See ADR 0029.
 */

import type { AssetCatalogSnapshot } from "../assetCatalog.ts";
import { snapshotHasProxy } from "../assetCatalog.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import type {
  ActiveSetEntry,
  EntityMode,
  EntitySnapshot,
  FieldEntry,
  InvisibleEntry,
  PlanStats,
  ResolvedMode,
  WellAsProxyEntry,
  WellGroup,
} from "./types.ts";

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
 * {@link ActiveSetEntry} variant. {@link EntityMode} narrows to the two
 * field-mode values, so `chooseEntityMode` returns the wider union.
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
      // `FieldSnapshot.parentId` is non-null by construction. A field
      // without a parent is a producer invariant violation, not an
      // orphan to coerce — so there's no `parentId === null` branch.
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
    // Narrowing on `kind === "Field"` gives a {@link FieldSnapshot}
    // with non-null `parentId`, so no extra guard is needed.
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
 * Three-tier per-well decision:
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
  // can see them. They live in a dedicated `InvisibleEntry` variant
  // and contribute no chunk requests (the planner's lane emitters
  // skip them).
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
  // Planning hands the caller exactly one level: the orchestrator
  // does not filter the request stream to the target level, so
  // emitting a multi-level buffer would queue chunks the cache could
  // never use.
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
