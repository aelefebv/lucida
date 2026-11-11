/** Volume render path: plan-based chunk upload + multi-pass render. */
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";
import type { FrameScale, TickContext, TickView } from "./renderLoopTypes.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import { computeScissorRect } from "./pipeline/upload/scissor.ts";
import { labelChunkAt, resolveVisibleLabels, type LabelViewSetting, type ResolvedLabel } from "./pipeline/planning/labelRequests.ts";
import { labelModelMatrices } from "./renderer/labelLayout.ts";
import { compositeKey } from "./tickCommon.ts";
import type { ResolvedLayers } from "./resolvedLayers.ts";
import { traceRecorder } from "./trace/recorder.ts";
import { comparisonClip, intersectRects } from "./comparison.ts";
import type { PixelRect } from "./renderer/layerBatches.ts";
import type { TickCoordinatorResult } from "./pipeline/tickCoordinator.ts";
import { datasetViewKey } from "./renderer/poolKeys.ts";
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

/** The canvas at a volume view's render scale, which drops while the camera moves. */
export function volumeFrameScale(ctx: TickContext): FrameScale {
  // The plan sizes levels from the full-resolution canvas, so the scale
  // lowers only what is drawn.
  const scale = ctx.renderScale * ctx.resolutionScale;
  return {
    canvasW: Math.round(Math.round(ctx.canvas.clientWidth * devicePixelRatio) * scale),
    canvasH: Math.round(Math.round(ctx.canvas.clientHeight * devicePixelRatio) * scale),
    scale,
  };
}

/** Build `view`'s layer params and render it in its rectangle of the canvas. */
export function renderVolumeView(
  ctx: TickContext,
  plan: TickCoordinatorResult,
  resolvedLayers: ResolvedLayers,
  view: TickView,
  frame: FrameScale,
): void {
  const { scene, client, datasets } = ctx;
  const { memberRosterByDatasetView, settings, entityIndexByDatasetView } = plan;
  const { canvasW: fullCanvasW, canvasH: fullCanvasH } = frame;
  const { layerOrder, allSettings } = settings;
  // Cursors keep their size whatever the render scale, so they read the
  // view in device pixels.
  const [, , fullW, fullH] = view.rect;
  const rect = scaleRect(view.rect, frame.scale);
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

    // The members and descriptors of this view's draw of the dataset.
    const members = memberRosterByDatasetView.get(datasetViewKey(dsId, view.id))
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    const indexByMember = entityIndexByDatasetView.get(datasetViewKey(dsId, view.id)) ?? new Map<string, number>();

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

export function clearVolumeForDataset(_state: VolumeState, _dsId: string): void {}

export function clearVolumeForMembers(_state: VolumeState, _memberIds: string[]): void {}

export function resetVolumeState(_state: VolumeState): void {}
