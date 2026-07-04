import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import type { LayerInfo } from "../components/LayerPanel.tsx";
import type { DatasetState } from "../types.ts";
import { dtypeMax } from "../types.ts";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { ViewportCommand } from "../commands.ts";
import type { BlendMode, Colormap, RenderMode } from "../savedView/types.ts";
import { invalidateDisplaySettings, requestRender } from "../invalidation.ts";
import { Axis } from "../axes.ts";
import { eligibleLabelInfos } from "../pipeline/planning/labelRequests.ts";

/** Apply a display-settings command and signal the change: the planner's
 *  settings cache is invalidated and the render loop (when mounted) is asked
 *  for a frame, in one composed intent so neither tap can be forgotten. */
function applySettingsCommand(
  scene: WasmScene,
  cmd: ViewportCommand,
  loop: RenderLoop | null,
): void {
  scene.apply_command(JSON.stringify(cmd));
  invalidateDisplaySettings(loop);
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

/** The per-dataset display settings shape `scene.all_dataset_settings()`
 *  serializes (mirrors `lucida_core::scene::DatasetDisplaySettings`). */
interface RawDatasetSettings {
  visible: boolean;
  opacity: number;
  contrast_min: number;
  contrast_max: number;
  gamma: number;
  blend_mode: string;
  render_mode?: string;
  channel_settings?: { visible: boolean; colormap: string; contrast_min: number; contrast_max: number; gamma: number; name?: string }[];
  label_settings?: { visible: boolean; opacity: number }[];
  channel_blend_mode?: string;
  detail_level_override?: number | null;
}

/**
 * Derive the layer panel's per-layer view models from the live scene + dataset
 * state. Pure and standalone (no refs/React) so the scene→`LayerInfo` seam —
 * in particular that per-channel AND per-label settings from
 * `scene.all_dataset_settings()` reach the panel — is unit-testable with a stub
 * scene, which a component-with-injected-props test cannot cover.
 *
 * Label rows expose ONLY the DRAWABLE (eligible) labels via
 * {@link eligibleLabelInfos}, each carrying its MANIFEST index so the toggle /
 * opacity handlers target the right `label_settings` entry even when earlier
 * (ineligible) labels are omitted — a control never lies about a label that
 * can't render.
 */
export function buildLayerInfos(
  scene: WasmScene,
  datasets: Map<string, DatasetState>,
  maps: {
    autoContrast: Map<string, boolean>;
    fullRange: Map<string, boolean>;
    dataRange: Map<string, { min: number; max: number }>;
  },
): LayerInfo[] {
  let layerOrder: string[];
  let allSettings: Record<string, RawDatasetSettings>;
  try {
    layerOrder = JSON.parse(scene.dataset_order());
    allSettings = JSON.parse(scene.all_dataset_settings());
  } catch {
    return [];
  }

  const currentC = scene.c();

  return layerOrder.slice().reverse().map((id) => {
    const settings = allSettings[id];
    const ds = datasets.get(id);
    const dr = maps.dataRange.get(id) ?? null;
    const frMax = ds ? dtypeMax(ds.manifest.images[0].multiscale.data_type) : 65535;

    const chSettings = settings?.channel_settings?.[currentC];

    // One row per DRAWABLE label, keyed by manifest index. Visibility mirrors
    // `resolveVisibleLabels` (the render path) EXACTLY so the toggle state and
    // the drawn set never disagree: with settings present, the stored flag (a
    // missing/short entry → hidden); with NO settings (a snapshot predating
    // per-label seeding), only the FIRST drawable label shows.
    const rawLabelSettings = settings?.label_settings;
    const hasLabelSettings = !!rawLabelSettings && rawLabelSettings.length > 0;
    const labelRows = ds
      ? eligibleLabelInfos(ds.manifest).map((e, orderIdx) => {
          const ls = rawLabelSettings?.[e.index];
          return {
            index: e.index,
            name: e.name,
            visible: hasLabelSettings ? (ls?.visible ?? false) : orderIdx === 0,
            opacity: ls?.opacity ?? 0.5,
          };
        })
      : [];

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
      autoContrast: maps.autoContrast.get(id) ?? true,
      fullRange: maps.fullRange.get(id) ?? false,
      dataRange: dr,
      fullRangeMax: frMax,
      channelSettings: settings?.channel_settings,
      // Immutable channel labels from the manifest's omero block (positional;
      // may be absent/short — LayerPanel falls back to `Ch {i}` per index).
      channelInfos: ds?.manifest.images[0]?.multiscale.channel_infos,
      // Per-label rows for the Labels subsection + count badge (drawable only).
      labelRows: labelRows.length > 0 ? labelRows : undefined,
      channelBlendMode: settings?.channel_blend_mode ?? "additive",
      detailLevelOverride: settings?.detail_level_override ?? null,
      detailLevelOptions: detailLevelOptions(ds),
    };
  });
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
      applySettingsCommand(scene, { type: "set_dataset_visible", dataset_id: id, visible }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetOpacity = useCallback((id: string, opacity: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_opacity", dataset_id: id, opacity }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetContrast = useCallback((id: string, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      const c = scene.c();
      applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min, max }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, false); return next; });
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetGamma = useCallback((id: string, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      const c = scene.c();
      applySettingsCommand(scene, { type: "set_channel_gamma", dataset_id: id, channel: c, gamma }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetColormap = useCallback((id: string, colormap: Colormap) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      const c = scene.c();
      applySettingsCommand(scene, { type: "set_channel_colormap", dataset_id: id, channel: c, colormap }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  // Channel-specific handlers for multi-channel sublayer controls
  const handleChannelSetVisible = useCallback((id: string, channel: number, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_visible", dataset_id: id, channel, visible }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetColormap = useCallback((id: string, channel: number, colormap: Colormap) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_colormap", dataset_id: id, channel, colormap }, loopRef.current);
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
      applySettingsCommand(scene, { type: "set_channel_name", dataset_id: id, channel, name }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetContrast = useCallback((id: string, channel: number, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel, min, max }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetGamma = useCallback((id: string, channel: number, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_gamma", dataset_id: id, channel, gamma }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleChannelSetBlendMode = useCallback((id: string, blendMode: BlendMode) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_blend_mode", dataset_id: id, blend_mode: blendMode }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  // Per-label overlay handlers. Mirror handleChannelSetVisible exactly (a
  // viewport/display command — applies locally, breaks follow, marks dirty,
  // emits presence so followers see it via the selection epoch), scoped to a
  // single label overlay. Toggling / adjusting a label NEVER reframes the
  // camera (view-state only), mirroring the per-channel behavior.
  const handleLabelSetVisible = useCallback((id: string, label: number, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_label_visible", dataset_id: id, label, visible }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLabelSetOpacity = useCallback((id: string, label: number, opacity: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_label_opacity", dataset_id: id, label, opacity }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetBlendMode = useCallback((id: string, mode: BlendMode) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_blend_mode", dataset_id: id, blend_mode: mode }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetRenderMode = useCallback((id: string, mode: RenderMode) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_render_mode", dataset_id: id, render_mode: mode }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const handleLayerSetDetailLevelOverride = useCallback((id: string, level: number | null) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_detail_level_override", dataset_id: id, level }, loopRef.current);
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
        applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max }, loopRef.current);
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
            applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max }, loopRef.current);
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
          applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: 0, max: frMax }, loopRef.current);
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, false); return n; });
        } else {
          const dr = dataRangeMap.get(id);
          if (dr) {
            applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max }, loopRef.current);
          } else {
            // No recorded data range to return to: the scene is unchanged,
            // but keep the frame this toggle has always requested so the
            // panel state flip is reflected promptly.
            requestRender(loopRef.current);
          }
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, true); return n; });
        }
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
    applySettingsCommand(scene, { type: "set_dataset_order", order }, loopRef.current);
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

  // buildLayerInfos (the module-scope pure fn) reads the scene + datasets refs
  // and the state maps; all are mirrored from state via the version counters
  // above (datasetsVersion, remoteDocumentVersion, layerSettingsVersion) so
  // re-renders pick up the latest values. Reading the refs during render is
  // intentional here (the layer panel view models are derived per render).
  // eslint-disable-next-line react-hooks/refs
  const scene = wasmSceneRef.current;
  // eslint-disable-next-line react-hooks/refs
  const datasets = datasetsRef.current;
  const layerInfos = scene
    ? buildLayerInfos(scene, datasets, {
        autoContrast: autoContrastMap,
        fullRange: fullRangeMap,
        dataRange: dataRangeMap,
      })
    : [];
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
    handleLabelSetVisible,
    handleLabelSetOpacity,
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
