import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { Bridge } from "../bridge.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop } from "../renderLoop.ts";

interface Params {
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
  autoContrastMapRef: React.RefObject<Map<string, boolean>>;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  loopRef: React.RefObject<RenderLoop | null>;
  bridgeRef: React.RefObject<Bridge | null>;
  setDataRangeMap: React.Dispatch<React.SetStateAction<Map<string, { min: number; max: number }>>>;
}

export function useIntensityBatcher({
  clientReady,
  clientRef,
  autoContrastMapRef,
  wasmSceneRef,
  loopRef,
  bridgeRef,
  setDataRangeMap,
}: Params) {
  const pendingIntensityRef = useRef(new Map<string, { min: number; max: number }>());
  const intensityRafRef = useRef(0);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.onIntensityRange = (datasetId, min, max) => {
      const isAuto = autoContrastMapRef.current.get(datasetId) ?? true;
      if (isAuto) {
        const scene = wasmSceneRef.current;
        if (scene) {
          scene.apply_command(JSON.stringify({
            type: "set_dataset_contrast",
            dataset_id: datasetId,
            min,
            max,
          }));
          loopRef.current?.markDirty();
          bridgeRef.current?.sendDatasetPresence(scene.export_dataset_presence());
        }
      }

      pendingIntensityRef.current.set(datasetId, { min, max });
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
              next.set(id, range);
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
  }, [clientReady, clientRef, autoContrastMapRef, wasmSceneRef, loopRef, bridgeRef, setDataRangeMap]);
}
