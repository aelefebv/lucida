/**
 * The planner's side of the core's chunk enumerator
 * (`lucida-core/src/chunk.rs`): which chunks of each entity level the view
 * samples, culled and render-radius filtered, and how far each lies from
 * the view's focus. A plan crosses into the core once, with every query in
 * one typed array, because a wide collection asks for thousands.
 */

import { enumerate_chunks } from "lucida-core";
import { Axis } from "../../axes.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { EntitySnapshot, PlanCullingStats } from "./types.ts";

/** `QUERY_STRIDE`, `QUERY_HEADER` and `CHUNK_STRIDE` in `lucida-core/src/chunk.rs`. */
const QUERY_STRIDE = 15;
const QUERY_HEADER = 5;
const CHUNK_STRIDE = 4;

/** One level of one entity to enumerate, and the render radius it keeps. */
export interface LevelQuery {
  entity: EntitySnapshot;
  level: number;
  /** A multiple of the view's radius basis; 2 or more keeps every chunk. */
  radiusView: number;
}

/** What one plan's queries found, read by query index. */
export interface ChunkEnumeration {
  /** Chunks the query found; 0 for a level the entity lacks. */
  size(query: number): number;
  /** Visit each chunk the query found, in grid order, with its distance from the focus. */
  forEach(query: number, visit: (x: number, y: number, z: number, distance: number) => void): void;
  /**
   * Add the query's culling counts to `culling`, `times` over: once per
   * channel, since the core counts grid cells.
   */
  addCounts(query: number, culling: PlanCullingStats, times: number): void;
}

/**
 * Enumerate every query under `region`. `depthBiasView` moves the focus
 * along Z by a share of the region's half-depth. A query for a level the
 * entity lacks finds nothing and counts nothing.
 */
export function enumerateChunks(
  region: VisibleRegion,
  depthBiasView: number,
  queries: readonly LevelQuery[],
): ChunkEnumeration {
  // The core's index of each query, or -1 for one that never crosses.
  const sent = new Int32Array(queries.length).fill(-1);
  const input = new Float64Array(queries.length * QUERY_STRIDE);
  let count = 0;
  for (let i = 0; i < queries.length; i++) {
    const { entity, level, radiusView } = queries[i];
    const full = entity.levels[0];
    const geo = entity.levels[level];
    if (full === undefined || geo === undefined) continue;
    const fields = [
      entity.layoutPositionVox[0],
      entity.layoutPositionVox[1],
      full.shape[Axis.X],
      full.shape[Axis.Y],
      full.shape[Axis.Z],
      geo.shape[Axis.X],
      geo.shape[Axis.Y],
      geo.shape[Axis.Z],
      geo.chunk_shape[Axis.X],
      geo.chunk_shape[Axis.Y],
      geo.chunk_shape[Axis.Z],
      geo.grid_shape[Axis.X],
      geo.grid_shape[Axis.Y],
      geo.grid_shape[Axis.Z],
      radiusView,
    ];
    input.set(fields, count * QUERY_STRIDE);
    sent[i] = count++;
  }

  const out = count === 0
    ? new Float64Array(0)
    : enumerate_chunks(regionJson(region), depthBiasView, input.subarray(0, count * QUERY_STRIDE));
  // Where each sent query's chunks start in `out`.
  const starts = new Int32Array(count);
  let at = count * QUERY_HEADER;
  for (let q = 0; q < count; q++) {
    starts[q] = at;
    at += out[q * QUERY_HEADER + 4] * CHUNK_STRIDE;
  }

  return {
    size: (query) => (sent[query] < 0 ? 0 : out[sent[query] * QUERY_HEADER + 4]),
    forEach(query, visit) {
      const q = sent[query];
      if (q < 0) return;
      const end = starts[q] + out[q * QUERY_HEADER + 4] * CHUNK_STRIDE;
      for (let i = starts[q]; i < end; i += CHUNK_STRIDE) visit(out[i], out[i + 1], out[i + 2], out[i + 3]);
    },
    addCounts(query, culling, times) {
      const q = sent[query];
      if (q < 0) return;
      const head = q * QUERY_HEADER;
      culling.considered += out[head] * times;
      culling.afterXyBounds += out[head + 1] * times;
      culling.afterZRange += out[head + 2] * times;
      culling.afterFrustum += out[head + 3] * times;
    },
  };
}

/** The region as the core reads it: `VisibleRegion` in `lucida-core/src/camera.rs`. */
function regionJson(region: VisibleRegion): string {
  return JSON.stringify({
    xy_bounds: region.xyBoundsVox,
    z_range: region.zRangeVox,
    radius_basis_vox: region.radiusBasisVox ?? null,
    sort_center: region.sortCenterVox,
    frustum_planes: region.frustumPlanes,
    ...(region.sidePlanes ? { side_planes: region.sidePlanes } : {}),
    ...(region.cutAxis && region.cutAxis !== "z" ? { cut_axis: region.cutAxis } : {}),
  });
}
