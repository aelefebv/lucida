/**
 * Per-row translation from a view-query record into an {@link EntitySnapshot},
 * and the fold that applies a view-query delta onto a prior snapshot map. The
 * full builder (`snapshot.ts`) and the fold share {@link makeEntitySnapshot},
 * so the two paths cannot drift. `targetLevel` arrives from the core already
 * pinned and clamped; nothing here picks a level. The map is keyed
 * by `image_id` because one entity can own images at several pyramid depths.
 * A delta carries only quantized fields, so continuous fields on a carried-over
 * record may be stale: never derive a discrete decision from them.
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
  level_pinned: boolean;
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
 * The image's source levels, ascending: every listed level except the
 * generated coarse levels, which belong to the coarse tier. The
 * set the prefetch lane's level step stays inside. The target level arrives
 * from the core already inside it, so nothing here clamps.
 */
function sourceLevelsOf(imgSpec: ImageSpec | undefined): number[] {
  if (!imgSpec) return [0];
  const generated = new Set(
    (imgSpec.multiscale.generated_levels ?? []).map((level) => level.level_index),
  );
  const sourceLevels = imgSpec.multiscale.levels
    .map((level, idx) => level.level_index ?? idx)
    .filter((level) => !generated.has(level))
    .sort((a, b) => a - b);
  return sourceLevels.length > 0 ? sourceLevels : [0];
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
 * The record's `kind` selects the variant. A `Tile` with no parent edge in
 * the manifest is a producer-invariant violation and throws here, at
 * assembly, rather than later in grouping.
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
    levelPinned: row.level_pinned,
    sourceLevels: sourceLevelsOf(imgSpec),
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
 * - A `Full` payload builds a fresh map from `visible_entities`, ignoring
 *   any prior.
 * - A `Delta` payload clones `prev`, deletes every `image_id` in `left`,
 *   then upserts every record in `entered` and `changed`.
 *
 * A `Delta` with a null `prev` throws: it would fabricate a snapshot from
 * only the changed records. The caller seeds from a full query instead.
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
