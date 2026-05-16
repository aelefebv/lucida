/**
 * Cold-state roster builders.
 *
 * The roster is the per-dataset list of `MemberRosterEntry` records that
 * the render paths (slice + volume) consume to build layer params. The
 * same matrices are consumed by `buildColdState` to populate per-entry
 * model matrices in the cold-state message sent to the GPU worker.
 *
 * `buildRoster` wraps the per-active-set walk into a single pure builder
 * that produces both the roster list and the matricesByEntity map in one
 * pass.
 */
import { Axis } from "../../../axes.ts";
import type { TickContext } from "../../../renderLoopTypes.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
} from "../../planning/index.ts";
import { groupByWell } from "../../planning/index.ts";
import type { MemberRosterEntry } from "../../orchestrator.ts";

/**
 * Build a synthetic roster entry for a `well-as-proxy` entry.
 *
 * Wells aren't in `derived.members` so `scene.member_model_matrix` would
 * return identity for them; instead we compute the well's world-space
 * AABB by unioning each visible field's `[0,1]^3` cube transformed by
 * its own model matrix, then build a translate+scale matrix that maps
 * `[0,1]^3` onto that AABB. The shader marches a ray through this
 * synthetic cube and samples the well's proxy texture once per fragment.
 *
 * Returns `null` if no field model matrices were available (defensive;
 * caller already filters out wells with zero visible fields).
 *
 * Pure modulo `ctx.scene.member_model_matrix` reads.
 */
export function synthesizeWellRosterEntry(
  ctx: TickContext,
  dsId: string,
  wellEntityId: string,
  childFields: EntitySnapshot[],
): MemberRosterEntry | null {
  // 3D AABB (in 3D world-space, post Y-flip + global correction). Drives
  // the volume path's `modelMatrix` for ray-marching the well as one
  // synthetic cube.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let validCornerCount = 0;
  // 2D AABB (in voxel space). Drives the slice path's `position` and
  // `dataW/dataH` for rendering the well as a flat quad. Voxel-space is
  // a different frame from the 3D model matrix output (no Y-flip, no
  // global scaling), so we must compute it independently.
  let min2DX = Infinity, min2DY = Infinity;
  let max2DX = -Infinity, max2DY = -Infinity;
  let valid2DCount = 0;
  for (const field of childFields) {
    // 2D voxel-space AABB from the field's own position + level0 shape.
    // EntitySnapshot.layoutPositionVox is already in voxel coords (from
    // `scene.member_positions`).
    const fx = field.layoutPositionVox[0];
    const fy = field.layoutPositionVox[1];
    const lvl0 = field.levels[0];
    if (lvl0) {
      const fw = lvl0.shape[Axis.X];
      const fh = lvl0.shape[Axis.Y];
      min2DX = Math.min(min2DX, fx);
      min2DY = Math.min(min2DY, fy);
      max2DX = Math.max(max2DX, fx + fw);
      max2DY = Math.max(max2DY, fy + fh);
      valid2DCount++;
    }

    // 3D world AABB via the field's model matrix.
    const model = ctx.scene.member_model_matrix(dsId, field.imageId);
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
    // `ColdStateActiveEntry`) we set `imageId = wellEntityId` so the
    // render path has a non-empty handle. The descriptor lookup uses
    // `entityId` (via `memberIdForColdEntry`), not `imageId`.
    imageId: wellEntityId,
    // 2D voxel-space position + size for the slice path. Independent of
    // the 3D model matrix above (different coordinate frame).
    position: [min2DX, min2DY],
    entityId: wellEntityId,
    mode: "well-as-proxy",
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

/**
 * Walk an active set and produce both the render roster and the
 * matrices map in a single pass.
 *
 * Behaviour:
 *   - `well-as-proxy` entries are synthesised via
 *     {@link synthesizeWellRosterEntry}; skipped if the well has zero
 *     visible fields (no geometry to render).
 *   - `invisible` entries are skipped (they don't render).
 *   - `field` entries look up their `EntitySnapshot` and produce a
 *     roster entry forwarding `imageId`, `position`, `entityId`, `mode`.
 *
 * For every produced entry with an `entityId`, this builder records the
 * model + inverse matrices into `matricesByEntity`. `well-as-proxy`
 * entries reuse the synthesised matrices; field entries look them up
 * from `scene.member_model_matrix` / `inv_member_model_matrix`.
 */
export function buildRoster(args: {
  activeSet: ActiveSetEntry[];
  entities: EntitySnapshot[];
  ctx: TickContext;
  datasetId: string;
}): BuildRosterResult {
  const { activeSet, entities, ctx, datasetId } = args;

  // Use the planning module's canonical well-grouping (ADR 0025) so the
  // roster builder agrees with `assignModes` on which fields make up
  // each well group.
  const fieldsByWell = new Map<string, EntitySnapshot[]>();
  for (const group of groupByWell(entities)) {
    if (group.fields.length > 0) {
      fieldsByWell.set(group.wellId, group.fields);
    }
  }

  const entityById = new Map(entities.map(e => [e.entityId, e]));

  const entries: MemberRosterEntry[] = [];
  for (const entry of activeSet) {
    if (entry.kind === "well-as-proxy") {
      const childFields = fieldsByWell.get(entry.entityId) ?? [];
      if (childFields.length === 0) continue; // no geometry to render
      const synth = synthesizeWellRosterEntry(ctx, datasetId, entry.entityId, childFields);
      if (synth) entries.push(synth);
      continue;
    }
    // Invisible entries don't render — skip them in the roster.
    if (entry.kind === "invisible") continue;
    // Narrowed: entry is FieldEntry below.
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
  // `well-as-proxy` matrices were already synthesised here).
  const matricesByEntity = new Map<string, { model: Float32Array; inv: Float32Array }>();
  for (const r of entries) {
    if (!r.entityId) continue;
    const model = r.modelMatrix
      ?? new Float32Array(ctx.scene.member_model_matrix(datasetId, r.imageId));
    const inv = r.invModelMatrix
      ?? new Float32Array(ctx.scene.inv_member_model_matrix(datasetId, r.imageId));
    matricesByEntity.set(r.entityId, { model, inv });
  }

  return { entries, matricesByEntity };
}
