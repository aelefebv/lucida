/**
 * Uploader — owns the CPU → GPU worker hand-off.
 *
 * CpuCache now owns delivery eligibility and optimistic sent state; the
 * uploader constructs wire messages, posts them, records telemetry, and
 * handles worker-feedback parsing.
 */

import type { CpuCache, ReadyDelivery } from "../fetch/index.ts";
import type { ResidencyTier } from "../residencyTier.ts";
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
  ColdStateDeltaMessage,
  ColdStateDisplayState,
  ColdStateMessage,
  MissingChunk,
  MissingProxy,
} from "../../renderer/workerProtocol.ts";
import {
  emptyUploadTickStats,
  type UploadTickStats,
} from "./telemetry/upload.ts";
import { buildColdState, buildColdStateDelta } from "./coldState/build.ts";
import {
  buildViewHotState,
  buildViewHotStateFromMembers,
} from "./coldState/hotState.ts";
import { WorkerFeedback } from "./delivery/feedback.ts";
import {
  buildManifestByImage,
  type ManifestEntry,
} from "./delivery/manifestIndex.ts";
import {
  dispatchChunkDelivery,
  dispatchLabelChunkDelivery,
  dispatchLabelVolumeChunkDelivery,
  dispatchProxy,
} from "./delivery/dispatch.ts";
import { WorkerResourceTracker } from "./delivery/resources.ts";
import { UploadTelemetry } from "./telemetry/upload.ts";
import { ColdStateTelemetry } from "./telemetry/coldState.ts";
import { orchTelemetryActive } from "./telemetry/active.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { CountedPhaseIndex } from "../../trace/types.ts";

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
    renderRadiusView?: { detail: number; coarse: number };
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
      renderRadiusView: args.renderRadiusView,
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
   * Push a display-only update to the worker for a dataset whose geometry
   * and residency are unchanged (a contrast / gamma / colormap / opacity
   * edit). Does not touch `lastEpochs`: no cold state was rebuilt and no
   * chunk residency changed, so in-flight chunk deliveries stay stamped
   * with the epochs of the last real cold state — exactly what the worker
   * still expects.
   */
  sendColdStateDisplay(args: {
    ctx: TickContext;
    datasetId: string;
    displayStateByChannel: Record<number, ColdStateDisplayState>;
  }): void {
    args.ctx.client.coldStateDisplay({
      type: "coldStateDisplay",
      datasetId: args.datasetId,
      displayStateByChannel: args.displayStateByChannel,
    });
  }

  /**
   * Push a selection-scrub update to the worker for a dataset whose visible
   * set, geometry, LOD, matrices, and display state are unchanged — only the
   * current T and/or Z moved. The worker re-points the dataset's most recent
   * cold state at the new selection and re-ingests it, repacking the atlas
   * indirection for the new plane/timepoint without re-transmitting the
   * O(active-set) descriptor array.
   *
   * Snapshots `epochs` (like {@link sendColdState}) so a later
   * {@link deliverToWorker} stamps the freshly-fetched T/Z chunks with the
   * selection's epochs — the worker's retained cold state now expects them.
   */
  sendColdStateSelection(args: {
    ctx: TickContext;
    datasetId: string;
    currentT: number;
    currentZ: number;
    visibleRegion: VisibleRegion;
    desiredProxyKeys: Iterable<string>;
    epochs: SceneEpochs;
  }): void {
    args.ctx.client.coldStateSelection({
      type: "coldStateSelection",
      datasetId: args.datasetId,
      currentT: args.currentT,
      currentZ: args.currentZ,
      visibleRegion: args.visibleRegion,
      desiredProxyKeys: Array.from(args.desiredProxyKeys).sort(),
      epochs: args.epochs,
    });
    this.lastEpochs = args.epochs;
  }

  /**
   * Build and send a view-move cold-state delta. Snapshots `epochs` (like
   * {@link sendColdState}) so a later {@link deliverToWorker} stamps the
   * freshly-fetched chunks with the view's epochs — the worker's patched cold
   * state now expects them.
   */
  sendColdStateDelta(args: {
    ctx: TickContext;
    datasetId: string;
    activeSet: ActiveSetEntry[];
    previousActiveSet: ActiveSetEntry[];
    entities: EntitySnapshot[];
    selection: SelectionState;
    visibleRegion: VisibleRegion;
    renderRadiusView?: { detail: number; coarse: number };
    desiredProxyKeys?: Iterable<string>;
    epochs: SceneEpochs;
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
    dsSettings: DatasetSettings | undefined;
  }): ColdStateDeltaMessage {
    const msg = buildColdStateDelta({
      datasetId: args.datasetId,
      activeSet: args.activeSet,
      previousActiveSet: args.previousActiveSet,
      entities: args.entities,
      selection: args.selection,
      visibleRegion: args.visibleRegion,
      renderRadiusView: args.renderRadiusView,
      desiredProxyKeys: args.desiredProxyKeys,
      epochs: args.epochs,
      matricesByEntity: args.matricesByEntity,
      dsSettings: args.dsSettings,
    });
    args.ctx.client.coldStateDelta(msg);
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
    return this.emitViewHotState(args.ctx, args.datasetId, args.epochs, (rayHit) =>
      buildViewHotState({
        coldMsg: args.coldMsg,
        rayHit,
        epochs: args.epochs,
        datasetId: args.datasetId,
      }),
    );
  }

  /**
   * Like {@link sendViewHotStateIfAdvanced} but sourced from a member-id
   * iterable (the view-move delta path, which has no built cold-state message).
   * Same viewEpoch guard, same per-member ray-hit payload.
   */
  sendViewHotStateFromMembersIfAdvanced(args: {
    ctx: TickContext;
    datasetId: string;
    memberIds: Iterable<string>;
    epochs: SceneEpochs;
  }): boolean {
    return this.emitViewHotState(args.ctx, args.datasetId, args.epochs, (rayHit) =>
      buildViewHotStateFromMembers({
        memberIds: args.memberIds,
        rayHit,
        epochs: args.epochs,
        datasetId: args.datasetId,
      }),
    );
  }

  /** Shared viewEpoch guard + ray-pick read for both hot-state senders. */
  private emitViewHotState(
    ctx: TickContext,
    datasetId: string,
    epochs: SceneEpochs,
    build: (rayHit: [number, number, number]) => ReturnType<typeof buildViewHotState>,
  ): boolean {
    const lastView = this.lastViewEpochByDataset.get(datasetId);
    if (lastView === epochs.view) return false;
    const hit = Array.from(
      ctx.scene.ray_hit_local_image(datasetId),
    ) as [number, number, number];
    ctx.client.viewHotState(build(hit));
    this.lastViewEpochByDataset.set(datasetId, epochs.view);
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

    // Rolling-window/anomaly telemetry only aggregates while someone can
    // see it (panel open or `orch` log category on); the send loop below
    // is unaffected either way. Sampled once per tick so recordEvent and
    // publish agree within the tick.
    const telemetryActive = orchTelemetryActive();
    const recordUpload = (bytes: number, kind: "chunk" | "proxy"): void => {
      if (!telemetryActive) return;
      this.uploadTelemetry.recordEvent(tickStart, bytes, kind);
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
    if (telemetryActive) {
      this.uploadTelemetry.publish(tickStart, this.currentUploadStats);
    }

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

    // Categorical label overlays route to the r32uint label pool via a
    // distinct message. In the 2D slice view the dispatch pre-slices to one
    // Z-plane and reports the bytes actually sent (~64 KB); in the 3D volume
    // view it forwards the whole ~8 MB chunk for the first-hit surface. Both
    // report the REAL bytes sent so the per-frame budget throttles the
    // upload (one item per frame) instead of fanning every chunk out at once
    // — and labels never blank/starve because at least one always goes.
    if (meta.isLabel) {
      const label = ctx.mode === "slice"
        ? dispatchLabelChunkDelivery(ctx.client, delivery, meta, sliceZ, epochs)
        : dispatchLabelVolumeChunkDelivery(ctx.client, delivery, meta, epochs);
      if (!label) {
        this.currentUploadStats.skippedNoMeta++;
        return 0;
      }
      this.workerResources.recordMember(label.memberId);
      this.currentUploadStats.uploadedChunks++;
      traceRecorder.countPhase(CountedPhaseIndex.WorkerDispatch);
      return label.bytes;
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
    // Worker dispatch: chunk bytes handed to the GPU worker. Counted, not
    // timed — the post itself is below the platform's clock floor, and what
    // happens after it belongs to the `upload` phase.
    traceRecorder.countPhase(CountedPhaseIndex.WorkerDispatch);
    return delivery.data.byteLength;
  }

  private computeChunkTierDemand(deliveries: ReadyDelivery[]): Record<ResidencyTier, boolean> {
    return {
      detail: deliveries.some((d) => this.deliveryResidencyTier(d) === "detail"),
      coarse: deliveries.some((d) => this.deliveryResidencyTier(d) === "coarse"),
    };
  }

  private deliveryResidencyTier(delivery: ReadyDelivery): ResidencyTier | null {
    return delivery.kind === "chunk" ? delivery.residencyTier : null;
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
    datasetId: string,
    missing: Array<MissingChunk | MissingProxy>,
    cpuCache: CpuCache,
  ): void {
    this.workerFeedback.handleWantedSetDelta(datasetId, missing, cpuCache);
  }

  workerChunkResidency(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
  ): "resident" | "missing" | "unknown" {
    return this.workerFeedback.chunkResidency(datasetId, imageId, c, chunkKey);
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
