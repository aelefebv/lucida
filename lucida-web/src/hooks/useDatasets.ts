import { useCallback, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";

interface Params {
  wasmSceneRef: React.RefObject<WasmScene | null>;
  ensureScene: () => WasmScene;
  setWasmScene: React.Dispatch<React.SetStateAction<WasmScene | null>>;
  loopRef: React.RefObject<RenderLoop | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  sendCommand: (json: string) => void;
  emitPresence: () => void;
  emitDatasetPresence: () => void;
  initLayerMaps: (id: string) => void;
  sendOpenRemoteDataset: (url: string) => void;
  // Lifted state setters
  setSelectedDatasetId: React.Dispatch<React.SetStateAction<string | null>>;
  setVolumeMap: React.Dispatch<React.SetStateAction<Map<string, VolumeData>>>;
  bumpDatasetsVersion: () => void;
}

export function useDatasets({
  sendOpenRemoteDataset,
}: Params) {
  const [loading] = useState(false);
  const [loadError] = useState<string | null>(null);

  const handleUrlSubmit = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    sendOpenRemoteDataset(trimmed);
  }, [sendOpenRemoteDataset]);

  return {
    loading,
    loadError,
    handleUrlSubmit,
  };
}
