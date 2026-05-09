// Reads the live scene + tracked dataset state and produces a `SavedView`.
// Pure-ish: reads from `WasmScene` and the URL→DatasetId map, returns a
// data-only struct. No side effects, no DOM. Caller is responsible for
// passing a freshly-imported view.
//
// The natural co-tap point for "scene state changed" is the same path
// that emits presence — see `useBridge.emitPresence` and
// `lucida-core/src/wasm.rs` `export_presence` / `export_dataset_presence`
// for the wire shapes this mirrors.

import type { WasmScene } from "lucida-core";
import type {
  Camera,
  DatasetId,
  DatasetDisplaySettings,
  DisplayState,
  LayoutId,
  SavedView,
  ViewState,
} from "./types.ts";
import { SAVED_VIEW_VERSION } from "./types.ts";

/**
 * Maps a `DatasetId` (server's `ds-{blake3-prefix}`) back to the URL it
 * was opened from. Populated whenever the local client calls
 * `sendOpenRemoteDataset(url)` and persists across the session — peers'
 * `DatasetOpened` broadcasts re-fill it through `dataset_id_for_url`.
 *
 * Datasets opened *before* this map was wired up (e.g. via a snapshot
 * during reconnect) won't have an entry here and will be omitted from
 * `SavedView.datasets` — the recipient will only see the URLs the
 * sender actually has source-of-truth for.
 */
export type UrlByDatasetId = ReadonlyMap<DatasetId, string>;

export interface CaptureInputs {
  scene: WasmScene;
  /** URL→DatasetId map maintained alongside dataset opens. */
  urlByDatasetId: UrlByDatasetId;
}

/**
 * Build a `SavedView` capture record from the live scene state.
 *
 * Datasets without a known URL are omitted — there's no way to round-trip
 * them to a recipient. (See [[decisions/0014-local-file-datasets-personal-only-in-saved-views]]
 * for the local-file warning that the share button surfaces.)
 */
export function buildCapture({ scene, urlByDatasetId }: CaptureInputs): SavedView {
  const presence = JSON.parse(scene.export_presence()) as {
    camera: Camera;
    view: ViewState;
    display: DisplayState;
  };
  const datasetPresence = JSON.parse(scene.export_dataset_presence()) as {
    dataset_order: DatasetId[];
    dataset_settings: Record<DatasetId, DatasetDisplaySettings>;
  };

  // Active layouts — read from WASM. `dataset_ids()` returns ALL loaded
  // datasets; `available_layouts(id)` is keyed by dataset and includes
  // the active marker. We need the active id per dataset.
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

  // Datasets list: ordered to match `dataset_order` so the recipient
  // opens them in the same order; URLs we don't know are skipped.
  const orderedUrls: string[] = [];
  for (const dsId of datasetPresence.dataset_order) {
    const url = urlByDatasetId.get(dsId);
    if (url !== undefined) orderedUrls.push(url);
  }
  // Pick up any datasets not in the order list (defensive — should be rare).
  for (const dsId of datasetIds) {
    if (datasetPresence.dataset_order.includes(dsId)) continue;
    const url = urlByDatasetId.get(dsId);
    if (url !== undefined) orderedUrls.push(url);
  }

  return {
    v: SAVED_VIEW_VERSION,
    datasets: orderedUrls,
    active_layouts: activeLayouts,
    camera: presence.camera,
    view: presence.view,
    display: presence.display,
    dataset_order: datasetPresence.dataset_order,
    dataset_settings: datasetPresence.dataset_settings,
  };
}

/** True if any URL is a local-file path. Used by the share toolbar to
 * surface the personal-only warning per
 * [[decisions/0014-local-file-datasets-personal-only-in-saved-views]]. */
export function hasLocalFilePaths(view: SavedView): boolean {
  return view.datasets.some(isLocalFilePath);
}

export function localFilePathCount(view: SavedView): number {
  return view.datasets.filter(isLocalFilePath).length;
}

function isLocalFilePath(url: string): boolean {
  return url.startsWith("/") || url.startsWith("file://");
}
