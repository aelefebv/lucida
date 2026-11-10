/** Volume render path: plan-based chunk upload + multi-pass render. */
import { assertCanvasSize } from "./applyAndSend.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import { drawnView, type TickContext, type TickView } from "./renderLoopTypes.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import { computeScissorRect } from "./pipeline/upload/scissor.ts";
import { labelChunkAt, resolveVisibleLabels, type LabelViewSetting, type ResolvedLabel } from "./pipeline/planning/labelRequests.ts";
import { labelModelMatrices } from "./renderer/labelLayout.ts";
import { compositeKey } from "./tickCommon.ts";
import type { DatasetSettings } from "./tickCommon.ts";
import { readResolvedLayers, type ResolvedLayers } from "./resolvedLayers.ts";
import { traceRecorder } from "./trace/recorder.ts";
import { comparisonClip, intersectRects } from "./comparison.ts";
import type { PixelRect } from "./renderer/layerBatches.ts";
import type { TickCoordinator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import { scaleRect } from "./slicePath.ts";

/**
 * Ray-march steps a gesture's frame takes per step of its sampled level.
 * Half the samples halves a frame's GPU time, at the cost of fine structure
 * along the ray while the view moves.
 */
export const INTERACTION_MARCH_STEP_SCALE = 2;

/**
 * The ray-march step scale a frame at `renderScale` takes, before a slow
 * gesture coarsens it further. The viewer draws a gesture at a reduced
 * render scale and restores it, with a frame, once input stops. The coarser
 * march rides the same switch, so that restored frame is drawn at full
 * quality, as every settled one is.
 */
export function marchStepScaleFor(renderScale: number): number {
  return renderScale < 1 ? INTERACTION_MARCH_STEP_SCALE : 1;
}

/**
 * The scene bindings {@link pushLabelVolumeLayers} needs to place a label.
 * Narrow so the function stays unit-testable without wasm.
 */
export interface LabelVolumeScene {
  member_model_matrix(datasetId: string, memberId: string): Float32Array;
  inv_member_model_matrix(datasetId: string, memberId: string): Float32Array;
}

/** The level and chunk-T of a label that volume mode draws at source `t`, every Z of it. */
function labelVolumeChunkAt(resolved: ResolvedLabel, t: number): { level: number; t: number } {
  const chunk = labelChunkAt(resolved, t);
  return { level: chunk.level, t: chunk.t };
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
  viewProj: Float32Array,
  canvasW: number,
  canvasH: number,
  labelSettings?: LabelViewSetting[],
  t?: number,
): void {
  // `mode: "volume"` matches the volume fetch, so a label too large for a 3D
  // texture is skipped by both.
  for (const resolved of resolveVisibleLabels(manifest, labelSettings, { mode: "volume" })) {
    const { label, source, opacity } = resolved;
    const sourceImageId = label.source_image_id;
    const sourceModel = new Float32Array(scene.member_model_matrix(datasetId, sourceImageId));
    const sourceInv = new Float32Array(scene.inv_member_model_matrix(datasetId, sourceImageId));
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
      entityId: source.owner,
      entityIndex: 0, // labels render via a transient descriptor, not the cold-state buffer
      isLabel: true,
      opacity,
      labelColors: label.colors,
      labelChunk: t === undefined ? undefined : labelVolumeChunkAt(resolved, t),
      modelMatrix: model,
      invModelMatrix: inv,
    });
  }
}

/**
 * Narrow the layers from `start` on to `clip`, dropping any it leaves no
 * pixels of. A layer marches only inside its scissor, so the clip saves the
 * march as well as hiding what it would draw.
 */
export function clipVolumeLayers(layers: VolumeLayerParams[], start: number, clip: PixelRect): void {
  let kept = start;
  for (let i = start; i < layers.length; i++) {
    const layer = layers[i];
    const rect = intersectRects(layer.scissorRect ?? clip, clip);
    if (!rect) continue;
    layer.scissorRect = rect;
    layers[kept++] = layer;
  }
  layers.length = kept;
}

export type VolumeState = Record<string, never>;

export function createVolumeState(): VolumeState { return {}; }

/** Data passed from the plan+fetch phase to the upload+render phase. */
interface PlanResult {
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: { layerOrder: string[]; allSettings: Record<string, DatasetSettings> };
  layers: ResolvedLayers;
  /** The canvas's backing store, at the frame's render scale. */
  canvasW: number;
  canvasH: number;
  /** Backing-store pixels per device pixel of the canvas. */
  scale: number;
  epochs: SceneEpochs;
  /** Per-dataset memberId → entity index map. */
  entityIndexByDataset: Map<string, Map<string, number>>;
}


/**
 * Upload+render phase: deliver decoded chunks via Uploader, unless uploads
 * are held, build layer params, and render. Returns true if more work
 * remains.
 */
