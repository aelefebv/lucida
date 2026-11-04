// Builds a `SavedView` from the live scene and tracked dataset state, with no
// side effects and no DOM. The shapes mirror `export_presence` and
// `export_dataset_presence` in `lucida-core/src/wasm.rs`.

import type { WasmScene } from "lucida-core";
import { is_local_dataset_url } from "lucida-core";
import type {
  Camera,
  DatasetId,
  DatasetDisplaySettings,
  DisplayState,
  DatasetReferenceMode,
  LayoutId,
  SavedView,
  ViewState,
} from "./types.ts";
import { SAVED_VIEW_VERSION } from "./types.ts";

/**
 * Maps a source-derived global `DatasetId` (`ds-{blake3-prefix}`) back to the
 * URL it was opened from. Local opens and peers' `DatasetOpened` broadcasts
 * fill it. A dataset with no entry (e.g. one that arrived in a reconnect
 * snapshot) is left out of `SavedView.datasets`.
 */
export type UrlByDatasetId = ReadonlyMap<DatasetId, string>;
export type AutoContrastByDatasetId = ReadonlyMap<DatasetId, boolean>;
/** Resolves a dataset's current label names in manifest (`labels[]`) order, the
 *  order per-label settings index into, so a restore can key per-label state by
 *  name and occurrence. */
export type LabelNamesByDatasetId = (datasetId: DatasetId) => string[] | undefined;

export interface CaptureInputs {
  scene: WasmScene;
  urlByDatasetId: UrlByDatasetId;
  /** Global saved views identify datasets by source URL. Workspace
   *  inline views identify already-loaded datasets by workspace-local
   *  DatasetId and intentionally leave `datasets` empty so source URLs
   *  do not enter copied links. */
  datasetReferenceMode?: DatasetReferenceMode;
  /** From `useDatasetSettings.autoContrastMap`. */
  autoContrastByDatasetId?: AutoContrastByDatasetId;
  /**
   * The live Z/T/C selection from React dimension state, captured verbatim as
   * `view`. Preferred over the scene's presence export, which can lag React
   * (the scene writes sit behind an `if (scene)` guard) and then reports the
   * default slab, which the encoder strips. Falls back to the scene's view.
   */
  liveView?: ViewState;
  /** When omitted, `label_names` stays as the scene export carried it and the
   *  restore falls back to positional matching. */
  labelNamesFor?: LabelNamesByDatasetId;
}

/**
 * Build a `SavedView` from the live scene state. Datasets without a known URL
 * are omitted, since a recipient could not open them.
 */
export function buildCapture({
  scene,
  urlByDatasetId,
  datasetReferenceMode = "source-url",
  autoContrastByDatasetId,
  liveView,
  labelNamesFor,
}: CaptureInputs): SavedView {
  const presence = JSON.parse(scene.export_presence()) as {
    camera: Camera;
    view: ViewState;
    display: DisplayState;
  };

  const view: ViewState = liveView ?? presence.view;
  const datasetPresence = JSON.parse(scene.export_dataset_presence()) as {
    dataset_order: DatasetId[];
    dataset_settings: Record<DatasetId, DatasetDisplaySettings>;
  };

  // A dataset with no labels leaves the field absent, matching the Rust
  // `skip_serializing_if = "Vec::is_empty"`.
  if (labelNamesFor) {
    for (const [id, s] of Object.entries(datasetPresence.dataset_settings)) {
      const names = labelNamesFor(id);
      if (names && names.length > 0) {
        s.label_names = names;
      }
    }
  }

  // `available_layouts(id)` carries the active marker; keep the active id.
  const activeLayouts: Record<DatasetId, LayoutId> = {};
  const datasetIds = JSON.parse(scene.dataset_ids()) as DatasetId[];
  for (const dsId of datasetIds) {
    const layouts = JSON.parse(scene.available_layouts(dsId)) as Array<{
      id: string;
      name: string;
      active?: boolean;
    }>;
    const active = layouts.find((l) => l.active);
    if (active) {
      activeLayouts[dsId] = active.id;
    }
  }

  // Global views list source URLs for the recipient to open. Workspace views
  // leave them out: the workspace document owns membership, and source URLs
  // must not enter copied links.
  const orderedUrls: string[] = [];
  if (datasetReferenceMode === "source-url") {
    for (const dsId of datasetPresence.dataset_order) {
      const url = urlByDatasetId.get(dsId);
      if (url !== undefined) orderedUrls.push(url);
    }
    // Defensive: datasets missing from the order list.
    for (const dsId of datasetIds) {
      if (datasetPresence.dataset_order.includes(dsId)) continue;
      const url = urlByDatasetId.get(dsId);
      if (url !== undefined) orderedUrls.push(url);
    }
  }

  // The decoder reads absence as true, but both values are captured and the
  // encoder strips defaults.
  const autoContrast: Record<DatasetId, boolean> = {};
  if (autoContrastByDatasetId) {
    for (const dsId of datasetIds) {
      const flag = autoContrastByDatasetId.get(dsId);
      if (flag !== undefined) autoContrast[dsId] = flag;
    }
  }

  return {
    v: SAVED_VIEW_VERSION,
    datasets: orderedUrls,
    active_layouts: activeLayouts,
    camera: presence.camera,
    view,
    display: presence.display,
    dataset_order: datasetPresence.dataset_order,
    dataset_settings: datasetPresence.dataset_settings,
    auto_contrast: Object.keys(autoContrast).length > 0 ? autoContrast : undefined,
  };
}

/** True if any URL is a local-file path. The share toolbar warns that such a
 * view is personal-only (ADR 0014). */
export function hasLocalFilePaths(view: SavedView): boolean {
  return view.datasets.some(isLocalFilePath);
}

export function localFilePathCount(view: SavedView): number {
  return view.datasets.filter(isLocalFilePath).length;
}

/**
 * Delegates to the wasm `is_local_dataset_url` so the share warning shares one
 * classifier with the Rust server. Callers pass canonical URLs (ADR 0042):
 * `useDatasets.handleUrlSubmit` and the server normalize them upstream.
 */
function isLocalFilePath(url: string): boolean {
  return is_local_dataset_url(url);
}
