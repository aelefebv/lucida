/**
 * What each view draws with on the worker, sized to that view's own pixels:
 * the layer targets its passes composite, the depth its volume pass writes,
 * and, for a view that covers part of the canvas, the frame it keeps until
 * the views are presented together. Views of different sizes never resize
 * each other's, and a view's resources go when the view does.
 *
 * Every byte counts against the page's one GPU budget through the ledger.
 * The member bind groups each of a view's slice group passes keeps hold no
 * memory of their own, and go with the view too.
 */

import type { WorkerCtx } from "../workerContext.ts";
import { createOffscreenTarget } from "../gpuContext.ts";
import { allocateWatched } from "./gpuErrors.ts";
import { handleGpuOutOfMemory } from "./gpuBudget.ts";
import { setGpuLedgerLine } from "./gpuLedger.ts";
import { MemberBindGroups } from "../sliceRenderer.ts";

/** Bytes one `rgba16float` layer-target texel holds. */
export const OFFSCREEN_BYTES_PER_TEXEL = 8;
/** `depth24plus` is stored in four bytes a texel on every backend. */
const DEPTH_BYTES_PER_TEXEL = 4;
/** The canvas formats, `bgra8unorm` or `rgba8unorm`, hold four bytes a texel. */
const FRAME_BYTES_PER_TEXEL = 4;

export interface ViewResources {
  layers: GPUTexture[];
  layersW: number;
  layersH: number;
  depth: GPUTexture | null;
  /** The frame of a view that covers part of the canvas, kept between presents. */
  frame: GPUTexture | null;
  /** Per drawn group, as `layers` is indexed, the member bind groups its slice pass kept. */
  memberGroups: MemberBindGroups[];
}

function resourcesOf(ctx: WorkerCtx, view: number): ViewResources {
  let held = ctx.state.viewResources.get(view);
  if (!held) {
    held = { layers: [], layersW: 0, layersH: 0, depth: null, frame: null, memberGroups: [] };
    ctx.state.viewResources.set(view, held);
  }
  return held;
}

function noteViewBytes(ctx: WorkerCtx): void {
  let layers = 0;
  let depth = 0;
  let frames = 0;
  for (const held of ctx.state.viewResources.values()) {
    layers += held.layers.length * held.layersW * held.layersH * OFFSCREEN_BYTES_PER_TEXEL;
    if (held.depth) depth += held.depth.width * held.depth.height * DEPTH_BYTES_PER_TEXEL;
    if (held.frame) frames += held.frame.width * held.frame.height * FRAME_BYTES_PER_TEXEL;
  }
  setGpuLedgerLine("viewportTargets", layers);
  setGpuLedgerLine("depth", depth);
  setGpuLedgerLine("viewFrames", frames);
}

/**
 * At least `count` layer targets of `w`×`h` for `view`, rebuilt when its size
 * changes. A target the device can't allocate leaves them, so the next frame
 * makes it again under the halved total.
 */
export function viewLayerTargets(ctx: WorkerCtx, view: number, count: number, w: number, h: number): GPUTexture[] {
  const held = resourcesOf(ctx, view);
  if (w !== held.layersW || h !== held.layersH) {
    for (const texture of held.layers) texture.destroy();
    held.layers = [];
    held.layersW = w;
    held.layersH = h;
  }
  while (held.layers.length < count) {
    held.layers.push(allocateWatched(
      ctx,
      () => createOffscreenTarget(ctx.device, w, h),
      (lost) => {
        const at = held.layers.indexOf(lost);
        if (at >= 0) {
          held.layers.splice(at, 1);
          lost.destroy();
          noteViewBytes(ctx);
        }
        handleGpuOutOfMemory(ctx);
      },
    ));
  }
  noteViewBytes(ctx);
  return held.layers;
}

/**
 * Free `view`'s layer targets past the first `count`, which its frame just
 * drawn did not use, and the member bind groups kept for the groups past them.
 */
export function trimViewLayerTargets(ctx: WorkerCtx, view: number, count: number): void {
  const held = ctx.state.viewResources.get(view);
  if (!held) return;
  held.memberGroups.splice(count);
  if (held.layers.length <= count) return;
  for (const texture of held.layers.splice(count)) texture.destroy();
  noteViewBytes(ctx);
}

/**
 * The member bind groups the slice pass of `view`'s `index`th drawn group
 * keeps from frame to frame. A pass that takes another group's place, as
 * when a group before it stops drawing, finds that group's and makes its own.
 */
export function viewMemberBindGroups(ctx: WorkerCtx, view: number, index: number): MemberBindGroups {
  const held = resourcesOf(ctx, view);
  while (held.memberGroups.length <= index) held.memberGroups.push(new MemberBindGroups());
  return held.memberGroups[index];
}

/** `view`'s depth at `w`×`h`, which its volume pass writes and its cursors test against. */
export function viewDepth(ctx: WorkerCtx, view: number, w: number, h: number): GPUTexture {
  const held = resourcesOf(ctx, view);
  if (held.depth && held.depth.width === w && held.depth.height === h) return held.depth;
  held.depth?.destroy();
  held.depth = ctx.device.createTexture({
    size: [w, h],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  noteViewBytes(ctx);
  return held.depth;
}

/** The depth `view` last drew with, if any. */
export function heldViewDepth(ctx: WorkerCtx, view: number): GPUTexture | null {
  return ctx.state.viewResources.get(view)?.depth ?? null;
}

/** The frame `view` keeps at `w`×`h` in the canvas's format, while its size holds. */
export function viewFrameTarget(ctx: WorkerCtx, view: number, w: number, h: number): GPUTexture {
  const held = resourcesOf(ctx, view);
  const kept = held.frame;
  if (kept && kept.width === w && kept.height === h && kept.format === ctx.format) return kept;
  kept?.destroy();
  held.frame = ctx.device.createTexture({
    size: [w, h],
    format: ctx.format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  noteViewBytes(ctx);
  return held.frame;
}

/** The frame `view` keeps, if it has drawn one. */
export function heldViewFrame(ctx: WorkerCtx, view: number): GPUTexture | null {
  return ctx.state.viewResources.get(view)?.frame ?? null;
}

/** Let a view that now covers the canvas go of the frame it kept while it covered part. */
export function dropViewFrame(ctx: WorkerCtx, view: number): void {
  const held = ctx.state.viewResources.get(view);
  if (!held?.frame) return;
  held.frame.destroy();
  held.frame = null;
  noteViewBytes(ctx);
}

function destroyResources(held: ViewResources): void {
  for (const texture of held.layers) texture.destroy();
  held.depth?.destroy();
  held.frame?.destroy();
}

/** Free the resources of every view but those in `keep`, the views the page still has. */
export function releaseViewsBut(ctx: WorkerCtx, keep: ReadonlySet<number>): void {
  let released = false;
  for (const [view, held] of ctx.state.viewResources) {
    if (keep.has(view)) continue;
    destroyResources(held);
    ctx.state.viewResources.delete(view);
    ctx.state.lastFrames.delete(view);
    released = true;
  }
  if (released) noteViewBytes(ctx);
}

/** Free every view's resources, as the device goes. */
export function releaseAllViewResources(ctx: WorkerCtx): void {
  for (const held of ctx.state.viewResources.values()) destroyResources(held);
  ctx.state.viewResources.clear();
  noteViewBytes(ctx);
}
