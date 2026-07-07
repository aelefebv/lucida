/** Slice render path: upload chunks + render multi-pass. */
import { Axis } from "./axes.ts";
import { labelFootprint } from "./renderer/labelLayout.ts";
import { resolveVisibleLabels, type LabelViewSetting } from "./pipeline/planning/labelRequests.ts";
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

/**
 * Append a categorical overlay layer for each of the dataset's VISIBLE labels,
 * composited over the intensity layers already pushed. The visible set + each
 * label's opacity come from `labelSettings` (the dataset's per-label display
 * state); with no settings this falls back to the single default label at the
 * default opacity, so behavior is unchanged until the user interacts.
 *
 * The set drawn here MUST match what {@link computeLabelChunkRequests} fetches,
 * so both resolve through the shared {@link resolveVisibleLabels} (each
 * manifest-order label that is VISIBLE per settings and a uint32 mask with a
 * resolvable source, a positive footprint, and a level within the caps).
 * Rendering a label whose chunks were never fetched would draw nothing; fetching
 * a hidden label would waste bandwidth.
 *
 * Each overlay is sized to the SOURCE image's full-resolution voxel footprint
 * via {@link labelFootprint} (so a coarser label stays aligned rather than
 * shrinking) and placed at the source member's position. Declared
 * `image-label.colors` are forwarded so authored palettes render exactly.
 * Labels never change the camera or bounds.
 */
export function pushLabelLayers(
  layers: SliceLayerParams[],
  manifest: DatasetManifest,
  members: MemberRosterEntry[],
  labelSettings?: LabelViewSetting[],
  memberPositions?: Record<string, [number, number]>,
): void {
  for (const resolved of resolveVisibleLabels(manifest, labelSettings)) {
    const { label, source, opacity } = resolved;
    const sourceLevel0 = source.multiscale.levels[0];
    const labelLevel0 = label.image.multiscale.levels[0];
    const { dataW, dataH } = labelFootprint(sourceLevel0, labelLevel0);
    // Tiles can be offset within a collection/layout; place the overlay at the
    // source member's position so it lands on the image it annotates. The
    // source tile is frequently ABSENT from the active-set roster — in a collection
    // a whole group renders as a single proxy, and off-view tiles aren't active
    // at all — so fall back to the scene's authoritative per-member layout
    // position (keyed by the source ENTITY id, the same space as the roster's
    // positions). Falling back to the origin instead would stack every
    // off-roster label on the first group (the bug this repairs).
    const sourceMember = members.find((m) => m.imageId === label.source_image_id);
    const position = sourceMember?.position ?? memberPositions?.[source.owner] ?? [0, 0];
    layers.push({
      datasetId: label.image.image_id,
      dataW,
      dataH,
      blendMode: "alpha",
      offsetX: position[0],
      offsetY: position[1],
      entityIndex: 0, // labels render via a transient descriptor, not the cold-state buffer
      isLabel: true,
      opacity,
      labelColors: label.colors,
    });
  }
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
          // Synthesized group-as-proxy entries carry their own dataW/dataH
          // (the group's world-space AABB footprint). Fall back to the
          // dataset's full-res image dims for normal tile entries.
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
        // Synthesized group-as-proxy entries carry their own dataW/dataH
        // (the group's world-space AABB footprint).
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
    // intensity layers. Honors the per-label visible set + opacity; never
    // affects camera/bounds. A label's source tile is often not in the active
    // roster (collection groups proxy; off-view tiles), so hand the scene's full
    // per-member position map (entity id -> [x, y]) as the placement fallback.
    let labelMemberPositions: Record<string, [number, number]> | undefined;
    if (ds.manifest.labels && ds.manifest.labels.length > 0) {
      try {
        labelMemberPositions = JSON.parse(scene.member_positions(dsId)) as Record<string, [number, number]>;
      } catch {
        labelMemberPositions = undefined;
      }
    }
    pushLabelLayers(layers, ds.manifest, members, dsSettings.label_settings, labelMemberPositions);

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
