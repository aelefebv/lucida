/**
 * Orchestrator — assembles PlanningSnapshot from live WASM scene state,
 * invokes plan(), and routes the output to CpuCache for fetching and
 * delivery to the GPU worker.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { SceneSettings } from "../tickCommon.ts";
import type { ImageSpec, ContentGraph, LevelGeometry } from "../contentTypes.ts";
import type {
  ColdStateActiveEntry,
  ColdStateMessage,
  MissingChunk as MissingChunkLite,
  MissingProxy as MissingProxyLite,
} from "../renderer/workerProtocol.ts";
// Note: atlas config messages eliminated — worker manages atlases from cold state
import {
  getSceneSettings,
  getActiveChannels,
  compositeKey,
} from "../tickCommon.ts";
import { plan } from "./planning.ts";
import type {
  PlanningSnapshot,
  ActiveSetEntry,
  PlanningEpochs,
  EntitySnapshot,
  VisibleRegion,
  SelectionState,
  ChunkRequest,
} from "./planning.ts";
import type {
  CpuCache,
  ReadyChunkDelivery,
  ReadyProxyDelivery,
} from "./cpuCache.ts";
import type { ProxyRequest } from "./planning.ts";
import { debugStats, type OrchDebug, type OrchMemberDebug } from "../debug/debugStats.ts";

/** A visible member for render layer construction. */
export interface MemberRosterEntry {
  imageId: string;
  position: [number, number];
  /**
   * S8: entity id from the planning active set entry that produced this
   * roster member. Forwarded to the GPU worker per-layer so it can look
   * up the proxy descriptor for shader binding.
   */
  entityId?: string;
  /**
   * S8: promotion mode from the planning active set entry. Drives the
   * shader's `renderMode` branch (well-as-proxy direct sample vs
   * detail+proxy fallback). Optional for backward compat.
   */
  mode?: "well-as-proxy" | "fields-with-proxy-fallback" | "fields-with-detail";
  /**
   * S8: optional precomputed world-space model matrix for the
   * `[0,1]^3` unit cube that bounds this member. When present, the
   * render path uses it instead of querying `scene.member_model_matrix`.
   * Used by `well-as-proxy` entries because wells aren't in
   * `derived.members` and therefore have no native model matrix.
   * Column-major 4×4. `invModelMatrix` is the matching inverse.
   */
  modelMatrix?: Float32Array;
  invModelMatrix?: Float32Array;
  /**
   * S8 fix: optional 2D world-space footprint of the member (in voxel
   * units, the same coordinate frame as `position`). When present, the
   * slice path uses these instead of the dataset's per-image dataW/dataH
   * for layer sizing — necessary for synthesized `well-as-proxy`
   * entries whose footprint spans multiple field images.
   */
  dataW?: number;
  dataH?: number;
}

export interface OrchestratorResult {
  /** Per-dataset roster of members that need render layers, keyed by dsId. */
  memberRoster: Map<string, MemberRosterEntry[]>;
  settings: SceneSettings;
  multiChannel: boolean;
  epochs: PlanningEpochs;
}

/** Lightweight chunk coordinate for minimap pending fetches. */
export interface MinimapChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  key: string;
}

/**
 * S8: build a synthetic roster entry for a `well-as-proxy` entry.
 *
 * Wells aren't in `derived.members` so `scene.member_model_matrix` would
 * return identity for them; instead we compute the well's world-space
 * AABB by unioning each visible field's `[0,1]^3` cube transformed by
 * its own model matrix, then build a translate+scale matrix that maps
 * `[0,1]^3` onto that AABB. The shader marches a ray through this
 * synthetic cube and samples the well's proxy texture once per fragment.
 *
 * Returns `null` if no field model matrices were available (defensive;
 * caller already filters out wells with zero visible fields).
 */
