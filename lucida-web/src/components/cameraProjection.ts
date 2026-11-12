/**
 * Event, world, and screen conversions for the live viewer camera, shared by
 * the viewers, peer cursors, and both annotation overlays.
 *
 * Each conversion is for one view, in the element laid over its rectangle of
 * the canvas ({@link ViewSurface}).
 *
 * 2D: the camera is `zoom` and `center` in physical pixels against the view's
 * midpoint; {@link eventToWorld} and {@link makeWorldToScreen} are exact
 * inverses. The 2D world is the scene frame every dataset is placed in, seen
 * across and down the plane the view cuts. A mark is stored in its own
 * dataset's frame, so it goes through the dataset's placement onto that plane
 * ({@link makeFrameToScreen}). Picking a mark's point, in 2D and 3D, and the
 * 3D projection live in WASM (`scene.pick_annotation_voxel`,
 * `scene.project_annotation`), so they use the same transforms as the passes
 * that draw the data.
 */
import type { WasmScene } from "lucida-core";
import { placePoint, readPlacement } from "../placement.ts";
import { planeAxes, xyz, type SlicePlane } from "../renderer/slicePlane.ts";
import type { FramePoint, ScreenPoint } from "./annotationGeometry.ts";

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

/**
 * The point of `datasetId`'s frame a mark placed at `e` in `surface`'s view
 * takes (`scene.pick_annotation_voxel`): on a slice view's plane, in the
 * middle of the dataset's plane there, or where a volume view's ray meets the
 * volume. Null where there is none.
 */
export function pickFramePoint(
  scene: Pick<WasmScene, "pick_annotation_voxel">,
  { view, element }: ViewSurface,
  datasetId: string,
  e: ClientPoint,
): FramePoint | null {
  const [x, y] = eventToScreenPx(element, e);
  const point = scene.pick_annotation_voxel(view, datasetId, x, y);
  return point.length < 3 ? null : [point[0], point[1], point[2]];
}

/** The plane `surface`'s slice view cuts. */
export function viewPlane(scene: Pick<WasmScene, "slice_plane">, { view }: ViewSurface): SlicePlane {
  return scene.slice_plane(view) as SlicePlane;
}

/**
 * {@link makeWorldToScreen} for points in `datasetId`'s frame, placed as the
 * dataset is and seen across and down the plane the view cuts, the inverse of
 * {@link pickFramePoint} there. Call once per frame, as it snapshots the
 * placement too.
 */
export function makeFrameToScreen(
  scene: WasmScene,
  surface: ViewSurface,
  datasetId: string,
): (v: FramePoint) => ScreenPoint {
  const project = makeWorldToScreen(scene, surface);
  const placement = readPlacement(scene, datasetId);
  const [across, down] = planeAxes(viewPlane(scene, surface)).map(xyz);
  return (v: FramePoint): ScreenPoint => {
    const point = placePoint(placement, v);
    return project([point[across], point[down]]);
  };
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
): (v: FramePoint) => ScreenPoint | null {
  const dpr = devicePixelRatio;
  return (v: FramePoint): ScreenPoint | null => {
    const proj = scene.project_annotation(view, datasetId, v[0], v[1], v[2]);
    return proj.length < 2 ? null : [proj[0] / dpr, proj[1] / dpr];
  };
}

/**
 * `make` for each dataset, called once on its first use. A view draws the
 * marks of several datasets, each placed its own way, so a frame snapshots
 * each one's projection once and shares it among its marks.
 */
export function perDataset<T>(make: (datasetId: string) => T): (datasetId: string) => T {
  const made = new Map<string, T>();
  return (datasetId) => {
    if (!made.has(datasetId)) made.set(datasetId, make(datasetId));
    return made.get(datasetId) as T;
  };
}
