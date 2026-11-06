import type { WasmScene } from "lucida-core";
import { applyViewportCommand } from "../applyAndSend.ts";
import type { VoxelRect } from "../pipeline/layoutBuilders.ts";

/**
 * Slack around a framed group: lucida-core's `FIT_MARGIN_2D`, so a group fills
 * the view the way a freshly opened dataset does.
 */
export const GROUP_FIT_MARGIN = 1.15;

/** The smallest rectangle containing every non-null rect, or null if none. */
export function unionRects(rects: Iterable<VoxelRect | null>): VoxelRect | null {
  let out: VoxelRect | null = null;
  for (const r of rects) {
    if (!r) continue;
    out = out
      ? {
          min: [Math.min(out.min[0], r.min[0]), Math.min(out.min[1], r.min[1])],
          max: [Math.max(out.max[0], r.max[0]), Math.max(out.max[1], r.max[1])],
        }
      : { min: [r.min[0], r.min[1]], max: [r.max[0], r.max[1]] };
  }
  return out;
}

/**
 * The slice-camera center and zoom that show all of `rect` with `margin` slack
 * on the limiting axis, as lucida-core's `slice_framing` computes them. The
 * camera's zoom is device pixels per voxel, so `viewportPx` must be in device
 * pixels for the fit to hold at every devicePixelRatio. Null when the viewport
 * has no area, since no zoom fits it.
 */
export function fitRectToViewport(
  rect: VoxelRect,
  viewportPx: [number, number],
  margin: number = GROUP_FIT_MARGIN,
): { center: [number, number]; zoom: number } | null {
  const [vw, vh] = viewportPx;
  if (!(vw > 0 && vh > 0)) return null;
  const center: [number, number] = [
    (rect.min[0] + rect.max[0]) / 2,
    (rect.min[1] + rect.max[1]) / 2,
  ];
  // A zero-width or zero-height rect fits on its other axis; the floor keeps
  // the divide finite.
  const width = Math.max(rect.max[0] - rect.min[0], 1e-9);
  const height = Math.max(rect.max[1] - rect.min[1], 1e-9);
  const m = Math.max(margin, 1);
  const zoom = Math.min(vw / (m * width), vh / (m * height));
  return { center, zoom };
}

/** Center and zoom the slice camera so `rect` fits the canvas. */
export function frameRect(scene: WasmScene, canvas: HTMLCanvasElement, rect: VoxelRect): void {
  const dpr = devicePixelRatio;
  const fit = fitRectToViewport(rect, [
    Math.round(canvas.clientWidth * dpr),
    Math.round(canvas.clientHeight * dpr),
  ]);
  if (!fit) return;
  applyViewportCommand(scene, { type: "set_zoom", value: fit.zoom });
  applyViewportCommand(scene, { type: "set_center", x: fit.center[0], y: fit.center[1] });
}