function synthesizeWellRosterEntry(
  ctx: TickContext,
  dsId: string,
  wellEntityId: string,
  childFields: EntitySnapshot[],
): MemberRosterEntry | null {
  // 3D AABB (in 3D world-space, post Y-flip + global correction). Drives
  // the volume path's `modelMatrix` for ray-marching the well as one
  // synthetic cube.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let validCornerCount = 0;
  // 2D AABB (in voxel space). Drives the slice path's `position` and
  // `dataW/dataH` for rendering the well as a flat quad. Voxel-space is
  // a different frame from the 3D model matrix output (no Y-flip, no
  // global scaling), so we must compute it independently.
  let min2DX = Infinity, min2DY = Infinity;
  let max2DX = -Infinity, max2DY = -Infinity;
  let valid2DCount = 0;
  for (const field of childFields) {
    // 2D voxel-space AABB from the field's own position + level0 shape.
    // EntitySnapshot.position is already in voxel coords (from
    // `scene.member_positions`).
    const fx = field.position[0];
    const fy = field.position[1];
    const lvl0 = field.levels[0];
    if (lvl0) {
      const fw = lvl0.shape[4]; // X
      const fh = lvl0.shape[3]; // Y
      min2DX = Math.min(min2DX, fx);
      min2DY = Math.min(min2DY, fy);
      max2DX = Math.max(max2DX, fx + fw);
      max2DY = Math.max(max2DY, fy + fh);
      valid2DCount++;
    }

    // 3D world AABB via the field's model matrix.
    const model = ctx.scene.member_model_matrix(dsId, field.imageId);
    if (model.length !== 16) continue;
    for (let i = 0; i < 8; i++) {
      const cx = i & 1;
      const cy = (i >> 1) & 1;
      const cz = (i >> 2) & 1;
      const wx = model[0] * cx + model[4] * cy + model[8] * cz + model[12];
      const wy = model[1] * cx + model[5] * cy + model[9] * cz + model[13];
      const wz = model[2] * cx + model[6] * cy + model[10] * cz + model[14];
      const ww = model[3] * cx + model[7] * cy + model[11] * cz + model[15];
      if (ww === 0) continue;
      const x = wx / ww;
      const y = wy / ww;
      const z = wz / ww;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      validCornerCount++;
    }
  }
  if (validCornerCount === 0 || valid2DCount === 0) return null;
  const sx = maxX - minX;
  const sy = maxY - minY;
  const sz = maxZ - minZ;
  if (sx === 0 || sy === 0 || sz === 0) return null;
  const sx2D = max2DX - min2DX;
  const sy2D = max2DY - min2DY;
  if (sx2D === 0 || sy2D === 0) return null;
  // Column-major 3D model matrix: scale + translate so [0,1]^3 → world AABB.
  const model = new Float32Array([
    sx,   0,    0,    0,
    0,    sy,   0,    0,
    0,    0,    sz,   0,
    minX, minY, minZ, 1,
  ]);
  const inv = new Float32Array([
    1 / sx,         0,              0,              0,
    0,              1 / sy,         0,              0,
    0,              0,              1 / sz,         0,
    -minX / sx,     -minY / sy,     -minZ / sz,     1,
  ]);
  return {
    // imageId stays empty per planning's `well-as-proxy` convention; the
    // worker uses entityId for descriptor lookup, not imageId.
    imageId: wellEntityId,
    // 2D voxel-space position + size for the slice path. Independent of
    // the 3D model matrix above (different coordinate frame).
    position: [min2DX, min2DY],
    entityId: wellEntityId,
    mode: "well-as-proxy",
    modelMatrix: model,
    invModelMatrix: inv,
    dataW: sx2D,
    dataH: sy2D,
  };
}

export class Orchestrator {
  private previousActiveSet = new Map<string, ActiveSetEntry[]>();
  private lastEpochs: PlanningEpochs | null = null;
  private cachedResult: OrchestratorResult | null = null;
  private requestEpoch = 0;
  private _lastRequests: ChunkRequest[] = [];
  private _lastVisibleRegion: VisibleRegion | null = null;
  private _lastEntities: EntitySnapshot[] = [];
  private _lastCachedKeyCounts = new Map<string, number>();
  /** Last filtered requests, re-submitted on epoch HIT to CpuCache. */
  private _lastFilteredRequests: ChunkRequest[] = [];
  /**
   * Last proxy requests produced by `plan()`, re-submitted on epoch HIT
   * to CpuCache. S5 only cached chunk requests, which dropped any
   * proxies whenever the orchestrator took the cache-hit short-circuit;
   * S6 closes that gap so proxies stay live across cached planning ticks.
   */
  private _lastProxyRequests: ProxyRequest[] = [];

  // Delivery state — tracks what's been sent to the GPU worker
  private deliverySentToWorker = new Map<string, Set<string>>();

  /** Wanted-set from the GPU worker — entityId → Set<chunkKey> of missing chunks. */
  private workerWantedSet = new Map<string, Set<string>>();

