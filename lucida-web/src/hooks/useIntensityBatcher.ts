import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { ViewportCommand } from "../commands.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { ViewportCoordinator } from "../viewportCoordinator.ts";

declare global {
  interface Window {
    // The latest auto-contrast data window, exposed so headless tooling (the
    // `dataset montage` capture) can read a dataset's data range and derive a
    // shared, background-clipped contrast. Additive — auto behaviour is unchanged.
    __lucidaAutoContrast?: { min: number; max: number };
  }
}

interface Params {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  /** The sole local viewport/display mutation boundary. Automatic contrast is
   * data-driven, but it still changes the shareable scene and must publish the
   * same URL/dataset-presence/invalidation effects as a panel-driven change. */
  viewport: Pick<ViewportCoordinator, "apply">;
  setDataRangeMap: React.Dispatch<React.SetStateAction<Map<string, { min: number; max: number }>>>;
}

/** Stable key for ranges that must never union across channels. */
export function intensityRangeKey(datasetId: string, channel: number): string {
  return `${datasetId}\u0000${channel}`;
}

export function useIntensityBatcher({
  clientReady,
  clientRef,
  autoContrastMapRef,
  wasmSceneRef,
  viewport,
  setDataRangeMap,
}: Params) {
  const pendingIntensityRef = useRef(new Map<string, { min: number; max: number }>());
  const intensityRafRef = useRef(0);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.onIntensityRange = (datasetId, channel, min, max) => {
      const key = intensityRangeKey(datasetId, channel);
      // Merge across members of this dataset/channel only.
      const existing = pendingIntensityRef.current.get(key);
      const mergedMin = existing ? Math.min(existing.min, min) : min;
      const mergedMax = existing ? Math.max(existing.max, max) : max;

      // A montage view shows a single dataset, so the latest window is its
      // data range; the headless capture reads this to clip the background.
      window.__lucidaAutoContrast = { min: mergedMin, max: mergedMax };

      const isAuto = autoContrastMapRef.current.get(datasetId) ?? true;
      if (isAuto) {
        const scene = wasmSceneRef.current;
        if (scene) {
          const cmd: ViewportCommand = {
            type: "set_channel_contrast",
            dataset_id: datasetId,
            channel,
            min: mergedMin,
            max: mergedMax,
          };
          viewport.apply(cmd, {
            source: "auto_contrast",
            breakFollow: false,
            publication: "dataset-presence",
            invalidation: "residency",
            history: { skip: true },
          });
        }
      }

      pendingIntensityRef.current.set(key, { min: mergedMin, max: mergedMax });
      if (!intensityRafRef.current) {
        intensityRafRef.current = requestAnimationFrame(() => {
          intensityRafRef.current = 0;
          const pending = pendingIntensityRef.current;
          if (pending.size === 0) return;
          const batch = new Map(pending);
          pending.clear();
          setDataRangeMap(prev => {
            const next = new Map(prev);
            for (const [id, range] of batch) {
              const prevRange = next.get(id);
              if (prevRange) {
                next.set(id, {
                  min: Math.min(prevRange.min, range.min),
                  max: Math.max(prevRange.max, range.max),
                });
              } else {
                next.set(id, range);
              }
            }
            return next;
          });
        });
      }
    };
    return () => {
      if (intensityRafRef.current) {
        cancelAnimationFrame(intensityRafRef.current);
        intensityRafRef.current = 0;
      }
    };
  }, [clientReady, clientRef, autoContrastMapRef, wasmSceneRef, viewport, setDataRangeMap]);
}
