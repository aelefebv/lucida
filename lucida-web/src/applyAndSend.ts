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
