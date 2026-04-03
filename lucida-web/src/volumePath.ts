/** Volume render path: upload chunks with atlas-based tracking + render multi-pass. */
import type { ChunkCoord, QualifiedChunkCoord } from "./zarr/chunkStore.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import { VOLUME_ATLAS_BUDGET } from "./renderer/workerProtocol.ts";
import { evaluateChunkPlanFor } from "./zarr/chunkPlan.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";

export interface VolumeState {
  uploaded: Map<string, Map<string, { x: number; y: number; z: number }>>;  // memberId → chunkKey → position
  lodKeys: Map<string, string>;
  prevTC: Map<string, string>;
  seedPending: Map<string, {
    level: number;
    coords: ChunkCoord[];
  }>;
}

/** Squared distance from a chunk grid coordinate to a reference point in [0,1] volume space. */
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
  const layerOrder: string[] = JSON.parse(scene.dataset_order());
  const allSettings: Record<string, {
    visible: boolean;
    opacity: number;
    contrast_min: number;
    contrast_max: number;
    gamma: number;
    blend_mode: string;
    render_mode: string;
  }> = JSON.parse(scene.all_dataset_settings());

  let budgetRemaining = UPLOAD_BUDGET_BYTES;
  let exhausted = false;
  let hasPending = false;

  const eye = new Float32Array(scene.eye_position());
  const hitLocals = new Map<string, [number, number, number]>();

  // Cache member plans per dataset so we don't call WASM twice (upload + render).
  const memberPlanCache = new Map<string, MemberChunkPlan[]>();

  // Camera target for spatial priority (eye position in volume mode)
  const eyeForPriority: [number, number, number] = [eye[0], eye[1], eye[2]];

  // Upload chunks for ALL datasets, iterating per-member
  for (const [dsId, ds] of datasets) {
    // Skip datasets whose C/T are exceeded (volume renders all Z slices)
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

    const memberPlans = evaluateChunkPlanFor(scene, dsId);
    if (!memberPlans) continue;
    memberPlanCache.set(dsId, memberPlans);

    // Sort member plans by distance from eye position (nearest first)
    const sortedPlans = [...memberPlans].sort((a, b) => {
      const dxA = a.position[0] - eyeForPriority[0];
      const dyA = a.position[1] - eyeForPriority[1];
      const dxB = b.position[0] - eyeForPriority[0];
      const dyB = b.position[1] - eyeForPriority[1];
      return (dxA * dxA + dyA * dyA) - (dxB * dxB + dyB * dyB);
    });

    // Build per-member fetch lists (with seed coords prepended) and collect for interleaving
    const perMemberFetchLists: { memberId: string; list: ChunkCoord[] }[] = [];

    for (const mp of sortedPlans) {
      const memberId = mp.member_id;
      const sharedQueue = ds.sharedQueue;

      if (mp.needed.length === 0) continue;
      const targetLevel = mp.needed[0].level;

      // Detect T/C change and compute coarse seed coords
      const tcKey = `${viewT}/${viewC}`;
      const prevTCKey = state.prevTC.get(memberId);
      const tcChanged = prevTCKey !== undefined && prevTCKey !== tcKey;
      state.prevTC.set(memberId, tcKey);

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
          state.seedPending.set(memberId, { level: seedLevel, coords: seedCoords });
        } else {
          state.seedPending.delete(memberId);
        }
      }

      // Build per-member fetch list with seed coords prepended for priority
      const mmPending = minimapPendingFetch.get(memberId);
      let fetchList: ChunkCoord[] = [...mp.needed, ...mp.prefetch, ...(mmPending ?? [])];
      const seedInfo = state.seedPending.get(memberId);
      if (seedInfo) {
        const seedFetchCoords = seedInfo.coords.filter(c => !sharedQueue.has(memberId, c.key));
        if (seedFetchCoords.length > 0) {
          fetchList = [...seedFetchCoords, ...fetchList];
        }
      }
      if (fetchList.length > 0) {
        perMemberFetchLists.push({ memberId, list: fetchList });
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

      // Ray-volume intersection point in local [0,1]^3 space for distance-based eviction.
      // Chunks closest to where the camera ray hits the volume surface are prioritized.
      const hitLocal = Array.from(scene.ray_hit_local(dsId)) as [number, number, number];
      hitLocals.set(memberId, hitLocal);

      const lodKey = `${memberId}/${targetLevel}/${viewT}/${viewC}`;
      const lodKeyChanged = state.lodKeys.get(memberId) !== lodKey;

      // On LOD key change, clear the uploaded set for this member
      if (lodKeyChanged) {
        state.uploaded.set(memberId, new Map());
        state.lodKeys.set(memberId, lodKey);
      }

      let uploaded = state.uploaded.get(memberId);
      if (!uploaded) {
        uploaded = new Map();
        state.uploaded.set(memberId, uploaded);
      }

      // --- Seed upload (assemble coarse new-T/C data as fallback) ---
      if (seedInfo) {
        const allReady = seedInfo.coords.every(sc => {
          const buf = sharedQueue.get(memberId, sc.key);
          return buf && buf.byteLength > 0;
        });
        if (allReady) {
          const seedMeta = ds.info.levels[seedInfo.level];
          const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
          const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
          const assembled = new Uint16Array(sWidth * sHeight * sDepth);
          for (const sc of seedInfo.coords) {
            const buf = sharedQueue.get(memberId, sc.key)!;
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
          client.volumeSetInitialForLayer(memberId, assembled, sWidth, sHeight, sDepth);
          state.seedPending.delete(memberId);
        } else {
          hasPending = true;
        }
      }

      // --- Fine-level upload ---
      const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of mp.needed) {
        if (uploaded.has(coord.key)) continue;
        const buf = sharedQueue.get(memberId, coord.key);
        if (!buf || buf.byteLength === 0) { hasPending = true; continue; }
        if (uploaded.size >= totalSlots) {
          // Evict the farthest uploaded chunk if incoming chunk is closer
          let farthestKey = "";
          let farthestDist = -1;
          for (const [key, pos] of uploaded) {
            const d = chunkDistSqLocal(pos.x, pos.y, pos.z, chunkX, chunkY, chunkZ, widthFull, heightFull, depthFull, hitLocal);
            if (d > farthestDist) { farthestDist = d; farthestKey = key; }
          }
          const incomingDist = chunkDistSqLocal(coord.x, coord.y, coord.z, chunkX, chunkY, chunkZ, widthFull, heightFull, depthFull, hitLocal);
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

      if (newChunks.length > 0 || (lodKeyChanged && !state.seedPending.has(memberId))) {
        client.volumeUploadChunksForLayer(
          memberId,
          newChunks,
          targetLevel, viewT, viewC,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
          hitLocal,
        );
      }

      if (budgetRemaining <= 0) break;
    }

    // Interleave per-member fetch lists (round-robin by spatial priority) and submit
    if (perMemberFetchLists.length > 0) {
      const unified: QualifiedChunkCoord[] = [];
      const maxLen = Math.max(...perMemberFetchLists.map(p => p.list.length));
      for (let i = 0; i < maxLen; i++) {
        for (const { memberId, list } of perMemberFetchLists) {
          if (i < list.length) {
            unified.push({ ...list[i], memberId });
          }
        }
      }
      ds.sharedQueue.ensureFetched(unified);
    }

    if (budgetRemaining <= 0) break;
  }

  // Build layer params for visible layers in order
  const invVP = new Float32Array(scene.inv_view_proj());
  const viewProj = new Float32Array(scene.view_proj());
  const camForward = new Float32Array(scene.camera_forward());
  const clipDistance = scene.clip_distance();
  const clipModeStr = scene.clip_mode();
  const clipMode = clipModeStr === "sphere" ? 1 : 0;

  const layers: VolumeLayerParams[] = [];
  for (const dsId of layerOrder) {
    const dsVol = datasets.get(dsId);
    if (!dsVol) continue;
    const settings = allSettings[dsId];
    if (!settings || !settings.visible) continue;

    // Skip layers whose C/T are exceeded (volume renders all Z slices)
    const dsShapeV = dsVol.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShapeV[1] || viewT >= dsShapeV[0]) continue;

    // Get member plans to emit one layer per member with its own model matrix (use cache from upload phase)
    const members: MemberChunkPlan[] = memberPlanCache.get(dsId) ?? [{ member_id: dsId, position: [0, 0], store_prefix: null, needed: [], prefetch: [] }];

    for (const mp of members) {
      const memberId = mp.member_id;
      const model = new Float32Array(scene.member_model_matrix(dsId, memberId));
      const invModel = new Float32Array(scene.inv_member_model_matrix(dsId, memberId));

      layers.push({
        datasetId: memberId,
        modelMatrix: model,
        invModelMatrix: invModel,
        rayHitLocal: hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local(dsId)) as [number, number, number],
        contrastMin: settings.contrast_min,
        contrastMax: settings.contrast_max,
        gamma: settings.gamma,
        opacity: settings.opacity,
        blendMode: settings.blend_mode as "alpha" | "additive" | "max",
        renderMode: (settings.render_mode || "translucent") as "translucent" | "max_intensity",
      });
    }
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH, fullW, fullH, viewProj, camForward, clipDistance, clipMode);

  return exhausted || hasPending;
}

export function clearVolumeForDataset(state: VolumeState, dsId: string): void {
  state.uploaded.delete(dsId);
  state.lodKeys.delete(dsId);
  state.prevTC.delete(dsId);
  state.seedPending.delete(dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearVolumeForMembers(state: VolumeState, memberIds: string[]): void {
  for (const id of memberIds) {
    state.uploaded.delete(id);
    state.lodKeys.delete(id);
    state.prevTC.delete(id);
    state.seedPending.delete(id);
  }
}

export function resetVolumeState(state: VolumeState): void {
  state.uploaded.clear();
  state.lodKeys.clear();
  state.prevTC.clear();
  state.seedPending.clear();
}
