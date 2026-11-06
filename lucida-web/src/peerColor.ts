import { peer_palette } from "lucida-core";
import type { ClientId } from "./bridge.ts";

let palette: readonly string[] | null = null;

/**
 * A peer's color as CSS, the one its cursor wears on the canvas. The palette
 * is defined once, in lucida-core, which draws the cursors. Call only after
 * the wasm module is initialized.
 */
export function peerColor(clientId: ClientId): string {
  palette ??= peer_palette();
  return palette[clientId % palette.length];
}
