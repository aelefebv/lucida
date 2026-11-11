/**
 * One tick of every view: the datasets they draw are planned together, their
 * chunks go to the worker for the pools of each mode that wants them, and
 * each view is drawn in its own mode.
 *
 * A lone view across the canvas draws straight onto it. Views that divide
 * the canvas each draw into a frame of their own, which the worker keeps, and
 * one present lands every view's frame. A frame for a camera move alone
 * redraws only the views whose camera moved.
 */

import { assertCanvasSize } from "./applyAndSend.ts";
import type { MinimapChunkCoord, TickCoordinator, TickCoordinatorResult } from "./pipeline/tickCoordinator.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import { drawnView, type TickContext, type TickView } from "./renderLoopTypes.ts";
import { readResolvedLayers } from "./resolvedLayers.ts";
import { renderSliceView, scaleRect, sliceFrameScale } from "./slicePath.ts";
import { renderVolumeView, volumeFrameScale } from "./volumePath.ts";

/**
 * Plan, deliver and draw. Returns true when chunks are left to deliver, so
 * the caller schedules another tick.
 */
export function tickViews(
  ctx: TickContext,
  coordinator: TickCoordinator,
  uploader: Uploader,
  minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  redraws: ViewRedraws,
  frame: { render: boolean; newChunks: boolean },
): boolean {
  const { scene, canvas } = ctx;
  const dpr = devicePixelRatio;
  assertCanvasSize(scene, Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr), dpr);

  const plan = coordinator.planAndFetch(ctx, minimapPendingFetch);
  if (!plan) return false;
  const backlogged = deliver(ctx, coordinator, uploader);
  if (!frame.render) return backlogged;
  if (ctx.views.length === 1) drawOnlyView(ctx, plan, ctx.views[0]);
  else drawViews(ctx, plan, redraws.select(ctx, frame.newChunks));
  return backlogged;
}

/** Deliver decoded chunks, unless a short volume view's move holds them. */
function deliver(ctx: TickContext, coordinator: TickCoordinator, uploader: Uploader): boolean {
  // Read after the plan, which notes whether the view moved.
  if (drawnView(ctx).mode === "volume" && coordinator.msUntilUploadsResume(performance.now()) !== null) {
    uploader.holdDelivery();
    return false;
  }
  return uploader.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES);
}

/** The one view across the canvas, which draws straight onto it. */
function drawOnlyView(ctx: TickContext, plan: TickCoordinatorResult, view: TickView): void {
  // The view draws the layers its plan resolved, which a coalesced tick keeps
  // from the plan before.
  if (view.mode === "slice") {
    const frame = sliceFrameScale(ctx);
    ctx.client.resize(frame.canvasW, frame.canvasH);
    renderSliceView(ctx, plan, plan.layers, view, frame);
  } else {
    renderVolumeView(ctx, plan, plan.layers, view, volumeFrameScale(ctx));
  }
}

/**
 * Views that divide the canvas: each one in `redrawn` draws its frame at its
 * own scale, then one present lands every view's frame on the canvas at full
 * resolution.
 */
function drawViews(ctx: TickContext, plan: TickCoordinatorResult, redrawn: readonly TickView[]): void {
  const slice = sliceFrameScale(ctx);
  for (const view of redrawn) {
    const layers = readResolvedLayers(ctx.scene, view.id);
    if (view.mode === "slice") renderSliceView(ctx, plan, layers, view, slice);
    else renderVolumeView(ctx, plan, layers, view, volumeFrameScale(ctx));
  }
  ctx.client.presentViews(
    slice.canvasW,
    slice.canvasH,
    ctx.views.map((view) => ({ view: view.id, rect: scaleRect(view.rect, slice.scale) })),
  );
}

/**
 * Which views a frame redraws. A frame for a camera move alone redraws the
 * views whose camera, rectangle or mode moved since each last drew, and the
 * rest keep the frames the worker holds. Any other frame, for new chunks or a
 * change to what the views show, redraws every view.
 */
export class ViewRedraws {
  private drawnAs = new Map<number, string>();
  private shown = "";

  /** The views this frame redraws. `newChunks` says chunks landed since the last frame. */
  select(ctx: TickContext, newChunks: boolean): TickView[] {
    // Every epoch but the camera's: what the views show, not where they look.
    const { view: _camera, ...shown } = JSON.parse(ctx.scene.epochs()) as Record<string, number>;
    const shownKey = JSON.stringify(shown);
    const cameraOnly = !newChunks && shownKey === this.shown;
    this.shown = shownKey;
    const redrawn = ctx.views.filter((view) => {
      const pose = poseOf(ctx, view);
      if (cameraOnly && this.drawnAs.get(view.id) === pose) return false;
      this.drawnAs.set(view.id, pose);
      return true;
    });
    for (const id of this.drawnAs.keys()) {
      if (!ctx.views.some((view) => view.id === id)) this.drawnAs.delete(id);
    }
    return redrawn;
  }
}

/** What a view's frame shows of its camera, its rectangle and its mode. */
function poseOf(ctx: TickContext, view: TickView): string {
  const { scene } = ctx;
  const camera = view.mode === "slice"
    ? `${scene.zoom(view.id)}|${scene.center(view.id)}|${scene.slice_plane(view.id)}`
    : `${scene.inv_view_proj(view.id)}|${scene.clip_distance(view.id)}|${scene.clip_mode(view.id)}`;
  return `${view.mode}|${view.rect}|${ctx.renderScale}|${ctx.resolutionScale}|${camera}`;
}
