/**
 * The event↔world↔screen conversions for the live viewer camera — one home for
 * the coordinate math every canvas-adjacent surface shares (SliceViewer,
 * VolumeViewer, PeerCursors, and both annotation overlays).
 *
 * 2D (slice camera): the persisted/shared camera is `zoom` + `center`, in
 * logical CSS pixels against the canvas midpoint. {@link eventToWorld} is the inverse projection
 * (pointer event → in-plane world point) and {@link makeWorldToScreen} the
 * forward one (world point → CSS px), snapshotting the camera once so a RAF
 * tick can project many vertices per frame against a consistent camera. The
 * two are exact inverses: `world = (screenCssPx − halfCss)/zoom + center`
 * vs `cssPx = (world − center)·zoom + halfCss`. Device-pixel ratio is a
 * render-boundary concern and must not change shared camera geometry.
 *
 * 3D (volume camera): the world→screen lift lives in WASM —
 * `scene.project_annotation` raises a stored in-plane-voxel + voxel-depth
 * point to world through the SAME rendering transform the volume pass uses,
 * then projects with the active camera. {@link makeProjectAnnotationToCss}
 * wraps it per frame (physical px → CSS px; empty result = behind the camera).
 * The inverse (screen → voxel) is `scene.pick_annotation_voxel`, fed physical
 * coords from {@link eventToScreenPx}. The matrix-based 3D projection for
 * points that already carry explicit world coordinates (peer cursors, minimap
 * frusta) is `projectToCanvas` in `minimapMath.ts`.
 */
import type { WasmScene } from "lucida-core";
import type { ScreenPoint } from "./annotationGeometry.ts";

/** The x/y of a pointer event — all a projection needs, so plain objects and
 * React synthetic events both qualify. */
export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/** Convert a pointer event to PHYSICAL-pixel screen coords relative to the
 * canvas — the coordinate space the WASM viewport uses (`pick_annotation_voxel`,
 * `project_to_screen`). */
export function eventToScreenPx(canvas: HTMLCanvasElement, e: ClientPoint): [number, number] {
  const dpr = devicePixelRatio;
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
}

/** Convert a pointer event to 2D world coords — the inverse of the slice
 * camera (`world = (screenPhysPx − half)/zoom + center`). Reused by every
 * producer that anchors something at the cursor (pin drop, pin move, handle
 * reshape, cursor presence), so all of them land in the SAME world frame
 * regardless of pan/zoom. */
export function eventToWorld(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
  e: ClientPoint,
): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const cursorX = e.clientX - rect.left;
  const cursorY = e.clientY - rect.top;
  const zoom = scene.zoom();
  const center = scene.center();
  const halfW = canvas.clientWidth / 2;
  const halfH = canvas.clientHeight / 2;
  return [(cursorX - halfW) / zoom + center[0], (cursorY - halfH) / zoom + center[1]];
}

/** Center a 2D camera after zoom so a world point remains under one CSS pointer. */
export function centerForWorldAnchor(
  canvas: HTMLCanvasElement,
  e: ClientPoint,
  worldAnchor: ScreenPoint,
  newZoom: number,
): ScreenPoint {
  const rect = canvas.getBoundingClientRect();
  const cursorX = e.clientX - rect.left;
  const cursorY = e.clientY - rect.top;
  return [
    worldAnchor[0] - (cursorX - canvas.clientWidth / 2) / newZoom,
    worldAnchor[1] - (cursorY - canvas.clientHeight / 2) / newZoom,
  ];
}

/**
 * Snapshot the 2D slice camera and return the world→screen projector (CSS px)
 * for this frame — the exact inverse of {@link eventToWorld}. A RAF tick calls
 * this once per frame, then projects every marker/vertex through the returned
 * function, so all of them see one consistent camera even if the scene moves
 * mid-frame.
 */
export function makeWorldToScreen(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
): (v: ScreenPoint) => ScreenPoint {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const zoom = scene.zoom();
  const center = scene.center();
  const centerX = center[0];
  const centerY = center[1];
  return (v: ScreenPoint): ScreenPoint => [
    (v[0] - centerX) * zoom + cssW / 2,
    (v[1] - centerY) * zoom + cssH / 2,
  ];
}

/**
 * The 3D per-vertex marker projection for one frame: lift an in-plane voxel
 * point (+ shared depth `z`) to world and project it with the active volume
 * camera via `scene.project_annotation`, converting the returned physical
 * pixels to CSS px. `null` means the vertex is behind the camera (or the
 * dataset has no anchorable member) — the caller hides that marker/shape.
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
