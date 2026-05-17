/**
 * Uploader — owns upload-phase state the tickCoordinator hands off
 * alongside its planning role. See
 * `wiki/decisions/0034-orchestrator-split-into-pipeline-upload.md`.
 */

import type { CpuCache } from "../fetch/index.ts";
import type {
  ChunkRequest,
  ProxyRequest,
  ActiveSetEntry,
  EntitySnapshot,
  SelectionState,
} from "../planning/index.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { TickContext } from "../../renderLoopTypes.ts";
import type { DatasetSettings } from "../../tickCommon.ts";
import type {
  ColdStateMessage,
  MissingChunk,
  MissingProxy,
} from "../../renderer/workerProtocol.ts";
import {
  emptyUploadTickStats,
  type UploadTickStats,
} from "../../debug/debugStats.ts";
import { buildColdState } from "./coldState/build.ts";
import { buildViewHotState } from "./coldState/hotState.ts";
import { DeliveryTracker } from "./delivery/tracker.ts";
import { WorkerFeedback } from "./delivery/feedback.ts";
import { buildManifestByImage } from "./delivery/manifestIndex.ts";
import { runDrainPass } from "./delivery/drain.ts";
import {
  runChunkResendPass,
  runProxyResendPass,
} from "./delivery/resend.ts";
import { UploadTelemetry } from "./telemetry/upload.ts";
import { ColdStateTelemetry } from "./telemetry/coldState.ts";

export class Uploader {
  private readonly deliveryTracker = new DeliveryTracker();
  private readonly workerFeedback = new WorkerFeedback(this.deliveryTracker);

  readonly uploadTelemetry = new UploadTelemetry();

  /** Exposed so `TickCoordinator` can wire cache-hit / rebuild events. */
  readonly coldStateTelemetry = new ColdStateTelemetry();

  /** Per-dataset so multi-dataset rebuilds aren't last-dataset-wins. */
  private readonly lastFilteredRequests = new Map<string, ChunkRequest[]>();
  /** Per-dataset so multi-dataset rebuilds aren't last-dataset-wins. */
  private readonly lastProxyRequests = new Map<string, ProxyRequest[]>();
  private readonly lastViewEpochByDataset = new Map<string, number>();

  /** Snapshotted by `sendColdState` so `deliverToWorker` can stamp chunks. */
  private lastEpochs: SceneEpochs | null = null;

  /** Reset at the start of each `deliverToWorker`; mutated by drain/resend. */
  private currentUploadStats: UploadTickStats = emptyUploadTickStats();

  // Planner → Uploader seam

  /**
   * Called once at the top of every cold-state rebuild path. Hoisted to
   * once-per-tick (not per-dataset) because atlas state is global per
   * worker — multi-dataset rebuilds must not multi-clear. Proxy delivery
   * tracking is NOT cleared here (proxy pools persist across rebuilds).
   */
  onPlanRebuildStart(): void {
    this.deliveryTracker.onColdStateRebuild();
  }

  /**
   * Build and send a `ColdStateMessage` to the GPU worker. Snapshots
   * `epochs` so a later `deliverToWorker` can stamp chunks without re-
   * reading WASM. Tracker reset is hoisted to `onPlanRebuildStart`.
   */
  sendColdState(args: {
    ctx: TickContext;
    datasetId: string;
    activeSet: ActiveSetEntry[];
    entities: EntitySnapshot[];
    selection: SelectionState;
    visibleRegion: VisibleRegion;
    epochs: SceneEpochs;
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
    dsSettings: DatasetSettings | undefined;
  }): ColdStateMessage {
    const msg = buildColdState({
      datasetId: args.datasetId,
      activeSet: args.activeSet,
      entities: args.entities,
      selection: args.selection,
      visibleRegion: args.visibleRegion,
      epochs: args.epochs,
      matricesByEntity: args.matricesByEntity,
      dsSettings: args.dsSettings,
    });
    args.ctx.client.coldState(msg);
    this.lastEpochs = args.epochs;
    return msg;
  }

  /**
   * Build and send a viewEpoch hot-state message. Must be posted before
   * subsequent render messages so the worker's `rayHitPerEntity` is
   * current when chunk-data eviction fires. Returns `false` (and emits
   * nothing) if the viewEpoch is unchanged for this dataset.
   */
  sendViewHotStateIfAdvanced(args: {
    ctx: TickContext;
    datasetId: string;
    coldMsg: ColdStateMessage;
    epochs: SceneEpochs;
  }): boolean {
    const lastView = this.lastViewEpochByDataset.get(args.datasetId);
    if (lastView === args.epochs.view) return false;
    const hit = Array.from(
      args.ctx.scene.ray_hit_local_image(args.datasetId),
    ) as [number, number, number];
    const msg = buildViewHotState({
      coldMsg: args.coldMsg,
      rayHit: hit,
      epochs: args.epochs,
      datasetId: args.datasetId,
    });
    args.ctx.client.viewHotState(msg);
    this.lastViewEpochByDataset.set(args.datasetId, args.epochs.view);
    return true;
  }

