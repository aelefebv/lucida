/**
 * The overview draw the minimap and the explore thumbnails share: their
 * overviews, from the overview atlases, as member batches. Overviews whose
 * places on the target do not meet share a batch (`layerBatches.ts`), and a
 * batch costs one draw per atlas and display it holds, so a collection's
 * channel is one draw however many members it has.
 *
 * A render keeps what its inputs decide. Which overviews it can draw, and
 * their descriptors, hold while its layers and the overviews held do; their
 * rects, batches and instances while the camera, the target size and the
 * blend modes do as well. So a display edit with the camera still writes one
 * uniform block and entity reference per atlas and display, and nothing per
 * overview.
 */

import type { WorkerCtx } from "./workerContext.ts";
import type { OverviewDisplay, OverviewLayers } from "./workerProtocol.ts";
import type { BlendMode } from "./layerCompositor.ts";
import type { MemberBatch, MemberInstance, VolumeMemberDraw, VolumeRenderer } from "./volumeRenderer.ts";
import { batchLayers, type PixelRect } from "./layerBatches.ts";
import { computeScissorRect } from "../pipeline/upload/scissor.ts";
import { overviewBinding, type Overview, type OverviewAtlas } from "./overviewAtlas.ts";

/** The camera a render draws its overviews from. */
export interface OverviewCamera {
  invViewProj: Float32Array;
  /** The inverse of `invViewProj`, which places each overview on the target. */
  viewProj: Float32Array;
  eye: Float32Array;
  /** Device pixels per CSS pixel, so the failed hatch is one size at any ratio. */
  pixelRatio: number;
}

/** Where a render draws: `view`, through the `scratch` target and its `memberIds`, both `width` by `height`. */
export interface OverviewTarget {
  view: GPUTextureView;
  scratch: GPUTexture;
  memberIds: GPUTexture;
  width: number;
  height: number;
}

interface DrawnOverview {
  /** Its index in the layers. */
  layer: number;
  overview: Overview;
  /** Its entity in the descriptor table. */
  entity: number;
  /** The run it falls in: its index among the prepared draws. */
  run: number;
}

/** Overviews of one atlas that take one display, drawn by one prepared draw. */
interface Run {
  atlas: OverviewAtlas;
  display: number;
}

interface OverviewBatch extends MemberBatch {
  blendMode: BlendMode;
}

/** What one caller's renders keep between them. Each caller has its own, as it has its own member draw set. */
export interface OverviewDrawCache {
  renderer: VolumeRenderer | null;
  layers: OverviewLayers | null;
  layoutKey: string | null;
  drawn: DrawnOverview[];
  runs: Run[];
  descriptors: GPUBuffer | null;
  placeKey: string | null;
  batches: OverviewBatch[];
}

export function createOverviewDrawCache(): OverviewDrawCache {
  return { renderer: null, layers: null, layoutKey: null, drawn: [], runs: [], descriptors: null, placeKey: null, batches: [] };
}

/** Forget what the cache keeps, as when the device that held it is gone. */
export function resetOverviewDrawCache(cache: OverviewDrawCache): void {
  Object.assign(cache, createOverviewDrawCache());
}

/**
 * Draw `layers`' overviews into `target.view`, clearing it under the first
 * batch, each through the display its layer names. Returns how many had an
 * overview to draw.
 */
export function drawOverviews(
  ctx: WorkerCtx,
  cache: OverviewDrawCache,
  setName: string,
  layers: OverviewLayers,
  displays: ReadonlyArray<OverviewDisplay | null>,
  camera: OverviewCamera,
  target: OverviewTarget,
  encoder: GPUCommandEncoder,
): number {
  const renderer = ctx.getVolumeRenderer();
  const atlases = ctx.state.minimap.atlases;
  const layoutKey = `${atlases.version}|${displays.map((display) => (display ? 1 : 0)).join("")}`;
  if (cache.renderer !== renderer || cache.layers !== layers || cache.layoutKey !== layoutKey) {
    layOut(ctx, cache, setName, layers, displays);
    cache.renderer = renderer;
    cache.layers = layers;
    cache.layoutKey = layoutKey;
    cache.placeKey = null;
  }
  if (cache.drawn.length === 0) return 0;

  const { width, height } = target;
  const placeKey = `${width}x${height}|${camera.viewProj.join(",")}|${displays.map((display) => display?.blendMode).join(",")}`;
  if (cache.placeKey !== placeKey) {
    place(renderer, cache, setName, layers, displays, camera.viewProj, width, height);
    cache.placeKey = placeKey;
  }

  renderer.setMatrices(camera.invViewProj, camera.eye);
  renderer.setPixelRatio(camera.pixelRatio);
  renderer.prepareMembers(setName, cache.runs.map(({ atlas, display }): VolumeMemberDraw => {
    const shown = displays[display]!;
    return {
      levels: [overviewBinding(atlas)],
      coarse: null,
      colormap: ctx.getOrCreateLUT(shown.colormap),
      descriptorBuffer: cache.descriptors!,
      entityIndex: 0,
      // Opacity is 1: the minimap shows every layer at full strength.
      display: { contrastMin: shown.contrastMin, contrastMax: shown.contrastMax, gamma: shown.gamma, opacity: 1 },
    };
  }));

  const comp = ctx.getCompositor();
  const scratchView = target.scratch.createView();
  const depthView = renderer.transientDepthView(width, height);
  cache.batches.forEach((batch, i) => {
    renderer.renderMemberBatch(setName, batch, scratchView, target.memberIds, depthView, true, encoder);
    comp.composite(target.view, [{ view: scratchView, blendMode: batch.blendMode }], encoder, i === 0);
  });
  return cache.drawn.length;
}

