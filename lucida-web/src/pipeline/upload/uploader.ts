/**
 * Owns the CPU-to-GPU worker hand-off: builds wire messages, posts them,
 * records telemetry, and applies worker feedback. CpuCache decides delivery
 * eligibility and keeps the mirror of what the worker holds.
 */

import type { CpuCache, FailedChunk, ReadyChunkDelivery } from "../fetch/index.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import type {
  ActiveSetEntry,
  ChunkRequest,
  EntitySnapshot,
  SelectionState,
} from "../planning/index.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { TickContext } from "../../renderLoopTypes.ts";
import type { ResolvedLayer } from "../../resolvedLayers.ts";
import type {
  ChunkFeedbackReason,
  ChunkResidencyChange,
  ColdStateDeltaMessage,
  ColdStateDisplayState,
  ColdStateMessage,
  MissingChunk,
} from "../../renderer/workerProtocol.ts";
import {
  emptyUploadTickStats,
  type UploadTickStats,
} from "./telemetry/upload.ts";
import { buildColdState, buildColdStateDelta } from "./coldState/build.ts";
import {
  diffWantedChunks,
  wantedChunksFromPlan,
  type WantedChunksByMember,
} from "./coldState/wanted.ts";
import {
  buildViewHotState,
  buildViewHotStateFromMembers,
} from "./coldState/hotState.ts";
import { WorkerFeedback } from "./delivery/feedback.ts";
import { ResendGuard, type HeldChunk } from "./delivery/resendGuard.ts";
import {
  buildManifestByImage,
  type ManifestEntry,
} from "./delivery/manifestIndex.ts";
import {
  dispatchChunkDelivery,
  dispatchLabelChunkDelivery,
  dispatchLabelVolumeChunkDelivery,
  type Dispatched,
} from "./delivery/dispatch.ts";
import { WorkerResourceTracker } from "./delivery/resources.ts";
import { UploadTelemetry } from "./telemetry/upload.ts";
import { ColdStateTelemetry } from "./telemetry/coldState.ts";
import { orchTelemetryActive } from "./telemetry/active.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { CountedPhaseIndex, PointEvent } from "../../trace/types.ts";
import { debugLog } from "../../debug/logging.ts";
import { datasetSampleFormat } from "../../renderer/dataTypeUtil.ts";

export class Uploader {
  private readonly resendGuard = new ResendGuard();
  private readonly workerFeedback = new WorkerFeedback(this.resendGuard);
  private readonly workerResources = new WorkerResourceTracker();

  readonly uploadTelemetry = new UploadTelemetry();

  /** Exposed so `TickCoordinator` can wire cache-hit / rebuild events. */
  readonly coldStateTelemetry = new ColdStateTelemetry();

  private readonly lastViewEpochByDataset = new Map<string, number>();

  /** The wanted chunks each dataset's last cold state carried, which a delta diffs against. */
  private readonly wantedByDataset = new Map<string, WantedChunksByMember>();

