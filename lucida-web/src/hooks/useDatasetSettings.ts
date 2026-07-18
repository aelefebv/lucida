import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import type { LayerInfo } from "../components/LayerPanel.tsx";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { DatasetState, ViewMode } from "../types.ts";
import { dtypeMax } from "../types.ts";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { ViewportCommand } from "../commands.ts";
import type { BlendMode, Colormap, RenderMode } from "../savedView/types.ts";
import type { ViewportMutationOptions } from "../viewportCoordinator.ts";
import { requestRender } from "../invalidation.ts";
import { Axis } from "../axes.ts";
import { eligibleLabelInfos, volumeBudgetPrefix } from "../pipeline/planning/labelRequests.ts";
import {
  resolveLabelSettings,
  type LabelSettings,
} from "../labelSettings.ts";
import { intensityRangeKey } from "./useIntensityBatcher.ts";

/** A per-label overlay row for the layer panel, keyed by manifest index. */
interface PanelLabelRow {
  index: number;
  name: string;
  visible: boolean;
  opacity: number;
  disabledReason?: string;
}

/**
 * The per-label rows for one dataset, VIEW-MODE-AWARE.
 *
 * The panel lists every label drawable in EITHER view mode (the union of the
 * slice- and volume-eligible sets), so it is stable across a 2D/3D switch. A
 * label drawable in the CURRENT mode is a normal, interactive row; a label
 * drawable ONLY in the other mode carries a `disabledReason` so its controls
 * render disabled with the reason shown — never an "on" toggle that draws
 * nothing (the render/fetch paths drop it under this mode's caps). Volume caps
 * are stricter than slice, so the realistic disabled case is a slice-eligible
 * label that busts the volume caps, viewed in 3D. Visibility mirrors
 * `resolveVisibleLabels` (the render path): masks are opt-in, so with settings
 * the stored flag drives it (a label with no explicit setting defaults to
 * HIDDEN), and with NO settings every row starts hidden — the panel still lists
 * every drawable mask so any can be toggled on with one click.
 *
 * In 3D there is a second disabled case: a visible + volume-eligible mask that
 * falls past the TOTAL label-volume memory budget. The panel applies the SAME
 * manifest-order budget prefix ({@link volumeBudgetPrefix}) the render path
 * does, and gives each budget-skipped mask a `disabledReason` naming the memory
 * limit — so it never renders as a plain interactive "on" row that draws
 * nothing. This is distinct from the "too large to render in 3D" reason a
 * per-mask volume-INELIGIBLE label carries.
 */
