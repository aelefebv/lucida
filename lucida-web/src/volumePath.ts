/** Volume render path: plan-based chunk upload + multi-pass render. */
import type { ChunkCoord } from "./zarr/chunkStore.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberChunkPlan } from "./zarr/chunkPlan.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { evaluateAndSortPlans, buildMemberFetchList, interleaveFetchLists, getSceneSettings } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";

export interface VolumeState {
  prevTC: Map<string, string>;
  seedPending: Map<string, {
    level: number;
    coords: ChunkCoord[];
    sentKeys: Set<string>;
  }>;
}

export function createVolumeState(): VolumeState {
  return {
    prevTC: new Map(),
    seedPending: new Map(),
  };
}

/** Data passed from the plan+fetch phase to the upload+render phase. */
interface PlanResult {
  memberPlanCache: Map<string, MemberChunkPlan[]>;
  settings: { layerOrder: string[]; allSettings: Record<string, DatasetSettings> };
  eye: Float32Array;
  hitLocals: Map<string, [number, number, number]>;
  canvasW: number;
  canvasH: number;
  fullW: number;
  fullH: number;
  viewT: number;
  viewC: number;
}

/**
 * Plan+fetch phase: evaluate chunk plans, compute seeds, build fetch lists,
 * and submit to ensureFetched. Returns data needed by upload+render, or null
 * if there's nothing to do.
 */
function planAndFetchVolume(
  ctx: TickContext,
  state: VolumeState,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
): PlanResult | null {
  const { scene, datasets } = ctx;

  // Use full-res viewport for chunk planning so LOD selection isn't affected
  // by renderScale (which drops to 0.25 during interaction). This prevents
  // the level from flip-flopping and clearing the chunk cache on every drag.
  const fullW = Math.round(ctx.canvas.clientWidth * devicePixelRatio);
  const fullH = Math.round(ctx.canvas.clientHeight * devicePixelRatio);
  scene.set_viewport(fullW, fullH);

  // Scaled dimensions for the actual render target
  const canvasW = Math.round(fullW * ctx.renderScale);
  const canvasH = Math.round(fullH * ctx.renderScale);

  const viewT = scene.t();
  const viewC = scene.c();

  const settings = getSceneSettings(scene);

  const eye = new Float32Array(scene.eye_position());
  const hitLocals = new Map<string, [number, number, number]>();

  // Cache member plans per dataset so we don't call WASM twice (upload + render).
  const memberPlanCache = new Map<string, MemberChunkPlan[]>();

  // Camera target for spatial priority (eye position in volume mode)
  const eyeForPriority: [number, number, number] = [eye[0], eye[1], eye[2]];

  for (const [dsId, ds] of datasets) {
    // Skip datasets whose C/T are exceeded (volume renders all Z slices)
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

    const sortedPlans = evaluateAndSortPlans(scene, dsId, eyeForPriority[0], eyeForPriority[1]);
    if (!sortedPlans) continue;
    memberPlanCache.set(dsId, sortedPlans);

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
      const needsSeed = prevTCKey === undefined || prevTCKey !== tcKey;
      state.prevTC.set(memberId, tcKey);

      if (needsSeed) {
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
          state.seedPending.set(memberId, { level: seedLevel, coords: seedCoords, sentKeys: new Set() });
        } else {
          state.seedPending.delete(memberId);
        }
      }

      // Build per-member fetch list with seed coords prepended for priority
      const mmPending = minimapPendingFetch.get(memberId);
      const seedInfo = state.seedPending.get(memberId);
      const fetchList = buildMemberFetchList(mp.needed, mp.prefetch, seedInfo, sharedQueue, memberId, mmPending);
      if (fetchList.length > 0) {
        perMemberFetchLists.push({ memberId, list: fetchList });
      }

      // Ray-volume intersection point in local [0,1]^3 space for upload prioritization.
      const hitLocal = Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];
      hitLocals.set(memberId, hitLocal);
    }

    // Interleave per-member fetch lists (round-robin by spatial priority) and submit
    if (perMemberFetchLists.length > 0) {
      const unified = interleaveFetchLists(perMemberFetchLists);
      ds.sharedQueue.ensureFetched(unified);
    }
  }

  return { memberPlanCache, settings, eye, hitLocals, canvasW, canvasH, fullW, fullH, viewT, viewC };
}

/**
 * Upload+render phase: stream seed chunks, send chunk plans to worker,
 * build layer params, and render. Returns true if more work remains.
 */
