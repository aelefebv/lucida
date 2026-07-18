/**
 * Planning domain — dev-mode boundary validator for `plan()`'s inputs.
 *
 * `validatePlanningInputs(snapshot, state)` runs nine semantic-invariant
 * checks against the planner's two non-config inputs. Each check
 * corresponds to a producer-side invariant the type system can't
 * express but the runtime depends on (referential integrity, uniqueness
 * of ids, manifest-shape arity, …). Violations throw an `Error` whose
 * message names the violated invariant and (where applicable) the
 * offending id.
 *
 * Posture: throw, don't degrade. Throwing surfaces the bug at the call
 * site; degrading would defeat the point. `plan()` calls this only when
 * `import.meta.env.DEV` is true so Vite dead-code-eliminates the call in
 * production builds. See ADR `0031-validate-planning-inputs-dev-mode-
 * boundary-check.md` for the rationale and the full check list.
 *
 * Cost: O(N) in entities (one map-build pass + one scan), plus O(L) in
 * total levels for the level-shape arity check. Cheap enough to run on
 * every dev-mode `plan()` call.
 *
 * Each check is exported individually for direct test coverage; the
 * composing {@link validatePlanningInputs} runs them in order and
 * throws on first failure.
 */

import type { ActiveSetEntry, EntitySnapshot, PlanningSnapshot, PlanningState } from "./types.ts";

/**
 * Check 1 — TileSnapshot.parentId references a known GroupSnapshot.
 *
 * Every {@link TileSnapshot}'s `parentId`, when present in
 * `snapshot.entities`, must refer to an entity whose `kind === "Group"`.
 *
 * The snapshot only carries entities WASM's `view_query` returned this
 * tick — a visible tile can have an invisible parent group that doesn't
 * appear at all. The planner's `groupMembers` already handles this via a
 * `groupEntity: null` group (see `pipeline/planning/modes.ts`); treating
 * a missing parent as a violation would false-positive on every
 * legitimate tile-without-visible-parent snapshot the orchestrator
 * builds. This narrowed form catches the genuinely-broken case (parent
 * IS in entities but it's not a Group) without contradicting reality.
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
 * Check 2 — entityId uniqueness.
 *
 * Every `entityId` must be unique across `snapshot.entities`. Duplicate
 * ids cause `prevModeByGroup` (and other entity-keyed maps inside the
 * planner and downstream consumers) to silently drop earlier values.
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
 * Check 3 — imageId uniqueness.
 *
 * Every non-empty `imageId` must be unique across `snapshot.entities`.
 * Duplicate `imageId`s break `minimapPending` keying and any
 * image-keyed downstream lookup (cache keys, residency tables).
 *
 * Empty-string `imageId` is the conventional placeholder for `Group`
 * entities, which do not own an image; a multi-group collection snapshot legitimately carries multiple
 * `imageId: ""` entries. The check only flags duplicates among the
 * non-empty image ids that actually drive image-keyed downstream
 * lookups.
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
 * Check 4 — level shape arity (TCZYX = 5).
 *
 * Every level on every entity must have `shape.length === 5` and
 * `chunk_shape.length === 5`. The TCZYX axis convention is a hard
 * precondition for `iterateChunks`, `chunkOutsideFrustum`, and every
 * `Axis.X` / `Axis.Y` / `Axis.Z` indexed read in the planner.
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
 * Check 5 — visibleRegion bbox + z-range validity.
 *
 * `visibleRegion.xyBoundsVox` must be a valid bbox: `xMin <= xMax` and
 * `yMin <= yMax`. `zRangeVox[0] <= zRangeVox[1]`. The tile shape is
 * `[minX, minY, maxX, maxY]` (see `pipeline/viewport.ts`).
 *
 * A degenerate bbox produces no chunks, but it's a producer bug worth
 * surfacing rather than silently emitting an empty plan.
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

// Check 6 (minimapPending → imageId referential integrity) is intentionally
// absent because producer scopes differ: minimapPath enumerates all
// `dataset_images()`, snapshot.entities is `view_query` output, and
// `emitMinimapLane` only walks images in the active set.

/**
 * Check 8 — previousActiveSet has no duplicate entityIds.
 *
 * `state.previousActiveSet` must have no duplicate `entityId` entries.
 * Duplicates break `prevModeByGroup`'s last-write-wins indexing
 * downstream of the planner.
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
 * Check 9 — previousActiveSet entry kind agrees with snapshot entity kind.
 *
 * For each `state.previousActiveSet` entry whose `entityId` is also in
 * `snapshot.entities`, the entry's `kind` must agree with the entity's
 * `kind`:
 *
 *   - `kind: "tile"`         ⇒ entity must be `kind: "Tile"` OR
 *     `kind: "Image"`. The planner's `groupMembers` synthesizes an
 *     `__image__${entityId}` group for `Image` entities (singletons,
 *     non-collection datasets) so they go through the same tile-mode
 *     code path as collection tiles. The active-set entry it produces is
 *     therefore a `TileEntry` even though the entity itself is an
 *     `ImageSnapshot`. See `pipeline/planning/modes.ts::groupMembers`.
 *   - `kind: "invisible"`     ⇒ NOT validated against entity kind. An
 *     entity can become invisible regardless of its kind, so the
 *     invisible variant is intentionally permissive.
 *
 * Disappeared entities (entry's `entityId` no longer in
 * `snapshot.entities`) are explicitly NOT a violation — entities can
 * come and go across ticks (datasets opened/closed, layout changes,
 * selection shifts). The planner already handles disappeared entries
 * gracefully; surfacing them here would generate false positives on
 * every legitimate state transition.
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
 * Map an {@link ActiveSetEntry} kind to the set of {@link EntitySnapshot}
 * kinds it may correspond to. Returns `null` for `kind: "invisible"` —
 * invisible entries are permissive (any entity can become invisible).
 *
 * `tile` accepts both `Tile` and `Image`: see the comment on
 * {@link checkPrevActiveSetKindAgreement} for the singleton rationale.
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
 * Run the seven semantic-invariant checks on `plan()`'s inputs. Throws
 * on first failure with the violated invariant and the offending id.
 * Called from {@link plan} only when `import.meta.env.DEV` is true.
 *
 * Order is fixed (see ADR 0031): earlier checks build referential
 * context later checks rely on (e.g. uniqueness before reference
 * resolution), so a violation fires before a downstream check could be
 * misled.
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
  // Minimap referential check intentionally absent — see comment above.
  checkPrevActiveSetUnique(state);
  checkPrevActiveSetKindAgreement(snapshot, state);
}
