/**
 * Uploader — owns every upload-phase concern that the pre-refactor
 * Orchestrator god-class also carried alongside its planning role.
 *
 * After Slices 5-9 extracted the collaborators ({@link DeliveryTracker},
 * {@link WorkerFeedback}, {@link UploadTelemetry}, {@link ColdStateTelemetry},
 * pure cold-state builders, drain/resend passes, dispatch helpers), the
 * Uploader's body is composition: methods are thin wrappers wiring the
 * collaborators together. The Orchestrator drives one Uploader instance
 * per render loop and calls dedicated methods from `planAndFetch` rather
 * than passing a wide "tick bundle" struct.
 *
 * See `wiki/outputs/dechaos-upload-2026-05-15/02-boundary-scan.md` Seam A
 * (the headline split) and `wiki/decisions/0034-orchestrator-split-into-pipeline-upload.md`
 * for the design rationale.
 *
 * ## Planner → Uploader seam (Option A: dedicated methods, no bundle type)
 *
 * `Orchestrator.planAndFetch` calls:
 *   1. {@link onPlanRebuildStart} once at the top of a rebuild path — clears
 *      the tracker so the per-dataset loop sees every chunk as un-sent.
 *   2. {@link sendColdState} per dataset — builds + emits cold state; the
 *      tracker reset already happened in step 1, so this method only
 *      forwards to the worker.
 *   3. {@link sendViewHotState} per dataset (conditional on viewEpoch
 *      advancing) — builds + emits view hot state.
 *   4. {@link recordPlanForDataset} per dataset — stashes per-dataset
 *      `_lastFilteredRequests` / `_lastProxyRequests` snapshots the
 *      resend passes consume on subsequent ticks.
 *   5. {@link recordMember} per request — pre-populates wid → entityId
 *      for `handleChunksEvicted` reports that arrive before any chunk
 *      has been sent.
 *
 * The bundle-type alternative (a single `PlanTickBundle` object passed to
 * `applyTick`) was considered and rejected: each method has a focused
 * signature; widening to a struct couples evolution of the bundle to
 * every callsite. See the issue HITL discussion and Slice 10 commit
 * message for context.
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
  /**
   * Delivery state for both chunks and proxies. Owns four maps that
   * were previously scattered as orchestrator fields
   * (`deliverySentToWorker`, `deliveryRejectedByWorker`, `widToEntityId`,
   * `proxyDeliveredToWorker`). The implicit lifetime invariants
   * ("clear sent / rejected / wid on every cold-state rebuild", "proxy
   * delivery survives cold state") are encoded as method contracts on
   * the tracker. See Seam F of the dechaos boundary scan.
   */
  private readonly deliveryTracker = new DeliveryTracker();

  /**
   * Worker → main-thread feedback handlers. Owns the body of
   * `handleChunksEvicted` and `handleWantedSetDelta`; the orchestrator
   * methods are thin delegations. Constructed eagerly here (no
   * constructor wiring needed) since it only depends on
   * `this.deliveryTracker`, which is initialised above. See Seam G of
   * the dechaos boundary scan.
   */
  private readonly workerFeedback = new WorkerFeedback(this.deliveryTracker);

  /**
   * Upload telemetry. Owns the events ring buffer, the per-tick
   * aggregate ring buffer, the p50/p95 size sketch, the cumulative
   * counters, and the three sustained-anomaly detectors
   * (`upload.budget_exhausted_sustained`, `upload.resend_storm`,
   * `upload.drain_waste`). The uploader calls `recordEvent` per upload
   * (wired through the drain/resend passes) and `publish` at the end of
   * each `deliverToWorker` invocation.
   */
  readonly uploadTelemetry = new UploadTelemetry();

  /**
   * Cold-state rebuild telemetry. Owns the events ring buffer, the
   * cumulative + windowed counters, the per-epoch cause attribution,
   * the p50/p95 sample buffer, and the sustained-non-view-churn
   * detector. The orchestrator calls `recordHit` / `recordRebuild` at
   * the right sites in `planAndFetch` and reads the snapshot via
   * `publish()` when attaching to `debugStats.orch.coldState`.
   *
   * Exposed on the Uploader so the Orchestrator can wire its
   * cache-hit / rebuild events without rebuilding the import surface.
   */
  readonly coldStateTelemetry = new ColdStateTelemetry();

  /**
   * Per-dataset last filtered requests, kept for the deliverToWorker
   * resend pass on cache hits. Keyed by datasetId so multi-dataset
   * rebuilds preserve every dataset's requests (previously a flat
   * `ChunkRequest[]` was last-dataset-wins; see #613).
   */
  private readonly lastFilteredRequests = new Map<string, ChunkRequest[]>();

  /**
   * Per-dataset last proxy requests produced by `plan()`, kept for the
   * deliverToWorker proxy resend pass on cache hits. Keyed by datasetId
   * so multi-dataset rebuilds preserve every dataset's proxy requests
   * (see #613).
   */
  private readonly lastProxyRequests = new Map<string, ProxyRequest[]>();

  /**
   * Per-dataset last-emitted viewEpoch. Tracked so `viewHotState` only
   * fires when the camera-ray pick may have moved. Cleared on dataset
   * removal.
   */
  private readonly lastViewEpochByDataset = new Map<string, number>();

  /**
   * Most-recently observed epochs from the planner. Snapshotted by
   * {@link sendColdState} (also rebuilt-path entry) so `deliverToWorker`
   * can stamp outgoing chunks without re-reading WASM. Falls back to a
   * zero-epoch object when no plan has run yet.
   */
  private lastEpochs: SceneEpochs | null = null;

  /**
   * Per-tick stats for the in-progress `deliverToWorker` call. Reset
   * to zero at the start of each call; the drain/resend passes mutate
   * the skip/byte fields directly. Handed to {@link uploadTelemetry}
   * via `publish(now, stats)` at the end of the tick.
   */
  private currentUploadStats: UploadTickStats = emptyUploadTickStats();

  // ---------------------------------------------------------------------
  // Planner → Uploader seam (Option A — see file-level JSDoc)
  // ---------------------------------------------------------------------

  /**
   * Called once at the top of every cold-state rebuild path in
   * `Orchestrator.planAndFetch` (i.e. the non-cache-hit branch). Clears
   * chunk-side delivery tracking so the per-dataset loop's subsequent
   * `sendColdState` + chunk dispatch sees a fresh atlas state.
   *
   * Hoisted to once-per-tick (vs once-per-dataset) so multi-dataset
   * rebuilds don't multi-clear. The atlas state is global per worker,
   * so this single reset covers every dataset in the rebuild.
   *
   * Proxy delivery tracking is NOT cleared here: worker proxy pools
   * persist across cold-state rebuilds (created lazily, destroyed only
   * on dataset removal). Proxies are cleared per-entry via
   * `clearProxyDelivered` on wantedSetDelta.
   */
  onPlanRebuildStart(): void {
    this.deliveryTracker.onColdStateRebuild();
  }

  /**
   * Build and send a `ColdStateMessage` to the GPU worker.
   *
   * The pure build lives in `coldState/build.ts`; this wrapper forwards
   * the planner output, posts the message, snapshots `epochs` for the
   * subsequent `deliverToWorker` call, and returns the message so the
   * caller can derive a deterministic entity-index map.
   *
   * The chunk delivery tracker reset is NOT done here — it's hoisted
   * to {@link onPlanRebuildStart} once-per-tick. Calling it here would
   * multi-clear in multi-dataset rebuilds.
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
   * Build and send a viewEpoch hot-state message. The pure build lives
   * in `coldState/hotState.ts`; this wrapper collects the per-dataset
   * ray hit from the WASM scene, emits to the worker, and stamps the
   * per-dataset `lastViewEpoch` so the next tick can short-circuit if
   * the viewEpoch is unchanged.
   *
   * The message must be posted before subsequent render messages so the
   * worker's `rayHitPerEntity` is current when chunk-data eviction fires.
   *
   * Returns `true` if the message was emitted; `false` if the viewEpoch
   * was unchanged (so the orchestrator can avoid duplicate work).
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
   * `deliverToWorker` resend passes (cache-hit ticks) can find them.
   * Called once per dataset by `Orchestrator.planAndFetch` after each
   * `plan()` returns.
   *
   * Also pre-populates the tracker's wid → entityId reverse lookup so
   * a worker eviction report that arrives before any chunk has been
   * sent can still resolve `cpuCache.markRejected(entityId, ...)`.
   * Pre-Slice-10 this was inlined in the orchestrator's per-dataset
   * loop; consolidating here keeps every read/write of the per-dataset
   * upload state on the Uploader.
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

  // ---------------------------------------------------------------------
  // Per-tick upload (slicePath / volumePath)
  // ---------------------------------------------------------------------

  /**
   * Deliver decoded chunks to the GPU worker via RenderClient. Called
   * from slicePath/volumePath.
   *
   * Composition of three extracted passes (see `delivery/`):
   *
   * - {@link runDrainPass} — iterate `cpuCache.drain(budget)` output and
   *   dispatch chunks / proxies that pass `classifyDelivery`.
   * - {@link runChunkResendPass} — re-send chunks the worker evicted or
   *   never received, sourced from `lastFilteredRequests`.
   * - {@link runProxyResendPass} — same shape for proxies, sourced from
   *   `lastProxyRequests`.
   *
   * Each pass owns its own counter writes (skips + uploads) onto the
   * shared `currentUploadStats`. The per-tick manifest index built by
   * `buildManifestByImage` eliminates the O(D × I) per-chunk scan the
   * old `sendDeliveryToWorker` did.
   *
   * Returns `true` if work remains (the caller should schedule another
   * tick): either the drain queue produced deliveries OR the byte budget
   * was exhausted.
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

    // Build per-tick lookup tables: target LOD by image (drives the
    // drain pass's wrongLod filter) and the per-image manifest index
    // (eliminates the per-chunk dataset scan during dispatch).
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

  // ---------------------------------------------------------------------
  // Worker feedback (wired in renderLoop.start)
  // ---------------------------------------------------------------------

  /**
   * Process a worker `chunksEvicted` report. Delegates to
   * {@link WorkerFeedback.handleChunksEvicted} — see that method for
   * the full eviction-vs-skipped semantics.
   */
  handleChunksEvicted(
    workerMemberId: string,
    evicted: string[],
    skipped: string[],
    cpuCache: CpuCache,
  ): void {
    this.workerFeedback.handleChunksEvicted(
      workerMemberId, evicted, skipped, cpuCache,
    );
  }

  /**
   * Process a wanted-set delta from the GPU worker. Delegates to
   * {@link WorkerFeedback.handleWantedSetDelta} — only the proxy
   * branch is meaningful (chunk entries are intentionally ignored
   * post-Slice 3).
   */
  handleWantedSetDelta(
    missing: Array<MissingChunk | MissingProxy>,
  ): void {
    this.workerFeedback.handleWantedSetDelta(missing);
  }

  // ---------------------------------------------------------------------
  // Lifecycle (dataset removal, multi-channel transitions)
  // ---------------------------------------------------------------------

  /**
   * Clear all chunk-side delivery state for a single workerMemberId
   * (typically used during multi-channel transitions: composite-keyed
   * trackers from the previous mode are stale and would block resends
   * under the new key shape).
   */
  clearMember(workerMemberId: string): void {
    this.deliveryTracker.clearMember(workerMemberId);
  }

  /**
   * Clear per-dataset upload state on dataset removal. Drops the
   * per-dataset `lastFilteredRequests` / `lastProxyRequests` /
   * `lastViewEpochByDataset` entries and best-effort prefix-deletes
   * the proxy-delivered set for keys starting with `${datasetId}|`.
   *
   * Symmetric with `Orchestrator.clearMemberResources` — both methods
   * accept the same id (a datasetId in the dataset-removal path) and
   * each cleans up its half of the state. The `RenderLoop` calls both
   * during dataset removal.
   */
  clearDataset(datasetId: string): void {
    this.deliveryTracker.clearDataset(datasetId);
    this.lastFilteredRequests.delete(datasetId);
    this.lastProxyRequests.delete(datasetId);
    this.lastViewEpochByDataset.delete(datasetId);
  }

  /**
   * Iterator over every tracked workerMemberId. Used by
   * {@link RenderLoop.collectMemberIds} and the multi-channel
   * transition cleanup path.
   */
  getTrackedMemberIds(): string[] {
    return [...this.deliveryTracker.trackedKeys()];
  }

  /**
   * Test-only accessor for the proxy-delivered tracking set. Used by
   * `uploader.test.ts` to assert the cache-hit short-circuit no longer
   * re-uploads cached proxies.
   *
   * @internal
   */
  getProxyDeliveredKeys(): Set<string> {
    return this.deliveryTracker.getProxyDeliveredKeys();
  }

  /**
   * Tear down any resources the Uploader holds. Today this is a no-op
   * (telemetry collaborators own no subscriptions, and the tracker is
   * pure in-memory state) — left as a placeholder so the RenderLoop
   * teardown story stays symmetric with `Orchestrator.dispose`.
   */
  dispose(): void {
    // No-op for now. If telemetry collaborators ever acquire
    // subscriptions (timers, event listeners), unsubscribe here.
  }
}