function uploadAndRenderVolume(
  ctx: TickContext,
  state: VolumeState,
  plan: PlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, datasets } = ctx;
  const { memberPlanCache, settings, eye, hitLocals, canvasW, canvasH, fullW, fullH, viewT, viewC } = plan;
  const { layerOrder, allSettings } = settings;

  // Send chunk plans for ALL datasets, iterating per-member
  for (const [dsId, ds] of datasets) {
    // Skip datasets whose C/T are exceeded (volume renders all Z slices)
    const dsShape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    if (viewC >= dsShape[1] || viewT >= dsShape[0]) continue;

    const sortedPlans = memberPlanCache.get(dsId);
    if (!sortedPlans) continue;

    for (const mp of sortedPlans) {
      const memberId = mp.member_id;
      const sharedQueue = ds.sharedQueue;

      if (mp.needed.length === 0) continue;
      const targetLevel = mp.needed[0].level;

      const tcKey = `${viewT}/${viewC}`;

      const levelMeta = ds.info.levels[targetLevel];
      const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

      const hitLocal = hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number];

      // --- Seed upload (stream coarse chunks as fallback) ---
      const seedInfo = state.seedPending.get(memberId);
      if (seedInfo) {
        const seedMeta = ds.info.levels[seedInfo.level];
        const [, , sDepth, sHeight, sWidth] = seedMeta.shape;
        const [, , sChunkZ, sChunkY, sChunkX] = seedMeta.chunkShape;
        let allSent = true;
        for (const sc of seedInfo.coords) {
          if (seedInfo.sentKeys.has(sc.key)) continue;
          const buf = sharedQueue.get(memberId, sc.key);
          if (!buf || buf.byteLength === 0) { allSent = false; continue; }
          const data = bufferToUint16(buf, seedMeta.dataType);
          const xOff = sc.x * sChunkX;
          const yOff = sc.y * sChunkY;
          const zOff = sc.z * sChunkZ;
          const cw = Math.min(sChunkX, sWidth - xOff);
          const ch = Math.min(sChunkY, sHeight - yOff);
          const cd = Math.min(sChunkZ, sDepth - zOff);
          const transferBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          client.volumeWriteFallbackChunk(
            memberId, tcKey,
            sWidth, sHeight, sDepth,
            transferBuf,
            xOff, yOff, zOff,
            cw, ch, cd,
            sChunkX, sChunkY,
          );
          seedInfo.sentKeys.add(sc.key);
        }
        if (allSent) {
          state.seedPending.delete(memberId);
        }
      }

      // --- Send plan to worker — worker will request what it needs ---
      const availableKeys: string[] = [];
      for (const coord of mp.needed) {
        if (sharedQueue.has(memberId, coord.key)) {
          availableKeys.push(coord.key);
        }
      }
      client.volumeChunkPlan(
        memberId,
        mp.needed.map(c => ({ level: c.level, x: c.x, y: c.y, z: c.z, key: c.key })),
        availableKeys,
        targetLevel, viewT, viewC,
        widthFull, heightFull, depthFull,
        chunkX, chunkY, chunkZ,
        hitLocal,
      );
    }
  }

  if (!shouldRender) return false;

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
    const dsSettings = allSettings[dsId];
    if (!dsSettings || !dsSettings.visible) continue;

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
        rayHitLocal: hitLocals.get(memberId) ?? Array.from(scene.ray_hit_local_image(dsId)) as [number, number, number],
        contrastMin: dsSettings.contrast_min,
        contrastMax: dsSettings.contrast_max,
        gamma: dsSettings.gamma,
        opacity: dsSettings.opacity,
        blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
        renderMode: (dsSettings.render_mode || "translucent") as "translucent" | "max_intensity",
      });
    }
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH, fullW, fullH, viewProj, camForward, clipDistance, clipMode);

  return false;
}

/**
 * Upload volume chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickVolume(
  ctx: TickContext,
  state: VolumeState,
  minimapPendingFetch: Map<string, ChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const planResult = planAndFetchVolume(ctx, state, minimapPendingFetch);
  if (!planResult) return false;
  return uploadAndRenderVolume(ctx, state, planResult, shouldRender);
}

export function clearVolumeForDataset(state: VolumeState, dsId: string): void {
  state.prevTC.delete(dsId);
  state.seedPending.delete(dsId);
}

/** Clear member-keyed entries for all members of a dataset. */
export function clearVolumeForMembers(state: VolumeState, memberIds: string[]): void {
  for (const id of memberIds) {
    state.prevTC.delete(id);
    state.seedPending.delete(id);
  }
}

export function resetVolumeState(state: VolumeState): void {
  state.prevTC.clear();
  state.seedPending.clear();
}
