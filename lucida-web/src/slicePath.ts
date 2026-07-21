/** Slice render path: upload chunks + render multi-pass. */
import { Axis } from "./axes.ts";
import { labelFootprint } from "./renderer/labelLayout.ts";
import { resolveVisibleLabels } from "./pipeline/planning/labelRequests.ts";
import type { LabelSettings } from "./labelSettings.ts";
import type { SliceAggregateParams, SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import { MAIN_VIEW_UPLOAD_BUDGET_BYTES } from "./pipeline/upload/constants.ts";
import { getActiveChannels, compositeKey } from "./tickCommon.ts";
import type { SceneSettings } from "./tickCommon.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import type { TickCoordinator, MemberRosterEntry, MinimapChunkCoord } from "./pipeline/tickCoordinator.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import { debugStats } from "./debug/debugStats.ts";
import {
  createMemberPlacementAccessor,
  type MemberPlacementAccessor,
} from "./memberPlacement.ts";

interface AggregateEmissionCache {
  /**
   * Geometry is valid for exactly one roster + descriptor-index identity.
   * Weak keys let superseded planner snapshots reclaim their potentially
   * large quad buffers without an explicit sweep.
   */
  byRoster: WeakMap<
    MemberRosterEntry[],
    WeakMap<Map<string, number>, Map<string, {
      basisKey: string;
      /** Maximal zoom band whose aggregate/individual partition is stable. */
      zoomBand: readonly [minInclusive: number, maxExclusive: number];
      layers: SliceLayerParams[];
    }>>
  >;
  namespace: number;
  nextId: number;
  revision: number;
}

let nextAggregateCacheNamespace = 1;

export interface SliceState {
  aggregateEmissionCache: AggregateEmissionCache;
}

export function createSliceState(): SliceState {
  return {
    aggregateEmissionCache: {
      byRoster: new WeakMap(),
      namespace: nextAggregateCacheNamespace++,
      nextId: 1,
      revision: 0,
    },
  };
}

/**
 * CSS-pixel diagonal below which a member's layer is folded into its
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
 * so a frame always presents. Planning keeps the logical CSS-pixel viewport;
 * DPR and this cap are applied only at the renderer boundary.
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
  /** Logical CSS pixels per voxel (the persisted/shared 2D camera zoom). */
  zoom: number;
  /**
   * Optional render-loop cache. Production supplies this; focused pure unit
   * tests may omit it. Roster + descriptor-map identity carry residency and
   * active-set changes, while `epochKey` carries placement/settings changes.
   */
  cache?: {
    state: SliceState;
    datasetId: string;
    epochKey: string;
  };
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
 * {@link MEMBER_AGGREGATE_MAX_DIAG_PX} CSS pixels keep individual
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

  let cachedLayers: SliceLayerParams[] | undefined;
  let cacheBucket: Map<string, {
    basisKey: string;
    zoomBand: readonly [minInclusive: number, maxExclusive: number];
    layers: SliceLayerParams[];
  }> | undefined;
  let cacheSlot = "";
  let basisKey = "";
  if (input.cache) {
    const cache = input.cache.state.aggregateEmissionCache;
    let byIndex = cache.byRoster.get(members);
    if (!byIndex) {
      byIndex = new WeakMap();
      cache.byRoster.set(members, byIndex);
    }
    cacheBucket = byIndex.get(indexByMember);
    if (!cacheBucket) {
      cacheBucket = new Map();
      byIndex.set(indexByMember, cacheBucket);
    }
    cacheSlot = `${input.cache.datasetId}|${channel ?? "single"}`;
    basisKey = [
      cache.revision,
      input.cache.epochKey,
      channel ?? "single",
      blendMode,
      fullResWidth,
      fullResHeight,
    ].join("|");
    const cached = cacheBucket.get(cacheSlot);
    if (
      cached?.basisKey === basisKey &&
      zoom >= cached.zoomBand[0] &&
      zoom < cached.zoomBand[1]
    ) {
      cachedLayers = cached.layers;
    }
  }
  if (cachedLayers) {
    layers.push(...cachedLayers);
    return;
  }

  const emissionStart = layers.length;

  const candidates: MemberLayerCandidate[] = [];
  let zoomBandMin = 0;
  let zoomBandMax = Infinity;
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
    const diagonalVoxels = Math.hypot(dataW, dataH);
    const diagPx = diagonalVoxels * zoom;
    const thresholdZoom = MEMBER_AGGREGATE_MAX_DIAG_PX / diagonalVoxels;
    // Aggregation membership changes only when a member crosses this exact
    // threshold. Cache the whole stable zoom interval, not the current zoom,
    // so a continuous gesture reuses O(N) geometry between real crossings.
    if (diagPx >= MEMBER_AGGREGATE_MAX_DIAG_PX) {
      zoomBandMin = Math.max(zoomBandMin, thresholdZoom);
    } else {
      zoomBandMax = Math.min(zoomBandMax, thresholdZoom);
    }
    candidates.push({
      member: m,
      memberKey,
      entityIndex,
      dataW,
      dataH,
      diagPx,
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
      const aggregate: SliceAggregateParams = input.cache
        ? {
            poolMemberId: batched[0].memberKey,
            count: batched.length,
            quads,
            cacheKey:
              `slice-aggregate-${input.cache.state.aggregateEmissionCache.namespace}-` +
              `${input.cache.state.aggregateEmissionCache.nextId++}`,
            cacheOwnerKey:
              `${input.cache.datasetId}|${channel === null ? "single" : `ch${channel}`}`,
            ownerDatasetId: input.cache.datasetId,
          }
        : {
            poolMemberId: batched[0].memberKey,
            count: batched.length,
            quads,
          };
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
        aggregate,
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

  if (cacheBucket) {
    // One entry per dataset/channel slot. A continuous zoom gesture replaces
    // the prior geometry instead of retaining one wide buffer per zoom value.
    cacheBucket.set(cacheSlot, {
      basisKey,
      zoomBand: [zoomBandMin, zoomBandMax],
      layers: layers.slice(emissionStart),
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
  placement: MemberPlacementAccessor,
  labelSettings?: LabelSettings[],
): void {
  for (const resolved of resolveVisibleLabels(manifest, labelSettings)) {
    const { label, source, opacity } = resolved;
    const sourceLevel0 = source.multiscale.levels[0];
    const labelLevel0 = label.image.multiscale.levels[0];
    const { dataW, dataH } = labelFootprint(sourceLevel0, labelLevel0);
    // Tiles can be offset within a collection/layout; place the overlay at the
    // source member's position so it lands on the image it annotates. The
    // source tile can be absent from the active-set roster when it is off-view,
    // so fall back to the scene's authoritative per-member layout
    // position (keyed by the source ENTITY id, the same space as the roster's
    // positions). Falling back to the origin instead would stack every
    // off-roster label on the first group (the bug this repairs).
    const position = placement.position2d(label.source_image_id, source.owner);
    layers.push({
      datasetId: label.image.image_id,
      ownerDatasetId: manifest.dataset_id,
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
  memberPositionsByDataset: Map<string, Record<string, [number, number]>>;
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
  sliceState?: SliceState,
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
  // The render loop may apply a stricter presentation bootstrap until the
  // worker confirms that content reached the screen. Compose it with the
  // steady-state oversized-backing cap so cold DPR2 surfaces cannot bypass
  // the same bounded-first-frame contract used by volume rendering.
  const backingScale = Math.min(ctx.renderScale, sliceBackingScale(fullW, fullH));
  const canvasW = Math.max(1, Math.round(fullW * backingScale));
  const canvasH = Math.max(1, Math.round(fullH * backingScale));

  const budgetExhausted = uploader.deliverToWorker(ctx, MAIN_VIEW_UPLOAD_BUDGET_BYTES, sliceZ);

  if (!shouldRender) return budgetExhausted;

  const { layerOrder, allSettings } = settings;
  // Shared camera zoom is CSS px/world-unit. Convert it to backing pixels only
  // at the renderer seam. Pass partitioning stays logical so DPR cannot alter
  // which collection members are batched and therefore cannot alter content.
  const logicalZoom = scene.zoom();
  const renderZoom = logicalZoom * dpr * backingScale;
  const centerArr = scene.center();
  const cx = centerArr[0];
  const cy = centerArr[1];

  const layers: SliceLayerParams[] = [];
  const passesByDataset: Record<string, number> = {};
  // View is intentionally excluded: panning changes the camera but not the
  // roster geometry. A new roster/index object still invalidates via the weak
  // identity keys when planning changes which members are renderable.
  const aggregateEpochKey = [
    planResult.epochs.content,
    planResult.epochs.layout,
    planResult.epochs.selection,
  ].join("|");
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
          zoom: logicalZoom,
          cache: sliceState ? {
            state: sliceState,
            datasetId: dsId,
            epochKey: aggregateEpochKey,
          } : undefined,
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
        zoom: logicalZoom,
        cache: sliceState ? {
          state: sliceState,
          datasetId: dsId,
          epochKey: aggregateEpochKey,
        } : undefined,
      });
    }
    // Categorical label overlays, composited on top of this dataset's
    // intensity layers. Honors the per-label visible set + opacity; never
    // affects camera/bounds. A label's source tile is often not in the active
    // roster (for example, off-view tiles), so use the same placement policy
    // as the volume path with the coordinator's already-parsed layout map.
    const labelPlacement = createMemberPlacementAccessor({
      members,
      positions: planResult.memberPositionsByDataset.get(dsId),
    });
    pushLabelLayers(
      layers,
      ds.manifest,
      labelPlacement,
      dsSettings.label_settings,
    );

    const added = layers.length - layersBefore;
    if (added > 0) passesByDataset[dsId] = added;
  }

  if (debugStats.enabled) {
    debugStats.renderPasses = { total: layers.length, byDataset: passesByDataset };
  }

  client.resize(canvasW, canvasH, "slice");
  client.sliceRenderMultiPass(layers, renderZoom, cx, cy, canvasW, canvasH, planResult.epochs);

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
  sliceState?: SliceState,
): boolean {
  const { scene, canvas } = ctx;

  // Set scene params before tickCoordinator queries WASM state
  scene.set_z(sliceZ);
  scene.set_t(sliceT);
  scene.set_c(sliceC);
  const canvasW = Math.round(canvas.clientWidth);
  const canvasH = Math.round(canvas.clientHeight);
  scene.set_viewport(canvasW, canvasH);

  const t0 = debugStats.enabled ? performance.now() : 0;
  const orchResult = tickCoordinator.planAndFetch(ctx, minimapPendingFetch);
  if (debugStats.enabled) debugStats.planTimeMs = performance.now() - t0;
  if (!orchResult) return false;

  const vpCenter = scene.center();
  const planResult: SlicePlanResult = {
    memberRoster: orchResult.memberRoster,
    memberPositionsByDataset: orchResult.memberPositionsByDataset,
    settings: orchResult.settings,
    vpCx: vpCenter[0],
    vpCy: vpCenter[1],
    multiChannel: orchResult.multiChannel,
    epochs: orchResult.epochs,
    entityIndexByDataset: orchResult.entityIndexByDataset,
  };

  const t1 = debugStats.enabled ? performance.now() : 0;
  const result = uploadAndRenderSlice(
    ctx,
    uploader,
    sliceZ,
    sliceT,
    sliceC,
    planResult,
    shouldRender,
    sliceState,
  );
  if (debugStats.enabled) debugStats.uploadTimeMs = performance.now() - t1;
  return result;
}

export function clearSliceForDataset(state: SliceState, _dsId: string): void {
  // Existing weak entries become unreachable from new cache keys immediately;
  // their roster snapshots reclaim the backing buffers once superseded.
  state.aggregateEmissionCache.revision++;
}

export function clearSliceForMembers(state: SliceState, _memberIds: string[]): void {
  state.aggregateEmissionCache.revision++;
}