  /** The cache's failure version the worker last heard about. */
  private failedVersionSent = 0;
  /** Each dataset's failed chunks as last sent, `imageId\nchunkKey` sorted and joined. */
  private failedSent = new Map<string, string>();

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
    /** The plan's requests; its detail and coarse lanes become the wanted chunks. */
    requests: readonly ChunkRequest[];
    entities: EntitySnapshot[];
    selection: SelectionState;
    visibleRegion: VisibleRegion;
    renderRadiusView?: { detail: number; coarse: number };
    epochs: SceneEpochs;
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
    layer: ResolvedLayer | undefined;
  }): ColdStateMessage {
    const wanted = wantedChunksFromPlan(args.requests);
    this.wantedByDataset.set(args.datasetId, wanted);
    const msg = buildColdState({
      datasetId: args.datasetId,
      activeSet: args.activeSet,
      entities: args.entities,
      selection: args.selection,
      visibleRegion: args.visibleRegion,
      renderRadiusView: args.renderRadiusView,
      wantedChunks: [...wanted.values()],
      epochs: args.epochs,
      matricesByEntity: args.matricesByEntity,
      layer: args.layer,
      sampleFormat: datasetSampleFormat(args.ctx.datasets.get(args.datasetId)?.manifest),
    });
    args.ctx.client.coldState(msg);
    this.lastEpochs = args.epochs;
    this.resendGuard.onRebuild();
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
   * Push a selection-scrub update for a dataset where only T and/or Z moved.
   * The worker re-points its latest cold state at the new selection and
   * re-ingests it, so the O(active-set) descriptor array is not re-sent.
   * Snapshots `epochs` so a later {@link deliverToWorker} stamps the newly
   * fetched T/Z chunks with the epochs the worker now expects.
   */
  sendColdStateSelection(args: {
    ctx: TickContext;
    datasetId: string;
    currentT: number;
    currentZ: number;
    /** The re-emitted plan's requests; see {@link sendColdState}. */
    requests: readonly ChunkRequest[];
    visibleRegion: VisibleRegion;
    epochs: SceneEpochs;
  }): void {
    const wanted = wantedChunksFromPlan(args.requests);
    this.wantedByDataset.set(args.datasetId, wanted);
    args.ctx.client.coldStateSelection({
      type: "coldStateSelection",
      datasetId: args.datasetId,
      currentT: args.currentT,
      currentZ: args.currentZ,
      visibleRegion: args.visibleRegion,
      wantedChunks: [...wanted.values()],
      epochs: args.epochs,
    });
    this.lastEpochs = args.epochs;
    this.resendGuard.onRebuild();
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
    /** The plan's requests; see {@link sendColdState}. */
    requests: readonly ChunkRequest[];
    entities: EntitySnapshot[];
    selection: SelectionState;
    visibleRegion: VisibleRegion;
    renderRadiusView?: { detail: number; coarse: number };
    epochs: SceneEpochs;
    matricesByEntity: Map<string, { model: Float32Array; inv: Float32Array }>;
    layer: ResolvedLayer | undefined;
  }): ColdStateDeltaMessage {
    const wanted = wantedChunksFromPlan(args.requests);
    const wantedChanges = diffWantedChunks(this.wantedByDataset.get(args.datasetId) ?? new Map(), wanted);
    this.wantedByDataset.set(args.datasetId, wanted);
    const msg = buildColdStateDelta({
      datasetId: args.datasetId,
      activeSet: args.activeSet,
      previousActiveSet: args.previousActiveSet,
      entities: args.entities,
      selection: args.selection,
      visibleRegion: args.visibleRegion,
      renderRadiusView: args.renderRadiusView,
      wantedChunks: wantedChanges,
      epochs: args.epochs,
      matricesByEntity: args.matricesByEntity,
      layer: args.layer,
    });
    args.ctx.client.coldStateDelta(msg);
    this.lastEpochs = args.epochs;
    this.resendGuard.onRebuild();
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

  /**
   * Tell the worker each dataset's chunks the source failed for good, when
   * they changed, so the next frame draws them hatched. Runs before the
   * tick's render message, which the worker handles after this. Returns the
   * failures when they changed, else null.
   */
  syncFailedChunks(ctx: TickContext): FailedChunk[] | null {
    const version = ctx.cpuCache.failedChunksVersion();
    if (version === this.failedVersionSent) return null;
    this.failedVersionSent = version;
    const failed = ctx.cpuCache.failedChunks();
    const byDataset = new Map<string, Map<string, string[]>>();
    for (const { datasetId, imageId, chunkKey } of failed) {
      let byImage = byDataset.get(datasetId);
      if (!byImage) {
        byImage = new Map();
        byDataset.set(datasetId, byImage);
      }
      const keys = byImage.get(imageId);
      if (keys) keys.push(chunkKey);
      else byImage.set(imageId, [chunkKey]);
    }
    for (const datasetId of new Set([...byDataset.keys(), ...this.failedSent.keys()])) {
      const images = [...(byDataset.get(datasetId) ?? [])].map(([imageId, chunkKeys]) => ({ imageId, chunkKeys }));
      const signature = images
        .flatMap(({ imageId, chunkKeys }) => chunkKeys.map((key) => `${imageId}\n${key}`))
        .sort()
        .join("\n");
      if (signature === (this.failedSent.get(datasetId) ?? "")) continue;
      ctx.client.failedChunks({ type: "failedChunks", datasetId, images });
      if (images.length > 0) this.failedSent.set(datasetId, signature);
      else this.failedSent.delete(datasetId);
    }
    return failed;
  }

  // Per-tick upload (slicePath / volumePath)

  /**
   * Deliver cached, wanted, not-yet-sent chunks to the GPU worker in
   * strict priority order. Budget is a one-item soft cap: the next
   * priority item is sent while `remaining > 0`, even if oversized, and
   * the loop stops after the send drives `remaining <= 0`.
   *
   * `sliceZFor` names the plane each dataset's slice view shows, which is the
   * scene's z clamped into that dataset; `null` in the volume view.
   */
  deliverToWorker(
    ctx: TickContext,
    budget: number,
    sliceZFor: ((datasetId: string) => number) | null,
  ): boolean {
    const tickStart = performance.now();
    this.currentUploadStats = emptyUploadTickStats();
    this.currentUploadStats.bytesBudget = budget;

    const epochs = this.lastEpochs ?? {
      content: 0, layout: 0, view: 0, selection: 0, request: 0,
    };
    const manifestByImage = buildManifestByImage(ctx.datasets);

    // Rolling-window/anomaly telemetry only aggregates while someone can
    // see it (panel open or `orch` log category on); the send loop below
    // is unaffected either way. Sampled once per tick so recordEvent and
    // publish agree within the tick.
    const telemetryActive = orchTelemetryActive();
    const recordUpload = (bytes: number): void => {
      if (!telemetryActive) return;
      this.uploadTelemetry.recordEvent(tickStart, bytes);
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
      if (this.resendGuard.isHeld(delivery)) continue;
      if (remaining <= 0) {
        budgetExhausted = true;
        break;
      }

      const chunkTier = delivery.residencyTier;
      if (splitTierBudget && chunkTier === "detail" && detailRemaining <= 0) {
        budgetExhausted = true;
        continue;
      }
      if (splitTierBudget && chunkTier === "coarse" && coarseRemaining <= 0) {
        budgetExhausted = true;
        continue;
      }

      this.currentUploadStats.drainedChunks++;

      const sent = this.tryDispatchDelivery({
        delivery,
        ctx,
        manifestByImage,
        sliceZFor,
        epochs,
      });
      if (sent === 0) continue;

      ctx.cpuCache.markSent(delivery);
      this.resendGuard.noteSent(delivery);
      sentAny = true;
      this.currentUploadStats.bytesUploaded += sent;
      recordUpload(sent);
      remaining -= sent;
      if (splitTierBudget && chunkTier === "detail") detailRemaining -= sent;
      if (splitTierBudget && chunkTier === "coarse") coarseRemaining -= sent;
      if (remaining <= 0) budgetExhausted = true;
    }

    this.currentUploadStats.budgetExhausted = budgetExhausted;
    if (telemetryActive) {
      this.uploadTelemetry.publish(tickStart, this.currentUploadStats);
    }
    this.recordHeld(this.resendGuard.endTick());

    return sentAny || budgetExhausted;
  }

  /** One trace event per chunk the guard stopped re-sending, so the run names the loop it cut. */
  private recordHeld(held: HeldChunk[]): void {
    if (held.length === 0) return;
    for (const { delivery, reason } of held) {
      traceRecorder.recordPointEvent(
        PointEvent.Held, reason, delivery, delivery.residencyTier === "coarse" ? 1 : 0,
      );
    }
    debugLog("orch", "upload.resend_held", {
      chunks: held.map(({ delivery, reason }) => `${delivery.imageId}/${delivery.chunkKey} (${reason})`),
    });
  }

  private tryDispatchDelivery(args: {
    delivery: ReadyChunkDelivery;
    ctx: TickContext;
    manifestByImage: Map<string, ManifestEntry>;
    sliceZFor: ((datasetId: string) => number) | null;
    epochs: SceneEpochs;
  }): number {
    const { delivery, ctx, manifestByImage, sliceZFor, epochs } = args;

    const meta = manifestByImage.get(delivery.imageId);
    if (!meta || !meta.levels[delivery.level]) {
      this.currentUploadStats.skippedNoMeta++;
      return 0;
    }
    const sliceZ = sliceZFor ? sliceZFor(meta.datasetId) : null;

    // Label overlays go to the r32uint label pool. The slice view sends one
    // Z-plane of each chunk and the volume view the whole chunk. Every
    // dispatch reports the real bytes sent so the frame budget throttles
    // uploads, and at least one always goes so labels never starve.
    let sent: Dispatched | null;
    if (meta.isLabel) {
      sent = ctx.mode === "slice"
        ? dispatchLabelChunkDelivery(ctx.client, delivery, meta, sliceZ, epochs)
        : dispatchLabelVolumeChunkDelivery(ctx.client, delivery, meta, epochs);
    } else {
      sent = dispatchChunkDelivery(ctx.client, delivery, meta, ctx.mode, sliceZ, epochs);
    }
    if (!sent) {
      this.currentUploadStats.skippedNoMeta++;
      return 0;
    }
    this.workerResources.recordMember(sent.memberId);
    this.currentUploadStats.uploadedChunks++;
    // Worker dispatch: chunk bytes handed to the GPU worker. Counted, not
    // timed — the post itself is below the platform's clock floor, and what
    // happens after it belongs to the `upload` phase.
    traceRecorder.countPhase(CountedPhaseIndex.WorkerDispatch);
    return sent.bytes;
  }

  private computeChunkTierDemand(deliveries: ReadyChunkDelivery[]): Record<ResidencyTier, boolean> {
    return {
      detail: deliveries.some((d) => d.residencyTier === "detail"),
      coarse: deliveries.some((d) => d.residencyTier === "coarse"),
    };
  }

  // Worker feedback (wired in renderLoop.start)

  /** Returns whether a chunk may now be sent again. */
  handleChunkResidency(
    memberId: string,
    tier: ResidencyTier,
    change: ChunkResidencyChange,
    keys: string[],
    cpuCache: CpuCache,
    reason?: ChunkFeedbackReason,
  ): boolean {
    return this.workerFeedback.handleChunkResidency(memberId, tier, change, keys, cpuCache, reason);
  }

  /** Returns whether a chunk may now be sent again. */
  handleWantedSetDelta(
    datasetId: string,
    missing: MissingChunk[],
    cpuCache: CpuCache,
  ): boolean {
    return this.workerFeedback.handleWantedSetDelta(datasetId, missing, cpuCache);
  }

  /** The worker rebuilt its pools empty on a new GPU device: send everything again, held chunks too. */
  handleDeviceRestored(cpuCache: CpuCache): void {
    cpuCache.forgetDelivered();
    this.resendGuard.onRebuild();
  }

  // Lifecycle (dataset removal)

  clearMember(workerMemberId: string): void {
    this.workerResources.clearMember(workerMemberId);
  }

  /** Symmetric with `TickCoordinator.clearMemberResources`; both are called on dataset removal. */
  clearDataset(datasetId: string): void {
    this.workerResources.clearDataset(datasetId);
    this.lastViewEpochByDataset.delete(datasetId);
    this.wantedByDataset.delete(datasetId);
    // The worker dropped its list with the dataset, so a reopen sends it again.
    this.failedSent.delete(datasetId);
  }

  getTrackedResourceMemberIds(): string[] {
    return this.workerResources.trackedMemberIds();
  }

  /** Placeholder so RenderLoop teardown stays symmetric with `TickCoordinator.dispose`. */
  dispose(): void {
    // No-op: telemetry collaborators own no subscriptions today.
  }
}
