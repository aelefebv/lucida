/**
 * Builds the active set. Every visible image or tile becomes one
 * {@link TileEntry} carrying the levels each residency tier holds for
 * it. Invisible entities pass through as {@link InvisibleEntry}. See ADR
 * 0029 for the file split and ADR 0039 for the two-tier residency model.
 */

import type {
  ActiveSetEntry,
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
 * when building the render-layer roster (see ADR 0025).
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
 * Build the active set, one entry per entity.
 *
 * Every visible image or tile becomes a tile entry. Its detail tier
 * holds one level, the dataset's level pin or level 0 when none is set,
 * clamped to the pyramid. Its coarse tier holds the source level the
 * coarse tier points at, when that level is no finer. Proxy assets and
 * projected size play no part, because the tier model renders from
 * chunks alone. A visible group entity gets no entry of its own; its
 * tiles carry its geometry.
 *
 * Invisible entities still appear so downstream consumers (the CPU
 * cache's eviction tier mapping, the trace's per-tick tallies) can see
 * them. They live in the dedicated {@link InvisibleEntry} variant and
 * contribute no chunk requests.
 */
export function buildActiveSet(entities: EntitySnapshot[]): ActiveSetEntry[] {
  const out: ActiveSetEntry[] = [];

  for (const group of groupMembers(entities)) {
    for (const tile of group.tiles) {
      out.push(makeTileEntry(tile));
    }
  }

  for (const entity of entities) {
    if (entity.visible) continue;
    out.push(makeInvisibleEntry(entity));
  }

  return out;
}

function makeTileEntry(entity: EntitySnapshot): TileEntry {
  const detailLevel = clampLevel(entity, entity.detailLevel);
  return {
    kind: "tile",
    entityId: entity.entityId,
    imageId: entity.imageId,
    mode: "tiles-with-detail",
    detailLevels: [detailLevel],
    coarseLevel: compatibleCoarseLevel(entity, detailLevel),
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