function uploadAndRenderVolume(
  ctx: TickContext,
  uploader: Uploader,
  plan: PlanResult,
  shouldRender: boolean,
  holdUploads: boolean,
): boolean {
  const { scene } = ctx;

  let budgetExhausted = false;
  if (holdUploads) uploader.holdDelivery();
  else budgetExhausted = uploader.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, null);

  if (!shouldRender) return budgetExhausted;

  const drawn = drawnView(ctx);
  for (const view of ctx.views) {
    if (view.mode !== "volume") continue;
    // The drawn view draws the layers its plan resolved, which a coalesced
    // tick keeps from the plan before.
    const layers = view.id === drawn.id ? plan.layers : readResolvedLayers(scene, view.id);
    renderVolumeView(ctx, plan, layers, view);
  }
  return budgetExhausted;
}

/** Build `view`'s layer params and render it in its rectangle of the canvas. */
function renderVolumeView(
  ctx: TickContext,
  plan: PlanResult,
  resolvedLayers: ResolvedLayers,
  view: TickView,
): void {
  const { scene, client, datasets } = ctx;
  const { memberRoster, settings, canvasW: fullCanvasW, canvasH: fullCanvasH, entityIndexByDataset } = plan;
  const { layerOrder, allSettings } = settings;
  // Cursors keep their size whatever the render scale, so they read the
  // view in device pixels.
  const [, , fullW, fullH] = view.rect;
  const rect = scaleRect(view.rect, plan.scale);
  const [, , canvasW, canvasH] = rect;

  // The eye drives the shader's ray-march; `rayHitLocal` is residency-only.
  const eye = new Float32Array(scene.eye_position(view.id));
  const invVP = new Float32Array(scene.inv_view_proj(view.id));
  const viewProj = new Float32Array(scene.view_proj(view.id));
  const camForward = new Float32Array(scene.camera_forward(view.id));
  const clipDistance = scene.clip_distance(view.id);
  const clipModeStr = scene.clip_mode(view.id);
  const clipMode = clipModeStr === "sphere" ? 1 : 0;

  const layers: VolumeLayerParams[] = [];
  for (const dsId of layerOrder) {
    const dsVol = datasets.get(dsId);
    if (!dsVol) continue;
    const dsSettings = allSettings[dsId];
    const resolved = resolvedLayers.get(dsId);
    if (!dsSettings || !resolved || !resolved.visible) continue;
    // A comparison draws a dataset on its side of the divider, or not at all
    // while a blink shows the other. Either way it stays planned and resident.
    const clip = comparisonClip(scene, view.id, dsId, canvasW, canvasH);
    if (clip === "hidden") continue;
    const firstLayer = layers.length;

    const members = memberRoster.get(dsId)
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    const indexByMember = entityIndexByDataset.get(dsId) ?? new Map<string, number>();

    // The descriptor holds the model matrix, but the CPU needs it too for
    // the scissor projection, which every channel of a member shares.
    const scissors = members.map((m) => computeScissorRect(
      m.modelMatrix ?? new Float32Array(scene.member_model_matrix(dsId, m.imageId)), viewProj, canvasW, canvasH,
    ));

    // A layer past the scene's t draws its clamped timepoint, which the plan
    // already asked for.
    for (const ch of resolved.channels) {
      for (const [i, m] of members.entries()) {
        const scissorRect = scissors[i];
        if (!scissorRect) continue; // group fully off-screen

        const compKey = compositeKey(m.imageId, ch.channel);
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
      viewProj,
      canvasW,
      canvasH,
      dsSettings.label_settings,
      resolved.t,
    );
    if (clip) clipVolumeLayers(layers, firstLayer, clip);
  }

  const pixelRatio = devicePixelRatio * ctx.renderScale * ctx.resolutionScale;
  const frameSeq = client.volumeRenderMultiPass(
    layers, invVP, eye, fullCanvasW, fullCanvasH, fullW, fullH, plan.epochs, view.id, rect, viewProj, camForward,
    clipDistance, clipMode, pixelRatio, ctx.marchStepScale, ctx.bands,
  );
  // The worker is FIFO, so every chunk posted above is written before this
  // render runs: `upload` closes here and `present` opens. Rows that opened
  // `present` at the previous frame are drawn by now and close here too.
  traceRecorder.noteFrameDispatched(frameSeq);
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
  assertCanvasSize(scene, fullW, fullH, devicePixelRatio);

  const scale = ctx.renderScale * ctx.resolutionScale;
  const canvasW = Math.round(fullW * scale);
  const canvasH = Math.round(fullH * scale);

  const orchResult = tickCoordinator.planAndFetch(ctx, minimapPendingFetch);
  if (!orchResult) return false;

  const planResult: PlanResult = {
    memberRoster: orchResult.memberRoster,
    settings: orchResult.settings,
    layers: orchResult.layers,
    canvasW, canvasH, scale,
    epochs: orchResult.epochs,
    entityIndexByDataset: orchResult.entityIndexByDataset,
  };

  // Read after the plan, which notes whether the view moved.
  const holdUploads = tickCoordinator.msUntilUploadsResume(performance.now()) !== null;
  return uploadAndRenderVolume(ctx, uploader, planResult, shouldRender, holdUploads);
}

export function clearVolumeForDataset(_state: VolumeState, _dsId: string): void {}

export function clearVolumeForMembers(_state: VolumeState, _memberIds: string[]): void {}

export function resetVolumeState(_state: VolumeState): void {}
