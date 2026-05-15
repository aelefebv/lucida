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

// ---------------------------------------------------------------------------
// Check 1 — FieldSnapshot.parentId references a known WellSnapshot
// ---------------------------------------------------------------------------

/**
 * Every {@link FieldSnapshot}'s `parentId`, when present in
 * `snapshot.entities`, must refer to an entity whose `kind === "Well"`.
 *
 * Subtle: the PRD's literal phrasing was "exists in entities AND refers
 * to a Well." In production the snapshot only carries entities WASM's
 * `view_query` returned this tick — a visible field can have an
 * invisible parent well that doesn't appear at all. The planner's
 * `groupByWell` already handles this via a `wellEntity: null` group
 * (see `pipeline/planning/modes.ts`). Treating a missing parent as a
 * violation would false-positive on every legitimate
 * field-without-visible-parent snapshot the orchestrator builds. The
 * narrowed form catches the genuinely-broken case (parent IS in
 * entities but it's not a Well) without contradicting reality.
 */
export function checkFieldParentRefs(snapshot: PlanningSnapshot): void {
  const byId = new Map<string, EntitySnapshot>();
  for (const e of snapshot.entities) byId.set(e.entityId, e);
  for (const e of snapshot.entities) {
    if (e.kind !== "Field") continue;
    const parent = byId.get(e.parentId);
    if (!parent) continue; // parent not in this tick's entities — not a violation
    if (parent.kind !== "Well") {
      throw new Error(
        `validatePlanningInputs: FieldSnapshot ${e.entityId} parentId references non-Well entity ${e.parentId} (kind=${parent.kind})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2 — entityId uniqueness
// ---------------------------------------------------------------------------

/**
 * Every `entityId` must be unique across `snapshot.entities`. Duplicate
 * ids cause `prevModeByWell` (and other entity-keyed maps inside the
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

// ---------------------------------------------------------------------------
// Check 3 — imageId uniqueness
// ---------------------------------------------------------------------------

/**
 * Every non-empty `imageId` must be unique across `snapshot.entities`.
 * Duplicate `imageId`s break `minimapPending` keying and any
 * image-keyed downstream lookup (cache keys, residency tables).
 *
 * Empty-string `imageId` is the conventional placeholder for `Well`
 * entities (the well IS the proxy — there is no image to key against);
 * a multi-well plate snapshot legitimately carries multiple
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

// ---------------------------------------------------------------------------
// Check 4 — level shape arity (TCZYX = 5)
// ---------------------------------------------------------------------------

/**
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

// ---------------------------------------------------------------------------
// Check 5 — visibleRegion bbox + z-range validity
// ---------------------------------------------------------------------------

/**
 * `visibleRegion.xyBoundsVox` must be a valid bbox: `xMin <= xMax` and
 * `yMin <= yMax`. `zRangeVox[0] <= zRangeVox[1]`. The field shape is
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

// ---------------------------------------------------------------------------
// Check 6 — assetCatalog references resolve to known entities
// ---------------------------------------------------------------------------

/**
 * Every `entityId` keyed in `snapshot.assetCatalog.byEntity` must
 * correspond to an entity present in `snapshot.entities`. Skipped when
 * `assetCatalog` is `null` (an explicitly accepted opt-out for tests
 * and the synthetic-snapshot helper).
 *
 * Dangling proxy references would cause `degradeForCatalog` to make
 * the wrong tier choice (treating a stale advertisement as live).
 *
 * Note on naming: the issue describes these as "proxy references";
 * the catalog snapshot is keyed by `entityId` (each entry carries the
 * set of proxy `kinds` that entity advertises). The check therefore
 * walks the keys and asserts each is a known `entityId`. See
 * `pipeline/assetCatalog.ts` for the snapshot shape.
 */
export function checkAssetCatalogRefs(snapshot: PlanningSnapshot): void {
  const catalog = snapshot.assetCatalog;
  if (catalog === null) return;
  const known = new Set<string>();
  for (const e of snapshot.entities) known.add(e.entityId);
  for (const entityId of catalog.byEntity.keys()) {
    if (!known.has(entityId)) {
      throw new Error(
        `validatePlanningInputs: assetCatalog references unknown entityId ${entityId}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 7 — minimapPending keys are valid imageIds
// ---------------------------------------------------------------------------

/**
 * Every key in `snapshot.minimapPending` must match the `imageId` of
 * some entity in `snapshot.entities`. Dangling keys surface as no-op
 * emits but mask a producer bug in the minimap path.
 */
export function checkMinimapKeys(snapshot: PlanningSnapshot): void {
  const knownImageIds = new Set<string>();
  for (const e of snapshot.entities) knownImageIds.add(e.imageId);
  for (const imageId of snapshot.minimapPending.keys()) {
    if (!knownImageIds.has(imageId)) {
      throw new Error(
        `validatePlanningInputs: minimapPending key ${imageId} is not a known imageId in snapshot.entities`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 8 — previousActiveSet has no duplicate entityIds
// ---------------------------------------------------------------------------

/**
 * `state.previousActiveSet` must have no duplicate `entityId` entries.
 * Duplicates break `prevModeByWell`'s last-write-wins indexing
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

// ---------------------------------------------------------------------------
// Check 9 — previousActiveSet entry kind agrees with snapshot entity kind
// ---------------------------------------------------------------------------

/**
 * For each `state.previousActiveSet` entry whose `entityId` is also in
 * `snapshot.entities`, the entry's `kind` must agree with the entity's
 * `kind`:
 *
 *   - `kind: "well-as-proxy"` ⇒ entity must be `kind: "Well"`.
 *   - `kind: "field"`         ⇒ entity must be `kind: "Field"`.
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
    const expectedEntityKind = expectedEntityKindFor(entry);
    if (expectedEntityKind === null) continue; // invisible — permissive
    if (entity.kind !== expectedEntityKind) {
      throw new Error(
        `validatePlanningInputs: previousActiveSet entry ${entry.entityId} (kind=${entry.kind}) disagrees with entity kind ${entity.kind} (expected ${expectedEntityKind})`,
      );
    }
  }
}

/**
 * Map an {@link ActiveSetEntry} kind to the {@link EntitySnapshot} kind
 * it must correspond to. Returns `null` for `kind: "invisible"` —
 * invisible entries are permissive (any entity can become invisible).
 */
function expectedEntityKindFor(entry: ActiveSetEntry): EntitySnapshot["kind"] | null {
  switch (entry.kind) {
    case "well-as-proxy":
      return "Well";
    case "field":
      return "Field";
    case "invisible":
      return null;
  }
}

// ---------------------------------------------------------------------------
// validatePlanningInputs — composing entry point
// ---------------------------------------------------------------------------

/**
 * Run all nine semantic-invariant checks on `plan()`'s inputs. Throws
 * on first failure; the message names the violated invariant and the
 * offending id where applicable. Called from {@link plan} only when
 * `import.meta.env.DEV` is true.
 *
 * Order of checks is fixed (matches ADR 0031). Earlier checks build the
 * referential context later checks rely on (e.g. uniqueness before
 * reference-resolution), so a violation in an earlier check fires before
 * a downstream check could be misled.
 */
export function validatePlanningInputs(
  snapshot: PlanningSnapshot,
  state: PlanningState,
): void {
  checkFieldParentRefs(snapshot);
  checkUniqueEntityIds(snapshot);
  checkUniqueImageIds(snapshot);
  checkLevelShapeArity(snapshot);
  checkVisibleRegionBounds(snapshot);
  checkAssetCatalogRefs(snapshot);
  checkMinimapKeys(snapshot);
  checkPrevActiveSetUnique(state);
  checkPrevActiveSetKindAgreement(snapshot, state);
}