/** Which layers have an overview and a shown display, their descriptors, and the runs they fall in. */
function layOut(
  ctx: WorkerCtx,
  cache: OverviewDrawCache,
  setName: string,
  layers: OverviewLayers,
  displays: ReadonlyArray<OverviewDisplay | null>,
): void {
  const { overviews } = ctx.state.minimap.atlases;
  const runOf = new Map<OverviewAtlas, Map<number, number>>();
  cache.drawn = [];
  cache.runs = [];
  layers.keys.forEach((key, layer) => {
    const display = layers.displays[layer];
    const overview = overviews.get(key);
    if (!displays[display] || !overview) return;
    let byDisplay = runOf.get(overview.atlas);
    if (!byDisplay) runOf.set(overview.atlas, (byDisplay = new Map()));
    let run = byDisplay.get(display);
    if (run === undefined) {
      run = cache.runs.length;
      byDisplay.set(display, run);
      cache.runs.push({ atlas: overview.atlas, display });
    }
    cache.drawn.push({ layer, overview, entity: cache.drawn.length, run });
  });
  cache.descriptors = ctx.getVolumeRenderer().writeDescriptorTable(setName, cache.drawn.map(({ layer, overview }) => ({
    modelMatrix: layers.matrices.subarray(layer * 32, layer * 32 + 16),
    invModelMatrix: layers.matrices.subarray(layer * 32 + 16, layer * 32 + 32),
    volumeDims: overview.levelDims,
    // The batch draw's display stands in for these.
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    sampleFormat: overview.atlas.format,
    chunkGrid: {
      gridDims: [overview.grid.x, overview.grid.y, overview.grid.z],
      chunkDims: overview.atlas.slotDims,
      indirectionOffset: overview.offset,
    },
  })));
}

/** Each drawn overview's rect, the batches they fall in, and the instances each batch draws. */
function place(
  renderer: VolumeRenderer,
  cache: OverviewDrawCache,
  setName: string,
  layers: OverviewLayers,
  displays: ReadonlyArray<OverviewDisplay | null>,
  viewProj: Float32Array,
  width: number,
  height: number,
): void {
  // An overview off the target draws nothing, as its rays would miss.
  const rects: PixelRect[] = cache.drawn.map(({ layer }) =>
    computeScissorRect(layers.matrices.subarray(layer * 32, layer * 32 + 16), viewProj, width, height) ?? [0, 0, 0, 0]);
  const batches = batchLayers(
    cache.drawn.map(({ layer }, i) => ({ rect: rects[i], blendMode: displays[layers.displays[layer]]!.blendMode })),
    width,
    height,
  );
  const instances: MemberInstance[] = [];
  cache.batches = batches.map(({ layers: members, blendMode }) => {
    const first = instances.length;
    const draws: number[] = [];
    let left = width;
    let top = height;
    let right = 0;
    let bottom = 0;
    for (const at of members) {
      const { entity, run } = cache.drawn[at];
      const rect = rects[at];
      instances.push({ entityIndex: entity, draw: run, rect });
      if (!draws.includes(run)) draws.push(run);
      const [x, y, w, h] = rect;
      if (w <= 0 || h <= 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + w);
      bottom = Math.max(bottom, y + h);
    }
    const bounds: PixelRect = right > left && bottom > top ? [left, top, right - left, bottom - top] : [0, 0, 0, 0];
    return { first, count: members.length, draws, bounds, blendMode };
  });
  renderer.setMemberInstances(setName, instances, width, height);
}