  planAndFetch(
    ctx: TickContext,
    minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  ): OrchestratorResult | null {
    // Step 1 — Epoch check
    const rawEpochs = JSON.parse(ctx.scene.epochs());
    const currentEpochs: PlanningEpochs = {
      content: rawEpochs.content,
      layout: rawEpochs.layout,
      view: rawEpochs.view,
      selection: rawEpochs.selection,
      // `asset_epoch()` is the authoritative source. Older WASM builds
      // without the binding fall back to 0 (functional no-op for S3).
      asset:
        typeof ctx.scene.asset_epoch === "function"
          ? ctx.scene.asset_epoch()
          : (rawEpochs.asset ?? 0),
      request: this.requestEpoch,
    };

    if (
      this.lastEpochs &&
      this.cachedResult &&
      currentEpochs.content === this.lastEpochs.content &&
      currentEpochs.layout === this.lastEpochs.layout &&
      currentEpochs.view === this.lastEpochs.view &&
      currentEpochs.selection === this.lastEpochs.selection &&
      currentEpochs.asset === this.lastEpochs.asset
    ) {
      // Re-submit detail + minimap (and any cached proxies) in one call
      // so they don't cancel each other. Forwarding `_lastProxyRequests`
      // here closes the S5 gap where proxies vanished on epoch HIT.
      const minimapReqs = this.collectMinimapRequests(ctx, minimapPendingFetch);
      const allRequests = [...this._lastFilteredRequests, ...minimapReqs];
      if (allRequests.length > 0 || this._lastProxyRequests.length > 0) {
        ctx.cpuCache.submit({
          requests: allRequests,
          activeSet: [...(this.previousActiveSet.values())].flat(),
          proxyRequests: this._lastProxyRequests,
          epochs: this.lastEpochs!,
        });
      }
      if (debugStats.enabled && debugStats.orch) {
        debugStats.orch.epochCacheHit = true;
      }
      return this.cachedResult;
    }

    // Step 2 — Settings
    const settings = getSceneSettings(ctx.scene);
    const multiChannel = ctx.scene.multi_channel();

    // Step 3 — Per-dataset loop
    const memberRoster = new Map<string, MemberRosterEntry[]>();

    for (const [dsId, ds] of ctx.datasets) {
      // 3a. Skip invisible datasets
      const dsSettings = settings.allSettings[dsId];
      if (dsSettings && !dsSettings.visible) continue;

      // 3b. View query — may return null if dataset not yet registered in scene
      const vqJson = ctx.scene.view_query(dsId);
      const vq = JSON.parse(vqJson);
      if (!vq || !vq.visible_entities) continue;

      // 3c. Member positions
      const posJson = ctx.scene.member_positions(dsId);
      const positions: Record<string, [number, number]> = JSON.parse(posJson);

      // 3d. Build EntitySnapshot[]
      const imageSpecById = new Map<string, ImageSpec>();
      for (const img of ds.content.images) {
        imageSpecById.set(img.image_id, img);
      }
      // Parent lookup from the dataset's content graph. S6 promotion
      // groups visible fields by `parentId` (the well id) so all fields
      // of a well agree on a single WellMode.
      const parentByEntityId = new Map<string, string | null>();
      for (const ent of ds.content.entities) {
        parentByEntityId.set(ent.id, ent.parent ?? null);
      }

      const entities: EntitySnapshot[] = vq.visible_entities.map((e: any) => {
        const imgSpec = imageSpecById.get(e.image_id);
        const numLevels = imgSpec ? imgSpec.multiscale.levels.length : 1;
        const levels = imgSpec ? imgSpec.multiscale.levels : [];
        const position = positions[e.entity_id] ?? ([0, 0] as [number, number]);
        return {
          entityId: e.entity_id,
          imageId: e.image_id,
          kind: e.kind as "Image" | "Well" | "Field",
          visible: e.visible,
          projectedDiagonalPx: e.projected_diagonal_px,
          projectedAreaPx2: e.projected_area_px2,
          centroidWorld: e.centroid_world,
          idealTargetLod: e.ideal_target_lod,
          importance: e.importance,
          numLevels,
          levels,
          position,
          parentId: parentByEntityId.get(e.entity_id) ?? null,
        } satisfies EntitySnapshot;
      });

      // 3e. Visible region
      const vrJson = ctx.scene.visible_region(dsId);
      const vr = vrJson && vrJson !== "null" ? JSON.parse(vrJson) : null;
      const visibleRegion: VisibleRegion = vr
        ? {
            xyBounds: vr.xy_bounds,
            zRange: vr.z_range,
            effectiveZoom: vr.effective_zoom,
            sortCenter: vr.sort_center,
            frustumPlanes: vr.frustum_planes,
          }
        : {
            xyBounds: [0, 0, 1024, 1024],
            zRange: [0, 1],
            effectiveZoom: 1,
            sortCenter: null,
            frustumPlanes: null,
          };

      // 3f. Selection state
      // In single-channel mode, plan only for the current C — the upload path
      // sends one atlas config with one channel, so other channels' data would
      // contaminate the atlas. Multi-channel mode uses composite keys per channel.
      let visibleChannels: number[];
      if (multiChannel && dsSettings?.channel_settings?.length > 0) {
        visibleChannels = getActiveChannels(dsSettings);
      } else {
        visibleChannels = [ctx.scene.c()];
      }

      const selection: SelectionState = {
        t: ctx.scene.t(),
        c: ctx.scene.c(),
        z: ctx.scene.z(),
        visibleChannels,
        renderMode: ctx.mode as "slice" | "volume",
        interactionState: "idle",
      };

      // 3g. Cache state — pass empty maps so Planning emits ALL needed chunks.
      // The re-send loop (deliverToWorker) iterates _lastFilteredRequests to
      // re-send worker-evicted chunks from CpuCache. If Planning filtered cached
      // chunks, _lastFilteredRequests would miss them and re-send would break.
      // CpuCache.submit() deduplicates internally, so no double-fetching occurs.
      for (const entity of entities) {
        const cachedKeys = ctx.cpuCache.snapshot().cached.get(entity.entityId);
        this._lastCachedKeyCounts.set(entity.entityId, cachedKeys?.size ?? 0);
      }

      // 3h. Plan
      const snapshot: PlanningSnapshot = {
        epochs: currentEpochs,
        entities,
        visibleRegion,
        selection,
        cacheState: { cached: new Map(), inFlight: new Map() },
        workerWantedSet: { missing: new Map() },
        previousActiveSet: this.previousActiveSet.get(dsId) ?? [],
        // S3: real (but empty) snapshot. Planning falls through to
        // existing two-tier promote() since `byEntity.size === 0`.
        // S6 will start consuming this for proxy promotion.
        assetCatalog: ctx.assetCatalog.snapshot(),
      };

      const result = plan(snapshot);
      this.previousActiveSet.set(dsId, result.activeSet);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion = visibleRegion;
      this._lastEntities = entities;

      // Annotate proxy requests with the real dataset id (Planning emits
      // an empty default since it has no per-dataset context).
      for (const pr of result.proxyRequests) {
        pr.datasetId = dsId;
      }
      this._lastProxyRequests = result.proxyRequests;

      // 3i. Filter to single level per entity for atlas config (M4 adds multi-level).
      // Skip `well-as-proxy` entries — they don't contribute chunks.
      const targetLevelByEntity = new Map<string, number>();
      for (const entry of result.activeSet) {
        if (entry.mode === "well-as-proxy") continue;
        targetLevelByEntity.set(entry.entityId, entry.targetLod);
      }
      const filteredRequests = result.requests.filter(r => {
        const target = targetLevelByEntity.get(r.entityId);
        return target !== undefined && r.level === target;
      });

      this._lastFilteredRequests = filteredRequests;

      // Send cold state to the worker — drives atlas creation/remap + wanted-set
      this.sendColdState(dsId, result.activeSet, entities, selection, visibleRegion, currentEpochs, ctx);
      // Clear delivery tracking so chunks are re-sent for the new state
      this.deliverySentToWorker.clear();

      // Annotate requests with the real dataset ID (entityId may differ for plates)
      for (const req of filteredRequests) {
        req.datasetId = dsId;
      }

      // 3j. Build member roster from active set for render layer construction.
      // S8: forward the planning entry's entityId + mode so the render
      // path can dispatch per-mode (well-as-proxy emits one layer per
      // well; field modes iterate fields).
      //
      // For `well-as-proxy` entries the well typically isn't in the
      // visible_entities query result (which iterates `derived.members`
      // — image-level members only). We synthesize a roster entry by
      // computing the well's world-space AABB from its visible fields,
      // building a precomputed model matrix that maps the unit cube
      // [0,1]^3 onto that AABB, and stashing the well's entityId for
      // proxy descriptor lookup in the worker.
      const entityById = new Map(entities.map(e => [e.entityId, e]));
      const fieldsByWell = new Map<string, EntitySnapshot[]>();
      for (const entity of entities) {
        if (entity.kind === "Field" && entity.parentId) {
          let arr = fieldsByWell.get(entity.parentId);
          if (!arr) {
            arr = [];
            fieldsByWell.set(entity.parentId, arr);
          }
          arr.push(entity);
        }
      }
      const rosterEntries: MemberRosterEntry[] = [];
      for (const entry of result.activeSet) {
        if (entry.mode === "well-as-proxy") {
          // Synthetic well member. Compute AABB from constituent fields.
          const childFields = fieldsByWell.get(entry.entityId) ?? [];
          if (childFields.length === 0) continue; // no geometry to render
          const synth = synthesizeWellRosterEntry(ctx, dsId, entry.entityId, childFields);
          if (synth) rosterEntries.push(synth);
          continue;
        }
        const entity = entityById.get(entry.entityId);
        if (entity) {
          rosterEntries.push({
            imageId: entity.imageId,
            position: entity.position,
            entityId: entry.entityId,
            mode: entry.mode,
          });
        }
      }
      memberRoster.set(dsId, rosterEntries);

      // 3k. Collect minimap pending fetches as overview-lane requests
      const minimapRequests: ChunkRequest[] = [];
      for (const entity of entities) {
        const pending = minimapPendingFetch.get(entity.imageId);
        if (pending) {
          for (const coord of pending) {
            minimapRequests.push({
              entityId: entity.entityId,
              imageId: entity.imageId,
              level: coord.level,
              t: coord.t,
              c: coord.c,
              z: coord.z,
              y: coord.y,
              x: coord.x,
              lane: "overview",
              priority: 2000,
              chunkKey: coord.key,
              datasetId: dsId,
            });
          }
        }
      }

      // Submit detail + minimap (chunks) and proxy requests in a single
      // call so they don't cancel each other. Proxies sit in their own
      // queue inside CpuCache but share the cancellation contract: if
      // the next plan omits a request, its in-flight fetch is aborted.
      ctx.cpuCache.submit({
        requests: [...filteredRequests, ...minimapRequests],
        activeSet: result.activeSet,
        proxyRequests: result.proxyRequests,
        epochs: currentEpochs,
      });

      // Debug stats
      if (debugStats.enabled) {
        for (const entity of entities) {
          debugStats.totalMembers++;
          debugStats.visibleMembers++;
          const activeEntry = result.activeSet.find(
            (a) => a.entityId === entity.entityId,
          );
          const tl = activeEntry?.targetLod ?? -1;
          const memberKey = multiChannel
            ? compositeKey(entity.imageId, selection.c)
            : entity.imageId;
          debugStats.memberStats.push({
            id: memberKey,
            level: tl,
            numLevels: entity.numLevels,
            chunksNeeded: result.requests.filter(
              (r) => r.entityId === entity.entityId && r.lane !== "runway",
            ).length,
            chunksSent: 0,
          });
          if (tl >= 0) {
            debugStats.selectedLevel = tl;
            debugStats.numLevels = entity.numLevels;
          }
        }
      }
    }

    // Step 4 — Orchestrator debug snapshot
    if (debugStats.enabled) {
      // Collect from all datasets' plans (last dataset wins for activeSet — fine for single-dataset debug)
      const orchDebug: OrchDebug = {
        activeSet: [],
        laneCount: { detail: 0, runway: 0, overview: 0 },
        levelCount: {},
        topRequests: [],
        members: [],
        hasMixedLevels: false,
        epochCacheHit: false,
      };

      // Aggregate from member roster
      for (const [_key, entries] of memberRoster) {
        for (const m of entries) {
          orchDebug.members.push({
            imageId: m.imageId,
            position: m.position,
            neededCount: 0,
            prefetchCount: 0,
            uploadLevel: undefined,
            levelCounts: {},
            mixedLevels: false,
          });
        }
      }

      // Aggregate from all per-dataset plan results
      // Re-run is wasteful, so store last result. For now just use previousActiveSet.
      for (const [, activeSet] of this.previousActiveSet) {
        for (const entry of activeSet) {
          orchDebug.activeSet.push({
            entityId: entry.entityId,
            mode: entry.mode,
            targetLod: entry.targetLod,
            seedDetailLod: entry.seedDetailLod,
            detailOwnedLodRange: entry.detailOwnedLodRange,
          });
        }
      }

      // Store last plan's request stats (use the last dataset's plan for simplicity)
      if (this._lastRequests) {
        for (const r of this._lastRequests) {
          if (r.lane === "detail") orchDebug.laneCount.detail++;
          else if (r.lane === "runway") orchDebug.laneCount.runway++;
          else orchDebug.laneCount.overview++;
          orchDebug.levelCount[r.level] = (orchDebug.levelCount[r.level] ?? 0) + 1;
        }
        orchDebug.topRequests = this._lastRequests.slice(0, 20).map(r => ({
          entityId: r.entityId,
          level: r.level,
          t: r.t, c: r.c, z: r.z, y: r.y, x: r.x,
          lane: r.lane,
          priority: r.priority,
          chunkKey: r.chunkKey,
        }));
      }

      // Coordinate diagnostic
      orchDebug.visibleRegion = this._lastVisibleRegion
        ? {
            xyBounds: this._lastVisibleRegion.xyBounds,
            zRange: this._lastVisibleRegion.zRange,
            effectiveZoom: this._lastVisibleRegion.effectiveZoom,
          }
        : null;
      orchDebug.entityDiag = this._lastEntities.slice(0, 5).map(e => ({
        entityId: e.entityId,
        position: e.position,
        fullShape: e.levels.length > 0
          ? [e.levels[0].shape[4], e.levels[0].shape[3]] as [number, number]
          : null,
        cachedKeys: this._lastCachedKeyCounts.get(e.entityId) ?? 0,
      }));

      debugStats.orch = orchDebug;
    }

    // Step 5 — Cache and return
    this.lastEpochs = currentEpochs;
    this.cachedResult = { memberRoster, settings, multiChannel, epochs: currentEpochs };
    return this.cachedResult;
  }

