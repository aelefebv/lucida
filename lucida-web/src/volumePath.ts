/** Volume render path: plan-based chunk upload + multi-pass render. */
import { Axis } from "./axes.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import { getActiveChannels, compositeKey } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";
import { debugStats } from "./debug/debugStats.ts";
import type { Orchestrator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/orchestrator.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";

/**
 * Project a well's [0,1]³ unit-cube AABB to screen space and return a scissor rect.
 * Returns null if the well is fully off-screen.
 *
 * @internal Exported for unit tests; not part of the public surface.
 */
export function computeScissorRect(
  modelMatrix: Float32Array,
  viewProj: Float32Array,
  canvasW: number,
  canvasH: number,
): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < 8; i++) {
    const cx = i & 1;
    const cy = (i >> 1) & 1;
    const cz = (i >> 2) & 1;

    // Model transform (column-major): local [0,1]³ → world
    const wx = modelMatrix[0] * cx + modelMatrix[4] * cy + modelMatrix[8] * cz + modelMatrix[12];
    const wy = modelMatrix[1] * cx + modelMatrix[5] * cy + modelMatrix[9] * cz + modelMatrix[13];
    const wz = modelMatrix[2] * cx + modelMatrix[6] * cy + modelMatrix[10] * cz + modelMatrix[14];
    const ww = modelMatrix[3] * cx + modelMatrix[7] * cy + modelMatrix[11] * cz + modelMatrix[15];

    // ViewProj transform: world → clip
    const clipX = viewProj[0] * wx + viewProj[4] * wy + viewProj[8] * wz + viewProj[12] * ww;
    const clipY = viewProj[1] * wx + viewProj[5] * wy + viewProj[9] * wz + viewProj[13] * ww;
    const clipW = viewProj[3] * wx + viewProj[7] * wy + viewProj[11] * wz + viewProj[15] * ww;

    if (clipW <= 0) {
      // Vertex behind camera — conservative fallback to full screen
      return [0, 0, canvasW, canvasH];
    }

    // NDC [-1,1] → screen (WebGPU: top-left origin, y-down)
    const ndcX = clipX / clipW;
    const ndcY = clipY / clipW;
    const sx = (ndcX + 1) * 0.5 * canvasW;
    const sy = (1 - ndcY) * 0.5 * canvasH;

    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }

  // Clamp to canvas bounds and compute integer rect
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const w = Math.min(canvasW, Math.ceil(maxX)) - x;
  const h = Math.min(canvasH, Math.ceil(maxY)) - y;

  if (w <= 0 || h <= 0) return null; // fully off-screen
  return [x, y, w, h];
}

export type VolumeState = Record<string, never>;

export function createVolumeState(): VolumeState { return {}; }

/** Data passed from the plan+fetch phase to the upload+render phase. */
interface PlanResult {
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: { layerOrder: string[]; allSettings: Record<string, DatasetSettings> };
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
  fullW: number;
  fullH: number;
  viewT: number;
  viewC: number;
  multiChannel: boolean;
  epochs: SceneEpochs;
  /** Per-dataset memberId → entity index map. */
  entityIndexByDataset: Map<string, Map<string, number>>;
}


/**
 * Upload+render phase: deliver decoded chunks via Orchestrator, build layer
 * params, and render. Returns true if more work remains.
 */
