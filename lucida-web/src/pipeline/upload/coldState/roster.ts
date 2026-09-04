/**
 * Per-dataset roster of `MemberRosterEntry` records: consumed by the
 * render paths to build layer params, and by `buildColdState` for the
 * per-entry model matrices. `buildRoster` produces both in one pass.
 */
import { Axis } from "../../../axes.ts";
import type { TickContext } from "../../../renderLoopTypes.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
} from "../../planning/index.ts";
import { groupMembers } from "../../planning/index.ts";
import type { MemberRosterEntry } from "../../tickCoordinator.ts";

/**
 * Synthetic roster entry for a `group-as-proxy` entry.
 *
 * Groups aren't in `derived.members` (so `scene.member_model_matrix`
 * returns identity for them). Instead we compute the group's world-space
 * AABB by unioning each visible tile's `[0,1]^3` cube, then build a
 * translate+scale matrix mapping `[0,1]^3` onto that AABB. The shader
 * ray-marches this synthetic cube and samples the group's proxy texture.
 *
 * Returns `null` if no tile matrices were available.
 */
export function synthesizeGroupRosterEntry(
  ctx: TickContext,
  dsId: string,
  groupEntityId: string,
  childTiles: EntitySnapshot[],
): MemberRosterEntry | null {
  // 3D AABB (in 3D world-space, post Y-flip + global correction). Drives
  // the volume path's `modelMatrix` for ray-marching the group as one
  // synthetic cube.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let validCornerCount = 0;
  // 2D AABB (in voxel space). Drives the slice path's `position` and
  // `dataW/dataH` for rendering the group as a flat quad. Voxel-space is
  // a different frame from the 3D model matrix output (no Y-flip, no
  // global scaling), so we must compute it independently.
  let min2DX = Infinity, min2DY = Infinity;
  let max2DX = -Infinity, max2DY = -Infinity;
  let valid2DCount = 0;
  for (const tile of childTiles) {
    // 2D voxel-space AABB from the tile's own position + level0 shape.
    // EntitySnapshot.layoutPositionVox is already in voxel coords (from
    // `scene.member_positions`).
    const fx = tile.layoutPositionVox[0];
    const fy = tile.layoutPositionVox[1];
    const lvl0 = tile.levels[0];
    if (lvl0) {
      const fw = lvl0.shape[Axis.X];
      const fh = lvl0.shape[Axis.Y];
      min2DX = Math.min(min2DX, fx);
      min2DY = Math.min(min2DY, fy);
      max2DX = Math.max(max2DX, fx + fw);
      max2DY = Math.max(max2DY, fy + fh);
      valid2DCount++;
    }

    // 3D world AABB via the tile's model matrix.
    const model = ctx.scene.member_model_matrix(dsId, tile.imageId);
    if (model.length !== 16) continue;
    for (let i = 0; i < 8; i++) {
      const cx = i & 1;
      const cy = (i >> 1) & 1;
      const cz = (i >> 2) & 1;
      const wx = model[0] * cx + model[4] * cy + model[8] * cz + model[12];
      const wy = model[1] * cx + model[5] * cy + model[9] * cz + model[13];
      const wz = model[2] * cx + model[6] * cy + model[10] * cz + model[14];
      const ww = model[3] * cx + model[7] * cy + model[11] * cz + model[15];
      if (ww === 0) continue;
      const x = wx / ww;
      const y = wy / ww;
      const z = wz / ww;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      validCornerCount++;
    }
  }
  if (validCornerCount === 0 || valid2DCount === 0) return null;
  const sx = maxX - minX;
  const sy = maxY - minY;
  const sz = maxZ - minZ;
  if (sx === 0 || sy === 0 || sz === 0) return null;
  const sx2D = max2DX - min2DX;
  const sy2D = max2DY - min2DY;
  if (sx2D === 0 || sy2D === 0) return null;
  // Column-major 3D model matrix: scale + translate so [0,1]^3 → world AABB.
  const model = new Float32Array([
    sx,   0,    0,    0,
    0,    sy,   0,    0,
    0,    0,    sz,   0,
    minX, minY, minZ, 1,
  ]);
  const inv = new Float32Array([
    1 / sx,         0,              0,              0,
    0,              1 / sy,         0,              0,
    0,              0,              1 / sz,         0,
    -minX / sx,     -minY / sy,     -minZ / sz,     1,
  ]);
  return {
    // For `MemberRosterEntry` (the render-side roster, separate from
    // `ColdStateActiveEntry`) we set `imageId = groupEntityId` so the
    // render path has a non-empty handle. The descriptor lookup uses
    // `entityId` (via `memberIdForColdEntry`), not `imageId`.
    imageId: groupEntityId,
    // 2D voxel-space position + size for the slice path. Independent of
    // the 3D model matrix above (different coordinate frame).
    position: [min2DX, min2DY],
    entityId: groupEntityId,
    mode: "group-as-proxy",
    modelMatrix: model,
    invModelMatrix: inv,
    dataW: sx2D,
    dataH: sy2D,
  };
}

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
   * tiles new to the walk are computed and written back. `group-as-proxy`
   * matrices are NEVER cached here — they are synthesized from the currently-
   * visible child-tile set, which a view move changes. The caller invalidates
   * the cache when layout/content/asset changes.
   */
  tileMatrixCache?: Map<string, { model: Float32Array; inv: Float32Array }>;
}): BuildRosterResult {
  const { activeSet, entities, ctx, datasetId, tileMatrixCache } = args;

  // Use the planning module's canonical grouping (ADR 0025) so the
  // roster builder agrees with `buildActiveSet` on which tiles make up
  // each group.
  const tilesByGroup = new Map<string, EntitySnapshot[]>();
  for (const group of groupMembers(entities)) {
    if (group.tiles.length > 0) {
      tilesByGroup.set(group.groupId, group.tiles);
    }
  }

  const entityById = new Map(entities.map(e => [e.entityId, e]));

  const entries: MemberRosterEntry[] = [];
  for (const entry of activeSet) {
    if (entry.kind === "group-as-proxy") {
      const childTiles = tilesByGroup.get(entry.entityId) ?? [];
      if (childTiles.length === 0) continue; // no geometry to render
      const synth = synthesizeGroupRosterEntry(ctx, datasetId, entry.entityId, childTiles);
      if (synth) entries.push(synth);
      continue;
    }
    // Invisible entries don't render — skip them in the roster.
    if (entry.kind === "invisible") continue;
    // Narrowed: entry is TileEntry below.
    const entity = entityById.get(entry.entityId);
    if (entity) {
      entries.push({
        imageId: entity.imageId,
        position: entity.layoutPositionVox,
        entityId: entry.entityId,
        mode: entry.mode,
      });
    }
  }

  // Build a model-matrix lookup keyed by entityId so cold state includes
  // precomputed model matrices (worker can't query WASM, and
  // `group-as-proxy` matrices were already synthesised here).
  const matricesByEntity = new Map<string, { model: Float32Array; inv: Float32Array }>();
  for (const r of entries) {
    if (!r.entityId) continue;
    // `group-as-proxy` entries carry a synthesized matrix (view-dependent —
    // never cached). Everything else is a tile whose matrix is layout-derived
    // and reusable across a view move.
    if (r.modelMatrix && r.invModelMatrix) {
      matricesByEntity.set(r.entityId, { model: r.modelMatrix, inv: r.invModelMatrix });
      continue;
    }
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
