/**
 * Four-up's planes where they cross a view, as the scene lays them out: in
 * a slice view a line for each plane whose axis it draws, in the volume each
 * plane's outline over the data.
 */
import type { WasmScene } from "lucida-core";
import { isCaptureSurface } from "../captureSurface.ts";
import type { SpatialAxis } from "../renderer/slicePlane.ts";

export interface PlaneLine {
  /** The axis the plane stands at a place along. */
  readonly axis: SpatialAxis;
  /** The segment's ends, as fractions of the view's width and height from its top left. */
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

const NO_LINES: readonly PlaneLine[] = [];

/** Where four-up's planes cross `view`; none in any other layout. */
export function readPlaneLines(scene: Pick<WasmScene, "plane_lines">, view: number): readonly PlaneLine[] {
  const lines = JSON.parse(scene.plane_lines(view)) as PlaneLine[];
  return lines.length > 0 ? lines : NO_LINES;
}

/**
 * The query parameter a capture sets to `1` to draw the plane lines, which
 * the capture surface otherwise leaves out with everything over the canvas.
 */
export const PLANE_LINES_PARAM = "plane_lines";

/** Whether this page is a capture that asked for the plane lines. */
export function planeLinesCaptured(search?: string): boolean {
  const raw = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return isCaptureSurface(raw) && new URLSearchParams(raw).get(PLANE_LINES_PARAM) === "1";
}

/** Whether `line` spans its view top to bottom, so a drag moves it across. */
export function isUpright(line: PlaneLine): boolean {
  return line.from[0] === line.to[0];
}
