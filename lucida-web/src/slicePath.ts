/** Slice render path: upload tiles + render multi-pass. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface SliceState {
  uploaded: Map<string, Map<string, true>>;  // dsId → tileKey → true (ordered for LRU)
  currentLod: Map<string, { level: number; z: number; t: number; c: number }>;
  prevTCZ: Map<string, string>;
  seedPending: Map<string, { level: number; coords: ChunkCoord[]; z: number }>;
}

export function createSliceState(): SliceState {
  return {
    uploaded: new Map(),
    currentLod: new Map(),
    prevTCZ: new Map(),
    seedPending: new Map(),
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

    const targetLevel = plan.needed[0]?.level;

    // Detect T/C/Z change and compute coarse seed coords
    const tczKey = `${t}/${c}/${z}`;
    const prevTCZKey = state.prevTCZ.get(dsId);
    const tczChanged = prevTCZKey !== undefined && prevTCZKey !== tczKey;
    state.prevTCZ.set(dsId, tczKey);

    if (tczChanged && targetLevel !== undefined) {
      const seedLevel = ds.info.levels.length - 1;
      if (seedLevel > targetLevel) {
        const seedMeta = ds.info.levels[seedLevel];
        const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const fullResDepthS = ds.info.levels[0].shape[2];
        const seedLevelZ = Math.min(
          Math.floor((z / Math.max(fullResDepthS - 1, 1)) * Math.max(sDepth - 1, 1)),
          sDepth - 1,
        );
        const targetChunkZ = Math.floor(seedLevelZ / sChunkZ);
        const ny = Math.ceil(sHeight / sChunkY);
        const nx = Math.ceil(sWidth / sChunkX);
        const seedCoords: ChunkCoord[] = [];
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            seedCoords.push({
              level: seedLevel,
              x: ix, y: iy, z: targetChunkZ,
              t, c,
              key: `${seedLevel}/${t}/${c}/${targetChunkZ}/${iy}/${ix}`,
            });
          }
        }
        state.seedPending.set(dsId, { level: seedLevel, coords: seedCoords, z: seedLevelZ });
      } else {
        state.seedPending.delete(dsId);
      }
    }

    // Build fetch list with seed coords prepended for priority
    const mmPending = minimapPendingFetch.get(dsId);
    let fetchList: ChunkCoord[] = [...plan.needed, ...plan.prefetch, ...(mmPending ?? [])];
    const seedInfo = state.seedPending.get(dsId);
    if (seedInfo) {
      const seedFetchCoords = seedInfo.coords.filter(sc => !ds.store.has(sc.key));
      if (seedFetchCoords.length > 0) {
        fetchList = [...seedFetchCoords, ...fetchList];
      }
    }
    if (fetchList.length > 0) {
      ds.store.ensureFetched(fetchList);
    }

    // Check if all seed chunks are available and assemble fallback
    if (seedInfo) {
      const allReady = seedInfo.coords.every(sc => {
        const buf = ds.store.get(sc.key);
        return buf && buf.byteLength > 0;
      });
      if (allReady) {
        const seedMeta = ds.info.levels[seedInfo.level];
        const [, , , sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        const localZ = seedInfo.z - seedInfo.coords[0].z * sChunkZ;
        const assembled = new Uint16Array(sWidth * sHeight);
        for (const sc of seedInfo.coords) {
          const buf = ds.store.get(sc.key)!;
          const data = bufferToUint16(buf, seedMeta.dataType);
          const xOff = sc.x * sChunkX;
          const yOff = sc.y * sChunkY;
          const tileW = Math.min(sChunkX, sWidth - xOff);
          const tileH = Math.min(sChunkY, sHeight - yOff);
          const sliceOffset = localZ * sChunkY * sChunkX;
          for (let row = 0; row < tileH; row++) {
            const srcStart = sliceOffset + row * sChunkX;
            const dstStart = (yOff + row) * sWidth + xOff;
            assembled.set(data.subarray(srcStart, srcStart + tileW), dstStart);
          }
        }
        client.sliceSetFallbackForLayer(dsId, assembled, sWidth, sHeight);
        state.seedPending.delete(dsId);
      }
    }

    const level = targetLevel;
    if (level === undefined) continue;

    const levelMeta = ds.info.levels[level];
    if (!levelMeta) continue;

    const [, , , levelHeight, levelWidth] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
    const fullResDepth = ds.info.levels[0].shape[2];
    const levelDepth = levelMeta.shape[2];

    // Per-dataset LOD tracking — clear uploaded set on change
    const lod = state.currentLod.get(dsId);
    if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
      state.uploaded.set(dsId, new Map());
      state.currentLod.set(dsId, { level, z, t, c });
    }

    let uploaded = state.uploaded.get(dsId);
    if (!uploaded) {
      uploaded = new Map();
      state.uploaded.set(dsId, uploaded);
    }

    const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
    for (const coord of plan.needed) {
      if (coord.level !== level) continue;
      if (uploaded.has(coord.key)) continue;
      const buf = ds.store.get(coord.key);
      if (!buf || buf.byteLength === 0) { hasPending = true; continue; }
      availableChunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
      uploaded.set(coord.key, true as const);
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
  state.prevTCZ.delete(dsId);
  state.seedPending.delete(dsId);
}
