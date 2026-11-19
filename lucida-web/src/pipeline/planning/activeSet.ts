/**
 * Builds the active set. Every visible image or tile becomes one
 * {@link TileEntry} carrying the levels each residency tier holds for
 * it. Invisible entities pass through as {@link InvisibleEntry}.
 */

import type {
  ActiveSetEntry,
  DatasetLevelSelection,
  EntitySnapshot,
  TileEntry,
  InvisibleEntry,
  MemberGroup,
} from "./types.ts";

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
 * when building the render-layer roster.
 */
export function groupMembers(entities: EntitySnapshot[]): MemberGroup[] {
  const groups = new Map<string, MemberGroup>();

  for (const entity of entities) {
    if (!entity.visible) continue;

    if (entity.kind === "Group") {
      const groupId = entity.entityId;
      const group = groups.get(groupId);
      if (group) {
        group.groupEntity = entity;
      } else {
        groups.set(groupId, { groupId, groupEntity: entity, tiles: [] });
      }
      continue;
    }

    if (entity.kind === "Tile") {
      const groupId = entity.parentId;
      const group = groups.get(groupId);
      if (group) {
        group.tiles.push(entity);
      } else {
        groups.set(groupId, { groupId, groupEntity: null, tiles: [entity] });
      }
      continue;
    }

    // kind === "Image": a singleton group, so non-collection datasets
    // take the same path.
    const groupId = `__image__${entity.entityId}`;
    groups.set(groupId, { groupId, groupEntity: null, tiles: [entity] });
  }

  return [...groups.values()];
}

/**
 * Build the active set, one entry per entity, in entity order.
 *
 * Every visible image or tile becomes a tile entry. Its detail tier holds
 * the levels the level selection chose for it, which the core already
 * resolved within the budget. Nothing here chooses a level or reads
 * residency. Its coarse tier holds the coarse source level when that level
 * is no finer. Projected size plays no part, because the tier model renders
 * from chunks alone. A visible group entity gets no entry of its own; its
 * tiles carry its geometry.
 *
 * Invisible entities still appear so downstream consumers (the CPU
 * cache's eviction tier mapping, the trace's per-tick tallies) can see
 * them. They live in the dedicated {@link InvisibleEntry} variant and
 * contribute no chunk requests.
 *
 * Entity order keeps every entry where it was when a view move turns a tile
 * visible or invisible, so the render worker's descriptor indices, which
 * follow this order, change for that tile alone.
 */
export function buildActiveSet(entities: EntitySnapshot[], selection: DatasetLevelSelection): ActiveSetEntry[] {
  const tiles = new Set<EntitySnapshot>();
  for (const group of groupMembers(entities)) {
    for (const tile of group.tiles) tiles.add(tile);
  }

  const out: ActiveSetEntry[] = [];
  for (const entity of entities) {
    if (tiles.has(entity)) out.push(makeTileEntry(entity, selection));
    else if (!entity.visible) out.push(makeInvisibleEntry(entity));
  }
  return out;
}

function makeTileEntry(entity: EntitySnapshot, selection: DatasetLevelSelection): TileEntry {
  const chosen = selection.entities.get(entity.entityId);
  const detailLevels = chosen?.detailLevels ?? [];
  return {
    kind: "tile",
    entityId: entity.entityId,
    imageId: entity.imageId,
    targetLevel: entity.targetLevel,
    detailLevels,
    keepsCoarse: chosen === undefined ? detailLevels.length === 0 : chosen.coarseCells > 0,
    coarseLevel: compatibleCoarseLevel(entity, detailLevels[0] ?? -Infinity),
  };
}

function clampLevel(entity: EntitySnapshot, level: number): number {
  if (entity.levels.length === 0) return 0;
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(entity.levels.length - 1, Math.floor(level)));
}

/** The entity's coarse level, unless it is finer than its finest detail level, which the coarse tier would only shadow. */
function compatibleCoarseLevel(
  entity: EntitySnapshot,
  finest: number,
): number | null {
  if (entity.coarseLevel === null) return null;
  const coarseLevel = clampLevel(entity, entity.coarseLevel);
  if (coarseLevel < finest) return null;
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
