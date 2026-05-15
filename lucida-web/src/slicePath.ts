/** Slice render path: upload chunks + render multi-pass. */
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";
import { getActiveChannels, compositeKey } from "./tickCommon.ts";
import type { SceneSettings } from "./tickCommon.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import type { Orchestrator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/orchestrator.ts";
import { debugStats } from "./debug/debugStats.ts";

/** SliceState — empty after S5.3 migration to Orchestrator delivery. */
export type SliceState = Record<string, never>;

export function createSliceState(): SliceState { return {}; }

/** Result of the plan+fetch phase, passed to the upload+render phase. */
interface SlicePlanResult {
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  vpCx: number;
  vpCy: number;
  multiChannel: boolean;
  epochs: SceneEpochs;
  /** M1: per-dataset memberId → entity index map. */
  entityIndexByDataset: Map<string, Map<string, number>>;
}

/**
 * Upload+render phase: deliver decoded chunks via Orchestrator, build layer
 * params, and render.
 */
function uploadAndRenderSlice(
  ctx: TickContext,
  orchestrator: Orchestrator,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  planResult: SlicePlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, canvas, datasets } = ctx;
  const { memberRoster, settings, multiChannel, entityIndexByDataset } = planResult;

  const z = sliceZ;
  const t = sliceT;
  const c = sliceC;

  const dpr = devicePixelRatio;
  const canvasW = Math.round(canvas.clientWidth * dpr);
  const canvasH = Math.round(canvas.clientHeight * dpr);

  // Use Orchestrator delivery loop instead of uploadChunksForMembers
  const budgetExhausted = orchestrator.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, sliceZ);

  if (!shouldRender) return budgetExhausted;

  // Build layer params for visible layers in order
  const { layerOrder, allSettings } = settings;
  const currentZoom = scene.zoom();
  const centerArr = scene.center();
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  const passesByDataset: Record<string, number> = {};
  for (const dsId of layerOrder) {
    const layersBefore = layers.length;
    const ds = datasets.get(dsId);
    if (!ds) continue;
    const dsSettings = allSettings[dsId];
    if (!dsSettings || !dsSettings.visible) continue;

    const dsShapeL = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    const fullResWidth = dsShapeL[4];
    const fullResHeight = dsShapeL[3];

    const members = memberRoster.get(dsId)
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    const indexByMember = entityIndexByDataset.get(dsId) ?? new Map<string, number>();

    if (multiChannel) {
      // Multi-channel: emit one layer per (member, channel) with per-channel settings
      const activeChannels = getActiveChannels(dsSettings);
      const channelBlend = dsSettings.channel_blend_mode as "alpha" | "additive" | "max" || "additive";

      for (const ch of activeChannels) {
        if (z >= dsShapeL[2] || ch >= dsShapeL[1] || t >= dsShapeL[0]) continue;

        for (const m of members) {
          // S8 fix: synthesized well-as-proxy entries carry their own
          // dataW/dataH (the well's world-space AABB footprint). Fall back
          // to the dataset's full-res image dims for normal field entries.
          const layerDataW = m.dataW ?? fullResWidth;
          const layerDataH = m.dataH ?? fullResHeight;
          const compKey = compositeKey(m.imageId, ch);
          const entityIndex = indexByMember.get(compKey);
          if (entityIndex === undefined) continue;
          layers.push({
            datasetId: compKey,
            dataW: layerDataW,
            dataH: layerDataH,
            blendMode: channelBlend,
            offsetX: m.position[0],
            offsetY: m.position[1],
            entityId: m.entityId,
            entityIndex,
          });
        }
      }
    } else {
      // Single-channel
      if (z >= dsShapeL[2] || c >= dsShapeL[1] || t >= dsShapeL[0]) continue;

      for (const m of members) {
        // S8 fix: synthesized well-as-proxy entries carry their own
        // dataW/dataH (the well's world-space AABB footprint).
        const layerDataW = m.dataW ?? fullResWidth;
        const layerDataH = m.dataH ?? fullResHeight;
        const entityIndex = indexByMember.get(m.imageId);
        if (entityIndex === undefined) continue;
        layers.push({
          datasetId: m.imageId,
          dataW: layerDataW,
          dataH: layerDataH,
          blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
          offsetX: m.position[0],
          offsetY: m.position[1],
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

  client.resize(canvasW, canvasH);
  client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH, planResult.epochs);

  return budgetExhausted;
}

/**
 * Upload slice chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickSlice(
  ctx: TickContext,
  orchestrator: Orchestrator,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene, canvas } = ctx;

  // Set scene params before orchestrator queries WASM state
  scene.set_z(sliceZ);
  scene.set_t(sliceT);
  scene.set_c(sliceC);
  const dpr = devicePixelRatio;
  const canvasW = Math.round(canvas.clientWidth * dpr);
  const canvasH = Math.round(canvas.clientHeight * dpr);
  scene.set_viewport(canvasW, canvasH);

  const t0 = debugStats.enabled ? performance.now() : 0;
  const orchResult = orchestrator.planAndFetch(ctx, minimapPendingFetch);
  if (debugStats.enabled) debugStats.planTimeMs = performance.now() - t0;
  if (!orchResult) return false;

  const vpCenter = scene.center();
  const planResult: SlicePlanResult = {
    memberRoster: orchResult.memberRoster,
    settings: orchResult.settings,
    vpCx: vpCenter[0],
    vpCy: vpCenter[1],
    multiChannel: orchResult.multiChannel,
    epochs: orchResult.epochs,
    entityIndexByDataset: orchResult.entityIndexByDataset,
  };

  return uploadAndRenderSlice(ctx, orchestrator, sliceZ, sliceT, sliceC, planResult, shouldRender);
}

export function clearSliceForDataset(_state: SliceState, _dsId: string): void {}

/** Clear member-keyed entries for all members of a dataset. */
export function clearSliceForMembers(_state: SliceState, _memberIds: string[]): void {}
