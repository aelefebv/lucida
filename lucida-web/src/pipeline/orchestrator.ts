/**
 * Orchestrator — assembles PlanningSnapshot from live WASM scene state,
 * invokes plan(), and translates the output into MemberChunkPlan[] for
 * the existing upload pipeline.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { ChunkCoord, QualifiedChunkCoord } from "../zarr/chunkStore.ts";
import type { MemberChunkPlan } from "../uploadCommon.ts";
import type { SceneSettings } from "../tickCommon.ts";
import type { ImageSpec, ContentGraph } from "../contentTypes.ts";
import {
  getSceneSettings,
  getActiveChannels,
  compositeKey,
  stripChannelSuffix,
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
import type { ReadyDelivery } from "./cpuCache.ts";
import { debugStats, type OrchDebug, type OrchMemberDebug } from "../debug/debugStats.ts";

export interface OrchestratorResult {
  memberPlanCache: Map<string, MemberChunkPlan[]>;
  settings: SceneSettings;
  multiChannel: boolean;
  epochs: PlanningEpochs;
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
  /** Last per-dataset fetch lists, re-submitted on epoch HIT to retry missing chunks. */
  private _lastFetchLists = new Map<string, QualifiedChunkCoord[]>();
  /** Last filtered requests, re-submitted on epoch HIT to CpuCache. */
  private _lastFilteredRequests: ChunkRequest[] = [];

  // Delivery state (replaces UploadState from uploadCommon at S5.3)
  private deliverySentToWorker = new Map<string, Set<string>>();
  private deliveryPrevStateKey = new Map<string, string>();

  planAndFetch(
    ctx: TickContext,
    minimapPendingFetch: Map<string, ChunkCoord[]>,
  ): OrchestratorResult | null {
    // Step 1 — Epoch check
    const rawEpochs = JSON.parse(ctx.scene.epochs());
    const currentEpochs: PlanningEpochs = {
      content: rawEpochs.content,
      layout: rawEpochs.layout,
      view: rawEpochs.view,
      selection: rawEpochs.selection,
      asset: 0,
      request: this.requestEpoch,
    };

    if (
      this.lastEpochs &&
      this.cachedResult &&
      currentEpochs.content === this.lastEpochs.content &&
      currentEpochs.layout === this.lastEpochs.layout &&
      currentEpochs.view === this.lastEpochs.view &&
      currentEpochs.selection === this.lastEpochs.selection
    ) {
      // Re-submit fetches on HIT frames: ensureFetched is idempotent
      // (skips cached + in-flight), but retries anything that was lost.
      for (const [dsId, ds] of ctx.datasets) {
        const fetchList = this._lastFetchLists.get(dsId);
        if (fetchList && fetchList.length > 0) {
          ds.sharedQueue.ensureFetched(fetchList);
        }
      }
      // Re-submit to CpuCache so it can retry failed/cancelled fetches
      if (ctx.cpuCache && this._lastFilteredRequests.length > 0) {
        ctx.cpuCache.submit({
          requests: this._lastFilteredRequests,
          activeSet: [...(this.previousActiveSet.values())].flat(),
          epochs: this.lastEpochs!,
        });
      }
      this.submitMinimapFetches(ctx, minimapPendingFetch);
      if (debugStats.enabled && debugStats.orch) {
        debugStats.orch.epochCacheHit = true;
      }
      return this.cachedResult;
    }

    // Step 2 — Settings
    const settings = getSceneSettings(ctx.scene);
    const multiChannel = ctx.scene.multi_channel();

    // Step 3 — Per-dataset loop
    const memberPlanCache = new Map<string, MemberChunkPlan[]>();

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

      // 3g. Cache state
      const cached = new Map<string, Set<string>>();
      for (const entity of entities) {
        const keys = ds.sharedQueue.getCachedKeys(entity.imageId);
        cached.set(entity.entityId, keys);
        this._lastCachedKeyCounts.set(entity.entityId, keys.size);
      }

      // 3h. Plan — use empty cache state so all needed chunks appear in the plan.
      // The upload path manages its own sentToWorker tracking; if we skip cached
      // chunks here, they vanish from memberPlanCache and never get uploaded.
      // Real cache state is used below for fetch submission only.
      const snapshot: PlanningSnapshot = {
        epochs: currentEpochs,
        entities,
        visibleRegion,
        selection,
        cacheState: { cached: new Map(), inFlight: new Map() },
        workerWantedSet: { resident: new Map() },
        previousActiveSet: this.previousActiveSet.get(dsId) ?? [],
        assetCatalog: null,
      };

      const result = plan(snapshot);
      this.previousActiveSet.set(dsId, result.activeSet);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion = visibleRegion;
      this._lastEntities = entities;

      // 3i. Adapter — convert RequestPlan to MemberChunkPlan[]
      // Filter to single level per entity: the upload path can only handle one atlas
      // config (one level's dimensions) per member. Multi-level rendering requires M4.
      const targetLevelByEntity = new Map<string, number>();
      for (const entry of result.activeSet) {
        targetLevelByEntity.set(entry.entityId, entry.targetLod);
      }
      const filteredRequests = result.requests.filter(r => {
        const target = targetLevelByEntity.get(r.entityId);
        return target !== undefined && r.level === target;
      });

      this._lastFilteredRequests = filteredRequests;

      // Annotate requests with the real dataset ID (entityId may differ for plates)
      for (const req of filteredRequests) {
        req.datasetId = dsId;
      }

      // Submit to CpuCache for fetching
      if (ctx.cpuCache) {
        ctx.cpuCache.submit({
          requests: filteredRequests,
          activeSet: result.activeSet,
          epochs: currentEpochs,
        });
      }

      const translated = translateRequestPlan(filteredRequests, entities, multiChannel);

      if (multiChannel) {
        for (const [memberKey, plans] of translated) {
          const channelMatch = memberKey.match(/:ch(\d+)$/);
          if (channelMatch) {
            const planCacheKey = `${dsId}:ch${channelMatch[1]}`;
            const existing = memberPlanCache.get(planCacheKey) ?? [];
            existing.push(...plans);
            memberPlanCache.set(planCacheKey, existing);
          }
        }
      } else {
        const allPlans: MemberChunkPlan[] = [];
        for (const plans of translated.values()) {
          allPlans.push(...plans);
        }
        memberPlanCache.set(dsId, allPlans);
      }

      // 3j. Fetch submission
      const minimapCoords: QualifiedChunkCoord[] = [];
      for (const entity of entities) {
        const pending = minimapPendingFetch.get(entity.imageId);
        if (pending) {
          for (const coord of pending) {
            minimapCoords.push({ ...coord, memberId: entity.imageId });
          }
        }
      }

      if (ctx.cpuCache) {
        // CpuCache handles main-view fetching; only submit minimap to SharedChunkQueue
        this._lastFetchLists.set(dsId, minimapCoords);
        if (minimapCoords.length > 0) {
          ds.sharedQueue.ensureFetched(minimapCoords);
        }
      } else {
        // No CpuCache: SharedChunkQueue handles everything
        const qualifiedCoords: QualifiedChunkCoord[] = filteredRequests.map(
          (req) => ({
            level: req.level,
            x: req.x,
            y: req.y,
            z: req.z,
            t: req.t,
            c: req.c,
            key: req.chunkKey,
            memberId: req.imageId,
          }),
        );
        const allCoords = [...qualifiedCoords, ...minimapCoords];
        this._lastFetchLists.set(dsId, allCoords);
        if (allCoords.length > 0) {
          ds.sharedQueue.ensureFetched(allCoords);
        }
      }

      const channelCount = multiChannel ? visibleChannels.length : 1;
      ds.sharedQueue.setConcurrency(Math.min(12 * channelCount, 48));

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

      // Aggregate from memberPlanCache (post-adapter)
      for (const [_key, plans] of memberPlanCache) {
        for (const mp of plans) {
          const levelCounts: Record<number, number> = {};
          for (const c of mp.needed) {
            levelCounts[c.level] = (levelCounts[c.level] ?? 0) + 1;
          }
          const mixedLevels = Object.keys(levelCounts).length > 1;
          if (mixedLevels) orchDebug.hasMixedLevels = true;
          orchDebug.members.push({
            imageId: mp.image_id,
            position: mp.position,
            neededCount: mp.needed.length,
            prefetchCount: mp.prefetch.length,
            uploadLevel: mp.needed[0]?.level,
            levelCounts,
            mixedLevels,
          });
        }
      }

      // Aggregate from all per-dataset plan results
      // Re-run is wasteful, so store last result. For now just use previousActiveSet.
      for (const [, activeSet] of this.previousActiveSet) {
        for (const entry of activeSet) {
          orchDebug.activeSet.push({
            entityId: entry.entityId,
            representation: entry.representation,
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
    this.cachedResult = { memberPlanCache, settings, multiChannel, epochs: currentEpochs };
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

    // Drain new deliveries from CpuCache
    if (!ctx.cpuCache) return false;
    const deliveries = ctx.cpuCache.drain(budget);

    // Send each delivery to the worker (skip runway — pre-cached for future timepoints)
    for (const delivery of deliveries) {
      if (delivery.lane === "runway") continue;
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

  /** Get all tracked worker member IDs (for multi-channel transition cleanup). */
  getTrackedMemberIds(): string[] {
    return [...new Set([...this.deliveryPrevStateKey.keys(), ...this.deliverySentToWorker.keys()])];
  }

  /** Clear all delivery state for a member (e.g. on dataset removal). */
  clearMemberResources(workerMemberId: string): void {
    this.deliveryPrevStateKey.delete(workerMemberId);
    this.deliverySentToWorker.delete(workerMemberId);
  }

  /**
   * Send a single delivery to the GPU worker, emitting atlas config if the
   * state key changed and the chunk data itself.  Returns bytes sent (0 if skipped).
   */
  private sendDeliveryToWorker(
    ctx: TickContext,
    delivery: ReadyDelivery,
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

    // Build state key and check for atlas config change
    const stateKey = viewMode === "slice"
      ? `${delivery.t}/${delivery.c}/${sliceZ}/${delivery.level}`
      : `${delivery.t}/${delivery.c}/${delivery.level}`;

    if (stateKey !== this.deliveryPrevStateKey.get(workerMemberId)) {
      if (viewMode === "slice") {
        ctx.client.sliceAtlasConfig(
          workerMemberId, delivery.level, sliceZ!, delivery.t, delivery.c,
          levelWidth, levelHeight, chunkX, chunkY, epochs,
        );
      } else {
        ctx.client.volumeAtlasConfig(
          workerMemberId, delivery.level, delivery.t, delivery.c,
          levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ, epochs,
        );
      }
      this.deliveryPrevStateKey.set(workerMemberId, stateKey);
      this.deliverySentToWorker.delete(workerMemberId);
    }

    // Send chunk data if not already sent
    let sentSet = this.deliverySentToWorker.get(workerMemberId);
    if (!sentSet) {
      sentSet = new Set();
      this.deliverySentToWorker.set(workerMemberId, sentSet);
    }

    if (sentSet.has(delivery.chunkKey)) return 0;

    const chunkData = {
      data: new Uint16Array(delivery.data),
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

  /** Submit minimap fetch lists for all datasets without re-planning. */
  private submitMinimapFetches(
    ctx: TickContext,
    minimapPendingFetch: Map<string, ChunkCoord[]>,
  ): void {
    for (const [, ds] of ctx.datasets) {
      for (const memberId of ds.sharedQueue.memberIds()) {
        const pending = minimapPendingFetch.get(memberId);
        if (pending && pending.length > 0) {
          const coords: QualifiedChunkCoord[] = pending.map((coord) => ({
            ...coord,
            memberId,
          }));
          ds.sharedQueue.ensureFetched(coords);
        }
      }
    }
  }
}

/**
 * Convert ChunkRequest[] into MemberChunkPlan[] grouped by member key.
 * Detail + overview lanes → needed, runway lane → prefetch.
 * Exported for unit testing.
 */
export function translateRequestPlan(
  requests: ChunkRequest[],
  entities: EntitySnapshot[],
  multiChannel: boolean,
): Map<string, MemberChunkPlan[]> {
  const entityPositions = new Map<string, [number, number]>();
  const entityByImageId = new Map<string, EntitySnapshot>();
  for (const entity of entities) {
    entityPositions.set(entity.entityId, entity.position);
    entityByImageId.set(entity.imageId, entity);
  }

  const memberRequests = new Map<
    string,
    { needed: ChunkCoord[]; prefetch: ChunkCoord[] }
  >();

  for (const req of requests) {
    const memberKey = multiChannel
      ? compositeKey(req.imageId, req.c)
      : req.imageId;

    let entry = memberRequests.get(memberKey);
    if (!entry) {
      entry = { needed: [], prefetch: [] };
      memberRequests.set(memberKey, entry);
    }

    const coord: ChunkCoord = {
      level: req.level,
      x: req.x,
      y: req.y,
      z: req.z,
      t: req.t,
      c: req.c,
      key: req.chunkKey,
    };

    // detail + overview are immediately needed; runway is speculative prefetch
    if (req.lane === "runway") {
      entry.prefetch.push(coord);
    } else {
      entry.needed.push(coord);
    }
  }

  const result = new Map<string, MemberChunkPlan[]>();

  for (const [memberKey, { needed, prefetch }] of memberRequests) {
    const rawImageId = multiChannel
      ? stripChannelSuffix(memberKey)
      : memberKey;
    const entity = entityByImageId.get(rawImageId);
    const position = entity
      ? (entityPositions.get(entity.entityId) ?? [0, 0])
      : [0, 0];

    const plan: MemberChunkPlan = {
      image_id: rawImageId,
      position: position as [number, number],
      needed,
      prefetch,
    };

    // Map key is the composite key (for multi-channel grouping),
    // but image_id stays raw so uploadCommon can append channel suffix itself.
    const existing = result.get(memberKey) ?? [];
    existing.push(plan);
    result.set(memberKey, existing);
  }

  return result;
}
