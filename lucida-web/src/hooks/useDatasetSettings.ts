import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import type { LayerInfo } from "../components/LayerPanel.tsx";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { DatasetState, ViewMode } from "../types.ts";
import { dtypeRange } from "../types.ts";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import type { ViewportCommand } from "../commands.ts";
import type { BlendMode, Colormap, RenderMode } from "../savedView/types.ts";
import { invalidateDisplaySettings, invalidateSelection } from "../invalidation.ts";
import { Axis } from "../axes.ts";
import { eligibleLabelInfos, volumeBudgetPrefix } from "../pipeline/planning/labelRequests.ts";
import type { LevelsByView } from "../pipeline/datasetLevels.ts";
import type { ChannelFit } from "../pipeline/autoContrast.ts";
import { channelDisplayName, channelRangeKey, parseChannelRangeKey } from "../components/channels.ts";
import { readResolvedLayers } from "../resolvedLayers.ts";
import { readUnits, readUserTransform } from "../userTransform.ts";

/** A per-label overlay row for the layer panel, keyed by manifest index. */
interface PanelLabelRow {
  index: number;
  name: string;
  visible: boolean;
  opacity: number;
  disabledReason?: string;
}

/**
 * The per-label rows for one dataset, aware of the view mode.
 *
 * Lists every label drawable in either mode, so the panel is stable across a
 * 2D/3D switch. A label drawable only in the other mode, or past the 3D
 * label-volume memory budget ({@link volumeBudgetPrefix}, the same prefix the
 * render path applies), gets a `disabledReason`. A control must never show "on"
 * for a label that draws nothing. Visibility mirrors `resolveVisibleLabels`:
 * masks are opt-in, so a label with no explicit setting starts hidden.
 */
function buildLabelRows(
  manifest: DatasetManifest,
  rawLabelSettings: { visible: boolean; opacity: number }[] | undefined,
  viewMode: ViewMode,
): PanelLabelRow[] {
  const labels = manifest.labels;
  if (!labels || labels.length === 0) return [];
  const sliceEligible = new Set(
    eligibleLabelInfos(manifest, { mode: "slice" }).map((e) => e.index),
  );
  const volumeEligible = new Set(
    eligibleLabelInfos(manifest, { mode: "volume" }).map((e) => e.index),
  );
  const is3d = viewMode === "3d";
  const currentEligible = is3d ? volumeEligible : sliceEligible;
  const hasLabelSettings = !!rawLabelSettings && rawLabelSettings.length > 0;

  const rows: PanelLabelRow[] = [];
  for (let i = 0; i < labels.length; i++) {
    const drawableInEitherMode = sliceEligible.has(i) || volumeEligible.has(i);
    if (!drawableInEitherMode) continue; // drawable in neither → omitted

    const drawableNow = currentEligible.has(i);
    const ls = rawLabelSettings?.[i];
    const row: PanelLabelRow = {
      index: i,
      name: labels[i].name,
      visible: hasLabelSettings ? (ls?.visible ?? false) : false,
      opacity: ls?.opacity ?? 0.5,
    };
    if (!drawableNow) {
      row.disabledReason = is3d
        ? "too large to render in 3D"
        : "too large to render in 2D";
    }
    rows.push(row);
  }

  // Same manifest-order budget prefix as the render path, so the panel and the
  // screen agree on which masks 3D shows.
  if (is3d) {
    const candidateIndices = rows
      .filter((r) => volumeEligible.has(r.index) && r.visible)
      .map((r) => r.index);
    const kept = volumeBudgetPrefix(manifest, candidateIndices);
    for (const row of rows) {
      if (volumeEligible.has(row.index) && row.visible && !kept.has(row.index)) {
        row.disabledReason = "too large to render in 3D (memory budget)";
      }
    }
  }
  return rows;
}

/** Apply a display-settings command and signal the change: the planner's
 *  settings cache is invalidated and the render loop (when mounted) is asked
 *  for a frame, in one composed intent so neither tap can be forgotten.
 *  Showing or hiding a channel, a dataset, or a label is a select, so the
 *  trace recorder opens an interaction run under that name. */
