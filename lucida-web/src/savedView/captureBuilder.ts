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
 * Maps a source-derived global `DatasetId` (`ds-{blake3-prefix}`) back
 * to the URL it was opened from. Populated whenever the local client calls
 * `sendOpenRemoteDataset(url)` and persists across the session — peers'
 * `DatasetOpened` broadcasts re-fill it through `dataset_id_for_url`.
 *
 * Datasets opened *before* this map was wired up (e.g. via a snapshot
 * during reconnect) won't have an entry here and will be omitted from
 * `SavedView.datasets` — the recipient will only see the URLs the
 * sender actually has source-of-truth for.
 */
export type UrlByDatasetId = ReadonlyMap<DatasetId, string>;
export type AutoContrastByDatasetId = ReadonlyMap<DatasetId, boolean>;
export type LabelNamesByDatasetId = ReadonlyMap<DatasetId, readonly string[]>;

export interface CaptureInputs {
  scene: WasmScene;
  /** URL→DatasetId map maintained alongside dataset opens. */
  urlByDatasetId: UrlByDatasetId;
  /** Global saved views identify datasets by source URL. Workspace
   *  inline views identify already-loaded datasets by workspace-local
   *  DatasetId and intentionally leave `datasets` empty so source URLs
   *  do not enter copied links. */
  datasetReferenceMode?: DatasetReferenceMode;
  /** Per-dataset auto-contrast flag, sourced from
   *  `useDatasetSettings.autoContrastMap`. Optional — omitted when no
   *  per-dataset preference has been set. */
  autoContrastByDatasetId?: AutoContrastByDatasetId;
  /** Per-dataset label names in manifest (OME `labels`) order, sourced from
   *  the caller's loaded manifests. `label_settings` is positional against
   *  the label list at capture time, so each captured entry is stamped with
   *  its label's NAME — the stable key a later restore uses when the
   *  dataset's label list has since changed (re-imports reorder/add/remove
   *  labels). When provided, this map is AUTHORITATIVE for the datasets it
   *  covers; datasets it omits (and captures without it) keep whatever names
   *  the scene's own settings export carries (the scene seeds them from the
   *  manifest on open). */
  labelNamesByDatasetId?: LabelNamesByDatasetId;
  /**
   * The authoritative live Z/T/C selection, sourced from the React
   * dimension state rather than the scene's presence export.
   *
   * Why this exists: the live React Z/T/C sliders are not always pushed
   * into the WASM scene before a "Save view" (e.g. a peer-follow update,
   * a bootstrap restore, or the dim-clamp effect can move React state
   * while the scene's `set_z`/`set_t`/`set_c` write is gated behind an
   * `if (scene)` guard or simply hasn't fired yet). When that happens,
   * `scene.export_presence().view` reports the *default* `z_range {0,1}`
   * (t/c = 0), which the encoder then strips — silently losing the user's
   * actual slab/timepoint/channel.
   *
   * When provided, this view is captured verbatim as the `view` field,
   * preserving the FULL `z_range` slab (start AND end), `t`, `c`, and
   * `multi_channel`. When omitted, we fall back to the scene's presence
   * export (legacy behavior) so other callers are unaffected.
   */
  liveView?: ViewState;
}

/**
 * Build a `SavedView` capture record from the live scene state.
 *
 * Datasets without a known URL are omitted — there's no way to round-trip
 * them to a recipient. (See [[decisions/0014-local-file-datasets-personal-only-in-saved-views]]
 * for the local-file warning that the share button surfaces.)
 */
export function buildCapture({
  scene,
  urlByDatasetId,
  datasetReferenceMode = "source-url",
  autoContrastByDatasetId,
  labelNamesByDatasetId,
  liveView,
}: CaptureInputs): SavedView {
  const presence = JSON.parse(scene.export_presence()) as {
    camera: Camera;
    view: ViewState;
    display: DisplayState;
  };

  // Capture the authoritative live Z/T/C when the caller supplied it,
  // since the React dimension state — not the scene's presence export —
  // is the source of truth for what the user is actually looking at. The
  // full `z_range` slab (start AND end), `t`, `c`, and `multi_channel`
  // are all preserved. Falls back to the scene's `view` when no live
  // state is passed (keeps legacy callers unchanged).
  const view: ViewState = liveView ?? presence.view;
  const datasetPresence = JSON.parse(scene.export_dataset_presence()) as {
    dataset_order: DatasetId[];
    dataset_settings: Record<DatasetId, DatasetDisplaySettings>;
  };
  const datasetSettings = withLabelNames(
    datasetPresence.dataset_settings,
    labelNamesByDatasetId,
  );

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

  // Datasets list: in global mode, ordered source URLs tell the
  // recipient what to open. In workspace mode, membership is owned by
  // the workspace document already, so the view only carries
  // workspace-local dataset IDs in `dataset_order`/settings/layouts and
  // leaves source URLs out of the copied hash.
  const orderedUrls: string[] = [];
  if (datasetReferenceMode === "source-url") {
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
  }

  // auto-contrast: capture the per-dataset preference for every dataset
  // we know the URL for. The decoder treats absence as "true" (the
  // default for new datasets), so we only need to emit explicit `false`
  // entries — but we capture both for forward-compat (the encoder strips
  // defaults).
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
    dataset_settings: datasetSettings,
    auto_contrast: Object.keys(autoContrast).length > 0 ? autoContrast : undefined,
  };
}

/** Stamp each captured `label_settings` entry with its label's manifest NAME
 * (positional at capture time: entry `i` controls label `i` of the CURRENT
 * list, so `names[i]` is its name). The caller-supplied manifest names are
 * authoritative for the datasets they cover; entries beyond the supplied list
 * — or datasets the map omits — keep whatever the scene export carried.
 * Non-mutating: returns fresh objects for the settings it re-stamps. */
function withLabelNames(
  settings: Record<DatasetId, DatasetDisplaySettings>,
  labelNamesByDatasetId?: LabelNamesByDatasetId,
): Record<DatasetId, DatasetDisplaySettings> {
  if (!labelNamesByDatasetId || labelNamesByDatasetId.size === 0) return settings;
  const out: Record<DatasetId, DatasetDisplaySettings> = {};
  for (const [dsId, s] of Object.entries(settings)) {
    const names = labelNamesByDatasetId.get(dsId);
    if (!names || !s.label_settings || s.label_settings.length === 0) {
      out[dsId] = s;
      continue;
    }
    out[dsId] = {
      ...s,
      label_settings: s.label_settings.map((ls, i) =>
        names[i] !== undefined ? { ...ls, name: names[i] } : ls,
      ),
    };
  }
  return out;
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

/**
 * Delegates to the wasm-shimmed `is_local_dataset_url` so the SPA's
 * share-warning classifier shares one implementation with the Rust
 * server and storage layer. See
 * [[decisions/0042-canonical-dataset-url-form]] for the canonical-form
 * contract: callers pass the already-canonical URL (URLs in
 * `SavedView.datasets` are normalized at submit-time by
 * `useDatasets.handleUrlSubmit`, and `DatasetOpened` broadcasts carry
 * server-normalized URLs).
 */
function isLocalFilePath(url: string): boolean {
  return is_local_dataset_url(url);
}
