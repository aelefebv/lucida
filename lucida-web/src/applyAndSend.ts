import type { WasmScene } from "lucida-core";
import type { DocumentCommand, ViewportCommand } from "./commands.ts";
import { invalidateDisplaySettings, type InvalidationSink } from "./invalidation.ts";
import { noteSceneWrite } from "./sceneStore.ts";
import { guardedSceneCall } from "./sceneGuard.ts";

/** Apply a document command locally and send it to the server. The local
 * apply is guarded so an engine failure surfaces even in a solo session
 * (see `sceneGuard.ts`); on failure nothing is sent and the error
 * propagates to the caller. A caller that holds the render loop passes it
 * so the change is drawn; one that doesn't wakes it some other way. */
export function applyDocumentCommand(
  scene: WasmScene,
  cmd: DocumentCommand,
  sendCommand: (json: string) => void,
  loop?: InvalidationSink | null,
) {
  const json = JSON.stringify(cmd);
  guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
  invalidateDisplaySettings(loop, "document_command");
  sendCommand(json);
}

/** Apply a viewport/display command locally only (not sent to server). */
export function applyViewportCommand(scene: WasmScene, cmd: ViewportCommand) {
  const json = JSON.stringify(cmd);
  guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
  noteSceneWrite();
}

/** Fit everything visible on `canvas`, as the fit key and double tap do. The
 *  canvas's size goes with the call, so the fit frames the canvas the user
 *  sees rather than the last size a render tick told the scene. */
export function frameOnCanvas(scene: WasmScene, canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  guardedSceneCall("frame", scene, () => scene.frame(width, height));
  noteSceneWrite();
}

/** Fit the slice camera to the voxel rect `region` on `canvas`, as a click on
 *  a collection's group does. */
export function frameRegionOnCanvas(
  scene: WasmScene,
  canvas: HTMLCanvasElement,
  region: { min: [number, number]; max: [number, number] },
): void {
  const dpr = window.devicePixelRatio || 1;
  assertCanvasSize(scene, Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr), dpr);
  guardedSceneCall("frame_region", scene, () =>
    scene.frame_region(region.min[0], region.min[1], region.max[0], region.max[1]),
  );
  noteSceneWrite();
}

const assertedSizes = new WeakMap<WasmScene, string>();

/** Tell the scene the canvas's size in device pixels and the pixel ratio
 *  behind it. Every render tick asserts it, and the stores hear of it only
 *  when it changed: a new size can refit a framed camera, and the URL and the
 *  last view must follow the view that leaves. */
export function assertCanvasSize(
  scene: WasmScene,
  width: number,
  height: number,
  pixelRatio: number,
): void {
  scene.set_viewport(width, height, pixelRatio);
  const size = `${width}x${height}@${pixelRatio}`;
  if (assertedSizes.get(scene) === size) return;
  assertedSizes.set(scene, size);
  noteSceneWrite();
}
