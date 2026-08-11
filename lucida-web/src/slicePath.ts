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
 * Device-pixel diagonal below which a member's layer is folded into its
 * dataset's aggregate pass instead of getting an individual render
 * pass. At overview zoom on a wide collection every member is far below
 * this, so the whole collection renders in one instanced pass; at
 * normal zoom members exceed it and keep per-member passes. A member
 * this small is at most a few pixels on screen, so the aggregate draw
 * is visually equivalent to the individual pass.
 */
export const MEMBER_AGGREGATE_MAX_DIAG_PX = 32;

/**
 * Hard cap on individual member passes per (dataset, channel). The size
 * threshold alone bounds passes roughly by screen area / threshold²;
 * this cap makes the bound explicit so per-frame pass count can never
 * track member count. When exceeded, the smallest members fold into the
 * aggregate pass (which draws the same content), largest stay individual.
 */
export const MAX_INDIVIDUAL_MEMBER_PASSES = 256;

/**
 * Backing-pixel cap for the slice render target (≈ a 4K backing). The
 * pass budget is the primary frame-cost bound; this is the bounded
 * fallback for very large backings (high-DPR fullscreen), where the
 * target is rendered at reduced resolution and upscaled by the browser
 * so a frame always presents. Planning keeps the full device-pixel
 * viewport (mirrors the volume path's renderScale split).
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

/** Inputs for {@link pushMemberLayers} — one (dataset, channel) emission. */
export interface MemberLayerInput {
  members: MemberRosterEntry[];
  /** memberId (or composite `id:chN` key) → entity descriptor index. */
  indexByMember: Map<string, number>;
  /** Channel for multi-channel composite keys; `null` in single-channel mode. */
  channel: number | null;
  blendMode: "alpha" | "additive" | "max";
  /** Fallback footprint for members without their own `dataW`/`dataH`. */
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
 * member-pass budget.
 *
 * Members whose on-screen diagonal is at least
 * {@link MEMBER_AGGREGATE_MAX_DIAG_PX} device pixels keep individual
 * layers, in roster order, with the standard per-member layer shape.
 * Smaller members — and, past {@link MAX_INDIVIDUAL_MEMBER_PASSES}, the
 * smallest of the rest — fold into ONE aggregate layer covering their
 * union extent, emitted beneath the individual layers. A lone tiny
 * member keeps its individual layer (aggregation only engages when it
 * reduces passes), so single-image datasets never batch at any zoom.
 */
export function pushMemberLayers(
  layers: SliceLayerParams[],
  input: MemberLayerInput,
): void {
  const {
    members, indexByMember, channel, blendMode,
    fullResWidth, fullResHeight, zoom,
  } = input;

  const candidates: MemberLayerCandidate[] = [];
  for (const m of members) {
    // Synthesized aggregate-footprint entries carry their own
    // dataW/dataH; normal tile entries use the dataset's image dims.
    const dataW = m.dataW ?? fullResWidth;
    const dataH = m.dataH ?? fullResHeight;
    // A zero/negative/non-finite extent covers no pixels and would
    // poison the aggregate's union-extent normalization (whose
    // degenerate-extent fallback dissolves the whole batch back into
    // unbounded per-member passes). Cull such members outright.
    if (!(dataW > 0) || !(dataH > 0)) continue;
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
    // Over budget even above the size threshold: keep the largest,
    // fold the rest into the aggregate. Individual emission order is
    // restored to roster order after the size cut.
    individual.sort((a, b) => b.diagPx - a.diagPx);
    batched = batched.concat(individual.slice(MAX_INDIVIDUAL_MEMBER_PASSES));
    individual = individual.slice(0, MAX_INDIVIDUAL_MEMBER_PASSES);
    individual.sort((a, b) => a.order - b.order);
  }
  if (batched.length === 1 && individual.length >= MAX_INDIVIDUAL_MEMBER_PASSES) {
    // Exactly one member over the cap: unfolding it (below) would emit
    // cap+1 individual passes. Fold the smallest individual with it
    // instead, so the cap holds exactly and the aggregate still reduces
    // passes (2 members → 1 pass).
    let smallest = 0;
    for (let i = 1; i < individual.length; i++) {
      if (individual[i].diagPx < individual[smallest].diagPx) smallest = i;
    }
    batched.push(individual.splice(smallest, 1)[0]);
  }
  if (batched.length < 2) {
    // Aggregation only engages when it reduces passes: a lone tiny member
    // stays an individual pass rather than a one-member aggregate.
    individual = individual.concat(batched);
    individual.sort((a, b) => a.order - b.order);
    batched = [];
  }
  // Quad order is the aggregate's internal draw (z) order. Restore
  // roster order regardless of how members got here — the cap-overflow
  // path above collects them in size order.
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
      // Emitted beneath the individual layers. Members that overlap
      // WITHIN the aggregate blend in quad (roster) order, matching the
      // per-member emission order; a batched member overlapping an
      // INDIVIDUAL member composites beneath it regardless of roster
      // position — the accepted residual of folding into one pass
      // (batched members are the smallest on screen).
      layers.push({
        datasetId: batched[0].memberKey,
        dataW: extW,
        dataH: extH,
        blendMode,
        offsetX: minX,
        offsetY: minY,
        // Informational for an aggregate layer — each quad carries its
        // own descriptor index in `quads`.
        entityIndex: batched[0].entityIndex,
        aggregate: {
          poolMemberId: batched[0].memberKey,
          count: batched.length,
          quads,
        },
      });
    } else {
      // Defensive only: zero-extent members are culled at candidate
      // collection, so a batch of positive-extent members always has a
      // positive union extent. Kept so a future regression degrades to
      // per-member emission rather than a division by zero.
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
    });
  }
}

/**
 * Append a categorical overlay layer for each of the dataset's VISIBLE labels,
 * composited over the intensity layers already pushed. The visible set + each
 * label's opacity come from `labelSettings` (the dataset's per-label display
 * state); with no settings every eligible label is shown at the default
 * opacity (see {@link resolveVisibleLabels}).
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
  const fullW = Math.round(canvas.clientWidth * dpr);
  const fullH = Math.round(canvas.clientHeight * dpr);
  // Bounded resolution fallback: render an oversized backing at reduced
  // resolution (browser upscales to the CSS size) so a frame always
  // presents. Zoom is scaled by the same factor below, keeping the
  // world field of view — and therefore the on-screen appearance —
  // unchanged apart from resolution.
  const backingScale = sliceBackingScale(fullW, fullH);
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
      // Multi-channel: one emission per channel with per-channel
      // composite keys; the member-pass budget applies per channel.
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
      // Single-channel
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
  }

  client.resize(canvasW, canvasH);
  client.sliceRenderMultiPass(layers, currentZoom, cx, cy, canvasW, canvasH, planResult.epochs);
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
