/**
 * Event, world, and screen conversions for the live viewer camera, shared by
 * the viewers, peer cursors, and both annotation overlays.
 *
 * 2D: the camera is `zoom` and `center` in physical pixels against the canvas
 * midpoint; {@link eventToWorld} and {@link makeWorldToScreen} are exact
 * inverses. The 2D world is the scene frame every dataset is placed in, and a
 * pin is stored in its own dataset's frame, so pins go through the dataset's
 * placement ({@link eventToFrame}, {@link makeFrameToScreen}). 3D: projection
 * lives in WASM (`scene.project_annotation`) so it uses the same transform as
 * the volume pass.
 */
import type { WasmScene } from "lucida-core";
import { frameToScene, readPlacement, sceneToFrame } from "../placement.ts";
import type { ScreenPoint } from "./annotationGeometry.ts";

/** The x/y of a pointer event, so plain objects and React events both qualify. */
export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/** A pointer event in physical-pixel canvas coords, the space the WASM viewport
 * uses. */
export function eventToScreenPx(canvas: HTMLCanvasElement, e: ClientPoint): [number, number] {
  const dpr = devicePixelRatio;
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
}

/** A pointer event in 2D world coords: `(screenPhysPx - half) / zoom + center`.
 * Every cursor-anchored producer uses it so all land in the same world frame. */
export function eventToWorld(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
  e: ClientPoint,
): [number, number] {
  const dpr = devicePixelRatio;
  const [cursorX, cursorY] = eventToScreenPx(canvas, e);
  const zoom = scene.zoom();
  const center = scene.center();
  const halfW = (canvas.clientWidth * dpr) / 2;
  const halfH = (canvas.clientHeight * dpr) / 2;
  return [(cursorX - halfW) / zoom + center[0], (cursorY - halfH) / zoom + center[1]];
}

/**
 * Snapshot the 2D camera and return a world-to-CSS-px projector, the inverse of
 * {@link eventToWorld}. Call once per frame so every vertex sees one camera.
 */
export function makeWorldToScreen(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
): (v: ScreenPoint) => ScreenPoint {
  const dpr = devicePixelRatio;
  const physW = Math.round(canvas.clientWidth * dpr);
  const physH = Math.round(canvas.clientHeight * dpr);
  const zoom = scene.zoom();
  const center = scene.center();
  const centerX = center[0];
  const centerY = center[1];
  return (v: ScreenPoint): ScreenPoint => [
    ((v[0] - centerX) * zoom + physW / 2) / dpr,
    ((v[1] - centerY) * zoom + physH / 2) / dpr,
  ];
}

/** A pointer event in `datasetId`'s frame, where its pins are stored. */
export function eventToFrame(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
  e: ClientPoint,
  datasetId: string,
): [number, number] {
  return sceneToFrame(readPlacement(scene, datasetId), eventToWorld(scene, canvas, e));
}

/**
 * {@link makeWorldToScreen} for points in `datasetId`'s frame, the inverse of
 * {@link eventToFrame}. Call once per frame, as it snapshots the placement too.
 */
export function makeFrameToScreen(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
  datasetId: string,
): (v: ScreenPoint) => ScreenPoint {
  const project = makeWorldToScreen(scene, canvas);
  const placement = readPlacement(scene, datasetId);
  return (v: ScreenPoint): ScreenPoint => project(frameToScene(placement, v));
}

/**
 * The 3D per-vertex projection to CSS px via `scene.project_annotation`. `null`
 * means behind the camera or no anchorable member; the caller hides the marker.
 */
export function makeProjectAnnotationToCss(
  scene: WasmScene,
  datasetId: string,
): (v: ScreenPoint, z: number) => ScreenPoint | null {
  const dpr = devicePixelRatio;
  return (v: ScreenPoint, z: number): ScreenPoint | null => {
    const proj = scene.project_annotation(datasetId, v[0], v[1], z);
    return proj.length < 2 ? null : [proj[0] / dpr, proj[1] / dpr];
  };
}
