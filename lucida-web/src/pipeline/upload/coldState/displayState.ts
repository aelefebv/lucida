/**
 * Per-channel display-state builder for cold-state messages.
 *
 * The worker writes one display-state record per (entry × visible channel)
 * pair into the GPU `EntityDescriptor`. This function bakes the per-channel
 * overrides — falling back to dataset-level contrast / gamma / opacity when
 * no per-channel override exists.
 *
 * Single-channel mode populates the lone active channel; multi-channel mode
 * populates every visible channel. The caller passes whatever `visibleChannels`
 * the planner has selected.
 *
 * Pure function — no orchestrator or scene state. Extracted from
 * `Orchestrator.sendColdState` so the build can be unit-tested without mocks.
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
    };
  }
  return out;
}
