// Build the Explore panel's `requestThumbnail` function: turn a candidate child
// `SavedView` into an off-screen render of that view, reusing the minimap's
// coarse-overview render path (no per-tile iframe, no re-streaming).
//
// The split of labor mirrors the minimap (`minimapPath.ts::tickMinimap`):
//   - The *content* + *placement* of each layer (which member, its model matrix,
//     its contrast/gamma/colormap) come from the CURRENT scene + display
//     settings — identical for every thumbnail of a dataset, exactly as the
//     minimap draws them.
//   - Only the *camera* varies per candidate: the child view's camera, turned
//     into GPU matrices by the wasm `camera_matrices` helper (the thumbnail
//     analogue of `scene.minimap_camera`).
//
// We feed those layers + the child camera's `invViewProj`/`eye` to
// `client.thumbnailRender`, which renders the dataset's resident coarse overview
// texture from that angle and returns an `ImageBitmap`.

import { camera_matrices, type WasmScene } from "lucida-core";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { MinimapLayerParams } from "./renderer/workerProtocol.ts";
import type { DatasetState } from "./types.ts";
import type { SavedView } from "./savedView/types.ts";
import {
  identityModelMatrix,
  readMemberRenderMatrices,
  resolveMinimapLayerColormap,
  resolveMinimapLayerContrast,
  type MinimapDatasetSettings,
} from "./minimapPath.ts";

/** The display-settings shape `all_dataset_settings()` serializes per dataset. */
type ThumbDatasetSettings = {
  visible: boolean;
} & MinimapDatasetSettings;

/**
 * Build the minimap-style layer params for `datasetId` from the live scene +
 * display settings — the same per-member model matrices + active-channel
 * contrast/colormap the minimap uses (`tickMinimap`). Returns one entry per
 * visible member (tile); empty when the dataset is hidden / unknown.
 *
 * These are camera-independent (content + placement), so all of a dataset's
 * thumbnails share them and only the camera matrices differ per candidate;
 * `makeThumbnailRequester` caches the list across requests on that basis.
 * The matrices come from the bulk `member_render_matrices` export (two wasm
 * calls for the whole dataset) rather than two per-member calls, so even a
 * cache-miss rebuild is a single pass over a wide collection.
 */
function buildThumbnailLayers(
  scene: WasmScene,
  ds: DatasetState,
  datasetId: string,
): MinimapLayerParams[] {
  let allSettings: Record<string, ThumbDatasetSettings>;
  try {
    allSettings = JSON.parse(scene.all_dataset_settings());
  } catch {
    return [];
  }
  const settings = allSettings[datasetId];
  if (!settings || !settings.visible) return [];

  const activeC = scene.c();
  const { contrastMin, contrastMax, gamma } = resolveMinimapLayerContrast(settings, activeC);
  const colormap = resolveMinimapLayerColormap(settings, activeC);

  const memberMatrices = readMemberRenderMatrices(scene, datasetId);
  const layers: MinimapLayerParams[] = [];
  for (const img of ds.manifest.images) {
    const memberId = img.image_id;
    // Worker overview textures are keyed by member id; the model matrices place
    // each member exactly as the minimap/main view does (shared world math).
    const mats = memberMatrices.get(memberId);
    const modelMatrix = mats?.model ?? identityModelMatrix();
    const invModelMatrix = mats?.invModel ?? identityModelMatrix();
    layers.push({ datasetId: memberId, modelMatrix, invModelMatrix, contrastMin, contrastMax, gamma, colormap });
  }
  return layers;
}

/**
 * Create the `requestThumbnail(view, size)` the Explore panel calls per
 * candidate. Returns `null` (→ label-only fallback) whenever a render can't be
 * produced: no scene/client, the dataset isn't loaded, it's hidden, or the
 * child camera can't be parsed.
 *
 * `getScene` / `getDatasets` are read at call time (refs), so the closure stays
 * stable while always seeing the latest scene + manifest. `datasetId` is the
 * Explore panel's current target.
 *
 * The layer list is cached across requests: it is camera-independent, so the
 * panel's whole batch of candidate thumbnails shares one list, rebuilt only
 * when an input that shapes it changes — content/layout epochs (member set +
 * matrices), the active channel, or the display settings (visibility,
 * contrast, colormap). Camera-only changes (view epoch) deliberately do NOT
 * invalidate it. `client.thumbnailRender` structured-clones the layers per
 * call, so reuse never hands the worker a detached buffer.
 */
export function makeThumbnailRequester(opts: {
  getScene: () => WasmScene | null;
  getClient: () => RenderClient | null;
  getDatasets: () => Map<string, DatasetState>;
  datasetId: string;
}): (view: SavedView, size: number) => Promise<ImageBitmap | null> {
  const { getScene, getClient, getDatasets, datasetId } = opts;
  let cachedLayers: MinimapLayerParams[] | null = null;
  let cachedLayersKey: string | null = null;
  return async (view, size) => {
    const scene = getScene();
    const client = getClient();
    if (!scene || !client) return null;
    const ds = getDatasets().get(datasetId);
    if (!ds) return null;

    let layersKey: string | null = null;
    try {
      const epochs: { content: number; layout: number } = JSON.parse(scene.epochs());
      layersKey =
        `${datasetId}|${epochs.content}|${epochs.layout}|${scene.c()}` +
        `|${ds.manifest.images.length}|${scene.all_dataset_settings()}`;
    } catch {
      // Unreadable epochs: fall through with a null key (rebuild, don't cache).
    }

    const layers =
      layersKey !== null && layersKey === cachedLayersKey && cachedLayers !== null
        ? cachedLayers
        : buildThumbnailLayers(scene, ds, datasetId);
    cachedLayers = layersKey !== null ? layers : null;
    cachedLayersKey = layersKey;
    if (layers.length === 0) return null;

    // Child camera → GPU matrices (35 floats: invViewProj[16] + eye[3] +
    // viewProj[16]). Empty result means the camera JSON didn't parse.
    const cam = new Float32Array(camera_matrices(JSON.stringify(view.camera), size, size));
    if (cam.length < 19) return null;
    const invViewProj = cam.subarray(0, 16);
    const eye = cam.subarray(16, 19);

    return client.thumbnailRender(layers, invViewProj, eye, size);
  };
}