function buildLabelRows(
  manifest: DatasetManifest,
  rawLabelSettings: LabelSettings[] | undefined,
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
  const rows: PanelLabelRow[] = [];
  for (let i = 0; i < labels.length; i++) {
    const drawableInEitherMode = sliceEligible.has(i) || volumeEligible.has(i);
    if (!drawableInEitherMode) continue; // drawable in neither → omitted

    const drawableNow = currentEligible.has(i);
    const setting = resolveLabelSettings(rawLabelSettings, i);
    const row: PanelLabelRow = {
      index: i,
      name: labels[i].name,
      // Masks are opt-in: a label with no explicit setting defaults to HIDDEN; an
      // explicit flag is honored. With NO settings, every row starts hidden.
      // Mirrors `resolveVisibleLabels`.
      visible: setting.visible,
      opacity: setting.opacity,
    };
    if (!drawableNow) {
      row.disabledReason = is3d
        ? "too large to render in 3D"
        : "too large to render in 2D";
    }
    rows.push(row);
  }

  // 3D total-volume memory fail-safe: over the VISIBLE + volume-eligible rows in
  // manifest order, keep masks up to the memory budget and mark the rest
  // disabled — the SAME manifest-order prefix the render path applies, so the
  // panel and the screen agree on which masks 3D actually shows.
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
  label_settings?: LabelSettings[];
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
 * Label rows are VIEW-MODE-AWARE (see {@link buildLabelRows}): they list every
 * label drawable in either mode, each carrying its MANIFEST index so the
 * toggle / opacity handlers target the right `label_settings` entry even when
 * earlier (ineligible) labels are omitted, and a `disabledReason` when a label
 * can't draw in the CURRENT mode — a control never lies about a label that
 * can't render. `viewMode` defaults to `"2d"` (slice caps) so 3-arg callers
 * keep today's behavior.
 */
export function buildLayerInfos(
  scene: WasmScene,
  datasets: Map<string, DatasetState>,
  maps: {
    autoContrast: Map<string, boolean>;
    fullRange: Map<string, boolean>;
    dataRange: Map<string, { min: number; max: number }>;
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

  const currentC = scene.c();

  return layerOrder.slice().reverse().map((id) => {
    const settings = allSettings[id];
    const ds = datasets.get(id);
    const dr = maps.dataRange.get(intensityRangeKey(id, currentC)) ?? null;
    const frMax = ds ? dtypeMax(ds.manifest.images[0].multiscale.data_type) : 65535;

    const chSettings = settings?.channel_settings?.[currentC];

    // One row per label drawable in EITHER view mode, keyed by manifest index
    // (see buildLabelRows). Visibility mirrors `resolveVisibleLabels` (the
    // render path); a row not drawable in the CURRENT mode carries a
    // disabledReason so the panel never shows an "on" toggle that draws nothing.
    const rawLabelSettings = settings?.label_settings;
    const labelRows = ds ? buildLabelRows(ds.manifest, rawLabelSettings, viewMode) : [];

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

export interface SceneMutationCallbacks {
  sendCommand: (json: string) => void;
  /** Delegates every local camera/view/display write to the host's one effect
   * coordinator. Raw presence, follow, URL, and repaint callbacks are
   * intentionally not exposed here, so a hook cannot assemble a partial
   * side-effect sequence. */
  mutateViewport: (
    commands: ViewportCommand | readonly ViewportCommand[],
    options: ViewportMutationOptions,
  ) => boolean;
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
  bridgeCallbacksRef: React.RefObject<SceneMutationCallbacks>;
  datasetCallbacksRef: React.RefObject<DatasetCallbacks>;
  datasetsVersion: number;
  remoteDocumentVersion: number;
  /** Active view mode. Drives the label rows' eligibility caps (slice vs volume)
   *  so the panel marks labels that can't draw in the current mode as disabled. */
  viewMode: ViewMode;
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
    setDataRangeMap(prev => {
      const next = new Map(prev);
      const prefix = `${id}\u0000`;
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) next.delete(key);
      }
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

  // Every local display mutation crosses the same coordinator boundary as
  // camera and dimension changes. Besides eliminating repeated partial
  // side-effect bundles, this is the capture point for bounded local undo.
  const mutateDisplay = useCallback((
    command: ViewportCommand,
    source: string,
    label: string,
    continuous = false,
  ) => bridgeCallbacksRef.current.mutateViewport(command, {
    source,
    invalidation: "display",
    publication: "dataset-presence",
    history: continuous
      ? { label, coalesceKey: source, coalesceWindowMs: 250 }
      : { label },
  }), [bridgeCallbacksRef]);

  const handleLayerSetVisible = useCallback((id: string, visible: boolean) => {
    if (mutateDisplay(
      { type: "set_dataset_visible", dataset_id: id, visible },
      "dataset_visibility",
      "layer visibility",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLayerSetOpacity = useCallback((id: string, opacity: number) => {
    if (mutateDisplay(
      { type: "set_dataset_opacity", dataset_id: id, opacity },
      "dataset_opacity",
      "layer opacity",
      true,
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLayerSetContrast = useCallback((id: string, min: number, max: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      const c = scene.c();
      mutateDisplay(
        { type: "set_channel_contrast", dataset_id: id, channel: c, min, max },
        "dataset_contrast",
        "contrast",
        true,
      );
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, false); return next; });
  }, [wasmSceneRef, mutateDisplay]);

  const handleLayerSetGamma = useCallback((id: string, gamma: number) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      const c = scene.c();
      mutateDisplay(
        { type: "set_channel_gamma", dataset_id: id, channel: c, gamma },
        "dataset_gamma",
        "gamma",
        true,
      );
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, mutateDisplay]);

  const handleLayerSetColormap = useCallback((id: string, colormap: Colormap) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      const c = scene.c();
      mutateDisplay(
        { type: "set_channel_colormap", dataset_id: id, channel: c, colormap },
        "dataset_colormap",
        "colormap",
      );
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [wasmSceneRef, mutateDisplay]);

  // Channel-specific handlers for multi-channel sublayer controls
  const handleChannelSetVisible = useCallback((id: string, channel: number, visible: boolean) => {
    if (mutateDisplay(
      { type: "set_channel_visible", dataset_id: id, channel, visible },
      "channel_visibility",
      "channel visibility",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleChannelSetColormap = useCallback((id: string, channel: number, colormap: Colormap) => {
    if (mutateDisplay(
      { type: "set_channel_colormap", dataset_id: id, channel, colormap },
      "channel_colormap",
      "channel colormap",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  // Set (or clear) a user display-name override for one channel. A
  // viewport/display command exactly like handleChannelSetColormap — applies
  // locally, breaks follow, marks dirty, and emits presence so followers see
  // it via the selection epoch. `name === null` (an emptied input) clears the
  // override, falling the label back to the omero name / `Ch N`. Whitespace is
  // trimmed before this is called; the caller passes null for a blank value.
  const handleChannelSetName = useCallback((id: string, channel: number, name: string | null) => {
    if (mutateDisplay(
      { type: "set_channel_name", dataset_id: id, channel, name },
      "channel_name",
      "channel name",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleChannelSetContrast = useCallback((id: string, channel: number, min: number, max: number) => {
    if (mutateDisplay(
      { type: "set_channel_contrast", dataset_id: id, channel, min, max },
      "channel_contrast",
      "channel contrast",
      true,
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleChannelSetGamma = useCallback((id: string, channel: number, gamma: number) => {
    if (mutateDisplay(
      { type: "set_channel_gamma", dataset_id: id, channel, gamma },
      "channel_gamma",
      "channel gamma",
      true,
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleChannelSetBlendMode = useCallback((id: string, blendMode: BlendMode) => {
    if (mutateDisplay(
      { type: "set_channel_blend_mode", dataset_id: id, blend_mode: blendMode },
      "channel_blend_mode",
      "channel blend mode",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  // Per-label overlay handlers. Mirror handleChannelSetVisible exactly (a
  // viewport/display command — applies locally, breaks follow, marks dirty,
  // emits presence so followers see it via the selection epoch), scoped to a
  // single label overlay. Toggling / adjusting a label NEVER reframes the
  // camera (view-state only), mirroring the per-channel behavior.
  const handleLabelSetVisible = useCallback((id: string, label: number, visible: boolean) => {
    if (mutateDisplay(
      { type: "set_label_visible", dataset_id: id, label, visible },
      "label_visibility",
      "label visibility",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLabelSetOpacity = useCallback((id: string, label: number, opacity: number) => {
    if (mutateDisplay(
      { type: "set_label_opacity", dataset_id: id, label, opacity },
      "label_opacity",
      "label opacity",
      true,
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLayerSetBlendMode = useCallback((id: string, mode: BlendMode) => {
    if (mutateDisplay(
      { type: "set_dataset_blend_mode", dataset_id: id, blend_mode: mode },
      "dataset_blend_mode",
      "layer blend mode",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLayerSetRenderMode = useCallback((id: string, mode: RenderMode) => {
    if (mutateDisplay(
      { type: "set_dataset_render_mode", dataset_id: id, render_mode: mode },
      "dataset_render_mode",
      "render mode",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLayerSetDetailLevelOverride = useCallback((id: string, level: number | null) => {
    if (mutateDisplay(
      { type: "set_dataset_detail_level_override", dataset_id: id, level },
      "dataset_detail_level",
      "detail level",
    )) {
      setLayerSettingsVersion((v) => v + 1);
    }
  }, [mutateDisplay]);

  const handleLayerAutoContrast = useCallback((id: string) => {
    const scene = wasmSceneRef.current;
    if (scene) {
      const c = scene.c();
      const dr = dataRangeMap.get(intensityRangeKey(id, c));
      if (dr) {
        mutateDisplay(
          { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max },
          "auto_contrast",
          "auto contrast",
        );
      }
    }
    setAutoContrastMap(prev => { const next = new Map(prev); next.set(id, true); return next; });
  }, [dataRangeMap, wasmSceneRef, mutateDisplay]);

  const handleLayerAutoContrastToggle = useCallback((id: string) => {
    setAutoContrastMap(prev => {
      const next = new Map(prev);
      const wasAuto = prev.get(id) ?? true;
      next.set(id, !wasAuto);
      if (!wasAuto) {
        const scene = wasmSceneRef.current;
        if (scene) {
          const c = scene.c();
          const dr = dataRangeMap.get(intensityRangeKey(id, c));
          if (dr) {
            mutateDisplay(
              { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max },
              "auto_contrast_toggle",
              "auto contrast",
            );
          }
        }
      }
      return next;
    });
  }, [dataRangeMap, wasmSceneRef, mutateDisplay]);

  const handleLayerFullRangeToggle = useCallback((id: string) => {
    setFullRangeMap(prev => {
      const next = new Map(prev);
      const wasFull = prev.get(id) ?? false;
      next.set(id, !wasFull);
      const scene = wasmSceneRef.current;
      if (scene) {
        const c = scene.c();
        if (!wasFull) {
          const ds = datasetsRef.current.get(id);
          const frMax = ds ? dtypeMax(ds.manifest.images[0].multiscale.data_type) : 65535;
          mutateDisplay(
            { type: "set_channel_contrast", dataset_id: id, channel: c, min: 0, max: frMax },
            "full_range_toggle",
            "full range",
          );
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, false); return n; });
        } else {
          const dr = dataRangeMap.get(intensityRangeKey(id, c));
          if (dr) {
            mutateDisplay(
              { type: "set_channel_contrast", dataset_id: id, channel: c, min: dr.min, max: dr.max },
              "full_range_toggle",
              "full range",
            );
          } else {
            // No recorded data range to return to: the scene is unchanged,
            // but keep the frame this toggle has always requested so the
            // panel state flip is reflected promptly.
            requestRender(loopRef.current);
          }
          setAutoContrastMap(p => { const n = new Map(p); n.set(id, true); return n; });
        }
      }
      return next;
    });
  }, [dataRangeMap, wasmSceneRef, datasetsRef, loopRef, mutateDisplay]);

  const handleLayerMove = useCallback((id: string, direction: "up" | "down") => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const order: string[] = JSON.parse(scene.dataset_order());
    const idx = order.indexOf(id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= order.length) return;
    [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
    mutateDisplay(
      { type: "set_dataset_order", order },
      "dataset_order",
      "layer order",
    );
    setLayerSettingsVersion((v) => v + 1);
  }, [wasmSceneRef, mutateDisplay]);

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
