/**
 * Per-dataset roster of `MemberRosterEntry` records: consumed by the
 * render paths to build layer params, and by `buildColdState` for the
 * per-entry model matrices. `buildRoster` produces both in one pass.
 */
import type { TickContext } from "../../../renderLoopTypes.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
} from "../../planning/index.ts";
import type { MemberRosterEntry } from "../../tickCoordinator.ts";

/**
 * Output of {@link buildRoster}: the per-dataset roster of members to
 * render, plus an entityId-keyed map of precomputed model+inverse
 * matrices that the cold-state builder consumes.
 */
export interface BuildRosterResult {
  entries: MemberRosterEntry[];
  matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
}

/** Single-pass walk of the active set producing roster + matrices map. */
export function buildRoster(args: {
  activeSet: ActiveSetEntry[];
  entities: EntitySnapshot[];
  ctx: TickContext;
  datasetId: string;
  /**
   * Optional entityId → tile matrices cache carried across rebuilds. A tile's
   * model matrix comes from `scene.member_model_matrix` (a pure function of
   * layout, no camera input), so it is byte-identical across a view move; when
   * a cache is supplied, tile matrices already in it are reused and matrices for
   * tiles new to the walk are computed and written back. The caller invalidates
   * the cache when layout or content changes.
   */
  tileMatrixCache?: Map<string, { model: Float32Array; inv: Float32Array }>;
}): BuildRosterResult {
  const { activeSet, entities, ctx, datasetId, tileMatrixCache } = args;

  const entityByImageId = new Map(entities.map(e => [e.imageId, e]));

  const entries: MemberRosterEntry[] = [];
  for (const entry of activeSet) {
    // Invisible entries don't render — skip them in the roster.
    if (entry.kind === "invisible") continue;
    // Narrowed: entry is TileEntry below.
    const entity = entityByImageId.get(entry.imageId);
    if (entity) {
      entries.push({
        imageId: entity.imageId,
        position: entity.layoutPositionVox,
        entityId: entry.entityId,
      });
    }
  }

  // Build a model-matrix lookup keyed by entityId so cold state includes
  // precomputed model matrices (the worker cannot query WASM).
  const matricesByEntity = new Map<string, { model: Float32Array; inv: Float32Array }>();
  for (const r of entries) {
    if (!r.entityId) continue;
    const cached = tileMatrixCache?.get(r.entityId);
    const matrices = cached ?? {
      model: new Float32Array(ctx.scene.member_model_matrix(datasetId, r.imageId)),
      inv: new Float32Array(ctx.scene.inv_member_model_matrix(datasetId, r.imageId)),
    };
    if (!cached) tileMatrixCache?.set(r.entityId, matrices);
    matricesByEntity.set(r.entityId, matrices);
  }

  return { entries, matricesByEntity };
}
