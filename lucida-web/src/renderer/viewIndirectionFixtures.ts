/**
 * Test fixtures for views drawing from shared chunk pools: a view's draw of a
 * dataset, and its indirection over a pool, without a GPU.
 */

import type { ColdStateMessage, PoolMode } from "./workerProtocol.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";
import type { ViewDraw } from "./worker/state.ts";
import type { SharedChunkPool, ViewIndirection } from "./viewIndirection.ts";
import { INDIRECTION_MISS } from "./remap.ts";
import type { WantedChunkIndex } from "./wantedChunks.ts";

/** A view's draw of `datasetId`, standing at `t` and cutting at `z`. */
export function fakeDraw(overrides: {
  datasetId?: string;
  view?: number;
  mode?: PoolMode;
  t?: number;
  z?: number;
  wanted?: WantedChunkIndex;
  targetLevels?: Map<string, number>;
} = {}): ViewDraw {
  const mode = overrides.mode ?? "volume";
  return {
    datasetId: overrides.datasetId ?? "ds1",
    view: overrides.view ?? 0,
    mode,
    cold: { currentT: overrides.t ?? 0, currentZ: overrides.z ?? 0, viewMode: mode } as ColdStateMessage,
    wanted: overrides.wanted ?? new Map(),
    routes: new Map(),
    targetLevels: overrides.targetLevels ?? new Map(),
    sources: new Map(),
    descriptor: null,
  };
}

/**
 * Give `pool` a view whose indirection lays out `entityMetas` in
 * `entries` cells, all empty, and return it.
 */
export function attachView(
  pool: SharedChunkPool,
  entityMetas: Map<string, LodIndirectionMeta[]>,
  options: { draw?: ViewDraw; entries?: number } = {},
): ViewIndirection {
  const draw = options.draw ?? fakeDraw({ datasetId: pool.datasetId });
  let entries = options.entries ?? 0;
  if (options.entries === undefined) {
    for (const metas of entityMetas.values()) {
      for (const meta of metas) {
        const [gz, gy, gx] = meta.gridDims;
        entries = Math.max(entries, meta.offset + gz * gy * gx);
      }
    }
  }
  const view: ViewIndirection = {
    draw,
    entityMetas,
    indirectionData: new Uint32Array(Math.max(entries, 1)).fill(INDIRECTION_MISS),
    indirectionBuf: { destroy: () => {} } as unknown as GPUBuffer,
    slotGridIdx: new Int32Array(pool.totalSlots).fill(-1),
    dirty: false,
  };
  pool.views.set(draw.view, view);
  return view;
}

/** The indirection of `pool`'s view `view`, which a test attached. */
export function viewOf(pool: SharedChunkPool, view = 0): ViewIndirection {
  const found = pool.views.get(view);
  if (!found) throw new Error(`no view ${view} over the pool`);
  return found;
}