  /**
   * Deliver decoded chunks to the GPU worker via RenderClient.
   * Replaces uploadChunksForMembers() -- called from slicePath/volumePath after S5.3.
   */
  deliverToWorker(
    ctx: TickContext,
    budget: number,
    sliceZ: number | null,
  ): boolean {
    const multiChannel = ctx.scene.multi_channel();
    const epochs = this.lastEpochs ?? { content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 };
    let remaining = budget;
    let budgetExhausted = false;

    // Build target level map from current plan for LOD filtering
    const targetLevelByImage = new Map<string, number>();
    for (const req of this._lastFilteredRequests) {
      targetLevelByImage.set(req.imageId, req.level);
    }

    // Drain new deliveries from CpuCache
    const deliveries = ctx.cpuCache.drain(budget);

    // Send each delivery to the worker.
    for (const delivery of deliveries) {
      if (delivery.kind === "proxy") {
        // S5: proxies are routed to a dedicated worker message. The
        // worker stub just logs receipt — S7 lands the actual GPU
        // upload.
        const sent = this.sendProxyDeliveryToWorker(ctx, delivery, epochs);
        if (sent > 0) {
          remaining -= sent;
          if (remaining <= 0) {
            budgetExhausted = true;
            break;
          }
        }
        continue;
      }
      // Chunk path. Skip runway (pre-cached for future timepoints),
      // overview (minimap path), and wrong-LOD chunks (stale requests
      // from a previous plan).
      if (delivery.lane === "runway" || delivery.lane === "overview") continue;
      const target = targetLevelByImage.get(delivery.imageId);
      if (target === undefined || delivery.level !== target) continue;
      const sent = this.sendDeliveryToWorker(ctx, delivery, multiChannel, sliceZ, epochs);
      if (sent > 0) {
        remaining -= sent;
        if (remaining <= 0) {
          budgetExhausted = true;
          break;
        }
      }
    }

    // Re-send evicted chunks (budget permitting).
    // Use _lastFilteredRequests (target-level only) to avoid flipping the atlas
    // config between levels, which clears the sent set and causes flickering.
    if (!budgetExhausted && this._lastFilteredRequests.length > 0) {
      for (const req of this._lastFilteredRequests) {
        if (budgetExhausted) break;
        if (req.lane === "runway") continue;
        const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
        const ss = this.deliverySentToWorker.get(wid);
        if (ss?.has(req.chunkKey)) continue;

        const cached = ctx.cpuCache.getCached(req.entityId, req.chunkKey);
        if (!cached) continue;

        const sent = this.sendDeliveryToWorker(ctx, cached, multiChannel, sliceZ, epochs);
        if (sent > 0) {
          remaining -= sent;
          if (remaining <= 0) budgetExhausted = true;
        }
      }
    }

    return deliveries.length > 0 || budgetExhausted;
  }

