/** Slice render path: upload tiles + render multi-pass. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface SliceState {
  uploaded: Map<string, Set<string>>;
  currentLod: Map<string, { level: number; z: number; t: number; c: number }>;
}

export function createSliceState(): SliceState {
  return {
    uploaded: new Map(),
    currentLod: new Map(),
  };
}

/**
 * Upload slice chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickSlice(
  ctx: TickContext,
  state: SliceState,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): boolean {
  const { scene, client, canvas, datasets } = ctx;
  if (datasets.size === 0) return false;

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  scene.set_z(z);
  scene.set_t(t);
  scene.set_c(c);

  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;
  scene.set_viewport(canvasW, canvasH);

  // Get layer ordering and settings from scene
  const layerOrder: string[] = JSON.parse(scene.layer_order());
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    contrast_min: number;
    contrast_max: number;
    gamma: number;
    blend_mode: string;
  }> = JSON.parse(scene.all_layer_settings());

  let budgetRemaining = UPLOAD_BUDGET_BYTES;
  let exhausted = false;
  let hasPending = false;

  // Upload chunks for ALL datasets
  for (const [dsId, ds] of datasets) {
    // Skip datasets whose dimensions are exceeded by the current slice position
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (z >= dsShape[2] || c >= dsShape[1] || t >= dsShape[0]) continue;

    const plan = evaluateChunkPlanFor(scene, dsId);
    if (!plan) continue;
    const mmPending = minimapPendingFetch.get(dsId);
    const fetchList = mmPending?.length ? [...plan.needed, ...mmPending] : plan.needed;
    if (fetchList.length > 0) {
      ds.store.ensureFetched(fetchList);
    }

    const level = plan.needed[0]?.level;
    if (level === undefined) continue;

    const levelMeta = ds.info.levels[level];
    if (!levelMeta) continue;

    const [, , , levelHeight, levelWidth] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
    const fullResDepth = ds.info.levels[0].shape[2];
    const levelDepth = levelMeta.shape[2];

    // Per-dataset LOD tracking
    const lod = state.currentLod.get(dsId);
    if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
      state.uploaded.set(dsId, new Set());
      state.currentLod.set(dsId, { level, z, t, c });
    }

    const uploaded = state.uploaded.get(dsId)!;

    const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
    for (const coord of plan.needed) {
      if (coord.level !== level) continue;
      if (uploaded.has(coord.key)) continue;
      const buf = ds.store.get(coord.key);
      if (!buf || buf.byteLength === 0) { hasPending = true; continue; }
      availableChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
      uploaded.add(coord.key);
      budgetRemaining -= buf.byteLength;
      if (budgetRemaining <= 0) {
        exhausted = true;
        break;
      }
    }

    if (availableChunks.length > 0) {
      client.sliceUploadTilesForLayer(
        dsId,
        availableChunks,
        level, z, t, c,
        levelWidth, levelHeight,
        chunkX, chunkY, chunkZ,
        fullResDepth, levelDepth, z,
      );
    }

    if (budgetRemaining <= 0) break;
  }

  // Build layer params for visible layers in order
  const currentZoom = scene.zoom();
  const centerArr = scene.center();
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  for (const dsId of layerOrder) {
    const ds = datasets.get(dsId);
    if (!ds) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    // Skip layers whose dimensions are exceeded by the current slice position
    const dsShapeL = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (z >= dsShapeL[2] || c >= dsShapeL[1] || t >= dsShapeL[0]) continue;

    const fullResWidth = ds.info.levels[0].shape[4];
    const fullResHeight = ds.info.levels[0].shape[3];

    layers.push({
      datasetId: dsId,
      dataW: fullResWidth,
      dataH: fullResHeight,
      contrastMin: settings.contrast_min,
      contrastMax: settings.contrast_max,
      gamma: settings.gamma,
      opacity: settings.opacity,
      blendMode: settings.blend_mode as "alpha" | "additive" | "max",
    });
  }

  client.resize(canvasW, canvasH);
  client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH);

  return exhausted || hasPending;
}

export function clearSliceForDataset(state: SliceState, dsId: string): void {
  state.uploaded.delete(dsId);
  state.currentLod.delete(dsId);
}
