/** Volume render path: upload chunks with atlas-based tracking + render multi-pass. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import { VOLUME_ATLAS_BUDGET } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface VolumeState {
  uploaded: Map<string, Map<string, { x: number; y: number; z: number }>>;  // dsId → chunkKey → position
  lodKeys: Map<string, string>;
  prevTC: Map<string, string>;
  seedPending: Map<string, {
    level: number;
    coords: ChunkCoord[];
  }>;
}

/** Squared distance from a chunk grid coordinate to the camera in [0,1] volume space. */
function chunkDistSqLocal(
  cx: number, cy: number, cz: number,
  chunkX: number, chunkY: number, chunkZ: number,
  levelW: number, levelH: number, levelD: number,
  cam: [number, number, number],
): number {
  const px = (cx + 0.5) * chunkX / levelW;
  const py = (cy + 0.5) * chunkY / levelH;
  const pz = (cz + 0.5) * chunkZ / levelD;
  const dx = px - cam[0];
  const dy = py - cam[1];
  const dz = pz - cam[2];
  return dx * dx + dy * dy + dz * dz;
}

export function createVolumeState(): VolumeState {
  return {
    uploaded: new Map(),
    lodKeys: new Map(),
    prevTC: new Map(),
    seedPending: new Map(),
  };
}