  /**
   * Stash the planner's per-dataset request snapshots so the
   * `deliverToWorker` resend passes can find them on cache-hit ticks.
   * Also pre-populates the wid → entityId reverse lookup so an eviction
   * report that arrives before any chunk has been sent can still resolve
   * `cpuCache.markRejected(entityId, ...)`.
   */
  recordPlanForDataset(
    datasetId: string,
    requests: ChunkRequest[],
    proxyRequests: ProxyRequest[],
    multiChannel: boolean,
  ): void {
    this.lastFilteredRequests.set(datasetId, requests);
    this.lastProxyRequests.set(datasetId, proxyRequests);
    for (const req of requests) {
      const wid = multiChannel ? `${req.imageId}:ch${req.c}` : req.imageId;
      this.deliveryTracker.recordMember(wid, req.entityId);
    }
  }

  // Per-tick upload (slicePath / volumePath)

  /**
   * Deliver decoded chunks to the GPU worker. Composes three passes
   * from `delivery/`: drain, chunk resend, proxy resend. Returns `true`
   * if more work remains (drain queue produced deliveries OR the byte
   * budget was exhausted).
   */
  deliverToWorker(
    ctx: TickContext,
    budget: number,
    sliceZ: number | null,
  ): boolean {
    const tickStart = performance.now();
    this.currentUploadStats = emptyUploadTickStats();
    this.currentUploadStats.bytesBudget = budget;

    const multiChannel = ctx.scene.multi_channel();
    const epochs = this.lastEpochs ?? {
      content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0,
    };
    const viewMode = ctx.mode;

    // Per-tick lookup tables: target LOD drives the drain pass's
    // wrongLod filter; the manifest index is per-image O(1) lookup.
    const targetLevelByImage = new Map<string, number>();
    for (const requests of this.lastFilteredRequests.values()) {
      for (const req of requests) {
        targetLevelByImage.set(req.imageId, req.level);
      }
    }
    const manifestByImage = buildManifestByImage(ctx.datasets);

    const deliveries = ctx.cpuCache.drain(budget);
    for (const d of deliveries) {
      if (d.kind === "proxy") this.currentUploadStats.drainedProxies++;
      else this.currentUploadStats.drainedChunks++;
    }

    const recordUpload = (bytes: number, isResend: boolean): void => {
      this.uploadTelemetry.recordEvent(tickStart, bytes, isResend);
    };
    const passCtx = {
      tracker: this.deliveryTracker,
      client: ctx.client,
      multiChannel,
      viewMode,
      sliceZ,
      epochs,
      stats: this.currentUploadStats,
      recordUpload,
    } as const;

    const drainRes = runDrainPass({
      deliveries,
      targetByImage: targetLevelByImage,
      manifestByImage,
      ...passCtx,
      remaining: budget,
    });
    let remaining = drainRes.remaining;
    let budgetExhausted = drainRes.budgetExhausted;

    if (!budgetExhausted) {
      const chunkRes = runChunkResendPass({
        requestsByDataset: this.lastFilteredRequests,
        manifestByImage,
        cpuCache: ctx.cpuCache,
        ...passCtx,
        remaining,
      });
      remaining = chunkRes.remaining;
      budgetExhausted = chunkRes.budgetExhausted;
    }

    if (!budgetExhausted) {
      const proxyRes = runProxyResendPass({
        requestsByDataset: this.lastProxyRequests,
        tracker: this.deliveryTracker,
        cpuCache: ctx.cpuCache,
        client: ctx.client,
        epochs,
        stats: this.currentUploadStats,
        recordUpload,
        remaining,
      });
      remaining = proxyRes.remaining;
      budgetExhausted = proxyRes.budgetExhausted;
    }

    this.currentUploadStats.budgetExhausted = budgetExhausted;
    this.uploadTelemetry.publish(tickStart, this.currentUploadStats);

    return deliveries.length > 0 || budgetExhausted;
  }

  // Worker feedback (wired in renderLoop.start)

  handleChunksEvicted(
    memberId: string,
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
  ): void {
    this.workerFeedback.handleChunksEvicted(
      memberId, evicted, skipped, cpuCache,
    );
  }

  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
  ): void {
    this.workerFeedback.handleWantedSetDelta(missing);
  }

  // Lifecycle (dataset removal, multi-channel transitions)

  /**
   * Clear chunk-side state for a workerMemberId. Used on multi-channel
   * transitions: composite-keyed trackers from the previous mode are
   * stale and would block resends under the new key shape.
   */
  clearMember(workerMemberId: string): void {
    this.deliveryTracker.clearMember(workerMemberId);
  }

  /** Symmetric with `TickCoordinator.clearMemberResources`; both are called on dataset removal. */
  clearDataset(datasetId: string): void {
    this.deliveryTracker.clearDataset(datasetId);
    this.lastFilteredRequests.delete(datasetId);
    this.lastProxyRequests.delete(datasetId);
    this.lastViewEpochByDataset.delete(datasetId);
  }

  getTrackedMemberIds(): string[] {
    return [...this.deliveryTracker.trackedKeys()];
  }

  /** @internal Test-only accessor. */
  getProxyDeliveredKeys(): Set<string> {
    return this.deliveryTracker.getProxyDeliveredKeys();
  }

  /** Placeholder so RenderLoop teardown stays symmetric with `TickCoordinator.dispose`. */
  dispose(): void {
    // No-op: telemetry collaborators own no subscriptions today.
  }
}
