// The Explore panel's `requestThumbnail`: render a candidate child `SavedView`
// off-screen through the minimap's coarse-overview path, with no re-streaming.
// Layer content and placement come from the current scene, as the minimap draws
// them; only the camera varies per candidate.

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
 * Minimap-style layer params for `datasetId` from the live scene, one per
 * member; empty when the dataset is hidden or unknown. Camera-independent, so
 * all of a dataset's thumbnails share them.
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
    // Worker overview textures are keyed by member id.
    const mats = memberMatrices.get(memberId);
    const modelMatrix = mats?.model ?? identityModelMatrix();
    const invModelMatrix = mats?.invModel ?? identityModelMatrix();
    layers.push({ datasetId: memberId, modelMatrix, invModelMatrix, contrastMin, contrastMax, gamma, colormap });
  }
  return layers;
}

/**
 * Create the `requestThumbnail(view, size)` the Explore panel calls per
 * candidate. Returns `null`, so the panel falls back to a label, whenever a
 * render can't be produced.
 *
 * The layer list is cached across the batch and rebuilt only when the epochs,
 * active channel, or display settings change; camera moves don't invalidate
 * it. `client.thumbnailRender` structured-clones the layers per call, so reuse
 * never hands the worker a detached buffer.
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
      // Unreadable epochs leave a null key: rebuild, don't cache.
    }

    const layers =
      layersKey !== null && layersKey === cachedLayersKey && cachedLayers !== null
        ? cachedLayers
        : buildThumbnailLayers(scene, ds, datasetId);
    cachedLayers = layersKey !== null ? layers : null;
    cachedLayersKey = layersKey;
    if (layers.length === 0) return null;

    // 35 floats: invViewProj[16] + eye[3] + viewProj[16]. Empty means the
    // camera JSON didn't parse.
    const cam = new Float32Array(camera_matrices(JSON.stringify(view.camera), size, size));
    if (cam.length < 19) return null;
    const invViewProj = cam.subarray(0, 16);
    const eye = cam.subarray(16, 19);

    return client.thumbnailRender(layers, invViewProj, eye, size);
  };
}