/**
 * Upload volume chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickVolume(
  ctx: TickContext,
  state: VolumeState,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): boolean {
  const { scene, client, canvas, datasets } = ctx;

  // Use full-res viewport for chunk planning so LOD selection isn't affected
  // by renderScale (which drops to 0.25 during interaction). This prevents
  // the level from flip-flopping and clearing the chunk cache on every drag.
  const fullW = Math.round(canvas.clientWidth * devicePixelRatio);
  const fullH = Math.round(canvas.clientHeight * devicePixelRatio);
  scene.set_viewport(fullW, fullH);

  // Scaled dimensions for the actual render target
  const canvasW = Math.round(fullW * ctx.renderScale);
  const canvasH = Math.round(fullH * ctx.renderScale);

  const viewT = scene.t();
  const viewC = scene.c();

  // Get layer ordering and settings from scene
  const layerOrder: string[] = JSON.parse(scene.layer_order());
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    contrast_min: number;
    contrast_max: number;
    gamma: number;
    blend_mode: string;
    render_mode: string;
  }> = JSON.parse(scene.all_layer_settings());

  let budgetRemaining = UPLOAD_BUDGET_BYTES;
  let exhausted = false;
  let hasPending = false;

  const eye = new Float32Array(scene.eye_position_3d());

  // Upload chunks for ALL datasets
  for (const [dsId, ds] of datasets) {
    // Skip datasets whose C/T are exceeded (volume renders all Z slices)
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

    const plan = evaluateChunkPlanFor(scene, dsId);
    if (!plan) continue;
    if (plan.needed.length === 0) continue;

    const targetLevel = plan.needed[0].level;

    // Detect T/C change and compute coarse seed coords
    const tcKey = `${viewT}/${viewC}`;
    const prevTCKey = state.prevTC.get(dsId);
    const tcChanged = prevTCKey !== undefined && prevTCKey !== tcKey;
    state.prevTC.set(dsId, tcKey);

    if (tcChanged) {
      const seedLevel = ds.info.levels.length - 1;
      if (seedLevel > targetLevel) {
        const seedMeta = ds.info.levels[seedLevel];
        const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const nz = Math.ceil(sDepth / sChunkZ);
        const ny = Math.ceil(sHeight / sChunkY);
        const nx = Math.ceil(sWidth / sChunkX);
        const seedCoords: ChunkCoord[] = [];
        for (let iz = 0; iz < nz; iz++) {
          for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
              seedCoords.push({
                level: seedLevel,
                x: ix, y: iy, z: iz,
                t: viewT, c: viewC,
                key: `${seedLevel}/${viewT}/${viewC}/${iz}/${iy}/${ix}`,
              });
            }
          }
        }
        state.seedPending.set(dsId, { level: seedLevel, coords: seedCoords });
      } else {
        state.seedPending.delete(dsId);
      }
    }

    // Build fetch list with seed coords prepended for priority
    const mmPending = minimapPendingFetch.get(dsId);
    let fetchList: ChunkCoord[] = [...plan.needed, ...plan.prefetch, ...(mmPending ?? [])];
    const seedInfo = state.seedPending.get(dsId);
    if (seedInfo) {
      const seedFetchCoords = seedInfo.coords.filter(c => !ds.store.has(c.key));
      if (seedFetchCoords.length > 0) {
        fetchList = [...seedFetchCoords, ...fetchList];
      }
    }
    if (fetchList.length > 0) {
      ds.store.ensureFetched(fetchList);
    }
    const levelMeta = ds.info.levels[targetLevel];
    const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

    // Compute atlas capacity (mirrors createVolumeAtlas in volumeHandlers.ts)
    const chunkTexels = chunkX * chunkY * chunkZ;
    const maxSlots = Math.floor(VOLUME_ATLAS_BUDGET / (chunkTexels * 2));
    const slotsPerAxis = Math.floor(Math.cbrt(maxSlots));
    const totalSlots =
      Math.min(slotsPerAxis, Math.floor(2048 / chunkX)) *
      Math.min(slotsPerAxis, Math.floor(2048 / chunkY)) *
      Math.min(slotsPerAxis, Math.floor(2048 / chunkZ));

    // Camera position in local [0,1]³ space for distance-based eviction
    const im = new Float32Array(scene.inv_model_matrix_for(dsId));
    const camLocal: [number, number, number] = [
      im[0] * eye[0] + im[4] * eye[1] + im[8] * eye[2] + im[12],
      im[1] * eye[0] + im[5] * eye[1] + im[9] * eye[2] + im[13],
      im[2] * eye[0] + im[6] * eye[1] + im[10] * eye[2] + im[14],
    ];

    const lodKey = `${dsId}/${targetLevel}/${viewT}/${viewC}`;
    const lodKeyChanged = state.lodKeys.get(dsId) !== lodKey;

    // On LOD key change, clear the uploaded set for this dataset
    if (lodKeyChanged) {
      state.uploaded.set(dsId, new Map());
      state.lodKeys.set(dsId, lodKey);
    }

    let uploaded = state.uploaded.get(dsId);
    if (!uploaded) {
      uploaded = new Map();
      state.uploaded.set(dsId, uploaded);
    }

    // --- Seed upload (assemble coarse new-T/C data as fallback) ---
    if (seedInfo) {
      const allReady = seedInfo.coords.every(sc => {
        const buf = ds.store.get(sc.key);
        return buf && buf.byteLength > 0;
      });
      if (allReady) {
        const seedMeta = ds.info.levels[seedInfo.level];
        const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const assembled = new Uint16Array(sWidth * sHeight * sDepth);
        for (const sc of seedInfo.coords) {
          const buf = ds.store.get(sc.key)!;
          const data = bufferToUint16(buf, seedMeta.dataType);
          const xOff = sc.x * sChunkX;
          const yOff = sc.y * sChunkY;
          const zOff = sc.z * sChunkZ;
          const cw = Math.min(sChunkX, sWidth - xOff);
          const ch = Math.min(sChunkY, sHeight - yOff);
          const cd = Math.min(sChunkZ, sDepth - zOff);
          for (let iz = 0; iz < cd; iz++) {
            for (let iy = 0; iy < ch; iy++) {
              const srcStart = iz * sChunkY * sChunkX + iy * sChunkX;
              const dstStart = (zOff + iz) * sHeight * sWidth + (yOff + iy) * sWidth + xOff;
              assembled.set(data.subarray(srcStart, srcStart + cw), dstStart);
            }
          }
        }
        client.volumeSetInitialForLayer(dsId, assembled, sWidth, sHeight, sDepth);
        state.seedPending.delete(dsId);
      } else {
        hasPending = true;
      }
    }

    // --- Fine-level upload ---
    const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
    for (const coord of plan.needed) {
      if (uploaded.has(coord.key)) continue;
      const buf = ds.store.get(coord.key);
      if (!buf || buf.byteLength === 0) { hasPending = true; continue; }
      if (uploaded.size >= totalSlots) {
        // Evict the farthest uploaded chunk if incoming chunk is closer
        let farthestKey = "";
        let farthestDist = -1;
        for (const [key, pos] of uploaded) {
          const d = chunkDistSqLocal(pos.x, pos.y, pos.z, chunkX, chunkY, chunkZ, widthFull, heightFull, depthFull, camLocal);
          if (d > farthestDist) { farthestDist = d; farthestKey = key; }
        }
        const incomingDist = chunkDistSqLocal(coord.x, coord.y, coord.z, chunkX, chunkY, chunkZ, widthFull, heightFull, depthFull, camLocal);
        if (incomingDist < farthestDist) {
          uploaded.delete(farthestKey);
        } else {
          break; // plan is sorted center-out; remaining chunks are all farther
        }
      }
      newChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
      uploaded.set(coord.key, { x: coord.x, y: coord.y, z: coord.z });
      budgetRemaining -= buf.byteLength;
      if (budgetRemaining <= 0) {
        exhausted = true;
        break;
      }
    }

    if (newChunks.length > 0 || (lodKeyChanged && !state.seedPending.has(dsId))) {
      client.volumeUploadChunksForLayer(
        dsId,
        newChunks,
        targetLevel, viewT, viewC,
        widthFull, heightFull, depthFull,
        chunkX, chunkY, chunkZ,
        camLocal,
      );
    }

    if (budgetRemaining <= 0) break;
  }

  // Build layer params for visible layers in order
  const invVP = new Float32Array(scene.inv_view_proj_3d());

  const layers: VolumeLayerParams[] = [];
  for (const dsId of layerOrder) {
    const dsVol = datasets.get(dsId);
    if (!dsVol) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    // Skip layers whose C/T are exceeded (volume renders all Z slices)
    const dsShapeV = dsVol.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShapeV[1] || viewT >= dsShapeV[0]) continue;

    const model = new Float32Array(scene.model_matrix_for(dsId));
    const invModel = new Float32Array(scene.inv_model_matrix_for(dsId));

    layers.push({
      datasetId: dsId,
      modelMatrix: model,
      invModelMatrix: invModel,
      contrastMin: settings.contrast_min,
      contrastMax: settings.contrast_max,
      gamma: settings.gamma,
      opacity: settings.opacity,
      blendMode: settings.blend_mode as "alpha" | "additive" | "max",
      renderMode: (settings.render_mode || "translucent") as "translucent" | "max_intensity",
    });
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH);

  return exhausted || hasPending;
}

export function clearVolumeForDataset(state: VolumeState, dsId: string): void {
  state.uploaded.delete(dsId);
  state.lodKeys.delete(dsId);
  state.prevTC.delete(dsId);
  state.seedPending.delete(dsId);
}

export function resetVolumeState(state: VolumeState): void {
  state.uploaded.clear();
  state.lodKeys.clear();
  state.prevTC.clear();
  state.seedPending.clear();
}
