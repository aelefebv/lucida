/**
 * Promotion-mode decision logic. Three-tier per-group:
 * group tiles → pick {@link ResolvedMode} by projected diagonal with
 * hysteresis → catalog-aware degrade if required proxy is missing →
 * emit one {@link ActiveSetEntry} per group (group-as-proxy) or per
 * visible tile. See ADR 0029.
 */

import type { AssetCatalogSnapshot } from "../assetCatalog.ts";
import { snapshotHasProxy } from "../assetCatalog.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";
import type {
  ActiveSetEntry,
  EntityMode,
  EntitySnapshot,
  TileEntry,
  InvisibleEntry,
  PlanStats,
  ResolvedMode,
  GroupAsProxyEntry,
  MemberGroup,
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
 * `"group-as-proxy"`) — the per-group decision step works on this set
 * before {@link assignModes} translates each result into the matching
 * {@link ActiveSetEntry} variant. {@link EntityMode} narrows to the two
 * tile-mode values, so `chooseEntityMode` returns the wider union.
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
  if (projectedDiagonalPx < farLower) return "group-as-proxy";
  if (projectedDiagonalPx > medUpper) return "tiles-with-detail";
  if (projectedDiagonalPx >= farUpper && projectedDiagonalPx <= medLower) {
    return "tiles-with-proxy-fallback";
  }

  // In a hysteresis band — keep prev mode if it's a sensible neighbor.
  if (prevMode === "group-as-proxy" && projectedDiagonalPx < farUpper) {
    return "group-as-proxy";
  }
  if (prevMode === "tiles-with-detail" && projectedDiagonalPx > medLower) {
    return "tiles-with-detail";
  }
  if (prevMode === "tiles-with-proxy-fallback") {
    // Already in the middle band — only flip when clearly past.
    return "tiles-with-proxy-fallback";
  }
  return prevMode ?? "tiles-with-proxy-fallback";
}

/**
 * Group visible tile entities by their parent group, also surfacing
 * standalone {@link EntitySnapshot}s with `kind === "Image"` (which are
 * treated as their own one-entry "group" so the rest of the pipeline is
 * uniform).
 *
 * `kind === "Group"` entries are grouped with their tiles; if a group is
 * visible but has no visible tiles, it still appears as a group with
 * `tiles: []`.
 *
 * Exported so the orchestrator can reuse the same grouping rule
 * when building the render-layer roster (see ADR 0025).
 */
export function groupMembers(entities: EntitySnapshot[]): MemberGroup[] {
  const groups = new Map<string, MemberGroup>();

  for (const entity of entities) {
    if (!entity.visible) continue;

    if (entity.kind === "Group") {
      const groupId = entity.entityId;
      let group = groups.get(groupId);
      if (!group) {
        group = {
          groupId,
          groupEntity: entity,
          tiles: [],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        };
        groups.set(groupId, group);
      } else {
        group.groupEntity = entity;
        group.projectedDiagonalPx = Math.max(
          group.projectedDiagonalPx,
          entity.projectedDiagonalPx,
        );
      }
      continue;
    }

    if (entity.kind === "Tile") {
      // `TileSnapshot.parentId` is non-null by construction. A tile
      // without a parent is a producer invariant violation, not an
      // orphan to coerce — so there's no `parentId === null` branch.
      const groupId = entity.parentId;
      let group = groups.get(groupId);
      if (!group) {
        group = {
          groupId,
          groupEntity: null,
          tiles: [entity],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        };
        groups.set(groupId, group);
      } else {
        group.tiles.push(entity);
        group.projectedDiagonalPx = Math.max(
          group.projectedDiagonalPx,
          entity.projectedDiagonalPx,
        );
      }
      continue;
    }

    // kind === "Image": treat as singleton group (its own "group") so
    // non-collection datasets keep working transparently.
    const groupId = `__image__${entity.entityId}`;
    groups.set(groupId, {
      groupId,
      groupEntity: null,
      tiles: [entity],
      projectedDiagonalPx: entity.projectedDiagonalPx,
    });
  }

  return [...groups.values()];
}

/**
 * Build the prev-mode lookup keyed by group id.
 *
 * Indexes the previous active set by group id (for `group-as-proxy`
 * entries — `entityId` IS the groupId) or by parent group id (for tile
 * entries) so both lookups land on the same `prevMode`. Returns a
 * fresh `Map`. Invisible entries are skipped — they had no promotion
 * decision to remember.
 *
 * Returns the broader {@link ResolvedMode} (since
 * `group-as-proxy` is no longer part of {@link EntityMode}). The map's
 * value still keys back into {@link chooseEntityMode}'s `prevMode`
 * argument.
 *
 * Pure helper — extracted from `assignModes` so the per-tick
 * mode-decision flow reads as `prev = buildPrevModeByGroup(...);
 * desired = chooseEntityMode(prev, ...)`.
 */
