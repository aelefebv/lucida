import { useCallback, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import type { LayerInfo } from "../components/LayerPanel.tsx";
import type { DatasetState } from "../types.ts";
import { dtypeMax } from "../types.ts";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";

/** Apply a settings command and invalidate the settings cache. */
function applySettingsCommand(scene: WasmScene, cmd: Record<string, unknown>): void {
  scene.apply_command(JSON.stringify(cmd));
  bumpSettingsGeneration();
}

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
  // Mirror the autoContrast map into a ref so the buildLayerInfos closure
  // (called during render and from event handlers) reads the latest map
  // without depending on it identity-wise.
  const autoContrastMapRef = useRef<Map<string, boolean>>(new Map());
  // eslint-disable-next-line react-hooks/refs
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
      applySettingsCommand(scene, { type: "set_dataset_visible", dataset_id: id, visible });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetOpacity = useCallback((id: string, opacity: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_opacity", dataset_id: id, opacity });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetContrast = useCallback((id: string, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      const c = scene.c();
      applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min, max });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, false); return next; });
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetGamma = useCallback((id: string, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      const c = scene.c();
      applySettingsCommand(scene, { type: "set_channel_gamma", dataset_id: id, channel: c, gamma });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetColormap = useCallback((id: string, colormap: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      const c = scene.c();
      applySettingsCommand(scene, { type: "set_channel_colormap", dataset_id: id, channel: c, colormap });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  // Channel-specific handlers for multi-channel sublayer controls
  const handleChannelSetVisible = useCallback((id: string, channel: number, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_visible", dataset_id: id, channel, visible });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetColormap = useCallback((id: string, channel: number, colormap: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_colormap", dataset_id: id, channel, colormap });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetContrast = useCallback((id: string, channel: number, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel, min, max });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetGamma = useCallback((id: string, channel: number, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_gamma", dataset_id: id, channel, gamma });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetBlendMode = useCallback((id: string, blendMode: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_blend_mode", dataset_id: id, blend_mode: blendMode });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetBlendMode = useCallback((id: string, mode: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_blend_mode", dataset_id: id, blend_mode: mode });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetRenderMode = useCallback((id: string, mode: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_render_mode", dataset_id: id, render_mode: mode });
      loopRef.current?.markInteractiveDirty();
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
        const c = scene.c();
        applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max });
        loopRef.current?.markInteractiveDirty();
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
            const c = scene.c();
            applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max });
            loopRef.current?.markInteractiveDirty();
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
        const c = scene.c();
        if (!wasFull) {
          const ds = datasetsRef.current.get(id);
          const frMax = ds ? dtypeMax(ds.manifest.images[0].multiscale.data_type) : 65535;
          applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: 0, max: frMax });
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, false); return n; });
        } else {
          const dr = dataRangeMap.get(id);
          if (dr) {
            applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max });
          }
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, true); return n; });
        }
        loopRef.current?.markInteractiveDirty();
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
    applySettingsCommand(scene, { type: "set_dataset_order", order });
    loopRef.current?.markInteractiveDirty();
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
      channel_settings?: { visible: boolean; colormap: string; contrast_min: number; contrast_max: number; gamma: number }[];
      channel_blend_mode?: string;
    }>;
    try {
      layerOrder = JSON.parse(scene.dataset_order());
      allSettings = JSON.parse(scene.all_dataset_settings());
    } catch {
      return [];
    }

    const currentC = scene.c();

    return layerOrder.slice().reverse().map(id => {
      const settings = allSettings[id];
      const ds = datasetsRef.current.get(id);
      const dr = dataRangeMap.get(id) ?? null;
      const frMax = ds ? dtypeMax(ds.manifest.images[0].multiscale.data_type) : 65535;

      // Use per-channel settings if available
      const chSettings = settings?.channel_settings?.[currentC];

      return {
        id,
        name: scene.dataset_name(id),
        visible: settings?.visible ?? true,
        opacity: settings?.opacity ?? 1,
        contrastMin: chSettings?.contrast_min ?? settings?.contrast_min ?? 0,
        contrastMax: chSettings?.contrast_max ?? settings?.contrast_max ?? 65535,
        gamma: chSettings?.gamma ?? settings?.gamma ?? 1,
        colormap: chSettings?.colormap ?? "gray",
        blendMode: settings?.blend_mode ?? "alpha",
        renderMode: settings?.render_mode ?? "translucent",
        autoContrast: autoContrastMap.get(id) ?? true,
        fullRange: fullRangeMap.get(id) ?? false,
        dataRange: dr,
        fullRangeMax: frMax,
        channelSettings: settings?.channel_settings,
        channelBlendMode: settings?.channel_blend_mode ?? "additive",
      };
    });
  };

  // buildLayerInfos closes over autoContrastMapRef + datasetsRef; both
  // are mirrored from state via the version counters above (datasetsVersion,
  // remoteDocumentVersion, layerSettingsVersion) so re-renders pick up
  // the latest values. Calling during render is intentional.
  // eslint-disable-next-line react-hooks/refs
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
    handleLayerSetColormap,
    handleChannelSetVisible,
    handleChannelSetColormap,
    handleChannelSetContrast,
    handleChannelSetGamma,
    handleChannelSetBlendMode,
    handleLayerSetBlendMode,
    handleLayerSetRenderMode,
    handleLayerAutoContrast,
    handleLayerAutoContrastToggle,
    handleLayerFullRangeToggle,
    handleLayerMove,
    handleRemoveLayer,
  };
}