  /** Remove evicted/skipped chunk keys from the sent-to-worker tracking. */
  handleChunksEvicted(workerMemberId: string, evicted: string[], skipped: string[]): void {
    const sentSet = this.deliverySentToWorker.get(workerMemberId);
    if (sentSet) {
      for (const key of evicted) sentSet.delete(key);
      for (const key of skipped) sentSet.delete(key);
    }
  }

  /**
   * Process a wanted-set delta from the GPU worker.
   *
   * S7: now accepts a discriminated union over chunks and proxies.
   * Chunks land in `workerWantedSet` (existing chunk-resend logic);
   * proxy entries are not yet tracked here — `_lastProxyRequests` is
   * the orchestrator's source of truth and the cache-hit path keeps
   * re-submitting them, so a proxy missing from the worker simply
   * stays in the next plan's request set. (Direct fast-path for proxy
   * resend can land in a future slice if the steady-state churn turns
   * out to need it.)
   */
  handleWantedSetDelta(
    missing: Array<MissingChunkLite | MissingProxyLite>,
  ): void {
    this.workerWantedSet.clear();
    for (const entry of missing) {
      if (entry.kind !== "chunk") continue;
      let set = this.workerWantedSet.get(entry.entityId);
      if (!set) {
        set = new Set();
        this.workerWantedSet.set(entry.entityId, set);
      }
      set.add(entry.chunkKey);
    }
  }