export function buildPrevModeByGroup(
  prev: ActiveSetEntry[],
  entities: EntitySnapshot[],
): Map<string, ResolvedMode> {
  const prevModeByGroup = new Map<string, ResolvedMode>();
  // Build a map from (entityId → groupId) so we can resolve where a
  // tile-mode entry's mode "belongs". For `group-as-proxy` entries
  // entityId IS the groupId.
  const tileEntityToGroup = new Map<string, string>();
  for (const entity of entities) {
    // Narrowing on `kind === "Tile"` gives a {@link TileSnapshot}
    // with non-null `parentId`, so no extra guard is needed.
    if (entity.kind === "Tile") {
      tileEntityToGroup.set(entity.entityId, entity.parentId);
    }
  }
  for (const p of prev) {
    if (p.kind === "group-as-proxy") {
      prevModeByGroup.set(p.entityId, "group-as-proxy");
    } else if (p.kind === "tile") {
      const groupId = tileEntityToGroup.get(p.entityId);
      if (groupId !== undefined) {
        // Same-group tile-mode entries always agree on mode, so
        // first-write-wins is fine.
        if (!prevModeByGroup.has(groupId)) {
          prevModeByGroup.set(groupId, p.mode);
        }
      }
    }
    // p.kind === "invisible" — skip; invisible entries had no
    // promotion decision to remember.
  }
  return prevModeByGroup;
}

/**
 * Catalog-aware tier degrade.
 *
 * Steps the desired mode down by exactly one tier when the chosen mode
 * requires a proxy that the catalog does not advertise. Tier order is
 * `group-as-proxy → tiles-with-proxy-fallback → tiles-with-detail`;
 * tier-skipping is forbidden (see ADR 0024 for the rationale).
 *
 * Each step increments `stats.catalogDegradations` by 1 if `stats` is
 * non-null. A group that degrades twice (e.g. all the way from
 * `group-as-proxy` to `tiles-with-detail`) increments by 2.
 *
 * Operates on the broader {@link ResolvedMode} so the per-group decision
 * step (which still discriminates on `group-as-proxy`) keeps a single
 * call site. {@link assignModes} translates the post-degrade value
 * into the matching {@link ActiveSetEntry} variant.
 */
export function degradeForCatalog(
  desired: ResolvedMode,
  group: MemberGroup,
  catalog: AssetCatalogSnapshot | null,
  stats: PlanStats | null,
): ResolvedMode {
  const groupHasProxy =
    catalog !== null && snapshotHasProxy(catalog, group.groupId, "GroupProxy3D");
  const anyTileHasProxy =
    catalog !== null &&
    group.tiles.some((f) => snapshotHasProxy(catalog, f.entityId, "TileProxy3D"));

  let mode: ResolvedMode = desired;
  if (mode === "group-as-proxy" && !groupHasProxy) {
    mode = "tiles-with-proxy-fallback";
    if (stats) stats.catalogDegradations++;
  }
  if (
    mode === "tiles-with-proxy-fallback" &&
    !anyTileHasProxy &&
    !groupHasProxy
  ) {
    mode = "tiles-with-detail";
    if (stats) stats.catalogDegradations++;
  }
  return mode;
}

/**
 * Decide each entity's promotion mode and compute its LOD range.
 *
 * Three-tier per-group decision:
 *   - Group tiles by parent group (or treat plain Images as singletons).
 *   - For each group, pick a {@link EntityMode} from the group's projected
 *     diagonal with hysteresis against the previous active set.
 *   - Catalog-aware degrade: if the chosen mode requires a proxy that
 *     isn't advertised, fall through to the next finer mode.
 *   - Emit one `ActiveSetEntry` per group (`group-as-proxy`) or one per
 *     visible tile (tile modes).
 */
