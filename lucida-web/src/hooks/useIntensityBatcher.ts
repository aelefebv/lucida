import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { Bridge } from "../bridge.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { DatasetState } from "../types.ts";

interface Params {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  loopRef: React.RefObject<RenderLoop | null>;
  bridgeRef: React.RefObject<Bridge | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  setDataRangeMap: React.Dispatch<React.SetStateAction<Map<string, { min: number; max: number }>>>;
}

export function useIntensityBatcher({
  clientReady,
  clientRef,
  autoContrastMapRef,
  wasmSceneRef,
  loopRef,
  bridgeRef,
  datasetsRef,
  setDataRangeMap,
}: Params) {
  const pendingIntensityRef = useRef(new Map<string, { min: number; max: number }>());
  const intensityRafRef = useRef(0);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.onIntensityRange = (rawId, min, max) => {
      // For plate datasets, the GPU worker reports intensity using member IDs,
      // but contrast settings and data-range maps are keyed by parent dataset ID.
      let datasetId = rawId;
      const datasets = datasetsRef.current;
      if (!datasets.has(rawId)) {
        for (const [dsId, ds] of datasets) {
          if (ds.members.some(m => m.id === rawId)) {
            datasetId = dsId;
            break;
          }
        }
      }

      // Merge with any existing pending range (union across members)
      const existing = pendingIntensityRef.current.get(datasetId);
      const mergedMin = existing ? Math.min(existing.min, min) : min;
      const mergedMax = existing ? Math.max(existing.max, max) : max;

      const isAuto = autoContrastMapRef.current.get(datasetId) ?? true;
      if (isAuto) {
        const scene = wasmSceneRef.current;
        if (scene) {
          const c = scene.c();
          scene.apply_command(JSON.stringify({
            type: "set_channel_contrast",
            dataset_id: datasetId,
            channel: c,
            min: mergedMin,
            max: mergedMax,
          }));
          bumpSettingsGeneration();
          loopRef.current?.markDataDirty();
          bridgeRef.current?.sendDatasetPresence(scene.export_dataset_presence());
        }
      }

      pendingIntensityRef.current.set(datasetId, { min: mergedMin, max: mergedMax });
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
  }, [clientReady, clientRef, autoContrastMapRef, wasmSceneRef, loopRef, bridgeRef, datasetsRef, setDataRangeMap]);
}
