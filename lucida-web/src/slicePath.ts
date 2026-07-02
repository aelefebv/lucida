/** Slice render path: upload chunks + render multi-pass. */
import { Axis } from "./axes.ts";
import { labelFootprint } from "./renderer/labelLayout.ts";
import { resolveDefaultLabel } from "./pipeline/planning/labelRequests.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import { getActiveChannels, compositeKey } from "./tickCommon.ts";
import type { SceneSettings } from "./tickCommon.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import type { TickCoordinator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import { debugStats } from "./debug/debugStats.ts";

export type SliceState = Record<string, never>;

export function createSliceState(): SliceState { return {}; }

/** Overlay opacity for labels on open — visible without hiding the image. */
const LABEL_DEFAULT_OPACITY = 0.5;

/**
 * Append a categorical overlay layer for the dataset's default label,
 * composited over the intensity layers already pushed. Exactly ONE label
 * is shown by default (at {@link LABEL_DEFAULT_OPACITY}) — stacking every
 * label muddies the view (e.g. a broad "foreground" mask washing out the
 * interesting "mitochondria"); per-label toggles to reveal the rest arrive
 * in a later slice.
 *
 * The label chosen here MUST be the same one {@link computeLabelChunkRequests}
 * fetches, so both call the shared {@link resolveDefaultLabel} (first
 * manifest-order label that is a uint32 mask with a resolvable source, a
 * positive footprint, and a level within the caps). Rendering a label whose
 * chunks were never fetched would draw nothing.
 *
 * The overlay is sized to the SOURCE image's full-resolution voxel
 * footprint via {@link labelFootprint} (so a coarser label stays aligned
 * rather than shrinking) and placed at the source member's position.
 * Declared `image-label.colors` are forwarded so authored palettes render
 * exactly. Labels never change the camera or bounds.
 */
export function pushLabelLayers(
  layers: SliceLayerParams[],
  manifest: DatasetManifest,
  members: MemberRosterEntry[],
): void {
  const resolved = resolveDefaultLabel(manifest);
  if (!resolved) return;
  const { label, source } = resolved;
  const sourceLevel0 = source.multiscale.levels[0];
  const labelLevel0 = label.image.multiscale.levels[0];
  const { dataW, dataH } = labelFootprint(sourceLevel0, labelLevel0);
  // Fields can be offset within a plate/layout; place the overlay at the
  // source member's position so it lands on the image it annotates.
  const sourceMember = members.find((m) => m.imageId === label.source_image_id);
  const position = sourceMember?.position ?? [0, 0];
  layers.push({
    datasetId: label.image.image_id,
    dataW,
    dataH,
    blendMode: "alpha",
    offsetX: position[0],
    offsetY: position[1],
    entityIndex: 0, // labels render via a transient descriptor, not the cold-state buffer
    isLabel: true,
    opacity: LABEL_DEFAULT_OPACITY,
    labelColors: label.colors,
  });
}

/** Result of the plan+fetch phase, passed to the upload+render phase. */
interface SlicePlanResult {
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  vpCx: number;
  vpCy: number;
  multiChannel: boolean;
  epochs: SceneEpochs;
  /** Per-dataset memberId → entity index map. */
  entityIndexByDataset: Map<string, Map<string, number>>;
}

/**
 * Upload+render phase: deliver decoded chunks via Uploader, build layer
 * params, and render.
 */
function uploadAndRenderSlice(
  ctx: TickContext,
  uploader: Uploader,
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

  const budgetExhausted = uploader.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, sliceZ);

  if (!shouldRender) return budgetExhausted;

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
    const fullResWidth = dsShapeL[Axis.X];
    const fullResHeight = dsShapeL[Axis.Y];

    const members = memberRoster.get(dsId)
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    const indexByMember = entityIndexByDataset.get(dsId) ?? new Map<string, number>();

    if (multiChannel) {
      // Multi-channel: emit one layer per (member, channel) with per-channel settings
      const activeChannels = getActiveChannels(dsSettings);
      const channelBlend = dsSettings.channel_blend_mode as "alpha" | "additive" | "max" || "additive";

      for (const ch of activeChannels) {
        if (z >= dsShapeL[Axis.Z] || ch >= dsShapeL[Axis.C] || t >= dsShapeL[Axis.T]) continue;

        for (const m of members) {
          // Synthesized well-as-proxy entries carry their own dataW/dataH
          // (the well's world-space AABB footprint). Fall back to the
          // dataset's full-res image dims for normal field entries.
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
      if (z >= dsShapeL[Axis.Z] || c >= dsShapeL[Axis.C] || t >= dsShapeL[Axis.T]) continue;

      for (const m of members) {
        // Synthesized well-as-proxy entries carry their own dataW/dataH
        // (the well's world-space AABB footprint).
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
    // Categorical label overlays, composited on top of this dataset's
    // intensity layers. Default-on; never affect camera/bounds.
    pushLabelLayers(layers, ds.manifest, members);

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
  tickCoordinator: TickCoordinator,
  uploader: Uploader,
  sliceZ: number,
  sliceT: number,
  sliceC: number,
  minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene, canvas } = ctx;

  // Set scene params before tickCoordinator queries WASM state
  scene.set_z(sliceZ);
  scene.set_t(sliceT);
  scene.set_c(sliceC);
  const dpr = devicePixelRatio;
  const canvasW = Math.round(canvas.clientWidth * dpr);
  const canvasH = Math.round(canvas.clientHeight * dpr);
  scene.set_viewport(canvasW, canvasH);

  const t0 = debugStats.enabled ? performance.now() : 0;
  const orchResult = tickCoordinator.planAndFetch(ctx, minimapPendingFetch);
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

  return uploadAndRenderSlice(ctx, uploader, sliceZ, sliceT, sliceC, planResult, shouldRender);
}

export function clearSliceForDataset(_state: SliceState, _dsId: string): void {}

export function clearSliceForMembers(_state: SliceState, _memberIds: string[]): void {}
