/**
 * Uploader — owns the CPU → GPU worker hand-off.
 *
 * CpuCache now owns delivery eligibility and optimistic sent state; the
 * uploader constructs wire messages, posts them, records telemetry, and
 * handles worker-feedback parsing.
 */

import type { CpuCache, ReadyDelivery, ResidencyTier } from "../fetch/index.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
  SelectionState,
} from "../planning/index.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { TickContext } from "../../renderLoopTypes.ts";
import type { DatasetSettings } from "../../tickCommon.ts";
import type {
  ChunkFeedbackReason,
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
import { WorkerFeedback } from "./delivery/feedback.ts";
import {
  buildManifestByImage,
  type ManifestEntry,
} from "./delivery/manifestIndex.ts";
import {
  dispatchChunkDelivery,
  dispatchProxy,
} from "./delivery/dispatch.ts";
import { WorkerResourceTracker } from "./delivery/resources.ts";
import { UploadTelemetry } from "./telemetry/upload.ts";
import { ColdStateTelemetry } from "./telemetry/coldState.ts";

export class Uploader {
  private readonly workerFeedback = new WorkerFeedback();
  private readonly workerResources = new WorkerResourceTracker();

  readonly uploadTelemetry = new UploadTelemetry();

  /** Exposed so `TickCoordinator` can wire cache-hit / rebuild events. */
  readonly coldStateTelemetry = new ColdStateTelemetry();

  private readonly lastViewEpochByDataset = new Map<string, number>();

  /** Snapshotted by `sendColdState` so `deliverToWorker` can stamp chunks. */
  private lastEpochs: SceneEpochs | null = null;

  /** Reset at the start of each `deliverToWorker`; mutated by the send loop. */
  private currentUploadStats: UploadTickStats = emptyUploadTickStats();

  // Planner → Uploader seam

  /**
   * Build and send a `ColdStateMessage` to the GPU worker. Snapshots
   * `epochs` so a later `deliverToWorker` can stamp chunks without re-
   * reading WASM.
   */
  sendColdState(args: {
    ctx: TickContext;
    datasetId: string;
    activeSet: ActiveSetEntry[];
    entities: EntitySnapshot[];
    selection: SelectionState;
    multiChannel: boolean;
    visibleRegion: VisibleRegion;
    desiredProxyKeys?: Iterable<string>;
    epochs: SceneEpochs;
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
    dsSettings: DatasetSettings | undefined;
  }): ColdStateMessage {
    const msg = buildColdState({
      datasetId: args.datasetId,
      activeSet: args.activeSet,
      entities: args.entities,
      selection: args.selection,
      multiChannel: args.multiChannel,
      visibleRegion: args.visibleRegion,
      desiredProxyKeys: args.desiredProxyKeys,
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

  // Per-tick upload (slicePath / volumePath)

  /**
   * Deliver cached, wanted, not-yet-sent assets to the GPU worker in
   * strict priority order. Budget is a one-item soft cap: the next
   * priority item is sent while `remaining > 0`, even if oversized, and
   * the loop stops after the send drives `remaining <= 0`.
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
    const manifestByImage = buildManifestByImage(ctx.datasets);

    const recordUpload = (bytes: number, kind: "chunk" | "proxy"): void => {
      this.uploadTelemetry.recordEvent(tickStart, bytes, false, kind);
    };

    const deliverables = Array.from(ctx.cpuCache.getDeliverable());
    const tierDemand = this.computeChunkTierDemand(deliverables);
    const splitTierBudget = tierDemand.detail && tierDemand.coarse;
    let detailRemaining = splitTierBudget ? Math.ceil(budget / 2) : budget;
    let coarseRemaining = splitTierBudget ? Math.floor(budget / 2) : budget;
    let remaining = budget;
    let budgetExhausted = false;
    let sentAny = false;

    for (const delivery of deliverables) {
      if (remaining <= 0) {
        budgetExhausted = true;
        break;
      }

      const chunkTier = this.deliveryResidencyTier(delivery);
      if (splitTierBudget && chunkTier === "detail" && detailRemaining <= 0) {
        budgetExhausted = true;
        continue;
      }
      if (splitTierBudget && chunkTier === "coarse" && coarseRemaining <= 0) {
        budgetExhausted = true;
        continue;
      }

      if (delivery.kind === "proxy") this.currentUploadStats.drainedProxies++;
      else this.currentUploadStats.drainedChunks++;

      const sent = this.tryDispatchDelivery({
        delivery,
        ctx,
        manifestByImage,
        multiChannel,
        sliceZ,
        epochs,
      });
      if (sent === 0) continue;

      ctx.cpuCache.markSent(delivery);
      sentAny = true;
      this.currentUploadStats.bytesUploaded += sent;
      recordUpload(sent, delivery.kind);
      remaining -= sent;
      if (splitTierBudget && chunkTier === "detail") detailRemaining -= sent;
      if (splitTierBudget && chunkTier === "coarse") coarseRemaining -= sent;
      if (remaining <= 0) budgetExhausted = true;
    }

    this.currentUploadStats.budgetExhausted = budgetExhausted;
    this.uploadTelemetry.publish(tickStart, this.currentUploadStats);

    return sentAny || budgetExhausted;
  }

  private tryDispatchDelivery(args: {
    delivery: ReadyDelivery;
    ctx: TickContext;
    manifestByImage: Map<string, ManifestEntry>;
    multiChannel: boolean;
    sliceZ: number | null;
    epochs: SceneEpochs;
  }): number {
    const { delivery, ctx, manifestByImage, multiChannel, sliceZ, epochs } = args;

    if (delivery.kind === "proxy") {
      dispatchProxy(ctx.client, delivery, epochs);
      this.currentUploadStats.uploadedProxies++;
      return delivery.data.byteLength;
    }

    const meta = manifestByImage.get(delivery.imageId);
    if (!meta || !meta.levels[delivery.level]) {
      this.currentUploadStats.skippedNoMeta++;
      return 0;
    }

    const memberId = dispatchChunkDelivery(
      ctx.client,
      delivery,
      meta,
      ctx.mode,
      multiChannel,
      sliceZ,
      epochs,
    );
    this.workerResources.recordMember(memberId);
    this.currentUploadStats.uploadedChunks++;
    return delivery.data.byteLength;
  }

  private computeChunkTierDemand(deliveries: ReadyDelivery[]): Record<ResidencyTier, boolean> {
    return {
      detail: deliveries.some((d) => this.deliveryResidencyTier(d) === "detail"),
      coarse: deliveries.some((d) => this.deliveryResidencyTier(d) === "coarse"),
    };
  }

  private deliveryResidencyTier(delivery: ReadyDelivery): ResidencyTier | null {
    if (delivery.kind !== "chunk") return null;
    return delivery.residencyTier ??
      (delivery.lane === "coarse" || delivery.lane === "overview" || delivery.lane === "minimap"
        ? "coarse"
        : "detail");
  }

  // Worker feedback (wired in renderLoop.start)

  handleChunksEvicted(
    memberId: string,
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
    reason?: ChunkFeedbackReason,
  ): void {
    this.workerFeedback.handleChunksEvicted(
      memberId, evicted, skipped, cpuCache, reason,
    );
  }

  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
    cpuCache: CpuCache,
  ): void {
    this.workerFeedback.handleWantedSetDelta(missing, cpuCache);
  }

  // Lifecycle (dataset removal, multi-channel transitions)

  clearMember(workerMemberId: string): void {
    this.workerResources.clearMember(workerMemberId);
  }

  /** Symmetric with `TickCoordinator.clearMemberResources`; both are called on dataset removal. */
  clearDataset(datasetId: string): void {
    this.workerResources.clearDataset(datasetId);
    this.lastViewEpochByDataset.delete(datasetId);
  }

  getTrackedResourceMemberIds(): string[] {
    return this.workerResources.trackedMemberIds();
  }

  /** Placeholder so RenderLoop teardown stays symmetric with `TickCoordinator.dispose`. */
  dispose(): void {
    // No-op: telemetry collaborators own no subscriptions today.
  }
}
