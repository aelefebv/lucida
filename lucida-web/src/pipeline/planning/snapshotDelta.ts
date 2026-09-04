/**
 * Incremental per-entity snapshot assembly. Holds the single per-row
 * translation from a scene view-query record into an {@link EntitySnapshot}
 * (snake_case → camelCase plus the manifest join for `levels`,
 * `coarseLevel`, `parentId`, and `layoutPositionVox`), and the fold that
 * applies an incremental view-query delta on top of a prior per-image
 * snapshot map.
 *
 * # The target level arrives resolved
 *
 * The core's view query reports each record's `targetLevel` with the
 * dataset's level pin folded in and clamped to the image's source levels
 * (`Scene::member_target_level`). This module copies it and the planner
 * reads it. Neither chooses nor clamps a level, so the core stays the one
 * home of that rule (ADR 0061). The level is in the quantized set the delta
 * tracks, so a zoom or a pin edit arrives as a `changed` record.
 *
 * The full builder (`snapshot.ts`) and the fold below share
 * {@link makeEntitySnapshot} so a delta-reconstructed snapshot is identical,
 * per row, to one assembled from the full visible set — the two paths cannot
 * drift because they run the same code.
 *
 * # Keying
 *
 * The snapshot map is keyed by `image_id`, the unique per-record identity. An
 * entity can own several images at different pyramid depths (distinct
 * `target_level`); keying by `entity_id` would collapse those into one and
 * lose a level. See `lucida-core/src/query.rs`.
 *
 * # What a delta does and does not carry
 *
 * A delta reports only the *quantized* projection of each record —
 * `{ membership, visible, target_level, kind }`. The continuous fields
 * (`importance`, `projectedDiagonalPx`, `projectedAreaPx2`, `centroidWorld`)
 * are excluded, so a record that appears in no delta between two full
 * snapshots keeps its last-reported continuous values, which may be stale.
 * That staleness is the source of the O(delta) win: a small camera nudge that
 * shifts only continuous fields yields an empty delta and no rebuild. A zoom
 * that moves a record's target level is a quantized change, so it arrives as
 * a `changed` record and re-runs the row translation. Any consumer that turns
 * a continuous field into a discrete decision must recompute that decision
 * itself rather than infer it from delta membership.
 */

import type { ImageSpec } from "../../manifestTypes.ts";
import type { EntitySnapshot } from "./types.ts";
import type { SceneEpochs } from "../epochs.ts";

/**
 * Wire shape of one record in a view-query payload (snake_case). Shared by
 * the full builder and the delta fold; mirrors the Rust `EntityQueryResult`
 * in `lucida-core/src/query.rs`.
 */
export interface ViewQueryEntityJson {
  entity_id: string;
  image_id: string;
  kind: "Image" | "Group" | "Tile";
  visible: boolean;
  projected_diagonal_px: number;
  projected_area_px2: number;
  centroid_world: [number, number, number];
  target_level: number;
  importance: number;
}

/**
 * Wire shape of an incremental view-query delta (serde externally-tagged
 * enum). `Full` carries the entire visible set (a fresh start); `Delta`
 * carries only the records that entered, left, or whose quantized state
 * changed since the prior query. `left` is a list of bare `image_id`s.
 * Mirrors the Rust `ViewQueryDelta` in `lucida-core/src/query.rs`.
 */
export type ViewQueryDeltaJson =
  | { Full: { epochs: SceneEpochs; visible_entities: ViewQueryEntityJson[] } }
  | {
      Delta: {
        epochs: SceneEpochs;
        entered: ViewQueryEntityJson[];
        left: string[];
        changed: ViewQueryEntityJson[];
      };
    };

/**
 * Camera-independent inputs to {@link makeEntitySnapshot}: the manifest
 * joins (`imageSpecById`, `parentByEntityId`) and the fixed layout placement
 * (`positions`). All three are stable across a camera move, so a caller
 * assembles them once and reuses them for every record in a delta.
 */
export interface SnapshotEntityDeps {
  imageSpecById: Map<string, ImageSpec>;
  parentByEntityId: Map<string, string | null>;
  positions: Record<string, [number, number]>;
}

/**
 * The coarse pyramid level for an image, or `null` when none is usable.
 * Reads the manifest's explicit `coarse_level_index` when in range.
 */