  /** Get all tracked worker member IDs (for multi-channel transition cleanup). */
  getTrackedMemberIds(): string[] {
    return [...this.deliverySentToWorker.keys()];
  }

  /** Clear all delivery state for a member (e.g. on dataset removal). */
  clearMemberResources(workerMemberId: string): void {
    this.deliverySentToWorker.delete(workerMemberId);
  }

  /**
   * Send a single chunk delivery to the GPU worker, emitting atlas config if the
   * state key changed and the chunk data itself.  Returns bytes sent (0 if skipped).
   */
  private sendDeliveryToWorker(
    ctx: TickContext,
    delivery: ReadyChunkDelivery,
    multiChannel: boolean,
    sliceZ: number | null,
    epochs: PlanningEpochs,
  ): number {
    const viewMode = ctx.mode;
    const workerMemberId = multiChannel ? `${delivery.imageId}:ch${delivery.c}` : delivery.imageId;

    // Find dataset for this delivery
    let dsContent: ContentGraph | null = null;
    let dsId = "";
    for (const [id, ds] of ctx.datasets) {
      if (ds.content.images.some(img => img.image_id === delivery.imageId)) {
        dsContent = ds.content;
        dsId = id;
        break;
      }
    }
    if (!dsContent) return 0;

    const imageSpec = dsContent.images.find(img => img.image_id === delivery.imageId);
    if (!imageSpec) return 0;
    const levelMeta = imageSpec.multiscale.levels[delivery.level];
    if (!levelMeta) return 0;

    const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;    // [T, C, Z, Y, X]
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;

    // Send chunk data if not already sent
    let sentSet = this.deliverySentToWorker.get(workerMemberId);
    if (!sentSet) {
      sentSet = new Set();
      this.deliverySentToWorker.set(workerMemberId, sentSet);
    }

    if (sentSet.has(delivery.chunkKey)) return 0;

    const chunkData = {
      data: delivery.data,
      dataType: delivery.dataType,
      x: delivery.x, y: delivery.y, z: delivery.z,
      key: delivery.chunkKey,
    };

    if (viewMode === "slice") {
      const fullResDepth = imageSpec.multiscale.levels[0].shape[2];
      ctx.client.sliceChunkData(
        workerMemberId, [chunkData],
        delivery.level, sliceZ!, delivery.t, delivery.c,
        levelWidth, levelHeight, chunkX, chunkY, chunkZ,
        fullResDepth, levelDepth, sliceZ!,
        epochs,
      );
    } else {
      const hitLocal = Array.from(ctx.scene.ray_hit_local_image(dsId)) as [number, number, number];
      ctx.client.volumeChunkData(
        workerMemberId, [chunkData],
        delivery.level, delivery.t, delivery.c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ, hitLocal,
        epochs,
      );
    }

    sentSet.add(delivery.chunkKey);
    return delivery.data.byteLength;
  }

