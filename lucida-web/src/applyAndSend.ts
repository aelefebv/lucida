import type { WasmScene } from "lucida-core";
import type { DocumentCommand, ViewportCommand } from "./commands.ts";
import { bumpSettingsGeneration } from "./tickCommon.ts";
import { guardedSceneCall } from "./sceneGuard.ts";

/** Apply a document command locally and send it to the server. The local
 * apply is guarded so an engine failure surfaces even in a solo session
 * (see `sceneGuard.ts`); on failure nothing is sent and the error
 * propagates to the caller as before. */
export function applyDocumentCommand(
  scene: WasmScene,
  cmd: DocumentCommand,
  sendCommand: (json: string) => void,
) {
  const json = JSON.stringify(cmd);
  guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
  bumpSettingsGeneration();
  sendCommand(json);
}

/** Apply a viewport/display command locally only (not sent to server). */
export function applyViewportCommand(scene: WasmScene, cmd: ViewportCommand) {
  const json = JSON.stringify(cmd);
  guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
}
