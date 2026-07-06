import type { WasmScene } from "lucida-core";
import type { DocumentCommand, ViewportCommand } from "./commands.ts";
import { bumpSettingsGeneration } from "./tickCommon.ts";

/** Apply a document command locally and send it to the server. */
export function applyDocumentCommand(
  scene: WasmScene,
  cmd: DocumentCommand,
  sendCommand: (json: string) => void,
) {
  const json = JSON.stringify(cmd);
  scene.apply_command(json);
  bumpSettingsGeneration();
  sendCommand(json);
}

/** Apply a viewport/display command locally only (not sent to server). */
export function applyViewportCommand(scene: WasmScene, cmd: ViewportCommand) {
  const json = JSON.stringify(cmd);
  scene.apply_command(json);
}

