/**
 * Dev-mode validator for `plan()`'s snapshot and state: producer
 * invariants the type system can't express but the planner relies on.
 * Each check throws an `Error` naming the invariant and the offending id.
 *
 * Throw, don't degrade: the point is to surface the producer bug at the
 * call site. `plan()` calls this only under `import.meta.env.DEV`, so
 * Vite strips it from production builds.
 */

import type { ActiveSetEntry, EntitySnapshot, PlanningSnapshot, PlanningState } from "./types.ts";

/**
 * Check 1: a tile's `parentId`, when that entity is in the snapshot,
 * names a Group. A missing parent is fine: the snapshot holds only this
 * tick's `view_query` entities, so a visible tile's group can be absent,
 * and `groupMembers` handles that with `groupEntity: null`.
 */
export function checkTileParentRefs(snapshot: PlanningSnapshot): void {
  const byId = new Map<string, EntitySnapshot>();
  for (const e of snapshot.entities) byId.set(e.entityId, e);
  for (const e of snapshot.entities) {
    if (e.kind !== "Tile") continue;
    const parent = byId.get(e.parentId);
    if (!parent) continue; // parent not in this tick's entities — not a violation
    if (parent.kind !== "Group") {
      throw new Error(
        `validatePlanningInputs: TileSnapshot ${e.entityId} parentId references non-Group entity ${e.parentId} (kind=${parent.kind})`,
      );
    }
  }
}

/**
 * Check 2: `entityId` is unique across `snapshot.entities`. Duplicates
 * make entity-keyed maps silently drop earlier values.
 */
export function checkUniqueEntityIds(snapshot: PlanningSnapshot): void {
  const seen = new Set<string>();
  for (const e of snapshot.entities) {
    if (seen.has(e.entityId)) {
      throw new Error(
        `validatePlanningInputs: duplicate entityId ${e.entityId} across snapshot.entities`,
      );
    }
    seen.add(e.entityId);
  }
}

/**
 * Check 3: each non-empty `imageId` is unique. Duplicates break
 * `minimapPending` and other image-keyed lookups. Groups carry
 * `imageId: ""`, so a multi-group snapshot repeats the empty id legitimately.
 */
export function checkUniqueImageIds(snapshot: PlanningSnapshot): void {
  const seen = new Set<string>();
  for (const e of snapshot.entities) {
    if (e.imageId === "") continue;
    if (seen.has(e.imageId)) {
      throw new Error(
        `validatePlanningInputs: duplicate imageId ${e.imageId} across snapshot.entities`,
      );
    }
    seen.add(e.imageId);
  }
}

/**
 * Check 4: every level's `shape` and `chunk_shape` have five axes (TCZYX).
 * The queries the planner sends the core's chunk enumerator, and every
 * `Axis`-indexed read in the planner, assume it.
 */
export function checkLevelShapeArity(snapshot: PlanningSnapshot): void {
  for (const e of snapshot.entities) {
    for (let i = 0; i < e.levels.length; i++) {
      const lvl = e.levels[i];
      if (lvl.shape.length !== 5) {
        throw new Error(
          `validatePlanningInputs: entity ${e.entityId} level ${i} shape.length=${lvl.shape.length}, expected 5 (TCZYX)`,
        );
      }
      if (lvl.chunk_shape.length !== 5) {
        throw new Error(
          `validatePlanningInputs: entity ${e.entityId} level ${i} chunk_shape.length=${lvl.chunk_shape.length}, expected 5 (TCZYX)`,
        );
      }
    }
  }
}

/**
 * Check 5: `visibleRegion.xyBoundsVox` (`[minX, minY, maxX, maxY]`) and
 * `zRangeVox` are ordered. A degenerate box yields no chunks, which would
 * hide a producer bug behind an empty plan.
 */
export function checkVisibleRegionBounds(snapshot: PlanningSnapshot): void {
  const [xMin, yMin, xMax, yMax] = snapshot.visibleRegion.xyBoundsVox;
  if (xMin > xMax) {
    throw new Error(
      `validatePlanningInputs: visibleRegion.xyBoundsVox has xMin (${xMin}) > xMax (${xMax})`,
    );
  }
  if (yMin > yMax) {
    throw new Error(
      `validatePlanningInputs: visibleRegion.xyBoundsVox has yMin (${yMin}) > yMax (${yMax})`,
    );
  }
  const [zMin, zMax] = snapshot.visibleRegion.zRangeVox;
  if (zMin > zMax) {
    throw new Error(
      `validatePlanningInputs: visibleRegion.zRangeVox has start (${zMin}) > end (${zMax})`,
    );
  }
}

// No check 7 (minimapPending keys name snapshot images): the minimap covers images view_query omits.

/**
 * Check 8: `state.previousActiveSet` has no duplicate `entityId`. The
 * cold-state delta indexes it by entity.
 */
export function checkPrevActiveSetUnique(state: PlanningState): void {
  const seen = new Set<string>();
  for (const entry of state.previousActiveSet) {
    if (seen.has(entry.entityId)) {
      throw new Error(
        `validatePlanningInputs: duplicate entityId ${entry.entityId} in state.previousActiveSet`,
      );
    }
    seen.add(entry.entityId);
  }
}

/**
 * Check 9: each previous active-set entry whose entity is still in the
 * snapshot agrees with that entity's kind. `tile` accepts Tile or Image,
 * because `groupMembers` wraps each Image in a synthetic one-tile group.
 * `invisible` accepts any kind. An entity missing from the snapshot is not
 * a violation; entities come and go across ticks.
 */
export function checkPrevActiveSetKindAgreement(
  snapshot: PlanningSnapshot,
  state: PlanningState,
): void {
  const byId = new Map<string, EntitySnapshot>();
  for (const e of snapshot.entities) byId.set(e.entityId, e);
  for (const entry of state.previousActiveSet) {
    const entity = byId.get(entry.entityId);
    if (!entity) continue; // disappeared — not a violation
    const allowed = allowedEntityKindsFor(entry);
    if (allowed === null) continue; // invisible — permissive
    if (!allowed.includes(entity.kind)) {
      const expected = allowed.length === 1 ? allowed[0] : allowed.join(" or ");
      throw new Error(
        `validatePlanningInputs: previousActiveSet entry ${entry.entityId} (kind=${entry.kind}) disagrees with entity kind ${entity.kind} (expected ${expected})`,
      );
    }
  }
}

/**
 * Entity kinds an active-set entry may correspond to, or `null` for
 * `invisible` (any kind). See {@link checkPrevActiveSetKindAgreement}.
 */
function allowedEntityKindsFor(
  entry: ActiveSetEntry,
): EntitySnapshot["kind"][] | null {
  switch (entry.kind) {
    case "tile":
      return ["Tile", "Image"];
    case "invisible":
      return null;
  }
}

/**
 * Run every check and throw on the first failure. {@link plan} calls
 * this only when `import.meta.env.DEV` is true.
 */
export function validatePlanningInputs(
  snapshot: PlanningSnapshot,
  state: PlanningState,
): void {
  checkTileParentRefs(snapshot);
  checkUniqueEntityIds(snapshot);
  checkUniqueImageIds(snapshot);
  checkLevelShapeArity(snapshot);
  checkVisibleRegionBounds(snapshot);
  checkPrevActiveSetUnique(state);
  checkPrevActiveSetKindAgreement(snapshot, state);
}
