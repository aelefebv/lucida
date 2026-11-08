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
import { traceRecorder } from "./trace/recorder.ts";

export type SliceState = Record<string, never>;

export function createSliceState(): SliceState { return {}; }

/**
 * Device-pixel diagonal below which a member folds into its dataset's
 * aggregate pass. At overview zoom a wide collection renders in one instanced
 * pass. A member this small is a few pixels on screen, so the aggregate draw
 * looks the same as an individual pass.
 */
export const MEMBER_AGGREGATE_MAX_DIAG_PX = 32;

/**
 * Hard cap on individual member passes per (dataset, channel), so per-frame
 * pass count can never track member count. Past it, the smallest members fold
 * into the aggregate pass.
 */
export const MAX_INDIVIDUAL_MEMBER_PASSES = 256;

/**
 * Backing-pixel cap for the slice render target (about 4K). Past it the target
 * renders at reduced resolution and the browser upscales, so a frame always
 * presents. Planning keeps the full device-pixel viewport, as the volume path
 * does with renderScale.
 */
export const MAX_SLICE_BACKING_PIXELS = 3840 * 2160;

/**
 * Uniform scale factor applied to an oversized backing so
 * `w·s × h·s ≤ MAX_SLICE_BACKING_PIXELS`; `1` for backings within the
 * cap. Callers must scale the render zoom by the same factor to keep
 * the world field of view unchanged.
 */
export function sliceBackingScale(backingW: number, backingH: number): number {
  const px = backingW * backingH;
  if (px <= MAX_SLICE_BACKING_PIXELS || px <= 0) return 1;
  return Math.sqrt(MAX_SLICE_BACKING_PIXELS / px);
}

/** Inputs for one (dataset, channel) {@link pushMemberLayers} call. */
export interface MemberLayerInput {
  members: MemberRosterEntry[];
  /** memberId (or composite `id:chN` key) → entity descriptor index. */
  indexByMember: Map<string, number>;
  /** Channel for multi-channel composite keys; `null` in single-channel mode. */
  channel: number | null;
  blendMode: "alpha" | "additive" | "max";
  /** Every member's footprint, in voxels. */
  fullResWidth: number;
  fullResHeight: number;
  /** Device pixels per voxel at the render backing resolution. */
  zoom: number;
}

/** Internal classification record for one renderable member. */
interface MemberLayerCandidate {
  member: MemberRosterEntry;
  memberKey: string;
  entityIndex: number;
  dataW: number;
  dataH: number;
  diagPx: number;
  order: number;
}

/** Bytes per record in {@link SliceAggregateParams.quads} (see its doc). */
const AGGREGATE_QUAD_STRIDE_BYTES = 32;

/**
 * Emit render layers for one (dataset, channel) member set under the
 * member-pass budget. Members at or above {@link MEMBER_AGGREGATE_MAX_DIAG_PX}
 * keep individual layers in roster order. Smaller ones, and the smallest past
 * {@link MAX_INDIVIDUAL_MEMBER_PASSES}, fold into one aggregate layer beneath
 * them. Aggregation only engages when it reduces passes, so a single-image
 * dataset never batches.
 */
