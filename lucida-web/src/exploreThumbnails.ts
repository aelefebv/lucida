// The Explore panel's `requestThumbnail`: render a candidate child `SavedView`
// off-screen through the minimap's coarse-overview path, with no re-streaming.
// Placement comes from the current scene, as the minimap draws it. What each
// layer shows comes from the scene resolving the candidate, so a candidate that
// solos a channel previews that channel and every other one previews the
// composite the canvas shows.

import { camera_matrices, type WasmScene } from "lucida-core";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { MinimapLayerParams } from "./renderer/workerProtocol.ts";
import type { DatasetState } from "./types.ts";
import type { SavedView } from "./savedView/types.ts";
import {
  identityModelMatrix,
  overviewKeyFor,
  overviewLayerParams,
  readMemberRenderMatrices,
  type MinimapRenderLayerGeometry,
} from "./minimapPath.ts";
import { parseResolvedLayers, type ResolvedLayers } from "./resolvedLayers.ts";

/**
 * Minimap-style layer params for `datasetId` under `resolved`, one per member
 * and shown channel; empty when the dataset is hidden or unknown.
 */
export function buildThumbnailLayers(
  scene: WasmScene,
  ds: DatasetState,
  datasetId: string,
  resolved: ResolvedLayers,
): MinimapLayerParams[] {
  const layer = resolved.get(datasetId);
  if (!layer || !layer.visible) return [];

  const memberMatrices = readMemberRenderMatrices(scene, datasetId);
  const geometry: MinimapRenderLayerGeometry[] = [];
  for (const img of ds.manifest.images) {
    const mats = memberMatrices.get(img.image_id);
    for (const ch of layer.channels) {
      geometry.push({
        memberId: overviewKeyFor(img.image_id, ch.channel),
        ownerDatasetId: datasetId,
        channel: ch.channel,
        modelMatrix: mats?.model ?? identityModelMatrix(),
        invModelMatrix: mats?.invModel ?? identityModelMatrix(),
      });
    }
  }
  return overviewLayerParams(geometry, resolved);
}

/**
 * Create the `requestThumbnail(view, size)` the Explore panel calls per
 * candidate. Returns `null`, so the panel falls back to a label, whenever a
 * render can't be produced.
 *
 * Layers are cached per what the candidate shows, so the camera-only
 * candidates of one batch share them. `client.thumbnailRender`
 * structured-clones the layers per call, so reuse never hands the worker a
 * detached buffer.
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

    const resolvedJson = scene.resolved_view_layers(JSON.stringify(view));
    let layersKey: string | null = null;
    try {
      const epochs: { content: number; layout: number } = JSON.parse(scene.epochs());
      layersKey =
        `${datasetId}|${epochs.content}|${epochs.layout}|${ds.manifest.images.length}|${resolvedJson}`;
    } catch {
      // Unreadable epochs leave a null key: rebuild, don't cache.
    }

    const layers =
      layersKey !== null && layersKey === cachedLayersKey && cachedLayers !== null
        ? cachedLayers
        : buildThumbnailLayers(scene, ds, datasetId, parseResolvedLayers(resolvedJson));
    cachedLayers = layersKey !== null ? layers : null;
    cachedLayersKey = layersKey;
    if (layers.length === 0) return null;

    // 35 floats: invViewProj[16] + eye[3] + viewProj[16]. Empty means the
    // camera JSON didn't parse.
    const cam = new Float32Array(camera_matrices(JSON.stringify(view.camera), size, size));
    if (cam.length < 35) return null;
    const invViewProj = cam.subarray(0, 16);
    const eye = cam.subarray(16, 19);
    const viewProj = cam.subarray(19, 35);

    return client.thumbnailRender(layers, invViewProj, viewProj, eye, size);
  };
}
