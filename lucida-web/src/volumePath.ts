/** Volume render path: plan-based chunk upload + multi-pass render. */
import { Axis } from "./axes.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import { computeScissorRect } from "./pipeline/upload/scissor.ts";
import { resolveVisibleLabels } from "./pipeline/planning/labelRequests.ts";
import type { LabelSettings } from "./labelSettings.ts";
import { labelModelMatrices } from "./renderer/labelLayout.ts";
import { getActiveChannels, compositeKey } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";
import { debugStats } from "./debug/debugStats.ts";
import type { TickCoordinator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import {
  createMemberPlacementAccessor,
  type MemberPlacementAccessor,
  type MemberPlacementMatrixScene,
} from "./memberPlacement.ts";

/**
 * Narrow scene facet used by the shared placement accessor when a source is
 * outside the active roster.
 */
export type LabelVolumeScene = MemberPlacementMatrixScene;

/**
 * Append a first-hit categorical overlay layer for each of the dataset's
 * VISIBLE labels, composited over the intensity volume already pushed. The
 * visible set + each label's opacity come from `labelSettings` (the dataset's
 * per-label display state); with no settings every eligible label is shown at
 * the default opacity (see {@link resolveVisibleLabels}).
 *
 * The set drawn here MUST match what {@link computeLabelChunkRequests}
 * fetches in `volume` mode, so both resolve through the shared
 * {@link resolveVisibleLabels}. A label overlays its source image's physical
 * extent, so it renders in the SOURCE member's world placement (its model
 * matrix + inverse) — a coarser label still covers the same region of the view,
 * aligned by its own scale in the shader. Both render modes resolve source
 * placement through the shared {@link MemberPlacementAccessor}. Declared
 * `image-label.colors` are
 * forwarded so authored palettes render exactly. Labels never change the
 * camera or bounds.
 */
export function pushLabelVolumeLayers(
  layers: VolumeLayerParams[],
  placement: MemberPlacementAccessor,
  manifest: DatasetManifest,
  viewProj: Float32Array,
  canvasW: number,
  canvasH: number,
  labelSettings?: LabelSettings[],
): void {
  // `mode: "volume"` so the render path resolves the SAME eligible set the
  // volume fetch did — a label too large for a 3D texture is skipped by both
  // (never fetched-but-blank or drawn-but-unfetched).
  for (const resolved of resolveVisibleLabels(manifest, labelSettings, { mode: "volume" })) {
    const { label, source, opacity } = resolved;
    const sourceImageId = label.source_image_id;
    // Anchor to the source member's world placement so the overlay lands on
    // the image it annotates.
    const { modelMatrix: sourceModel, invModelMatrix: sourceInv } =
      placement.matrices3d(sourceImageId);
    // Scale the source placement to the LABEL's own physical extent, so a
    // coarser/differently-scaled label stays aligned by its own scale (the
    // 3D analog of the 2D `labelFootprint`). Identity for a same-extent label.
    const { model, inv } = labelModelMatrices(
      sourceModel,
      sourceInv,
      source.multiscale.levels[0],
      label.image.multiscale.levels[0],
    );
    // Confine the ray-march to the label's screen footprint (off-screen →
    // skip), mirroring the intensity layers.
    const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
    if (!scissorRect) continue;
    layers.push({
      datasetId: label.image.image_id,
      ownerDatasetId: manifest.dataset_id,
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
  memberPositionsByDataset: Map<string, Record<string, [number, number]>>;
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
  const { memberRoster, settings, eye, canvasW, canvasH, fullW, fullH, viewT, viewC, multiChannel, entityIndexByDataset } = plan;
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
          // (precomputed when available, otherwise queried from the scene).
          const model = m.modelMatrix
            ?? new Float32Array(scene.member_model_matrix(dsId, m.imageId));

          const scissorRect = computeScissorRect(model, viewProj, canvasW, canvasH);
          if (!scissorRect) continue; // group fully off-screen

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
        if (!scissorRect) continue; // group fully off-screen

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
    // First-hit categorical label overlays, composited on top of this
    // dataset's intensity volume. Honors the per-label visible set + opacity;
    // never affects camera/bounds.
    pushLabelVolumeLayers(
      layers,
      createMemberPlacementAccessor({
        members,
        positions: plan.memberPositionsByDataset.get(dsId),
        matrixSource: { datasetId: dsId, scene },
      }),
      dsVol.manifest,
      viewProj,
      canvasW,
      canvasH,
      dsSettings.label_settings,
    );

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
  tickCoordinator: TickCoordinator,
  uploader: Uploader,
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
  const orchResult = tickCoordinator.planAndFetch(ctx, minimapPendingFetch);
  if (debugStats.enabled) debugStats.planTimeMs = performance.now() - t0;
  if (!orchResult) return false;

  // Volume-specific rendering state. Camera position drives ray-marching
  // in the shader (different from `rayHitLocal`, which is residency-only
  // and emitted by the tickCoordinator on viewEpoch advance).
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
    memberPositionsByDataset: orchResult.memberPositionsByDataset,
    settings: orchResult.settings,
    eye, canvasW, canvasH, fullW, fullH, viewT, viewC,
    multiChannel: orchResult.multiChannel,
    epochs: orchResult.epochs,
    entityIndexByDataset: orchResult.entityIndexByDataset,
  };

  const t1 = debugStats.enabled ? performance.now() : 0;
  const result = uploadAndRenderVolume(ctx, uploader, planResult, shouldRender);
  if (debugStats.enabled) debugStats.uploadTimeMs = performance.now() - t1;
  return result;
}

export function clearVolumeForDataset(_state: VolumeState, _dsId: string): void {}

export function clearVolumeForMembers(_state: VolumeState, _memberIds: string[]): void {}

export function resetVolumeState(_state: VolumeState): void {}
