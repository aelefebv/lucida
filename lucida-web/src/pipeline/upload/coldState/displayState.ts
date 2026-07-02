/**
 * Per-channel display-state builder. Bakes per-channel overrides into
 * the cold-state message, falling back to dataset-level contrast / gamma
 * / opacity when no per-channel override exists.
 */
import type { ColdStateDisplayState } from "../../../renderer/workerProtocol.ts";
import type { DatasetSettings } from "../../../tickCommon.ts";

export function buildDisplayStateByChannel(
  visibleChannels: number[],
  dsSettings: DatasetSettings | undefined,
): Record<number, ColdStateDisplayState> {
  const opacity = dsSettings?.opacity ?? 1;
  const dsContrastMin = dsSettings?.contrast_min ?? 0;
  const dsContrastMax = dsSettings?.contrast_max ?? 65535;
  const dsGamma = dsSettings?.gamma ?? 1;
  const out: Record<number, ColdStateDisplayState> = {};
  for (const ch of visibleChannels) {
    const chSettings = dsSettings?.channel_settings?.[ch];
    out[ch] = {
      contrastMin: chSettings?.contrast_min ?? dsContrastMin,
      contrastMax: chSettings?.contrast_max ?? dsContrastMax,
      gamma: chSettings?.gamma ?? dsGamma,
      opacity,
      colormapName: chSettings?.colormap ?? "gray",
      channelMask: 1 << (ch & 31),
      // Intensity channels always use the continuous colormap ramp;
      // categorical mode is reserved for label overlays.
      colormapMode: 0,
      labelOpacity: 1,
    };
  }
  return out;
}
