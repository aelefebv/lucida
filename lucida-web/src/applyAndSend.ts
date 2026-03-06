import type { WasmScene } from "lucida-core";

export function applyAndSend(
  scene: WasmScene,
  cmd: Record<string, unknown>,
  sendCommand: (json: string) => void,
) {
  const json = JSON.stringify(cmd);
  scene.apply_command(json);
  sendCommand(json);
}
