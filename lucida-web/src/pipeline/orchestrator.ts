/**
 * Orchestrator — assembles PlanningSnapshot from live WASM scene state,
 * invokes plan(), and routes the output to CpuCache for fetching and
 * delivery to the GPU worker.
 */

import type { TickContext } from "../renderLoopTypes.ts";
import type { SceneSettings } from "../tickCommon.ts";
import type { ImageSpec, ContentGraph, LevelGeometry } from "../contentTypes.ts";
import type { ColdStateActiveEntry, ColdStateMessage } from "../renderer/workerProtocol.ts";
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
import type { ReadyDelivery } from "./cpuCache.ts";
import { debugStats, type OrchDebug, type OrchMemberDebug } from "../debug/debugStats.ts";

/** A visible member for render layer construction. */
export interface MemberRosterEntry {
  imageId: string;
  position: [number, number];
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

  // Delivery state — tracks what's been sent to the GPU worker
  private deliverySentToWorker = new Map<string, Set<string>>();
  private deliveryPrevStateKey = new Map<string, string>();

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
      // Re-submit detail + minimap in one call so they don't cancel each other
      const minimapReqs = this.collectMinimapRequests(ctx, minimapPendingFetch);
      const allRequests = [...this._lastFilteredRequests, ...minimapReqs];
      if (allRequests.length > 0) {
        ctx.cpuCache.submit({
          requests: allRequests,
          activeSet: [...(this.previousActiveSet.values())].flat(),
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
        assetCatalog: null,
      };

      const result = plan(snapshot);
      this.previousActiveSet.set(dsId, result.activeSet);
      this.requestEpoch = result.epochs.request;
      this._lastRequests = result.requests;
      this._lastVisibleRegion = visibleRegion;
      this._lastEntities = entities;

      // 3i. Filter to single level per entity for atlas config (M4 adds multi-level).
      const targetLevelByEntity = new Map<string, number>();
      for (const entry of result.activeSet) {
        targetLevelByEntity.set(entry.entityId, entry.targetLod);
      }
      const filteredRequests = result.requests.filter(r => {
        const target = targetLevelByEntity.get(r.entityId);
        return target !== undefined && r.level === target;
      });

      this._lastFilteredRequests = filteredRequests;

      // Send cold state to the worker so it knows the full planning context
      this.sendColdState(result.activeSet, entities, selection, visibleRegion, currentEpochs, ctx);

      // Annotate requests with the real dataset ID (entityId may differ for plates)
      for (const req of filteredRequests) {
        req.datasetId = dsId;
      }

      // 3j. Build member roster from active set for render layer construction.
      const entityById = new Map(entities.map(e => [e.entityId, e]));
      const rosterEntries: MemberRosterEntry[] = [];
      for (const entry of result.activeSet) {
        const entity = entityById.get(entry.entityId);
        if (entity) {
          rosterEntries.push({ imageId: entity.imageId, position: entity.position });
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

      // Submit detail + minimap requests in a single call so they don't cancel each other
      ctx.cpuCache.submit({
        requests: [...filteredRequests, ...minimapRequests],
        activeSet: result.activeSet,
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
    this.cachedResult = { memberRoster, settings, multiChannel, epochs: currentEpochs };
    return this.cachedResult;
  }

  /**
   * Ensure atlas config is current for all tracked members.
   * Triggers remap in the worker when T/C/Z/LOD changed, even when no chunks are ready.
   */
  private syncAtlasState(ctx: TickContext, sliceZ: number | null, epochs: PlanningEpochs): void {
    if (this._lastFilteredRequests.length === 0) return;
    const multiChannel = ctx.scene.multi_channel();
    const seen = new Set<string>();
    for (const req of this._lastFilteredRequests) {
      const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
      if (seen.has(wid)) continue;
      seen.add(wid);
      this.updateAtlasConfigIfNeeded(ctx, wid, req, sliceZ, epochs);
    }
  }

  /**
   * Check state key for a member and send atlas config if it changed (triggering remap).
   * Returns true if atlas config was sent.
   */
  private updateAtlasConfigIfNeeded(
    ctx: TickContext,
    workerMemberId: string,
    req: { imageId: string; level: number; t: number; c: number },
    sliceZ: number | null,
    epochs: PlanningEpochs,
  ): boolean {
    const viewMode = ctx.mode;
    const stateKey = viewMode === "slice"
      ? `${req.t}/${req.c}/${sliceZ}/${req.level}`
      : `${req.t}/${req.c}/${req.level}`;

    if (stateKey === this.deliveryPrevStateKey.get(workerMemberId)) return false;

    // Find image spec for this member
    let dsContent: ContentGraph | null = null;
    for (const [, ds] of ctx.datasets) {
      if (ds.content.images.some(img => img.image_id === req.imageId)) {
        dsContent = ds.content;
        break;
      }
    }
    if (!dsContent) return false;

    const imageSpec = dsContent.images.find(img => img.image_id === req.imageId);
    if (!imageSpec) return false;
    const levelMeta = imageSpec.multiscale.levels[req.level];
    if (!levelMeta) return false;

    const [, , levelDepth, levelHeight, levelWidth] = levelMeta.shape;
    const [, , chunkZ, chunkY, chunkX] = levelMeta.chunk_shape;

    if (viewMode === "slice") {
      ctx.client.sliceAtlasConfig(
        workerMemberId, req.level, sliceZ!, req.t, req.c,
        levelWidth, levelHeight, chunkX, chunkY, epochs,
      );
    } else {
      ctx.client.volumeAtlasConfig(
        workerMemberId, req.level, req.t, req.c,
        levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ, epochs,
      );
    }
    this.deliveryPrevStateKey.set(workerMemberId, stateKey);
    this.deliverySentToWorker.delete(workerMemberId);
    return true;
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

    // Ensure atlas config is current for all members (triggers remap even with no deliveries)
    this.syncAtlasState(ctx, sliceZ, epochs);

    // Drain new deliveries from CpuCache
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

  /** Process a wanted-set delta from the GPU worker. */
  handleWantedSetDelta(missing: Array<{ entityId: string; chunkKey: string }>): void {
    this.workerWantedSet.clear();
    for (const { entityId, chunkKey } of missing) {
      let set = this.workerWantedSet.get(entityId);
      if (!set) {
        set = new Set();
        this.workerWantedSet.set(entityId, set);
      }
      set.add(chunkKey);
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

    // Ensure atlas config is current (triggers remap if state changed)
    this.updateAtlasConfigIfNeeded(ctx, workerMemberId, delivery, sliceZ, epochs);

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
        return { level: idx, chunkShape, gridShape };
      });

      return {
        entityId: entry.entityId,
        imageId: entry.imageId,
        targetLod: entry.targetLod,
        detailOwnedLodRange: entry.detailOwnedLodRange,
        levels,
      };
    });

    const msg: ColdStateMessage = {
      type: "coldState",
      epochs,
      currentT: selection.t,
      visibleChannels: selection.visibleChannels,
      visibleRegion,
      activeSet: coldActiveSet,
      viewMode: selection.renderMode,
    };

    ctx.client.coldState(msg);
  }
}