export function pushMemberLayers(
  layers: SliceLayerParams[],
  input: MemberLayerInput,
): void {
  const {
    members, indexByMember, channel, blendMode,
    fullResWidth, fullResHeight, zoom,
  } = input;
  // Every layer this call emits shares one target. The index of the first is
  // unique in the frame and needs no counter threaded through the callers.
  const passGroup = layers.length;

  // A non-positive or non-finite extent covers no pixels and would break
  // the aggregate's union-extent normalization, so cull it here.
  if (!(fullResWidth > 0) || !(fullResHeight > 0)) return;
  const dataW = fullResWidth;
  const dataH = fullResHeight;

  const candidates: MemberLayerCandidate[] = [];
  for (const m of members) {
    const memberKey = channel === null ? m.imageId : compositeKey(m.imageId, channel);
    const entityIndex = indexByMember.get(memberKey);
    if (entityIndex === undefined) continue;
    candidates.push({
      member: m,
      memberKey,
      entityIndex,
      dataW,
      dataH,
      diagPx: Math.hypot(dataW, dataH) * zoom,
      order: candidates.length,
    });
  }

  let individual: MemberLayerCandidate[] = [];
  let batched: MemberLayerCandidate[] = [];
  for (const c of candidates) {
    (c.diagPx >= MEMBER_AGGREGATE_MAX_DIAG_PX ? individual : batched).push(c);
  }
  if (individual.length > MAX_INDIVIDUAL_MEMBER_PASSES) {
    // Keep the largest, fold the rest, then restore roster order.
    individual.sort((a, b) => b.diagPx - a.diagPx);
    batched = batched.concat(individual.slice(MAX_INDIVIDUAL_MEMBER_PASSES));
    individual = individual.slice(0, MAX_INDIVIDUAL_MEMBER_PASSES);
    individual.sort((a, b) => a.order - b.order);
  }
  if (batched.length === 1 && individual.length >= MAX_INDIVIDUAL_MEMBER_PASSES) {
    // Unfolding a lone batched member below would emit cap+1 passes, so
    // fold the smallest individual in with it.
    let smallest = 0;
    for (let i = 1; i < individual.length; i++) {
      if (individual[i].diagPx < individual[smallest].diagPx) smallest = i;
    }
    batched.push(individual.splice(smallest, 1)[0]);
  }
  if (batched.length < 2) {
    individual = individual.concat(batched);
    individual.sort((a, b) => a.order - b.order);
    batched = [];
  }
  // Quad order is the aggregate's draw order. The cap-overflow path above
  // collects members in size order, so restore roster order.
  batched.sort((a, b) => a.order - b.order);

  if (batched.length > 0) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (const c of batched) {
      minX = Math.min(minX, c.member.position[0]);
      minY = Math.min(minY, c.member.position[1]);
      maxX = Math.max(maxX, c.member.position[0] + c.dataW);
      maxY = Math.max(maxY, c.member.position[1] + c.dataH);
    }
    const extW = maxX - minX;
    const extH = maxY - minY;
    if (extW > 0 && extH > 0) {
      const quads = new ArrayBuffer(batched.length * AGGREGATE_QUAD_STRIDE_BYTES);
      const f32 = new Float32Array(quads);
      const u32 = new Uint32Array(quads);
      batched.forEach((c, i) => {
        const base = i * (AGGREGATE_QUAD_STRIDE_BYTES / 4);
        f32[base + 0] = (c.member.position[0] - minX) / extW;
        f32[base + 1] = (c.member.position[1] - minY) / extH;
        f32[base + 2] = c.dataW / extW;
        f32[base + 3] = c.dataH / extH;
        u32[base + 4] = c.entityIndex;
      });
      // Emitted beneath the individual layers, so a batched member that
      // overlaps an individual one draws under it regardless of roster
      // order. Accepted, since batched members are the smallest on screen.
      layers.push({
        datasetId: batched[0].memberKey,
        dataW: extW,
        dataH: extH,
        blendMode,
        offsetX: minX,
        offsetY: minY,
        // Informational for an aggregate layer; each quad carries its
        // own descriptor index in `quads`.
        entityIndex: batched[0].entityIndex,
        aggregate: {
          poolMemberId: batched[0].memberKey,
          count: batched.length,
          quads,
        },
        passGroup,
      });
    } else {
      // Unreachable while zero-extent members are culled above. Falls back to
      // per-member emission rather than dividing by zero.
      individual = individual.concat(batched);
      individual.sort((a, b) => a.order - b.order);
    }
  }

  for (const c of individual) {
    layers.push({
      datasetId: c.memberKey,
      dataW: c.dataW,
      dataH: c.dataH,
      blendMode,
      offsetX: c.member.position[0],
      offsetY: c.member.position[1],
      entityId: c.member.entityId,
      entityIndex: c.entityIndex,
      passGroup,
    });
  }
}

