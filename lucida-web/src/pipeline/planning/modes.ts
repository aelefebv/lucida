/** Resolve visible entities onto the single coarse/detail chunk path. */

import type {
  ActiveSetEntry,
  EntitySnapshot,
  InvisibleEntry,
  MemberGroup,
  TileEntry,
} from "./types.ts";

/**
 * Group visible tiles by their collection parent. Standalone images are
 * represented as singleton groups so roster and planning consumers share one
 * structural rule. Group entities themselves do not produce chunk entries.
 */
export function groupMembers(entities: EntitySnapshot[]): MemberGroup[] {
  const groups = new Map<string, MemberGroup>();

  for (const entity of entities) {
    if (!entity.visible) continue;

    if (entity.kind === "Group") {
      const current = groups.get(entity.entityId);
      if (current) {
        current.groupEntity = entity;
        current.projectedDiagonalPx = Math.max(
          current.projectedDiagonalPx,
          entity.projectedDiagonalPx,
        );
      } else {
        groups.set(entity.entityId, {
          groupId: entity.entityId,
          groupEntity: entity,
          tiles: [],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        });
      }
      continue;
    }

    if (entity.kind === "Tile") {
      const current = groups.get(entity.parentId);
      if (current) {
        current.tiles.push(entity);
        current.projectedDiagonalPx = Math.max(
          current.projectedDiagonalPx,
          entity.projectedDiagonalPx,
        );
      } else {
        groups.set(entity.parentId, {
          groupId: entity.parentId,
          groupEntity: null,
          tiles: [entity],
          projectedDiagonalPx: entity.projectedDiagonalPx,
        });
      }
      continue;
    }

    groups.set(`__image__${entity.imageId}`, {
      groupId: `__image__${entity.imageId}`,
      groupEntity: null,
      tiles: [entity],
      projectedDiagonalPx: entity.projectedDiagonalPx,
    });
  }

  return [...groups.values()];
}

export function assignChunkModes(entities: EntitySnapshot[]): ActiveSetEntry[] {
  const out: ActiveSetEntry[] = [];
  for (const group of groupMembers(entities)) {
    for (const tile of group.tiles) out.push(makeChunkEntry(tile));
  }
  for (const entity of entities) {
    if (!entity.visible) out.push(makeInvisibleEntry(entity));
  }
  return out;
}

function makeChunkEntry(entity: EntitySnapshot): TileEntry {
  const detailLevel = clampLevel(entity, entity.detailLevel);
  const coarseLevel = compatibleCoarseLevel(entity, detailLevel);
  const coarsestDetailLod = coarseLevel ?? detailLevel;
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
    wantedLodLevels: coarseLevel !== null && coarseLevel !== detailLevel
      ? [detailLevel, coarseLevel]
      : [detailLevel],
  };
}

function clampLevel(entity: EntitySnapshot, level: number): number {
  if (entity.levels.length === 0 || !Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(entity.levels.length - 1, Math.floor(level)));
}

function compatibleCoarseLevel(
  entity: EntitySnapshot,
  detailLevel: number,
): number | null {
  if (entity.coarseLevel === null) return null;
  const coarseLevel = clampLevel(entity, entity.coarseLevel);
  return coarseLevel < detailLevel ? null : coarseLevel;
}

function makeInvisibleEntry(entity: EntitySnapshot): InvisibleEntry {
  return {
    kind: "invisible",
    entityId: entity.entityId,
    imageId: entity.imageId,
    coarsestLod: Math.max(entity.levels.length - 1, 0),
  };
}
