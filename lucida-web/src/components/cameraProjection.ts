/**
 * Event, world, and screen conversions for the live viewer camera, shared by
 * the viewers, peer cursors, and both annotation overlays.
 *
 * Each conversion is for one view, in the element laid over its rectangle of
 * the canvas ({@link ViewSurface}).
 *
 * 2D: the camera is `zoom` and `center` in physical pixels against the view's
 * midpoint; {@link eventToWorld} and {@link makeWorldToScreen} are exact
 * inverses. The 2D world is the scene frame every dataset is placed in, and a
 * pin is stored in its own dataset's frame, so pins go through the dataset's
 * placement ({@link eventToFrame}, {@link makeFrameToScreen}). 3D: projection
 * lives in WASM (`scene.project_annotation`) so it uses the same transform as
 * the volume pass.
 */
import type { WasmScene } from "lucida-core";
import { frameToScene, readPlaneMap, sceneToFrame } from "../placement.ts";
import type { ScreenPoint } from "./annotationGeometry.ts";

/** The x/y of a pointer event, so plain objects and React events both qualify. */
export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/** A view as the page shows it: the scene's view, and the element laid over its rectangle of the canvas. */
export interface ViewSurface {
  view: number;
  element: HTMLElement;
}

/** A pointer event in physical pixels from `element`'s corner, the space a
 * view's camera uses when the element covers the view. */
export function eventToScreenPx(element: HTMLElement, e: ClientPoint): [number, number] {
  const dpr = devicePixelRatio;
  const rect = element.getBoundingClientRect();
  return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
}

/** A pointer event as fractions of `element`'s width and height from its
 * corner, the form the core takes a point on a view in, whatever the pixel
 * ratio. */
export function eventToViewFraction(element: HTMLElement, e: ClientPoint): [number, number] {
  const rect = element.getBoundingClientRect();
  return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
}

/** A pointer event in 2D world coords: `(screenPhysPx - half) / zoom + center`,
 * across and down the plane, which a transposed view turns on the screen.
 * Every cursor-anchored producer uses it so all land in the same world frame. */
export function eventToWorld(
  scene: WasmScene,
  { view, element }: ViewSurface,
  e: ClientPoint,
): [number, number] {
  const dpr = devicePixelRatio;
  const [cursorX, cursorY] = eventToScreenPx(element, e);
  const zoom = scene.zoom(view);
  const center = scene.center(view);
  const halfW = (element.clientWidth * dpr) / 2;
  const halfH = (element.clientHeight * dpr) / 2;
  const across = (cursorX - halfW) / zoom;
  const down = (cursorY - halfH) / zoom;
  return scene.transposed(view)
    ? [down + center[0], across + center[1]]
    : [across + center[0], down + center[1]];
}

/**
 * Snapshot the 2D camera and return a world-to-CSS-px projector, the inverse of
 * {@link eventToWorld}. Call once per frame so every vertex sees one camera.
 */
export function makeWorldToScreen(
  scene: WasmScene,
  { view, element }: ViewSurface,
): (v: ScreenPoint) => ScreenPoint {
  const dpr = devicePixelRatio;
  const physW = Math.round(element.clientWidth * dpr);
  const physH = Math.round(element.clientHeight * dpr);
  const zoom = scene.zoom(view);
  const center = scene.center(view);
  const centerX = center[0];
  const centerY = center[1];
  if (scene.transposed(view)) {
    return (v: ScreenPoint): ScreenPoint => [
      ((v[1] - centerY) * zoom + physW / 2) / dpr,
      ((v[0] - centerX) * zoom + physH / 2) / dpr,
    ];
  }
  return (v: ScreenPoint): ScreenPoint => [
    ((v[0] - centerX) * zoom + physW / 2) / dpr,
    ((v[1] - centerY) * zoom + physH / 2) / dpr,
  ];
}

/** A pointer event in `datasetId`'s frame, where its pins are stored. */
export function eventToFrame(
  scene: WasmScene,
  surface: ViewSurface,
  e: ClientPoint,
  datasetId: string,
): [number, number] {
  return sceneToFrame(readPlaneMap(scene, datasetId), eventToWorld(scene, surface, e));
}

/**
 * {@link makeWorldToScreen} for points in `datasetId`'s frame, the inverse of
 * {@link eventToFrame}. Call once per frame, as it snapshots the placement too.
 */
export function makeFrameToScreen(
  scene: WasmScene,
  surface: ViewSurface,
  datasetId: string,
): (v: ScreenPoint) => ScreenPoint {
  const project = makeWorldToScreen(scene, surface);
  const placement = readPlaneMap(scene, datasetId);
  return (v: ScreenPoint): ScreenPoint => project(frameToScene(placement, v));
}

/**
 * The 3D per-vertex projection through `view`'s camera to CSS px from its
 * pane's corner, via `scene.project_annotation`. `null` means behind the
 * camera or no anchorable member; the caller hides the marker.
 */
export function makeProjectAnnotationToCss(
  scene: WasmScene,
  view: number,
  datasetId: string,
): (v: ScreenPoint, z: number) => ScreenPoint | null {
  const dpr = devicePixelRatio;
  return (v: ScreenPoint, z: number): ScreenPoint | null => {
    const proj = scene.project_annotation(view, datasetId, v[0], v[1], z);
    return proj.length < 2 ? null : [proj[0] / dpr, proj[1] / dpr];
  };
}
