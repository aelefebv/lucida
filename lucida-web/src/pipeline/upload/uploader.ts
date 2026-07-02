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
import type { LabelOverlayView } from "../../manifestTypes.ts";
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

  /**
   * `${datasetId}:${labelIndex}` keys whose label LUT bytes have already been
   * delivered to the worker. Guards against re-sending the (large) palette on
   * every cold state; cleared for a dataset in {@link forgetDatasetLabelLuts}
   * when its worker resources are dropped so the LUT is re-sent on re-open.
   */
  private readonly sentLabelLutKeys = new Set<string>();

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
    // Effective per-label opacity, keyed by label-relative index. Read from
    // WASM here (the pure builder can't reach the scene) so a shown label's
    // blend opacity from the layer panel flows into the descriptor. Cheap: one
    // call per dataset per cold state, empty for datasets without labels.
    const labelOpacityByIndex = readLabelOpacityByIndex(args.ctx, args.datasetId);
    // For labels present in this cold state, fetch the baked LUT bytes from WASM
    // only for labels whose LUT the worker doesn't already have — the 256 KB
    // palette is sent once per (dataset,label), not every tick.
    const labelLutRgbaToSend = this.collectLabelLutsToSend(
      args.ctx,
      args.datasetId,
      args.entities,
    );
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
      labelOpacityByIndex,
      labelLutRgbaToSend,
    });
    args.ctx.client.coldState(msg);
    this.lastEpochs = args.epochs;
    return msg;
  }

  /**
   * For every label entity present in this cold state, decide whether its LUT
   * bytes must ride along. Returns a map (label-relative index → `rgba8` bytes)
   * containing only labels whose LUT the worker doesn't have cached yet; those
   * keys are marked sent so subsequent ticks omit the payload. Empty for
   * datasets with no (shown) labels.
   */
  private collectLabelLutsToSend(
    ctx: TickContext,
    datasetId: string,
    entities: EntitySnapshot[],
  ): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const e of entities) {
      if (!e.isLabel || e.labelIndex === undefined) continue;
      const key = `${datasetId}:${e.labelIndex}`;
      if (this.sentLabelLutKeys.has(key)) continue;
      const lut = readLabelLutRgba(ctx, datasetId, e.labelIndex);
      if (!lut) continue;
      out.set(e.labelIndex, lut);
      this.sentLabelLutKeys.add(key);
    }
    return out;
  }

  /**
   * Forget the sent-LUT bookkeeping for a dataset (call when its worker
   * resources are dropped) so its label LUTs are re-sent on re-open rather than
   * assumed resident in a worker that no longer has them.
   */
  forgetDatasetLabelLuts(datasetId: string): void {
    const prefix = `${datasetId}:`;
    for (const key of this.sentLabelLutKeys) {
      if (key.startsWith(prefix)) this.sentLabelLutKeys.delete(key);
    }
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

/**
 * Read the dataset's effective per-label blend opacity, keyed by
 * label-relative index, from `WasmScene::label_overlays`. Returns an empty map
 * for datasets without labels (or if the query throws / returns malformed
 * JSON — labels then fall back to fully opaque rather than breaking the tick).
 */
function readLabelOpacityByIndex(
  ctx: TickContext,
  datasetId: string,
): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const overlays = JSON.parse(
      ctx.scene.label_overlays(datasetId),
    ) as LabelOverlayView[];
    for (const o of overlays) out.set(o.index, o.opacity);
  } catch {
    // Missing/older accessor or bad JSON — no per-label opacity this tick.
  }
  return out;
}

/**
 * Fetch the baked `rgba8` LUT bytes for a label from
 * `WasmScene::label_lut(datasetId, labelIndex)`. Returns `null` when the label
 * doesn't resolve (older core, intensity index, or malformed JSON) so the
 * caller simply doesn't send a LUT — the worker then falls back to no tint
 * rather than crashing the tick.
 */
function readLabelLutRgba(
  ctx: TickContext,
  datasetId: string,
  labelIndex: number,
): number[] | null {
  try {
    const parsed = JSON.parse(ctx.scene.label_lut(datasetId, labelIndex)) as
      | { rgba: number[]; width: number }
      | null;
    if (!parsed || !Array.isArray(parsed.rgba) || parsed.rgba.length === 0) {
      return null;
    }
    return parsed.rgba;
  } catch {
    return null;
  }
}