export function resolveCoarseLevel(imgSpec: ImageSpec | undefined): number | null {
  if (!imgSpec || imgSpec.multiscale.levels.length === 0) return null;
  const levels = imgSpec.multiscale.levels;
  const explicit = imgSpec.multiscale.coarse_level_index;
  if (typeof explicit === "number" && explicit >= 0 && explicit < levels.length) {
    return explicit;
  }
  return null;
}

/**
 * Translate one view-query record into an {@link EntitySnapshot}, joining the
 * scene payload with the manifest for `levels`, `coarseLevel`, `parentId`,
 * and `layoutPositionVox`. `targetLevel` is the record's own, as the core
 * reported it.
 *
 * {@link EntitySnapshot} is a discriminated union: the record's `kind`
 * selects the variant. A `Tile` requires a non-null parent edge in the
 * manifest — a missing edge is a producer-invariant violation and throws
 * here, surfacing it at assembly rather than later in grouping.
 *
 * The single source of the per-row shape: both the full builder and the
 * delta fold call this, so the two paths produce byte-identical records.
 */
export function makeEntitySnapshot(
  row: ViewQueryEntityJson,
  deps: SnapshotEntityDeps,
): EntitySnapshot {
  const imgSpec = deps.imageSpecById.get(row.image_id);
  const levels = imgSpec ? imgSpec.multiscale.levels : [];
  const coarseLevel = resolveCoarseLevel(imgSpec);
  const layoutPositionVox =
    deps.positions[row.entity_id] ?? ([0, 0] as [number, number]);
  const base = {
    entityId: row.entity_id,
    imageId: row.image_id,
    visible: row.visible,
    projectedDiagonalPx: row.projected_diagonal_px,
    projectedAreaPx2: row.projected_area_px2,
    centroidWorld: row.centroid_world,
    targetLevel: row.target_level,
    coarseLevel,
    importance: row.importance,
    layoutPositionVox,
    levels,
  };
  if (row.kind === "Tile") {
    const parentId = deps.parentByEntityId.get(row.entity_id);
    if (parentId === undefined || parentId === null) {
      throw new Error(
        `[planning] Tile entity "${row.entity_id}" has no parent edge ` +
          `in the manifest — TileSnapshot.parentId is required (non-null).`,
      );
    }
    return { kind: "Tile", parentId, ...base } satisfies EntitySnapshot;
  }
  if (row.kind === "Group") {
    return { kind: "Group", ...base } satisfies EntitySnapshot;
  }
  return { kind: "Image", ...base } satisfies EntitySnapshot;
}

/**
 * Fold a view-query delta onto the prior per-image snapshot map, producing
 * the next map keyed by `image_id`.
 *
 * - A `Full` payload (or `prev === null`) builds a fresh map from
 *   `visible_entities` — a self-contained snapshot that ignores any prior.
 * - A `Delta` payload clones `prev`, deletes every `image_id` in `left`,
 *   then upserts every record in `entered` and `changed`.
 *
 * A `Delta` requires a non-null `prev`: the caller keys the fast path on a
 * live cursor and seeds from a full query otherwise (a fresh consumer's
 * first delta must be a `Full`). Applying a `Delta` against a null prior
 * would fabricate a snapshot from only the changed records, so it is a
 * caller error and throws rather than silently returning a partial map.
 *
 * The returned map is a new object; `prev` is never mutated.
 */
export function applyViewQueryDelta(
  prev: ReadonlyMap<string, EntitySnapshot> | null,
  delta: ViewQueryDeltaJson,
  deps: SnapshotEntityDeps,
): Map<string, EntitySnapshot> {
  if ("Full" in delta) {
    const next = new Map<string, EntitySnapshot>();
    for (const row of delta.Full.visible_entities) {
      next.set(row.image_id, makeEntitySnapshot(row, deps));
    }
    return next;
  }

  if (prev === null) {
    throw new Error(
      "[planning] applyViewQueryDelta received a Delta with no prior snapshot; " +
        "a fresh consumer's first query must be a Full.",
    );
  }

  const next = new Map<string, EntitySnapshot>(prev);
  for (const imageId of delta.Delta.left) {
    next.delete(imageId);
  }
  for (const row of delta.Delta.entered) {
    next.set(row.image_id, makeEntitySnapshot(row, deps));
  }
  for (const row of delta.Delta.changed) {
    next.set(row.image_id, makeEntitySnapshot(row, deps));
  }
  return next;
}
