import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { VolumeData } from "../types.ts";
import type { DatasetState } from "../types.ts";
import { applyViewportCommand } from "../applyAndSend.ts";

interface Params {
  volumeMap: Map<string, VolumeData>;
  clientReady: boolean;
  clientRef: React.RefObject<RenderClient | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  loopRef: React.RefObject<RenderLoop | null>;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  emitPresence: () => void;
}

export function usePreUpload({
  volumeMap,
  clientReady,
  clientRef,
  datasetsRef,
  loopRef,
  wasmSceneRef,
  emitPresence,
}: Params) {
  const preUploadedRef = useRef(new Set<string>());
  const prevDimsMapRef = useRef(new Map<string, { w: number; h: number; d: number }>());

  // Eagerly pre-upload initial volumes/fallbacks for all datasets
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !clientReady) return;

    // Clean up removed datasets
    for (const id of preUploadedRef.current) {
      if (!volumeMap.has(id)) {
        preUploadedRef.current.delete(id);
      }
    }

    // Upload new datasets
    for (const [id, vol] of volumeMap) {
      if (preUploadedRef.current.has(id)) continue;
      preUploadedRef.current.add(id);

      client.volumeSetInitialForLayer(id, vol.data, vol.width, vol.height, vol.depth);

      const sliceSize = vol.width * vol.height;
      const slice = vol.data.subarray(0, sliceSize);
      client.sliceSetFallbackForLayer(id, slice, vol.width, vol.height);

      const ds = datasetsRef.current.get(id);
      if (ds) {
        client.minimapSetOverviewForLayer(id, vol.data, vol.width, vol.height, vol.depth, 0, 0);
        loopRef.current?.markMinimapOverviewSeeded(id, 0, 0);
      }
    }
  }, [volumeMap, clientReady, clientRef, datasetsRef, loopRef]);

  // Reset pan/zoom when dataset dimensions change (LOD upgrades)
  useEffect(() => {
    for (const [id, vol] of volumeMap) {
      const prev = prevDimsMapRef.current.get(id);
      if (prev && (vol.width !== prev.w || vol.height !== prev.h || vol.depth !== prev.d)) {
        const ds = datasetsRef.current.get(id);
        const scene = wasmSceneRef.current;
        if (ds && scene) {
          const fullResWidth = ds.info.levels[0].shape[4];
          const fullResHeight = ds.info.levels[0].shape[3];
          applyViewportCommand(scene, { type: "set_center", x: fullResWidth / 2, y: fullResHeight / 2 });
          applyViewportCommand(scene, { type: "set_zoom", value: 1.0 });
          emitPresence();
          loopRef.current?.markDirty();
        }
      }
      prevDimsMapRef.current.set(id, { w: vol.width, h: vol.height, d: vol.depth });
    }
    for (const id of prevDimsMapRef.current.keys()) {
      if (!volumeMap.has(id)) prevDimsMapRef.current.delete(id);
    }
  }, [volumeMap, emitPresence, datasetsRef, wasmSceneRef, loopRef]);
}