export function assignModes(
  entities: EntitySnapshot[],
  previousActiveSet: ActiveSetEntry[],
  catalog: AssetCatalogSnapshot | null = null,
  stats: PlanStats | null = null,
  config: PlanningConfig = DEFAULT_PLANNING_CONFIG,
): ActiveSetEntry[] {
  const prevModeByGroup = buildPrevModeByGroup(previousActiveSet, entities);

  const out: ActiveSetEntry[] = [];

  for (const group of groupMembers(entities)) {
    const prev = prevModeByGroup.get(group.groupId) ?? null;
    const desired = chooseEntityMode(prev, group.projectedDiagonalPx, config);
    const mode = degradeForCatalog(desired, group, catalog, stats);

    // We need groupHasProxy as the `groupProxyAvailable` flag on tile
    // entries. `degradeForCatalog` recomputes it internally; we
    // recompute here too because we need the value, not just the
    // post-degrade mode. Cheap to recheck.
    const groupHasProxy =
      catalog !== null && snapshotHasProxy(catalog, group.groupId, "GroupProxy3D");

    if (mode === "group-as-proxy") {
      out.push(makeGroupAsProxyEntry(group));
      continue;
    }

    // Tile-mode (proxy-fallback or detail). One entry per visible
    // tile. `groupEntity` (if visible) is intentionally NOT emitted as
    // its own entry: the group's geometry is represented by its tiles.
    // `mode` here is narrowed to {@link EntityMode} because the
    // `group-as-proxy` arm short-circuits above.
    for (const tile of group.tiles) {
      out.push(makeTileEntry(tile, mode, groupHasProxy, catalog));
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

/**
 * Chunk-only bridge mode assignment. Ignores proxy catalog and radius
 * promotion: every visible image/tile renders as tile-mode chunks
 * with an explicit detail level and, when compatible with the current
 * atlas layout, one source-backed coarse level in the fallback range.
 */
export function assignCoarseDetailModes(
  entities: EntitySnapshot[],
): ActiveSetEntry[] {
  const out: ActiveSetEntry[] = [];

  for (const group of groupMembers(entities)) {
    for (const tile of group.tiles) {
      out.push(makeCoarseDetailTileEntry(tile));
    }
  }

  for (const entity of entities) {
    if (entity.visible) continue;
    out.push(makeInvisibleEntry(entity));
  }

  return out;
}

function makeGroupAsProxyEntry(group: MemberGroup): GroupAsProxyEntry {
  return {
    kind: "group-as-proxy",
    entityId: group.groupId,
  };
}

function makeTileEntry(
  entity: EntitySnapshot,
  mode: EntityMode,
  groupProxyAvailable: boolean,
  catalog: AssetCatalogSnapshot | null,
): TileEntry {
  // Planning hands the caller exactly one level: the orchestrator
  // does not filter the request stream to the target level, so
  // emitting a multi-level buffer would queue chunks the cache could
  // never use.
  const targetLod = entity.idealTargetLod;
  const coarsestDetailLod = targetLod;
  const tileProxyAvailable =
    catalog !== null && snapshotHasProxy(catalog, entity.entityId, "TileProxy3D");

  return {
    kind: "tile",
    entityId: entity.entityId,
    imageId: entity.imageId,
    mode,
    targetLod,
    coarsestDetailLod,
    detailOwnedLodRange: [targetLod, coarsestDetailLod],
    proxyKind: "TileProxy3D",
    proxyAvailable: tileProxyAvailable,
    groupProxyAvailable,
  };
}

function makeCoarseDetailTileEntry(entity: EntitySnapshot): TileEntry {
  const detailLevel = clampLevel(entity, entity.detailLevel);
  const coarseLevel = compatibleCoarseLevel(entity, detailLevel);
  const coarsestDetailLod =
    coarseLevel !== null && coarseLevel >= detailLevel ? coarseLevel : detailLevel;
  const wantedLodLevels =
    coarseLevel !== null && coarseLevel !== detailLevel
      ? [detailLevel, coarseLevel]
      : [detailLevel];

  return {
    kind: "tile",
    entityId: entity.entityId,
    imageId: entity.imageId,
    mode: "tiles-with-detail",
    targetLod: detailLevel,
    coarsestDetailLod,
    detailOwnedLodRange: [detailLevel, coarsestDetailLod],
    detailLevel,
    coarseLevel,
    wantedLodLevels,
    proxyKind: undefined,
    proxyAvailable: false,
    groupProxyAvailable: false,
  };
}

function clampLevel(entity: EntitySnapshot, level: number): number {
  if (entity.levels.length === 0) return 0;
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(entity.levels.length - 1, Math.floor(level)));
}

function compatibleCoarseLevel(
  entity: EntitySnapshot,
  detailLevel: number,
): number | null {
  if (entity.coarseLevel === null) return null;
  const coarseLevel = clampLevel(entity, entity.coarseLevel);
  if (coarseLevel < detailLevel) return null;
  return coarseLevel;
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
