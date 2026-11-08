/**
 * Per-channel display state for the cold state, one entry per channel the
 * layer shows, from the scene's resolved layer.
 */
import type { ColdStateDisplayState } from "../../../renderer/workerProtocol.ts";
import type { ResolvedLayer } from "../../../resolvedLayers.ts";

export function buildDisplayStateByChannel(
  layer: ResolvedLayer | undefined,
): Record<number, ColdStateDisplayState> {
  const out: Record<number, ColdStateDisplayState> = {};
  for (const ch of layer?.channels ?? []) {
    out[ch.channel] = {
      contrastMin: ch.contrast_min,
      contrastMax: ch.contrast_max,
      gamma: ch.gamma,
      opacity: layer?.opacity ?? 1,
      colormapName: ch.colormap,
      channelMask: 1 << (ch.channel & 31),
      // Intensity channels always use the continuous colormap ramp;
      // categorical mode is reserved for label overlays.
      colormapMode: 0,
      labelOpacity: 1,
    };
  }
  return out;
}