function uploadAndRenderVolume(
  ctx: TickContext,
  orchestrator: Orchestrator,
  plan: PlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, datasets } = ctx;
  const { memberRoster, settings, eye, canvasW, canvasH, fullW, fullH, viewT, viewC, multiChannel, entityIndexByDataset } = plan;
  const { layerOrder, allSettings } = settings;

  // Use Orchestrator delivery loop instead of uploadChunksForMembers
  const budgetExhausted = orchestrator.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, null);

  if (!shouldRender) return budgetExhausted;

  // Build layer params for visible layers in order
  const invVP = new Float32Array(scene.inv_view_proj());
  const viewProj = new Float32Array(scene.view_proj());
  const camForward = new Float32Array(scene.camera_forward());
  const clipDistance = scene.clip_distance();
  const clipModeStr = scene.clip_mode();
  const clipMode = clipModeStr === "sphere" ? 1 : 0;

  const layers: VolumeLayerParams[] = [];
  const passesByDataset: Record<string, number> = {};
  for (const dsId of layerOrder) {
    const layersBefore = layers.length;
    const dsVol = datasets.get(dsId);
    if (!dsVol) continue;
    const dsSettings = allSettings[dsId];
    if (!dsSettings || !dsSettings.visible) continue;

    const dsShapeV = dsVol.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]

    const members = memberRoster.get(dsId)
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    const indexByMember = entityIndexByDataset.get(dsId) ?? new Map<string, number>();

    if (multiChannel) {
      // Multi-channel: emit one layer per (member, channel)
      const activeChannels = getActiveChannels(dsSettings);
      const channelBlend = dsSettings.channel_blend_mode as "alpha" | "additive" | "max" || "additive";

      for (const ch of activeChannels) {
        if (ch >= dsShapeV[Axis.C] || viewT >= dsShapeV[Axis.T]) continue;

        for (const m of members) {
          const compKey = compositeKey(m.imageId, ch);
          // Model matrix is in the descriptor; CPU side still needs it
          // for the scissor rect projection. Same source as cold state
          // (synthesised for well-as-proxy, scene query for fields).
          const model = m.modelMatrix
            ?? new Float32Array(scene.member_model_matrix(dsId, m.imageId));

          const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
          if (!scissorRect) continue; // well fully off-screen

          const entityIndex = indexByMember.get(compKey);
          if (entityIndex === undefined) continue;

          layers.push({
            datasetId: compKey,
            blendMode: channelBlend,
            renderMode: (dsSettings.render_mode || "translucent") as "translucent" | "max_intensity",
            scissorRect,
            entityId: m.entityId,
            entityIndex,
          });
        }
      }
    } else {
      // Single-channel
      if (viewC >= dsShapeV[Axis.C] || viewT >= dsShapeV[Axis.T]) continue;

      for (const m of members) {
        const model = m.modelMatrix
          ?? new Float32Array(scene.member_model_matrix(dsId, m.imageId));

        const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
        if (!scissorRect) continue; // well fully off-screen

        const entityIndex = indexByMember.get(m.imageId);
        if (entityIndex === undefined) continue;

        layers.push({
          datasetId: m.imageId,
          blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
          renderMode: (dsSettings.render_mode || "translucent") as "translucent" | "max_intensity",
          scissorRect,
          entityId: m.entityId,
          entityIndex,
        });
      }
    }
    const added = layers.length - layersBefore;
    if (added > 0) passesByDataset[dsId] = added;
  }

  if (debugStats.enabled) {
    debugStats.renderPasses = { total: layers.length, byDataset: passesByDataset };
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH, fullW, fullH, plan.epochs, viewProj, camForward, clipDistance, clipMode);

  return budgetExhausted;
}

/**
 * Upload volume chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickVolume(
  ctx: TickContext,
  orchestrator: Orchestrator,
  minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene } = ctx;

  // Use full-res viewport for chunk planning so LOD selection isn't affected
  // by renderScale (which drops to 0.25 during interaction).
  const fullW = Math.round(ctx.canvas.clientWidth * devicePixelRatio);
  const fullH = Math.round(ctx.canvas.clientHeight * devicePixelRatio);
  scene.set_viewport(fullW, fullH);

  const canvasW = Math.round(fullW * ctx.renderScale);
  const canvasH = Math.round(fullH * ctx.renderScale);

  const t0 = debugStats.enabled ? performance.now() : 0;
  const orchResult = orchestrator.planAndFetch(ctx, minimapPendingFetch);
  if (debugStats.enabled) debugStats.planTimeMs = performance.now() - t0;
  if (!orchResult) return false;

  // Volume-specific rendering state. Camera position drives ray-marching
  // in the shader (different from `rayHitLocal`, which is residency-only
  // and emitted by the orchestrator on viewEpoch advance).
  const eye = new Float32Array(scene.eye_position());

  if (debugStats.enabled) {
    const firstDsId = orchResult.settings.layerOrder[0];
    if (firstDsId) {
      const lodInfo = scene.debug_lod_info(firstDsId);
      debugStats.effectiveZoom = lodInfo[0];
      debugStats.zoomPerVoxel = lodInfo[1];
    }
    debugStats.activeChannels = orchResult.multiChannel
      ? getActiveChannels(orchResult.settings.allSettings[orchResult.settings.layerOrder[0]]).length
      : 1;
  }

  const viewT = scene.t();
  const viewC = scene.c();

  const planResult: PlanResult = {
    memberRoster: orchResult.memberRoster,
    settings: orchResult.settings,
    eye, canvasW, canvasH, fullW, fullH, viewT, viewC,
    multiChannel: orchResult.multiChannel,
    epochs: orchResult.epochs,
    entityIndexByDataset: orchResult.entityIndexByDataset,
  };

  const t1 = debugStats.enabled ? performance.now() : 0;
  const result = uploadAndRenderVolume(ctx, orchestrator, planResult, shouldRender);
  if (debugStats.enabled) debugStats.uploadTimeMs = performance.now() - t1;
  return result;
}

export function clearVolumeForDataset(_state: VolumeState, _dsId: string): void {}

/** Clear member-keyed entries for all members of a dataset. */
export function clearVolumeForMembers(_state: VolumeState, _memberIds: string[]): void {}

export function resetVolumeState(_state: VolumeState): void {}
