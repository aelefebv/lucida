import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import type { LayerInfo } from "../components/LayerPanel.tsx";
import type { LabelOverlayView } from "../manifestTypes.ts";
import type { DatasetState } from "../types.ts";
import { dtypeMax } from "../types.ts";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { bumpSettingsGeneration } from "../tickCommon.ts";
import { Axis } from "../axes.ts";

/** Apply a settings command and invalidate the settings cache. */
function applySettingsCommand(scene: WasmScene, cmd: Record<string, unknown>): void {
  scene.apply_command(JSON.stringify(cmd));
  bumpSettingsGeneration();
}

function detailLevelOptions(ds: DatasetState | undefined): { level: number; label: string }[] {
  const multiscale = ds?.manifest.images[0]?.multiscale;
  if (!multiscale) return [];
  const generated = new Set(
    (multiscale.generated_levels ?? []).map((level) => level.level_index),
  );
  return multiscale.levels
    .filter((level) => level.level_index !== 0 && !generated.has(level.level_index))
    .map((level) => ({
      level: level.level_index,
      label: `${level.shape[Axis.X]} x ${level.shape[Axis.Y]}`,
    }));
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
  const lastAutoExpandedLayerRef = useRef<string | null>(null);
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

  useEffect(() => {
    if (!selectedDatasetId || expandedLayerId !== null) return;
    if (lastAutoExpandedLayerRef.current === selectedDatasetId) return;
    lastAutoExpandedLayerRef.current = selectedDatasetId;
    setExpandedLayerId(selectedDatasetId);
  }, [selectedDatasetId, expandedLayerId]);

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

  // Set (or clear) a user display-name override for one channel. A
  // viewport/display command exactly like handleChannelSetColormap — applies
  // locally, breaks follow, marks dirty, and emits presence so followers see
  // it via the selection epoch. `name === null` (an emptied input) clears the
  // override, falling the label back to the omero name / `Ch N`. Whitespace is
  // trimmed before this is called; the caller passes null for a blank value.
  const handleChannelSetName = useCallback((id: string, channel: number, name: string | null) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_name", dataset_id: id, channel, name });
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

  // Toggle a label overlay's visibility — a viewport/display command exactly
  // like handleChannelSetVisible: apply locally for instant feedback, break
  // follow, mark dirty, and emit presence so followers see it via the labels
  // epoch. `index` is the label-relative index the `SetLabelVisible` command
  // carries. Bumps the layer-settings version so the panel re-reads the new
  // effective state from `label_overlays`.
  const handleSetLabelVisible = useCallback((id: string, index: number, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_label_visible", dataset_id: id, label: index, visible });
      loopRef.current?.markInteractiveDirty();
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  // Set a label overlay's blend opacity — the label sibling of
  // handleSetLabelVisible, dispatching `SetLabelOpacity`.
  const handleSetLabelOpacity = useCallback((id: string, index: number, opacity: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_label_opacity", dataset_id: id, label: index, opacity });
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

  const handleLayerSetDetailLevelOverride = useCallback((id: string, level: number | null) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_detail_level_override", dataset_id: id, level });
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
    if (
      !confirm(
        `Remove "${datasetsRef.current.get(id)?.name ?? id}" from this workspace? This only removes the workspace layer; it does not delete upstream storage or cached data.`,
      )
    ) return;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(scene, { type: "remove_dataset", id }, bridgeCallbacksRef.current.sendCommand);
    datasetCallbacksRef.current.removeDataset(id);
  }, [wasmSceneRef, datasetsRef, bridgeCallbacksRef, datasetCallbacksRef]);

  // Rename a layer (dataset) by mutating the shared document. Like
  // handleRemoveLayer, this is a document command: it applies locally for
  // immediate feedback and sends to the server, which authorizes it
  // editor-only, broadcasts it to co-present peers, and persists it so the
  // new name survives reopen. A blank/whitespace name is ignored client-side
  // (the server also rejects it); the trimmed name is sent.
  const handleLayerRename = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const scene = wasmSceneRef.current;
    if (!scene) return;
    if (scene.dataset_name(id) === trimmed) return;
    applyDocumentCommand(
      scene,
      { type: "rename_dataset", id, name: trimmed },
      bridgeCallbacksRef.current.sendCommand,
    );
    setLayerSettingsVersion((v) => v + 1);
  }, [wasmSceneRef, bridgeCallbacksRef]);

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
      channel_settings?: { visible: boolean; colormap: string; contrast_min: number; contrast_max: number; gamma: number; name?: string }[];
      channel_blend_mode?: string;
      detail_level_override?: number | null;
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

      const chSettings = settings?.channel_settings?.[currentC];

      // Segmentation label overlays for this dataset (empty for an
      // intensity-only dataset). Parsed defensively — a malformed payload
      // degrades to "no labels" rather than throwing out the whole row.
      let labels: LabelOverlayView[] = [];
      try {
        labels = JSON.parse(scene.label_overlays(id)) as LabelOverlayView[];
      } catch {
        labels = [];
      }

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
        // Immutable channel labels from the manifest's omero block (positional;
        // may be absent/short — LayerPanel falls back to `Ch {i}` per index).
        channelInfos: ds?.manifest.images[0]?.multiscale.channel_infos,
        channelBlendMode: settings?.channel_blend_mode ?? "additive",
        detailLevelOverride: settings?.detail_level_override ?? null,
        detailLevelOptions: detailLevelOptions(ds),
        labels,
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
    handleChannelSetName,
    handleChannelSetContrast,
    handleChannelSetGamma,
    handleChannelSetBlendMode,
    handleSetLabelVisible,
    handleSetLabelOpacity,
    handleLayerSetBlendMode,
    handleLayerSetRenderMode,
    handleLayerSetDetailLevelOverride,
    handleLayerAutoContrast,
    handleLayerAutoContrastToggle,
    handleLayerFullRangeToggle,
    handleLayerMove,
    handleRemoveLayer,
    handleLayerRename,
  };
}
