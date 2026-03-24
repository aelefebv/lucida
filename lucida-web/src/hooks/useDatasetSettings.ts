import { useCallback, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import type { LayerInfo } from "../components/LayerPanel.tsx";
import type { DatasetState } from "../types.ts";
import { dtypeMax } from "../types.ts";
import { applyDocumentCommand } from "../applyAndSend.ts";

export interface BridgeCallbacks {
  sendCommand: (json: string) => void;
  emitPresence: () => void;
  emitDatasetPresence: () => void;
  breakFollow: () => void;
}

export interface DatasetCallbacks {
  removeDataset: (id: string) => void;
}

interface Params {
  wasmSceneRef: React.RefObject<WasmScene | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  loopRef: React.RefObject<RenderLoop | null>;
  selectedDatasetId: string | null;
  setSelectedDatasetId: React.Dispatch<React.SetStateAction<string | null>>;
  bridgeCallbacksRef: React.RefObject<BridgeCallbacks>;
  datasetCallbacksRef: React.RefObject<DatasetCallbacks>;
  datasetsVersion: number;
  remoteDocumentVersion: number;
}

export function useDatasetSettings({
  wasmSceneRef,
  datasetsRef,
  loopRef,
  selectedDatasetId,
  setSelectedDatasetId,
  bridgeCallbacksRef,
  datasetCallbacksRef,
  datasetsVersion,
  remoteDocumentVersion,
}: Params) {
  const [autoContrastMap, setAutoContrastMap] = useState<Map<string, boolean>>(new Map());
  const [fullRangeMap, setFullRangeMap] = useState<Map<string, boolean>>(new Map());
  const [dataRangeMap, setDataRangeMap] = useState<Map<string, { min: number; max: number }>>(new Map());
  const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null);
  const [layerSettingsVersion, setLayerSettingsVersion] = useState(0);
  const autoContrastMapRef = useRef<Map<string, boolean>>(new Map());
  autoContrastMapRef.current = autoContrastMap;

  const bumpLayerSettingsVersion = useCallback(() => {
    setLayerSettingsVersion((v) => v + 1);
  }, []);

  const initLayerMaps = useCallback((id: string) => {
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, true); return next; });
    setFullRangeMap(prev => { const next = new Map(prev); next.set(id, false); return next; });
  }, []);

  const cleanupLayerMaps = useCallback((id: string) => {
    setAutoContrastMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    setFullRangeMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    setDataRangeMap(prev => { const next = new Map(prev); next.delete(id); return next; });
  }, []);

  const handleLayerSelect = useCallback((id: string) => {
    setSelectedDatasetId(id);
  }, [setSelectedDatasetId]);

  const handleLayerToggleExpand = useCallback((id: string) => {
    setExpandedLayerId(prev => prev === id ? null : id);
    setSelectedDatasetId(id);
  }, [setSelectedDatasetId]);

  const handleLayerSetVisible = useCallback((id: string, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_dataset_visible", dataset_id: id, visible }));
      loopRef.current?.markDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetOpacity = useCallback((id: string, opacity: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_dataset_opacity", dataset_id: id, opacity }));
      loopRef.current?.markDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetContrast = useCallback((id: string, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_dataset_contrast", dataset_id: id, min, max }));
      loopRef.current?.markDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, false); return next; });
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetGamma = useCallback((id: string, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_dataset_gamma", dataset_id: id, gamma }));
      loopRef.current?.markDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetBlendMode = useCallback((id: string, mode: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_dataset_blend_mode", dataset_id: id, blend_mode: mode }));
      loopRef.current?.markDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetRenderMode = useCallback((id: string, mode: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      scene.apply_command(JSON.stringify({ type: "set_dataset_render_mode", dataset_id: id, render_mode: mode }));
      loopRef.current?.markDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerAutoContrast = useCallback((id: string) => {
    const dr = dataRangeMap.get(id);
    if (dr) {
      const scene = wasmSceneRef.current;
      if (scene) {
        bridgeCallbacksRef.current.breakFollow();
        scene.apply_command(JSON.stringify({ type: "set_dataset_contrast", dataset_id: id, min: dr.min, max: dr.max }));
        loopRef.current?.markDirty();
        bridgeCallbacksRef.current.emitDatasetPresence();
      }
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, true); return next; });
  }, [dataRangeMap, wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerAutoContrastToggle = useCallback((id: string) => {
    setAutoContrastMap(prev => {
      const next = new Map(prev);
      const wasAuto = prev.get(id) ?? true;
      next.set(id, !wasAuto);
      if (!wasAuto) {
        const dr = dataRangeMap.get(id);
        if (dr) {
          const scene = wasmSceneRef.current;
          if (scene) {
            bridgeCallbacksRef.current.breakFollow();
            scene.apply_command(JSON.stringify({ type: "set_dataset_contrast", dataset_id: id, min: dr.min, max: dr.max }));
            loopRef.current?.markDirty();
            bridgeCallbacksRef.current.emitDatasetPresence();
          }
        }
      }
      return next;
    });
  }, [dataRangeMap, wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerFullRangeToggle = useCallback((id: string) => {
    setFullRangeMap(prev => {
      const next = new Map(prev);
      const wasFull = prev.get(id) ?? false;
      next.set(id, !wasFull);
      const scene = wasmSceneRef.current;
      if (scene) {
        bridgeCallbacksRef.current.breakFollow();
        if (!wasFull) {
          const ds = datasetsRef.current.get(id);
          const frMax = ds ? dtypeMax(ds.info.levels[0].dataType) : 65535;
          scene.apply_command(JSON.stringify({ type: "set_dataset_contrast", dataset_id: id, min: 0, max: frMax }));
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, false); return n; });
        } else {
          const dr = dataRangeMap.get(id);
          if (dr) {
            scene.apply_command(JSON.stringify({ type: "set_dataset_contrast", dataset_id: id, min: dr.min, max: dr.max }));
          }
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, true); return n; });
        }
        loopRef.current?.markDirty();
        bridgeCallbacksRef.current.emitDatasetPresence();
      }
      return next;
    });
  }, [dataRangeMap, wasmSceneRef, datasetsRef, loopRef, bridgeCallbacksRef]);

  const handleLayerMove = useCallback((id: string, direction: "up" | "down") => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    bridgeCallbacksRef.current.breakFollow();
    const order: string[] = JSON.parse(scene.dataset_order());
    const idx = order.indexOf(id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= order.length) return;
    [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
    scene.apply_command(JSON.stringify({ type: "set_dataset_order", order }));
    loopRef.current?.markDirty();
    bridgeCallbacksRef.current.emitDatasetPresence();
    setLayerSettingsVersion((v) => v + 1);
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleRemoveLayer = useCallback((id: string) => {
    if (!confirm(`Remove layer "${datasetsRef.current.get(id)?.name ?? id}"?`)) return;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(scene, { type: "remove_dataset", id }, bridgeCallbacksRef.current.sendCommand);
    datasetCallbacksRef.current.removeDataset(id);
  }, [wasmSceneRef, datasetsRef, bridgeCallbacksRef, datasetCallbacksRef]);

  // Build layer infos from WASM state
  const buildLayerInfos = (): LayerInfo[] => {
    const scene = wasmSceneRef.current;
    if (!scene) return [];

    let layerOrder: string[];
    let allSettings: Record<string, {
      visible: boolean;
      opacity: number;
      contrast_min: number;
      contrast_max: number;
      gamma: number;
      blend_mode: string;
      render_mode: string;
    }>;
    try {
      layerOrder = JSON.parse(scene.dataset_order());
      allSettings = JSON.parse(scene.all_dataset_settings());
    } catch {
      return [];
    }

    return layerOrder.slice().reverse().map(id => {
      const settings = allSettings[id];
      const ds = datasetsRef.current.get(id);
      const dr = dataRangeMap.get(id) ?? null;
      const frMax = ds ? dtypeMax(ds.info.levels[0].dataType) : 65535;

      return {
        id,
        name: scene.dataset_name(id),
        visible: settings?.visible ?? true,
        opacity: settings?.opacity ?? 1,
        contrastMin: settings?.contrast_min ?? 0,
        contrastMax: settings?.contrast_max ?? 65535,
        gamma: settings?.gamma ?? 1,
        blendMode: settings?.blend_mode ?? "alpha",
        renderMode: settings?.render_mode ?? "translucent",
        autoContrast: autoContrastMap.get(id) ?? true,
        fullRange: fullRangeMap.get(id) ?? false,
        dataRange: dr,
        fullRangeMax: frMax,
      };
    });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layerInfos = buildLayerInfos();
  void datasetsVersion;
  void remoteDocumentVersion;
  void layerSettingsVersion;
  void selectedDatasetId;

  return {
    autoContrastMap,
    setAutoContrastMap,
    autoContrastMapRef,
    fullRangeMap,
    setFullRangeMap,
    dataRangeMap,
    setDataRangeMap,
    expandedLayerId,
    layerSettingsVersion,
    bumpLayerSettingsVersion,
    initLayerMaps,
    cleanupLayerMaps,
    layerInfos,
    handleLayerSelect,
    handleLayerToggleExpand,
    handleLayerSetVisible,
    handleLayerSetOpacity,
    handleLayerSetContrast,
    handleLayerSetGamma,
    handleLayerSetBlendMode,
    handleLayerSetRenderMode,
    handleLayerAutoContrast,
    handleLayerAutoContrastToggle,
    handleLayerFullRangeToggle,
    handleLayerMove,
    handleRemoveLayer,
  };
}