  /**
   * S5: forward a proxy delivery to the GPU worker. The worker stub
   * just logs receipt; S7 will hook this up to real GPU residency.
   */
  private sendProxyDeliveryToWorker(
    ctx: TickContext,
    delivery: ReadyProxyDelivery,
    epochs: PlanningEpochs,
  ): number {
    ctx.client.proxyAssetData(
      delivery.datasetId,
      delivery.entityId,
      delivery.imageId,
      delivery.proxyKind,
      delivery.t,
      delivery.c,
      delivery.header.dims,
      delivery.data,
      epochs,
    );
    return delivery.data.byteLength;
  }

  /**
   * Debug helper for HITL: synthesize a single-proxy `RequestPlan`,
   * submit it to CpuCache, and rely on the normal subscribe → tick →
   * `deliverToWorker` path to forward the result to the GPU worker.
   *
   * Intended to be called from the dev console, e.g.
   * `window.__lucidaOrchestrator.requestTestProxy(...)`. App.tsx exposes
   * the orchestrator on `window` for this purpose.
   *
   * Returns immediately — the result lands in the worker asynchronously.
   */
  requestTestProxy(
    cpuCache: CpuCache,
    datasetId: string,
    entityId: string,
    imageId: string,
    kind: "WellProxy3D" | "FieldProxy3D",
    t: number,
    c: number,
  ): void {
    const proxyRequest: ProxyRequest = {
      datasetId,
      entityId,
      imageId,
      kind,
      t,
      c,
      priority: 0,
    };
    const epochs: PlanningEpochs = this.lastEpochs ?? {
      content: 0,
      layout: 0,
      view: 0,
      selection: 0,
      asset: 0,
      request: 0,
    };
    cpuCache.submit({
      requests: [],
      activeSet: [],
      proxyRequests: [proxyRequest],
      epochs,
    });
  }

