/** Volume render path: plan-based chunk upload + multi-pass render. */
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import { computeScissorRect } from "./pipeline/upload/scissor.ts";
import { resolveVisibleLabels, type LabelViewSetting } from "./pipeline/planning/labelRequests.ts";
import { labelModelMatrices } from "./renderer/labelLayout.ts";
import { compositeKey } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";
import type { ResolvedLayers } from "./resolvedLayers.ts";
import { traceRecorder } from "./trace/recorder.ts";
import type { TickCoordinator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";

/**
 * The scene bindings {@link pushLabelVolumeLayers} needs to place a label.
 * Narrow so the function stays unit-testable without wasm.
 */
export interface LabelVolumeScene {
  member_model_matrix(datasetId: string, memberId: string): Float32Array;
  inv_member_model_matrix(datasetId: string, memberId: string): Float32Array;
}

/**
 * Append a first-hit overlay layer for each visible label, over the intensity
 * volume. The drawn set must match what {@link computeLabelChunkRequests}
 * fetches in `volume` mode, so both go through {@link resolveVisibleLabels}.
 * Labels render in the source member's world placement and never change the
 * camera or bounds.
 */
export function pushLabelVolumeLayers(
  layers: VolumeLayerParams[],
  scene: LabelVolumeScene,
  datasetId: string,
  manifest: DatasetManifest,
  members: MemberRosterEntry[],
  viewProj: Float32Array,
  canvasW: number,
  canvasH: number,
  labelSettings?: LabelViewSetting[],
): void {
  // `mode: "volume"` matches the volume fetch, so a label too large for a 3D
  // texture is skipped by both.
  for (const resolved of resolveVisibleLabels(manifest, labelSettings, { mode: "volume" })) {
    const { label, source, opacity } = resolved;
    const sourceImageId = label.source_image_id;
    // Group-as-proxy roster entries carry their own matrices.
    const sourceMember = members.find((m) => m.imageId === sourceImageId);
    const sourceModel = sourceMember?.modelMatrix
      ?? new Float32Array(scene.member_model_matrix(datasetId, sourceImageId));
    const sourceInv = sourceMember?.invModelMatrix
      ?? new Float32Array(scene.inv_member_model_matrix(datasetId, sourceImageId));
    // Scale to the label's own extent so a differently scaled label stays
    // aligned (the 3D analog of `labelFootprint`).
    const { model, inv } = labelModelMatrices(
      sourceModel,
      sourceInv,
      source.multiscale.levels[0],
      label.image.multiscale.levels[0],
    );
    // Confine the ray-march to the label's screen footprint, as for intensity.
    const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
    if (!scissorRect) continue;
    layers.push({
      datasetId: label.image.image_id,
      blendMode: "alpha",
      renderMode: "translucent",
      scissorRect,
      entityIndex: 0, // labels render via a transient descriptor, not the cold-state buffer
      isLabel: true,
      opacity,
      labelColors: label.colors,
      modelMatrix: model,
      invModelMatrix: inv,
    });
  }
}

export type VolumeState = Record<string, never>;

export function createVolumeState(): VolumeState { return {}; }

/** Data passed from the plan+fetch phase to the upload+render phase. */
interface PlanResult {
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: { layerOrder: string[]; allSettings: Record<string, DatasetSettings> };
  layers: ResolvedLayers;
  eye: Float32Array;
  canvasW: number;
  canvasH: number;
  fullW: number;
  fullH: number;
  epochs: SceneEpochs;
  /** Per-dataset memberId → entity index map. */
  entityIndexByDataset: Map<string, Map<string, number>>;
}


/**
 * Upload+render phase: deliver decoded chunks via Uploader, build layer
 * params, and render. Returns true if more work remains.
 */
function uploadAndRenderVolume(
  ctx: TickContext,
  uploader: Uploader,
  plan: PlanResult,
  shouldRender: boolean = true,
): boolean {
  const { scene, client, datasets } = ctx;
  const { memberRoster, settings, layers: resolvedLayers, eye, canvasW, canvasH, fullW, fullH, entityIndexByDataset } = plan;
  const { layerOrder, allSettings } = settings;

  const budgetExhausted = uploader.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, null);

  if (!shouldRender) return budgetExhausted;

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
    const resolved = resolvedLayers.get(dsId);
    if (!dsSettings || !resolved || !resolved.visible) continue;

    const members = memberRoster.get(dsId)
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    const indexByMember = entityIndexByDataset.get(dsId) ?? new Map<string, number>();

    // A layer past the scene's t draws its clamped timepoint, which the plan
    // already asked for.
    for (const ch of resolved.channels) {
      for (const m of members) {
        const compKey = compositeKey(m.imageId, ch.channel);
        // The descriptor holds the model matrix, but the CPU needs it too
        // for the scissor projection.
        const model = m.modelMatrix
          ?? new Float32Array(scene.member_model_matrix(dsId, m.imageId));

        const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
        if (!scissorRect) continue; // group fully off-screen

        const entityIndex = indexByMember.get(compKey);
        if (entityIndex === undefined) continue;

        layers.push({
          datasetId: compKey,
          blendMode: ch.blend_mode,
          renderMode: resolved.render_mode,
          scissorRect,
          entityId: m.entityId,
          entityIndex,
        });
      }
    }
    pushLabelVolumeLayers(
      layers,
      scene,
      dsId,
      dsVol.manifest,
      members,
      viewProj,
      canvasW,
      canvasH,
      dsSettings.label_settings,
    );
  }

  client.volumeRenderMultiPass(layers, invVP, eye, canvasW, canvasH, fullW, fullH, plan.epochs, viewProj, camForward, clipDistance, clipMode);
  // The worker is FIFO, so every chunk posted above is written before this
  // render runs: `upload` closes here and `present` opens. Rows that opened
  // `present` at the previous frame are drawn by now and close here too.
  traceRecorder.noteFrameDispatched();

  return budgetExhausted;
}

/**
 * Upload volume chunks and render. Returns true if upload budget was exhausted
 * (caller should schedule another frame).
 */
export function tickVolume(
  ctx: TickContext,
  tickCoordinator: TickCoordinator,
  uploader: Uploader,
  minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene } = ctx;

  // Use full-res viewport for chunk planning so LOD selection isn't affected
  // by the render resolution, which drops while the camera moves.
  const fullW = Math.round(ctx.canvas.clientWidth * devicePixelRatio);
  const fullH = Math.round(ctx.canvas.clientHeight * devicePixelRatio);
  scene.set_viewport(fullW, fullH, devicePixelRatio);

  const scale = ctx.renderScale * ctx.resolutionScale;
  const canvasW = Math.round(fullW * scale);
  const canvasH = Math.round(fullH * scale);

  const orchResult = tickCoordinator.planAndFetch(ctx, minimapPendingFetch);
  if (!orchResult) return false;

  // The eye drives the shader's ray-march; `rayHitLocal` is residency-only.
  const eye = new Float32Array(scene.eye_position());

  const planResult: PlanResult = {
    memberRoster: orchResult.memberRoster,
    settings: orchResult.settings,
    layers: orchResult.layers,
    eye, canvasW, canvasH, fullW, fullH,
    epochs: orchResult.epochs,
    entityIndexByDataset: orchResult.entityIndexByDataset,
  };

  const result = uploadAndRenderVolume(ctx, uploader, planResult, shouldRender);
  return result;
}

export function clearVolumeForDataset(_state: VolumeState, _dsId: string): void {}

export function clearVolumeForMembers(_state: VolumeState, _memberIds: string[]): void {}

export function resetVolumeState(_state: VolumeState): void {}