/**
 * Append an overlay layer for each visible label, over the intensity layers.
 *
 * The drawn set must match what {@link computeLabelChunkRequests} fetches, so
 * both go through {@link resolveVisibleLabels}. Each overlay is sized to the
 * source image's full-resolution footprint, so a coarser label stays aligned
 * rather than shrinking. Labels never change the camera or bounds.
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
    // The source tile is often absent from the roster (off-view tiles aren't
    // active), so fall back to the scene's per-member layout position, keyed
    // by source entity id. Falling back to the origin would stack every
    // off-roster label on the first group.
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
  const fullW = Math.round(canvas.clientWidth * dpr);
  const fullH = Math.round(canvas.clientHeight * dpr);
  // Zoom is scaled by the same factor below, so only resolution changes.
  const resolution = ctx.resolutionScale;
  const backingScale = resolution * sliceBackingScale(fullW * resolution, fullH * resolution);
  const canvasW = Math.max(1, Math.round(fullW * backingScale));
  const canvasH = Math.max(1, Math.round(fullH * backingScale));

  const budgetExhausted = uploader.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, sliceZ);

  if (!shouldRender) return budgetExhausted;

  const { layerOrder, allSettings } = settings;
  const currentZoom = scene.zoom() * backingScale;
  const centerArr = scene.center();
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  for (const dsId of layerOrder) {
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
      // The member-pass budget applies per channel.
      const activeChannels = getActiveChannels(dsSettings);
      const channelBlend = dsSettings.channel_blend_mode as "alpha" | "additive" | "max" || "additive";

      for (const ch of activeChannels) {
        if (z >= dsShapeL[Axis.Z] || ch >= dsShapeL[Axis.C] || t >= dsShapeL[Axis.T]) continue;
        pushMemberLayers(layers, {
          members,
          indexByMember,
          channel: ch,
          blendMode: channelBlend,
          fullResWidth,
          fullResHeight,
          zoom: currentZoom,
        });
      }
    } else {
      if (z >= dsShapeL[Axis.Z] || c >= dsShapeL[Axis.C] || t >= dsShapeL[Axis.T]) continue;
      pushMemberLayers(layers, {
        members,
        indexByMember,
        channel: null,
        blendMode: dsSettings.blend_mode as "alpha" | "additive" | "max",
        fullResWidth,
        fullResHeight,
        zoom: currentZoom,
      });
    }
    // Placement fallback for label sources missing from the roster.
    let labelMemberPositions: Record<string, [number, number]> | undefined;
    if (ds.manifest.labels && ds.manifest.labels.length > 0) {
      try {
        labelMemberPositions = JSON.parse(scene.member_positions(dsId)) as Record<string, [number, number]>;
      } catch {
        labelMemberPositions = undefined;
      }
    }
    pushLabelLayers(layers, ds.manifest, members, dsSettings.label_settings, labelMemberPositions);
  }

  client.resize(canvasW, canvasH);
  client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH, planResult.epochs, dpr * backingScale);
  // The worker is FIFO, so every chunk posted above is written before this
  // render runs: `upload` closes here and `present` opens. Rows that opened
  // `present` at the previous frame are drawn by now and close here too.
  traceRecorder.noteFrameDispatched();

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
  minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  shouldRender: boolean = true,
): boolean {
  const { scene, canvas } = ctx;

  // The scene owns the selectors, as it does for the volume path, so this
  // reads them and never writes them back.
  const sliceZ = scene.z();
  const sliceT = scene.t();
  const sliceC = scene.c();
  const dpr = devicePixelRatio;
  const canvasW = Math.round(canvas.clientWidth * dpr);
  const canvasH = Math.round(canvas.clientHeight * dpr);
  scene.set_viewport(canvasW, canvasH, dpr);

  const orchResult = tickCoordinator.planAndFetch(ctx, minimapPendingFetch);
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

  const result = uploadAndRenderSlice(ctx, uploader, sliceZ, sliceT, sliceC, planResult, shouldRender);
  return result;
}

export function clearSliceForDataset(_state: SliceState, _dsId: string): void {}

export function clearSliceForMembers(_state: SliceState, _memberIds: string[]): void {}