  /** Collect minimap pending fetches as overview-lane ChunkRequests (no submit). */
  private collectMinimapRequests(
    ctx: TickContext,
    minimapPendingFetch: Map<string, MinimapChunkCoord[]>,
  ): ChunkRequest[] {
    const requests: ChunkRequest[] = [];
    for (const [dsId, ds] of ctx.datasets) {
      for (const img of ds.content.images) {
        const pending = minimapPendingFetch.get(img.image_id);
        if (pending && pending.length > 0) {
          for (const coord of pending) {
            requests.push({
              entityId: img.image_id,
              imageId: img.image_id,
              level: coord.level,
              t: coord.t,
              c: coord.c,
              z: coord.z,
              y: coord.y,
              x: coord.x,
              lane: "overview",
              priority: 2000,
              chunkKey: coord.key,
              datasetId: dsId,
            });
          }
        }
      }
    }
    return requests;
  }

  /** Build and send a ColdStateMessage to the GPU worker. */
  private sendColdState(
    dsId: string,
    activeSet: ActiveSetEntry[],
    entities: EntitySnapshot[],
    selection: SelectionState,
    visibleRegion: VisibleRegion,
    epochs: PlanningEpochs,
    ctx: TickContext,
  ): void {
    const entityById = new Map(entities.map(e => [e.entityId, e]));

    const coldActiveSet: ColdStateActiveEntry[] = activeSet.map(entry => {
      const entity = entityById.get(entry.entityId);
      const levels = (entity?.levels ?? []).map((lvl: LevelGeometry, idx: number) => {
        const chunkShape: [number, number, number] = [
          lvl.chunk_shape[2], lvl.chunk_shape[3], lvl.chunk_shape[4],
        ];
        const gridShape: [number, number, number] = [
          Math.ceil(lvl.shape[2] / lvl.chunk_shape[2]),
          Math.ceil(lvl.shape[3] / lvl.chunk_shape[3]),
          Math.ceil(lvl.shape[4] / lvl.chunk_shape[4]),
        ];
        const levelDims: [number, number, number] = [
          lvl.shape[2], lvl.shape[3], lvl.shape[4],
        ];
        return { level: idx, chunkShape, gridShape, levelDims };
      });

      // S7: forward Planning's promotion mode + proxy availability so
      // the worker's wanted-set knows whether to ask for proxies.
      // `parentWellId` lets the worker fan out a well-proxy upload to
      // its child fields' descriptors.
      const parentWellId =
        entity?.kind === "Field" ? (entity.parentId ?? null) : null;

      return {
        entityId: entry.entityId,
        imageId: entry.imageId,
        targetLod: entry.targetLod,
        detailOwnedLodRange: entry.detailOwnedLodRange,
        levels,
        mode: entry.mode,
        proxyKind: entry.proxyKind,
        proxyAvailable: entry.proxyAvailable,
        wellProxyAvailable: entry.wellProxyAvailable,
        parentWellId,
      };
    });

    const msg: ColdStateMessage = {
      type: "coldState",
      epochs,
      datasetId: dsId,
      currentT: selection.t,
      currentZ: selection.z,
      visibleChannels: selection.visibleChannels,
      visibleRegion,
      activeSet: coldActiveSet,
      viewMode: selection.renderMode,
    };

    ctx.client.coldState(msg);
  }
}