function applySettingsCommand(
  scene: WasmScene,
  cmd: ViewportCommand,
  loop: RenderLoop | null,
): void {
  guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
  if (
    cmd.type === "set_dataset_visible" ||
    cmd.type === "set_channel_visible" ||
    cmd.type === "set_channel_solo" ||
    cmd.type === "set_label_visible"
  ) {
    invalidateSelection(loop);
  } else {
    invalidateDisplaySettings(loop);
  }
}

/**
 * The scene owns which levels a pin may hold (`pinnable_levels`). The
 * manifest only supplies each level's shape for the label.
 */
function levelPinOptions(
  scene: WasmScene,
  id: string,
  ds: DatasetState | undefined,
): { level: number; label: string }[] {
  const levels = ds?.manifest.images[0]?.multiscale.levels ?? [];
  return Array.from(scene.pinnable_levels(id), (level) => {
    const geometry = levels.find((candidate) => candidate.level_index === level);
    const shape = geometry ? ` (${geometry.shape[Axis.X]} x ${geometry.shape[Axis.Y]})` : "";
    return { level, label: `Level ${level}${shape}` };
  });
}

/** How many channel entries the scene holds for a dataset, at least one. */
function settingsChannelCount(scene: WasmScene | null, id: string): number {
  if (!scene) return 0;
  try {
    const all = JSON.parse(scene.all_dataset_settings()) as Record<string, RawDatasetSettings>;
    return Math.max(1, all[id]?.channel_settings?.length ?? 1);
  } catch {
    return 1;
  }
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
 * Derive the layer panel's view models from the live scene and dataset state.
 * Pure, so the scene-to-`LayerInfo` seam is unit-testable with a stub scene.
 * Label rows carry their manifest index, so handlers hit the right
 * `label_settings` entry even when earlier ineligible labels are omitted.
 */
export function buildLayerInfos(
  scene: WasmScene,
  datasets: Map<string, DatasetState>,
  maps: {
    autoContrast: Map<string, boolean>;
    /** Each channel's latest auto-contrast fit, keyed by {@link channelRangeKey}. */
    contrastFit: Map<string, ChannelFit>;
    /** The worker's per-dataset level readouts by view; a dataset it has not reported yet is absent. */
    levels: Map<string, LevelsByView>;
  },
  viewMode: ViewMode = "2d",
): LayerInfo[] {
  let layerOrder: string[];
  let allSettings: Record<string, RawDatasetSettings>;
  try {
    layerOrder = JSON.parse(scene.dataset_order());
    allSettings = JSON.parse(scene.all_dataset_settings());
  } catch {
    return [];
  }
  const activeView = scene.active_view();

  return layerOrder.slice().reverse().map((id) => {
    const settings = allSettings[id];
    const ds = datasets.get(id);
    const multiscale = ds?.manifest.images[0]?.multiscale;
    const dataType = multiscale?.data_type ?? "uint16";

    const rawLabelSettings = settings?.label_settings;
    const labelRows = ds ? buildLabelRows(ds.manifest, rawLabelSettings, viewMode) : [];
    // The readout is the active view's, as the label rows are. Another view
    // lays out levels of its own, which a bare number here would misstate.
    const levels = maps.levels.get(id)?.get(activeView) ?? null;

    // The data's channel count is authoritative; the settings may still be
    // growing to match it while the dataset registers.
    const rawChannels = settings?.channel_settings ?? [];
    const channelCount = Math.max(1, multiscale?.levels[0]?.shape[Axis.C] ?? rawChannels.length);
    const channels = Array.from({ length: channelCount }, (_, i) => {
      const raw = rawChannels[i];
      const label = multiscale?.channel_infos?.[i]?.label;
      return {
        name: channelDisplayName(i, raw?.name, label),
        nameOverride: raw?.name?.trim() ? raw.name : null,
        inheritedName: channelDisplayName(i, null, label),
        visible: raw?.visible ?? true,
        colormap: raw?.colormap ?? "gray",
        contrastMin: raw?.contrast_min ?? settings?.contrast_min ?? 0,
        contrastMax: raw?.contrast_max ?? settings?.contrast_max ?? 65535,
        gamma: raw?.gamma ?? settings?.gamma ?? 1,
        dataRange: maps.contrastFit.get(channelRangeKey(id, i))?.range ?? null,
      };
    });

    return {
      id,
      name: scene.dataset_name(id),
      visible: settings?.visible ?? true,
      opacity: settings?.opacity ?? 1,
      channels,
      blendMode: settings?.blend_mode ?? "alpha",
      renderMode: settings?.render_mode ?? "translucent",
      autoContrast: maps.autoContrast.get(id) ?? true,
      valueRange: dtypeRange(dataType),
      integerData: !dataType.toLowerCase().startsWith("float"),
      labelRows: labelRows.length > 0 ? labelRows : undefined,
      channelBlendMode: settings?.channel_blend_mode ?? "additive",
      levelPin: settings?.detail_level_override ?? null,
      levelPinOptions: levelPinOptions(scene, id, ds),
      targetLevel: levels?.target ?? null,
      displayedLevel: levels?.displayed ?? null,
      displayedCoarserThanTarget: levels?.coarserThanTarget ?? false,
      downsamplingMethod: ds?.manifest.images[0]?.multiscale.downsampling_method ?? null,
      physicalScale: scene.dataset_has_physical_scale(id),
      userTransform: readUserTransform(scene, id),
      units: readUnits(scene, id),
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
  /** Picks the label rows' eligibility caps (slice or volume). */
  viewMode: ViewMode;
  /** The worker's per-dataset target and displayed levels, by view (see `useDatasetLevels`). */
  datasetLevels: Map<string, LevelsByView>;
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
  viewMode,
  datasetLevels,
}: Params) {
  const [autoContrastMap, setAutoContrastMap] = useState<Map<string, boolean>>(new Map());
  const [contrastFitMap, setContrastFitMap] = useState<Map<string, ChannelFit>>(new Map());
  const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null);
  const [layerSettingsVersion, setLayerSettingsVersion] = useState(0);
  const lastAutoExpandedLayerRef = useRef<string | null>(null);
  // Event handlers read the latest map without depending on its identity.
  const autoContrastMapRef = useRef<Map<string, boolean>>(new Map());
  // eslint-disable-next-line react-hooks/refs
  autoContrastMapRef.current = autoContrastMap;
  const contrastFitMapRef = useRef<Map<string, ChannelFit>>(new Map());
  // eslint-disable-next-line react-hooks/refs
  contrastFitMapRef.current = contrastFitMap;

  const bumpLayerSettingsVersion = useCallback(() => {
    setLayerSettingsVersion((v) => v + 1);
  }, []);

  const initLayerMaps = useCallback((id: string) => {
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, true); return next; });
  }, []);

  const cleanupLayerMaps = useCallback((id: string) => {
    setAutoContrastMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    setContrastFitMap(prev => {
      const next = new Map(prev);
      for (const key of prev.keys()) if (parseChannelRangeKey(key)?.datasetId === id) next.delete(key);
      return next;
    });
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

  const handleChannelSetVisible = useCallback((id: string, channel: number, visible: boolean) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_visible", dataset_id: id, channel, visible }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  /** Show one channel of a layer alone, or its composite with `null`. Other
   *  layers keep what they show. */
  const handleChannelSetSolo = useCallback((id: string, channel: number | null) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_solo", dataset_id: id, channel }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  /** Solo a channel of a layer, or return the layer to its composite when the
   *  channel is already soloed. */
  const handleSoloChannel = useCallback((id: string, channel: number) => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const solo = readResolvedLayers(scene, scene.active_view()).get(id)?.solo ?? null;
    handleChannelSetSolo(id, solo === channel ? null : channel);
  }, [wasmSceneRef, handleChannelSetSolo]);

  const handleShowAllChannels = useCallback((id: string) => {
    handleChannelSetSolo(id, null);
  }, [handleChannelSetSolo]);

  const handleChannelSetColormap = useCallback((id: string, channel: number, colormap: Colormap) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_colormap", dataset_id: id, channel, colormap }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  // A viewport command, not a document edit: followers see it via presence.
  // `null` clears the override, falling back to the metadata label or
  // `Channel n`. The caller trims and passes null for a blank value.
  const handleChannelSetName = useCallback((id: string, channel: number, name: string | null) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_name", dataset_id: id, channel, name }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  const applyChannelContrast = useCallback((id: string, channel: number, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_channel_contrast", dataset_id: id, channel, min, max }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

  // A hand-set limit stops continuous auto-contrast for the layer, or the next
  // fit would replace it. The recorder hears it here, at the control, and not
  // where auto-contrast applies its fits, which are no one's input.
  const handleChannelSetContrast = useCallback((id: string, channel: number, min: number, max: number) => {
    loopRef.current?.markInput("contrast");
    applyChannelContrast(id, channel, min, max);
    setAutoContrastMap((prev) => (prev.get(id) === false ? prev : new Map(prev).set(id, false)));
  }, [applyChannelContrast, loopRef]);

  /** Set a channel's limits to its latest fit once. */
  const handleChannelAutoFit = useCallback((id: string, channel: number) => {
    const fit = contrastFitMap.get(channelRangeKey(id, channel));
    if (fit) applyChannelContrast(id, channel, fit.limits.min, fit.limits.max);
  }, [contrastFitMap, applyChannelContrast]);

  /** Keep every channel of the layer at its latest fit, or stop. */
  const handleAutoContrastChange = useCallback((id: string, on: boolean) => {
    setAutoContrastMap((prev) => new Map(prev).set(id, on));
    if (!on) return;
    const count = settingsChannelCount(wasmSceneRef.current, id);
    for (let channel = 0; channel < count; channel++) {
      const fit = contrastFitMap.get(channelRangeKey(id, channel));
      if (fit) applyChannelContrast(id, channel, fit.limits.min, fit.limits.max);
    }
  }, [contrastFitMap, wasmSceneRef, applyChannelContrast]);

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

  // Label settings are view state like channel settings: they never reframe
  // the camera.
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

  // The wire command keeps the field's old name. The core clamps the level
  // to the pinnable levels.
  const handleLayerSetLevelPin = useCallback((id: string, level: number | null) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      bridgeCallbacksRef.current.breakFollow();
      applySettingsCommand(scene, { type: "set_dataset_detail_level_override", dataset_id: id, level }, loopRef.current);
      bridgeCallbacksRef.current.emitDatasetPresence();
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, loopRef, bridgeCallbacksRef]);

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

  /** Remove a layer from the workspace, once a person has confirmed it. A
   *  peer's removal arrives through `datasetCallbacksRef` and is no input. */
  const removeLayer = useCallback((id: string) => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    loopRef.current?.markInput("remove");
    applyDocumentCommand(
      scene,
      { type: "remove_dataset", id },
      bridgeCallbacksRef.current.sendCommand,
      loopRef.current,
    );
    datasetCallbacksRef.current.removeDataset(id);
  }, [wasmSceneRef, bridgeCallbacksRef, datasetCallbacksRef, loopRef]);

  const handleRemoveLayer = useCallback((id: string) => {
    if (
      !confirm(
        `Remove "${datasetsRef.current.get(id)?.name ?? id}" from this workspace? This only removes the workspace layer; it does not delete upstream storage or cached data.`,
      )
    ) return;
    removeLayer(id);
  }, [datasetsRef, removeLayer]);

  // A document command: the server authorizes it editor-only, broadcasts it,
  // and persists it. A blank name is ignored here; the server rejects it too.
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

  // Reading refs during render is intentional: the view models are derived per
  // render, and the version counters below trigger the re-renders.
  // eslint-disable-next-line react-hooks/refs
  const scene = wasmSceneRef.current;
  // eslint-disable-next-line react-hooks/refs
  const datasets = datasetsRef.current;
  const layerInfos = scene
    ? buildLayerInfos(scene, datasets, {
        autoContrast: autoContrastMap,
        contrastFit: contrastFitMap,
        levels: datasetLevels,
      }, viewMode)
    : [];
  void datasetsVersion;
  void remoteDocumentVersion;
  void layerSettingsVersion;
  void selectedDatasetId;

  return {
    autoContrastMap,
    setAutoContrastMap,
    autoContrastMapRef,
    contrastFitMap,
    contrastFitMapRef,
    setContrastFitMap,
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
    handleChannelSetVisible,
    handleChannelSetSolo,
    handleSoloChannel,
    handleShowAllChannels,
    handleChannelSetColormap,
    handleChannelSetName,
    handleChannelSetContrast,
    handleChannelSetGamma,
    handleChannelSetBlendMode,
    handleChannelAutoFit,
    handleAutoContrastChange,
    handleLabelSetVisible,
    handleLabelSetOpacity,
    handleLayerSetBlendMode,
    handleLayerSetRenderMode,
    handleLayerSetLevelPin,
    handleLayerMove,
    handleRemoveLayer,
    removeLayer,
    handleLayerRename,
  };
}
