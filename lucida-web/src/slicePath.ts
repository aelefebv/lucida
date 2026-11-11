/** Slice render path: upload chunks + render multi-pass. */
import { planeAxes, tczyx, toPlaneFrame, type SlicePlane } from "./renderer/slicePlane.ts";
import { labelFootprint } from "./renderer/labelLayout.ts";
import { labelChunkAt, resolveVisibleLabels, type LabelViewSetting, type ResolvedLabel } from "./pipeline/planning/labelRequests.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import { placementInPlane, readPlacement, rectToScene, type Placement } from "./placement.ts";
import type { FrameScale, TickContext, TickView } from "./renderLoopTypes.ts";
import { compositeKey } from "./tickCommon.ts";
import { outsideCut, type ResolvedLayers } from "./resolvedLayers.ts";
import type { MemberRosterEntry, TickCoordinatorResult } from "./pipeline/tickCoordinator.ts";
import { datasetModeKey } from "./renderer/poolKeys.ts";
import { traceRecorder } from "./trace/recorder.ts";
import { comparisonClip } from "./comparison.ts";
import type { PixelRect } from "./renderer/layerBatches.ts";

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
  /** Per-channel member key (`id:chN`) → entity descriptor index. */
  indexByMember: Map<string, number>;
  channel: number;
  blendMode: "alpha" | "additive" | "max";
  /** Every member's footprint, in level-0 samples of its dataset's frame. */
  fullResWidth: number;
  fullResHeight: number;
  /** Where the dataset's frame sits in the scene frame the camera views. */
  placement: Placement;
  /** Device pixels per scene-frame unit at the render backing resolution. */
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
    fullResWidth, fullResHeight, placement, zoom,
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
    const memberKey = compositeKey(m.imageId, channel);
    const entityIndex = indexByMember.get(memberKey);
    if (entityIndex === undefined) continue;
    candidates.push({
      member: m,
      memberKey,
      entityIndex,
      dataW,
      dataH,
      diagPx: Math.hypot(dataW * placement.scale[0], dataH * placement.scale[1]) * zoom,
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
      // The quads are fractions of the extent, so placing it places them.
      const extent = rectToScene(placement, minX, minY, extW, extH);
      layers.push({
        datasetId: batched[0].memberKey,
        dataW: extent.w,
        dataH: extent.h,
        blendMode,
        offsetX: extent.x,
        offsetY: extent.y,
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
    const rect = rectToScene(placement, c.member.position[0], c.member.position[1], c.dataW, c.dataH);
    layers.push({
      datasetId: c.memberKey,
      dataW: rect.w,
      dataH: rect.h,
      blendMode,
      offsetX: rect.x,
      offsetY: rect.y,
      entityId: c.member.entityId,
      entityIndex: c.entityIndex,
      passGroup,
    });
  }
}

/** The plane of a label that slice mode draws at source `t` and `z`, as its fetch names it. */
function labelPlaneAt(
  resolved: ResolvedLabel,
  at: { t: number; z: number },
): { level: number; t: number; z: number; plane: number } {
  const chunk = labelChunkAt(resolved, at.t, at.z);
  return { level: chunk.level, t: chunk.t, z: chunk.z ?? 0, plane: chunk.plane ?? 0 };
}

/**
 * Append an overlay layer for each visible label, over the intensity layers.
 *
 * The drawn set must match what {@link computeLabelChunkRequests} fetches, so
 * both go through {@link resolveVisibleLabels}. Each overlay is sized to the
 * source image's full-resolution footprint, so a coarser label stays aligned
 * rather than shrinking, and placed as its dataset is. Labels never change the
 * camera or bounds.
 */
export function pushLabelLayers(
  layers: SliceLayerParams[],
  manifest: DatasetManifest,
  members: MemberRosterEntry[],
  placement: Placement,
  labelSettings?: LabelViewSetting[],
  memberPositions?: Record<string, [number, number]>,
  at?: { t: number; z: number },
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
    const rect = rectToScene(placement, position[0], position[1], dataW, dataH);
    layers.push({
      datasetId: label.image.image_id,
      dataW: rect.w,
      dataH: rect.h,
      blendMode: "alpha",
      offsetX: rect.x,
      offsetY: rect.y,
      entityId: source.owner,
      entityIndex: 0, // labels render via a transient descriptor, not the cold-state buffer
      isLabel: true,
      opacity,
      labelColors: label.colors,
      labelChunk: at ? labelPlaneAt(resolved, at) : undefined,
      labelSamples: [dataW, dataH],
    });
  }
}

/** Give the layers from `start` on the clip a comparison sets their dataset, if any. */
function clipSliceLayers(layers: SliceLayerParams[], start: number, clip: PixelRect | null): void {
  if (clip) for (let i = start; i < layers.length; i++) layers[i].clip = clip;
}

/**
 * `rect`, device pixels of the canvas, in pixels of a backing store
 * `scale` times the canvas. Each edge rounds on its own, as the canvas's
 * size does, so the whole canvas scales to the whole backing store.
 */
export function scaleRect(rect: PixelRect, scale: number): PixelRect {
  const left = Math.round(rect[0] * scale);
  const top = Math.round(rect[1] * scale);
  return [
    left,
    top,
    Math.max(1, Math.round((rect[0] + rect[2]) * scale) - left),
    Math.max(1, Math.round((rect[1] + rect[3]) * scale) - top),
  ];
}

/**
 * The canvas at a slice view's backing scale: the frame's resolution,
 * capped where a large canvas would hold more than a frame may.
 */
export function sliceFrameScale(ctx: TickContext): FrameScale {
  const dpr = devicePixelRatio;
  const fullW = Math.round(ctx.canvas.clientWidth * dpr);
  const fullH = Math.round(ctx.canvas.clientHeight * dpr);
  // Zoom is scaled by the same factor below, so only resolution changes.
  const resolution = ctx.resolutionScale;
  const scale = resolution * sliceBackingScale(fullW * resolution, fullH * resolution);
  return {
    canvasW: Math.max(1, Math.round(fullW * scale)),
    canvasH: Math.max(1, Math.round(fullH * scale)),
    scale,
  };
}

/** Build `view`'s layer params and render it in its rectangle of the canvas. */
export function renderSliceView(
  ctx: TickContext,
  planResult: TickCoordinatorResult,
  resolvedLayers: ResolvedLayers,
  view: TickView,
  frame: FrameScale,
): void {
  const { scene, client, datasets } = ctx;
  const { memberRosterByDatasetMode, settings, entityIndexByDatasetMode } = planResult;
  const { canvasW, canvasH, scale: backingScale } = frame;
  const rect = scaleRect(view.rect, backingScale);
  const [, , viewW, viewH] = rect;

  const plane = scene.slice_plane(view.id) as SlicePlane;
  const { layerOrder, allSettings } = settings;
  const currentZoom = scene.zoom(view.id) * backingScale;
  const centerArr = scene.center(view.id);
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  for (const dsId of layerOrder) {
    const ds = datasets.get(dsId);
    if (!ds) continue;
    const dsSettings = allSettings[dsId];
    const resolved = resolvedLayers.get(dsId);
    if (!dsSettings || !resolved || !resolved.visible) continue;
    // Nor is a layer the cut misses drawn, so the readout, which probes the
    // drawn frame, finds no value for it.
    if (outsideCut(resolved, plane)) continue;
    // A comparison shows a dataset on its side of the divider, or not at all
    // while a blink shows the other. Either way it stays planned and resident.
    const clip = comparisonClip(scene, view.id, dsId, viewW, viewH);
    if (clip === "hidden") continue;
    const firstLayer = layers.length;

    // Each image's extent across the screen and down it, in its dataset's
    // frame, and the frame's placement on those two axes of the scene frame.
    const dsShapeL = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    const [across, down, cut] = planeAxes(plane);
    const fullResWidth = dsShapeL[tczyx(across)];
    const fullResHeight = dsShapeL[tczyx(down)];

    // The members and descriptors of the dataset's slice pools.
    const roster = memberRosterByDatasetMode.get(datasetModeKey(dsId, "slice"))
      ?? [{ imageId: dsId, position: [0, 0] as [number, number] }];
    // A layout places images along X and Y; along Z every image starts at 0.
    const members = plane === "xy" ? roster : roster.map((m) => ({
      ...m,
      position: toPlaneFrame([m.position[0], m.position[1], 0], cut).slice(0, 2) as [number, number],
    }));
    const indexByMember = entityIndexByDatasetMode.get(datasetModeKey(dsId, "slice")) ?? new Map<string, number>();
    const placement = placementInPlane(readPlacement(scene, dsId), cut);

    // The member-pass budget applies per channel. A layer past the scene's t,
    // or a flat one under a Z cut, draws its clamped plane, which the plan
    // already asked for.
    for (const ch of resolved.channels) {
      pushMemberLayers(layers, {
        members,
        indexByMember,
        channel: ch.channel,
        blendMode: ch.blend_mode,
        fullResWidth,
        fullResHeight,
        placement,
        zoom: currentZoom,
      });
    }
    clipSliceLayers(layers, firstLayer, clip);
    // A label overlay is drawn on an XY cut only, and its planner fetches
    // nothing in a side view.
    if (plane !== "xy") continue;
    // Placement fallback for label sources missing from the roster.
    let labelMemberPositions: Record<string, [number, number]> | undefined;
    if (ds.manifest.labels && ds.manifest.labels.length > 0) {
      try {
        labelMemberPositions = JSON.parse(scene.member_positions(dsId)) as Record<string, [number, number]>;
      } catch {
        labelMemberPositions = undefined;
      }
    }
    const firstLabel = layers.length;
    pushLabelLayers(layers, ds.manifest, members, placement, dsSettings.label_settings, labelMemberPositions, {
      t: resolved.t,
      z: resolved.z_range.start,
    });
    clipSliceLayers(layers, firstLabel, clip);
  }

  const frameSeq = client.sliceRenderMultiPass(
    layers, currentZoom, cx, cy, canvasW, canvasH, planResult.epochs, view.id, rect, devicePixelRatio * backingScale,
  );
  // The worker is FIFO, so every chunk posted above is written before this
  // render runs: `upload` closes here and `present` opens. Rows that opened
  // `present` at the previous frame are drawn by now and close here too.
  traceRecorder.noteFrameDispatched(frameSeq);
}

export function clearSliceForDataset(_state: SliceState, _dsId: string): void {}

export function clearSliceForMembers(_state: SliceState, _memberIds: string[]): void {}
