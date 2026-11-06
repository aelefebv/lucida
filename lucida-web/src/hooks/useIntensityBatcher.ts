import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { Session } from "../session.ts";
import type { ViewportCommand } from "../commands.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import { invalidateResidency } from "../invalidation.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { DatasetState } from "../types.ts";
import { channelRangeKey, parseChannelRangeKey } from "../components/channels.ts";

declare global {
  interface Window {
    // The latest auto-contrast window, read by the headless `dataset montage`
    // capture to derive a shared, background-clipped contrast.
    __lucidaAutoContrast?: { min: number; max: number };
  }
}

/**
 * The dataset and channel a reported range belongs to. In the composite the
 * worker reports per channel, as `<member>:ch<n>`; in single-channel mode it
 * reports the bare member, which is the scene's current channel. A
 * collection reports per tile, and ranges are kept per parent dataset.
 */
export function resolveIntensitySource(
  rawId: string,
  datasets: Map<string, DatasetState>,
  currentChannel: number,
): { datasetId: string; channel: number } {
  const parsed = parseChannelRangeKey(rawId);
  const memberId = parsed?.datasetId ?? rawId;
  const channel = parsed?.channel ?? currentChannel;
  if (datasets.has(memberId)) return { datasetId: memberId, channel };
  for (const [dsId, ds] of datasets) {
    if (ds.manifest.images.some((img) => img.image_id === memberId)) {
      return { datasetId: dsId, channel };
    }
  }
  return { datasetId: memberId, channel };
}

interface Params {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  loopRef: React.RefObject<RenderLoop | null>;
  sessionRef: React.RefObject<Session | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  setDataRangeMap: React.Dispatch<React.SetStateAction<Map<string, { min: number; max: number }>>>;
}

export function useIntensityBatcher({
  clientReady,
  clientRef,
  autoContrastMapRef,
  wasmSceneRef,
  loopRef,
  sessionRef,
  datasetsRef,
  setDataRangeMap,
}: Params) {
  const pendingIntensityRef = useRef(new Map<string, { min: number; max: number }>());
  const intensityRafRef = useRef(0);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.onIntensityRange = (rawId, min, max) => {
      const scene = wasmSceneRef.current;
      const { datasetId, channel } = resolveIntensitySource(rawId, datasetsRef.current, scene?.c() ?? 0);
      const key = channelRangeKey(datasetId, channel);

      // Union across collection members.
      const existing = pendingIntensityRef.current.get(key);
      const mergedMin = existing ? Math.min(existing.min, min) : min;
      const mergedMax = existing ? Math.max(existing.max, max) : max;

      // A montage view shows a single dataset, so the latest window is its
      // data range; the headless capture reads this to clip the background.
      window.__lucidaAutoContrast = { min: mergedMin, max: mergedMax };

      const isAuto = autoContrastMapRef.current.get(datasetId) ?? true;
      if (isAuto && scene) {
        const cmd: ViewportCommand = {
          type: "set_channel_contrast",
          dataset_id: datasetId,
          channel,
          min: mergedMin,
          max: mergedMax,
        };
        guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
        invalidateResidency(loopRef.current, "auto_contrast");
        sessionRef.current?.bridge.sendDatasetPresence(scene.export_dataset_presence());
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
  }, [clientReady, clientRef, autoContrastMapRef, wasmSceneRef, loopRef, sessionRef, datasetsRef, setDataRangeMap]);
}
