/**
 * A deterministic simulation of the viewer's pipeline loop, for vitest with
 * no browser or GPU. The render loop, tick coordinator, planner, CPU cache,
 * scheduler and uploader are the production modules, on a real wasm scene.
 * The server is {@link SimulatedSource}, the render worker is
 * {@link SimulatedWorker}, and time is vitest's fake clock, stepped one frame
 * at a time.
 *
 * {@link describeScenario} states a view and what happens to it;
 * {@link runScenario} runs it to a fixed point at one device pixel ratio.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate as realSetImmediate } from "node:timers";
import { vi } from "vitest";
import initWasm, { WasmScene } from "lucida-core";

import { RenderLoop } from "../../renderLoop.ts";
import { RenderClient } from "../../renderer/renderClient.ts";
import type { Session } from "../../session.ts";
import type { DatasetManifest } from "../../manifestTypes.ts";
import { applyViewportCommand } from "../../applyAndSend.ts";
import { bumpSettingsGeneration } from "../../tickCommon.ts";
import { AVAILABILITY_UPDATE_SOURCE } from "../../invalidation.ts";
import { traceRecorder } from "../../trace/recorder.ts";
import { PointEvent } from "../../trace/types.ts";
import { createSettleState, settleSignal } from "../settle.ts";
import { CEILING_BUDGETS } from "../../deviceBudget.ts";
import type { ChannelFit } from "../autoContrast.ts";
import {
  GeneratedAvailabilityCatalog,
  type WireGeneratedAvailabilityDelta,
} from "../generatedAvailability.ts";
import { CpuCache, type CpuCacheConfig } from "../fetch/index.ts";
import type { DatasetFixture } from "./fixtures.ts";
import {
  passThroughDecodePool,
  SimulatedSource,
  type SourceAnswer,
  type SourceRequest,
  type SourceSpec,
} from "./source.ts";
import { deliveryKey, GPU_USAGE_GLOBALS, SimulatedWorker, type ChunkDeliveries } from "./worker.ts";
import type { ResidencyTier } from "../residencyTier.ts";
import { workerMemberId } from "../upload/delivery/dispatch.ts";

/** One step of the simulation clock: a frame at 60 Hz. */
export const FRAME_MS = 16;

/**
 * How long a fixed point must hold before a phase counts as settled. Longer
 * than any timer a quiet view can still have armed (the in-fetch retry, the
 * first failure backoffs, a scenario's availability update), so a view that
 * would wake again does so inside the window.
 */
export const QUIET_MS = 3_000;

/** Steps a phase may take to reach its fixed point, unless the scenario says otherwise. */
export const DEFAULT_TICK_BOUND = 400;

/** Canvas size in CSS pixels, unless the scenario says otherwise. */
const DEFAULT_VIEWPORT: readonly [number, number] = [640, 400];

/** Keys listed per section of a report; the rest are counted. */
const REPORT_KEY_LIMIT = 12;

/**
 * Sends of one chunk within a phase from which the report lists it. Once
 * is the norm, and a rebuild can legitimately send it a second time.
 */
const RESENT_THRESHOLD = 3;

export type ScenarioStep =
  | { scrub: { z?: number; t?: number } }
  /** A drag, in device pixels; an arcball pan in a volume. */
  | { pan: [dx: number, dy: number] }
  /** A zoom by a factor about the view center; an arcball zoom in a volume. */
  | { zoom: number }
  /** A 3-D orbit, in radians. */
  | { orbit: [dTheta: number, dPhi: number] };

export interface ScenarioSpec {
  name: string;
  dataset: DatasetFixture;
  mode?: "slice" | "volume";
  /** Canvas size in CSS pixels. */
  viewport?: [number, number];
  source?: SourceSpec;
  /**
   * The worker's GPU total, which every chunk pool shares. Pools grow toward
   * it as chunks arrive, so a small total bounds them.
   */
  gpuTotalBytes?: number;
  cache?: Partial<Pick<CpuCacheConfig, "mainBudgetBytes" | "overviewBudgetBytes">>;
  /** What happens after the open, each followed by its own settle. */
  steps?: ScenarioStep[];
  tickBound?: number;
  /**
   * Whether settling also requires every chunk the worker wants to be on the
   * GPU. Off for views that want more than the atlas holds.
   */
  gpuComplete?: boolean;
}

export interface Scenario {
  readonly name: string;
  readonly dataset: DatasetFixture;
  readonly mode: "slice" | "volume";
  readonly viewport: readonly [number, number];
  readonly source: SourceSpec;
  readonly gpuTotalBytes: number;
  readonly cache: Partial<CpuCacheConfig>;
  readonly steps: readonly ScenarioStep[];
  readonly tickBound: number;
  readonly gpuComplete: boolean;
}

/** State a scenario, filling in the defaults every run uses. */
export function describeScenario(spec: ScenarioSpec): Scenario {
  return Object.freeze({
    name: spec.name,
    dataset: spec.dataset,
    mode: spec.mode ?? "slice",
    viewport: spec.viewport ?? DEFAULT_VIEWPORT,
    source: spec.source ?? {},
    gpuTotalBytes: spec.gpuTotalBytes ?? CEILING_BUDGETS.gpuTotalBytes,
    cache: { ...spec.cache },
    steps: spec.steps ?? [],
    tickBound: spec.tickBound ?? DEFAULT_TICK_BOUND,
    gpuComplete: spec.gpuComplete ?? true,
  });
}

/** An auto-contrast fit the render loop handed out. */
export interface ContrastFitRecord {
  datasetId: string;
  channel: number;
  fit: ChannelFit;
}

/** One residency tier's wanted-and-resident count in the CPU cache. */
interface TierCount {
  resident: number;
  desired: number;
}

export interface PhaseOutcome {
  label: string;
  settled: boolean;
  /** Steps to the fixed point, or the steps taken when there was none. */
  ticks: number;
  /** "settled", or the first condition that was not met. */
  why: string;
  /** Frames the render loop ran in this phase. */
  frames: number;
  /** Chunks the page sent the worker in this phase, a chunk resident in both tiers once per tier. */
  chunksSent: number;
  /** Distinct chunks among them; equal to `chunksSent` when none went twice. */
  distinctChunksSent: number;
  /** The bytes of chunk data the page sent the worker in this phase. */
  bytesSent: number;
  quiescence: string;
  /** The share of the wanted set the page says is resident. */
  coverage: number;
  detail: TierCount;
  coarse: TierCount;
  queued: number;
  inFlight: number;
  /** Chunks the last plan wants, outside prefetch, that the CPU cache does not hold. */
  missingCpu: string[];
  /** Chunks the worker wants that are not on the GPU. */
  missingGpu: string[];
  /** Chunks the page sent the worker again and again in this phase, most often first. */
  resent: string[];
  /** Chunk requests the source has answered since the open. */
  sourceRequests: number;
  /**
   * Chunks the uploader's progress guard held in this phase, with the
   * worker's last reason. A held chunk means a feedback loop was cut, so the
   * phase does not count as settled.
   */
  held: string[];
  /**
   * Wanted chunks the source failed for good, each with the reason it gave.
   * A view settles without them, and this is how the run names them.
   */
  failed: string[];
  /** The worker's indirection cells the shader draws as failed (see `SimulatedWorker.failedCells`). */
  drawnFailed: string[];
  /**
   * Label cells drawing another plane than the view's (see
   * `SimulatedWorker.staleLabelCells`). A phase that ends with one has not
   * settled: the screen shows a plane as one it isn't.
   */
  staleLabelCells: string[];
  /** The auto-contrast fits handed out in this phase, in order. */
  fits: ContrastFitRecord[];
}

export interface SimulationRun {
  scenario: string;
  dpr: number;
  phases: PhaseOutcome[];
  settled: boolean;
  /** `${imageId}/${chunkKey}` of each chunk the source served, in order. */
  served: string[];
  /** Why the run did or did not settle, for a failure message. */
  report: string;
}

/** Load the wasm core the scene runs on. Call once per test file, from `beforeAll`. */
export async function initSimulationWasm(): Promise<void> {
  // vitest runs from `lucida-web`; the wasm-bindgen web target takes the bytes.
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
}

/** Run a scenario at one device pixel ratio, phase by phase, until one fails to settle. */
export async function runScenario(scenario: Scenario, opts: { dpr: number }): Promise<SimulationRun> {
  const sim = new Simulation(scenario, opts.dpr);
  try {
    const phases: PhaseOutcome[] = [];
    sim.open();
    phases.push(await sim.settle("open"));
    for (const step of scenario.steps) {
      if (!phases[phases.length - 1].settled) break;
      phases.push(await sim.settle(sim.apply(step)));
    }
    const settled = phases.every((p) => p.settled) && phases.length === scenario.steps.length + 1;
    return {
      scenario: scenario.name,
      dpr: opts.dpr,
      phases,
      settled,
      served: sim.served(),
      report: formatReport(scenario.name, opts.dpr, phases),
    };
  } finally {
    sim.dispose();
  }
}

/** Fail with the run's report unless every phase settled. */
export function expectSettled(run: SimulationRun): void {
  if (!run.settled) throw new Error(run.report);
}

/**
 * Whether the page says its view settled, and if not, why. This is the
 * settle signal every settle consumer waits on, read where they read it, so
 * a change to that predicate changes what the simulation accepts.
 */
function pageSettle(): { settled: boolean; reason: string; coverage: number } {
  const published = settleSignal.state;
  return {
    settled: settleSignal.outcome === "settled",
    reason: settleSignal.stallReason ?? published?.reason ?? "unpublished",
    coverage: published?.coverage ?? 0,
  };
}

/** Resolve every pending microtask, including those the resolved ones queue. */
function flushMicrotasks(): Promise<void> {
  return new Promise((done) => realSetImmediate(done));
}

class Simulation {
  private readonly scenario: Scenario;
  private readonly dpr: number;
  private readonly frames = new Map<number, FrameRequestCallback>();
  private nextFrameId = 1;
  private readonly worker: SimulatedWorker;
  private readonly source: SimulatedSource;
  private readonly cpuCache: CpuCache;
  private readonly datasets = new Map<string, DatasetManifest>();
  private readonly availability = new GeneratedAvailabilityCatalog();
  private scene: WasmScene | null = null;
  private loop: RenderLoop | null = null;
  /** `${memberId}/${chunkKey}` → the worker's last feedback reason and how often it was given. */
  private readonly feedback = new Map<string, { reason: string; count: number }>();
  /** Every chunk the uploader's progress guard held, in order. */
  private readonly held: string[] = [];
  private framesRun = 0;
  private readonly fits: ContrastFitRecord[] = [];

  constructor(scenario: Scenario, dpr: number) {
    this.scenario = scenario;
    this.dpr = dpr;
    this.worker = new SimulatedWorker(scenario.gpuTotalBytes);
    this.worker.onPost = (msg) => {
      if (msg.type !== "chunkResidency" || msg.change === "held") return;
      const reason = `${msg.change} ${msg.reason ?? ""}`.trim();
      for (const key of msg.keys) {
        const id = `${msg.memberId}/${key}`;
        const prior = this.feedback.get(id);
        this.feedback.set(id, { reason, count: (prior?.reason === reason ? prior.count : 0) + 1 });
      }
    };
    this.source = new SimulatedSource(
      { ...scenario.source, answer: (req) => this.answer(req) },
      (datasetId) => this.datasets.get(datasetId),
    );
    this.cpuCache = new CpuCache(this.source, passThroughDecodePool(), {
      ...scenario.cache,
      // Backoff jitter is the only randomness on the path.
      random: () => 0.5,
    });
  }

  /** The scenario's answer, with a generated chunk pending until the server has made it. */
  private answer(req: SourceRequest): SourceAnswer {
    const generated = this.scenario.dataset.generated;
    if (
      generated &&
      Number(req.chunkKey.split("/")[0]) === generated.levelIndex &&
      req.nowMs < generated.readyAtMs
    ) {
      return "pending";
    }
    return this.scenario.source.answer?.(req) ?? "ready";
  }

  /** Install the fake clock and globals the page reads. {@link dispose} removes them. */
  private installEnvironment(): void {
    // The fake clock covers every timer the pipeline arms and the clock it
    // reads. `setImmediate` stays real: it is how a step waits out microtasks.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = this.nextFrameId++;
      this.frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      this.frames.delete(id);
    });
    vi.stubGlobal("devicePixelRatio", this.dpr);
    for (const [name, value] of Object.entries(GPU_USAGE_GLOBALS)) vi.stubGlobal(name, value);
    const worker = this.worker;
    vi.stubGlobal("Worker", function SimulatedWorkerHandle() {
      return worker;
    });
    traceRecorder.reset();
    settleSignal.reset();
    // The progress guard reports a held chunk only to the trace.
    const record = traceRecorder.recordPointEvent.bind(traceRecorder);
    vi.spyOn(traceRecorder, "recordPointEvent").mockImplementation((kind, reason, chunk, tier) => {
      if (kind === PointEvent.Held && chunk) {
        const { level, t, c, z, y, x } = chunk;
        this.held.push(`${chunk.imageId} ${level}/${t}/${c}/${z}/${y}/${x} (${reason})`);
      }
      record(kind, reason, chunk, tier);
    });
  }

  /** Open the dataset the way a live open does: apply, register, fit the camera, start the loop. */
  open(): void {
    this.installEnvironment();
    const { dataset, viewport, mode } = this.scenario;
    const [cssW, cssH] = viewport;
    const deviceW = Math.round(cssW * this.dpr);
    const deviceH = Math.round(cssH * this.dpr);

    const scene = new WasmScene(deviceW, deviceH);
    scene.apply_command(dataset.openCommand);
    // A fixture's labels are there to be drawn, and a label opens hidden.
    for (let label = 0; label < (dataset.manifest.labels?.length ?? 0); label++) {
      scene.apply_command(JSON.stringify({ type: "set_label_visible", dataset_id: dataset.datasetId, label, visible: true }));
    }
    bumpSettingsGeneration();
    this.scene = scene;

    let manifest = dataset.manifest;
    if (dataset.generated) {
      this.availability.applySnapshot(dataset.datasetId, dataset.generated.snapshot);
      manifest = this.availability.mergeManifest(dataset.datasetId, manifest);
    }
    this.datasets.set(dataset.datasetId, manifest);

    const session = {
      scene,
      cpuCache: this.cpuCache,
      contentSource: this.source,
      generatedAvailability: this.availability,
      bridge: { sendViewerInterest: () => {} },
    } as unknown as Session;

    const canvas = {
      clientWidth: cssW,
      clientHeight: cssH,
      width: deviceW,
      height: deviceH,
      transferControlToOffscreen: () => ({}),
    } as unknown as HTMLCanvasElement;
    const client = new RenderClient(canvas);
    const loop = new RenderLoop({ session, datasets: new Map(), client, canvas, mode });
    this.loop = loop;
    loop.start();
    loop.addDataset(dataset.datasetId, manifest);
    loop.setAutoContrastListener((datasetId, channel, fit) => this.fits.push({ datasetId, channel, fit }));

    scene.set_viewport(deviceW, deviceH, this.dpr);
    // The 3-D view's camera, as switching the dimension control sets it. The
    // scene fitted the open, and fits the new mode's camera.
    if (mode === "volume") applyViewportCommand(scene, { type: "set_mode_arcball" });
    loop.markInteractiveDirty("dataset_opened");

    if (dataset.generated) {
      const generated = dataset.generated;
      if (generated.publishedAtMs > 0) {
        setTimeout(() => this.applyAvailability({ levels: generated.levels }), generated.publishedAtMs);
      }
      const chunks = [...generated.chunkKeys].flatMap(([imageId, keys]) =>
        keys.map((key) => ({
          image_id: imageId,
          level_index: generated.levelIndex,
          key,
          status: "ready" as const,
        })),
      );
      setTimeout(() => this.applyAvailability({ chunks }), generated.readyAtMs);
    }
  }

  /**
   * A server availability update, applied as the session controller applies
   * one: level geometry replaces the manifest the loop holds, chunk statuses
   * go to the CPU cache, and residency is marked dirty.
   */
  private applyAvailability(delta: WireGeneratedAvailabilityDelta): void {
    const datasetId = this.scenario.dataset.datasetId;
    this.availability.applyDelta(datasetId, delta);
    if (delta.levels?.length) {
      const merged = this.availability.mergeManifest(datasetId, this.datasets.get(datasetId)!);
      this.datasets.set(datasetId, merged);
      this.loop!.updateDatasetManifest(datasetId, merged);
    }
    this.cpuCache.noteGeneratedAvailability(datasetId, delta.chunks ?? []);
    this.loop!.markResidencyDirty(AVAILABILITY_UPDATE_SOURCE);
  }

  /** Apply a step the way its control does, and name it for the report. */
  apply(step: ScenarioStep): string {
    const scene = this.scene!;
    const loop = this.loop!;
    const volume = this.scenario.mode === "volume";
    if ("pan" in step) {
      const [dx, dy] = step.pan;
      applyViewportCommand(scene, volume ? { type: "arcball_pan", dx, dy } : { type: "pan", dx, dy });
      loop.markInput("pan");
      return `pan ${dx},${dy}`;
    }
    if ("zoom" in step) {
      applyViewportCommand(
        scene,
        // The arcball scales its distance by `1 + delta`.
        volume ? { type: "arcball_zoom", delta: 1 / step.zoom - 1 } : { type: "zoom_by", factor: step.zoom },
      );
      loop.markInput("zoom");
      return `zoom ×${step.zoom}`;
    }
    if ("orbit" in step) {
      const [dTheta, dPhi] = step.orbit;
      applyViewportCommand(scene, { type: "arcball_rotate", d_theta: dTheta, d_phi: dPhi });
      loop.markInput("orbit");
      return `orbit ${dTheta},${dPhi}`;
    }
    const { scrub } = step;
    loop.markInput("scrub");
    if (scrub.z !== undefined) applyViewportCommand(scene, { type: "set_z", z: scrub.z });
    if (scrub.t !== undefined) applyViewportCommand(scene, { type: "set_t", t: scrub.t });
    return `scrub ${Object.entries(scrub).map(([axis, v]) => `${axis}=${v}`).join(" ")}`;
  }

  /**
   * Advance one frame: fire the timers that fall due, run the frame the loop
   * asked for, then let the worker answer everything it was sent. Returns
   * whether the loop ran a frame.
   */
  private async step(): Promise<boolean> {
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    await flushMicrotasks();
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const frame of due) frame(performance.now());
    if (due.length > 0) this.framesRun++;
    await flushMicrotasks();
    await this.worker.drain();
    await flushMicrotasks();
    return due.length > 0;
  }

  served(): string[] {
    return [...this.source.served];
  }

  /** Nothing queued, in flight or pending anywhere, and no frame requested. */
  private atFixedPoint(): boolean {
    if (this.frames.size > 0 || !this.worker.idle) return false;
    const q = this.cpuCache.settleInputs(createSettleState());
    return (
      q.pending === 0 &&
      q.inFlight === 0 &&
      q.speculativePending === 0 &&
      q.speculativeInFlight === 0 &&
      !q.pendingUnclassified
    );
  }

  /**
   * Step until a fixed point reached within the tick bound holds for
   * {@link QUIET_MS}. A frame, a request or a worker message in that window
   * means it was not one, and stepping goes on. A fixed point settles the
   * phase when the page publishes quiescence and, where the scenario asks,
   * the worker holds every chunk it wants.
   */
  async settle(label: string): Promise<PhaseOutcome> {
    const framesBefore = this.framesRun;
    const fitsBefore = this.fits.length;
    const sentBefore = new Map([...this.worker.deliveries].map(([key, d]) => [key, { ...d }]));
    const heldBefore = this.held.length;
    const quietSteps = Math.ceil(QUIET_MS / FRAME_MS);
    let fixedSince: number | null = null;
    let requestsAtFixed = this.source.requestCount;
    for (let i = 1; ; i++) {
      // A frame that ran is the loop waking, even when it asked for no other.
      const ranFrame = await this.step();
      if (ranFrame || !this.atFixedPoint() || this.source.requestCount !== requestsAtFixed) {
        fixedSince = null;
        requestsAtFixed = this.source.requestCount;
        if (i >= this.scenario.tickBound) return this.outcome(label, i, false, framesBefore, fitsBefore, sentBefore, heldBefore);
        continue;
      }
      fixedSince ??= i;
      if (i - fixedSince >= quietSteps) return this.outcome(label, fixedSince, true, framesBefore, fitsBefore, sentBefore, heldBefore);
    }
  }

  private outcome(
    label: string,
    ticks: number,
    fixed: boolean,
    framesBefore: number,
    fitsBefore: number,
    sentBefore: Map<string, ChunkDeliveries>,
    heldBefore: number,
  ): PhaseOutcome {
    const q = this.cpuCache.settleInputs(createSettleState());
    const page = pageSettle();
    const missingCpu = this.missingFromCpu();
    const missingGpu = this.missingFromGpu();
    const staleLabelCells = this.worker.staleLabelCells();

    let chunksSent = 0;
    let distinctChunksSent = 0;
    let bytesSent = 0;
    const resent: Array<{ text: string; times: number }> = [];
    for (const [key, { tier, memberId, chunkKey, count, bytes }] of this.worker.deliveries) {
      const before = sentBefore.get(key);
      const times = count - (before?.count ?? 0);
      chunksSent += times;
      bytesSent += bytes - (before?.bytes ?? 0);
      if (times > 0) distinctChunksSent++;
      if (times < RESENT_THRESHOLD) continue;
      resent.push({ text: this.describeKey(memberId, chunkKey, tier), times });
    }
    resent.sort((a, b) => b.times - a.times);

    let why = "settled";
    if (!fixed) {
      why = `no fixed point within ${this.scenario.tickBound} ticks: ${this.whatIsStillMoving()}`;
    } else if (!page.settled) {
      why = `fixed point after ${ticks} ticks, but the page publishes ${page.reason}`;
    } else if (this.scenario.gpuComplete && missingGpu.length > 0) {
      why = `fixed point after ${ticks} ticks, but the worker lacks ${missingGpu.length} chunks it wants`;
    } else if (this.held.length > heldBefore) {
      why = `fixed point after ${ticks} ticks, but only because the uploader held ${this.held.length - heldBefore} chunks`;
    } else if (staleLabelCells.length > 0) {
      why = `fixed point after ${ticks} ticks, but ${staleLabelCells.length} label cells draw another plane than the view's`;
    }

    return {
      label,
      settled: why === "settled",
      ticks,
      why,
      frames: this.framesRun - framesBefore,
      chunksSent,
      distinctChunksSent,
      bytesSent,
      quiescence: page.reason,
      coverage: page.coverage,
      detail: { resident: q.residentDetailChunks, desired: q.desiredDetailChunks },
      coarse: { resident: q.residentCoarseChunks, desired: q.desiredCoarseChunks },
      queued: q.pending + q.speculativePending,
      inFlight: q.inFlight + q.speculativeInFlight,
      missingCpu,
      missingGpu,
      resent: resent.map((r) => r.text),
      sourceRequests: this.source.requestCount,
      held: this.held.slice(heldBefore),
      failed: this.cpuCache
        .failedWantedChunks()
        .map(({ chunk, failure }) => `${chunk}: ${failure ?? "failed with no reason given"}`)
        .sort(),
      drawnFailed: this.worker.failedCells(this.scenario.dataset.datasetId),
      staleLabelCells,
      fits: this.fits.slice(fitsBefore),
    };
  }

  private whatIsStillMoving(): string {
    const parts: string[] = [];
    if (this.frames.size > 0) parts.push(`a frame is requested (the page publishes ${pageSettle().reason})`);
    const q = this.cpuCache.settleInputs(createSettleState());
    if (q.pending + q.speculativePending > 0) parts.push(`${q.pending + q.speculativePending} chunks queued`);
    if (q.inFlight + q.speculativeInFlight > 0) parts.push(`${q.inFlight + q.speculativeInFlight} in flight`);
    return parts.join(", ") || "the worker is still busy";
  }

  /** Each chunk the last plan asks for, outside prefetch, that its store does not hold. */
  private missingFromCpu(): string[] {
    const out: string[] = [];
    const plans = this.loop?.getTickCoordinator().getLastPlans() ?? new Map();
    for (const plan of plans.values()) {
      for (const req of plan.requests) {
        if (req.lane === "prefetch" || this.cpuCache.holds(req)) continue;
        out.push(this.describeKey(workerMemberId(req.imageId, req.c), req.chunkKey, req.tier));
      }
    }
    return out;
  }

  /** Each chunk the worker wants for the open dataset and does not hold. */
  private missingFromGpu(): string[] {
    return this.worker
      .missingNow(this.scenario.dataset.datasetId)
      .map((m) => this.describeKey(m.memberId, m.chunkKey, m.tier));
  }

  /** A key with the last word on it from the source and the worker. */
  private describeKey(memberId: string, chunkKey: string, tier: ResidencyTier): string {
    const imageId = memberId.replace(/:ch\d+$/, "");
    const notes: string[] = [];
    const source = this.source.records.get(`${imageId}/${chunkKey}`);
    if (!source) notes.push("never requested");
    else notes.push(`source answered ${source.last} (${times(source.requests, "request")})`);
    const sent = this.worker.deliveries.get(deliveryKey(tier, memberId, chunkKey))?.count ?? 0;
    if (sent > 0) notes.push(`sent to the worker ${times(sent, "time")}`);
    const feedback = this.feedback.get(`${memberId}/${chunkKey}`);
    if (feedback) notes.push(`last worker feedback ${feedback.reason} (${feedback.count} in a row)`);
    return `${memberId} ${chunkKey} [${tier}]: ${notes.join("; ")}`;
  }

  dispose(): void {
    this.loop?.getTickCoordinator().dispose();
    this.loop?.stop();
    this.scene?.free();
    traceRecorder.reset();
    settleSignal.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
}

function times(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function formatKeys(title: string, keys: string[]): string[] {
  if (keys.length === 0) return [];
  const lines = [`  ${title} (${keys.length}):`];
  for (const key of keys.slice(0, REPORT_KEY_LIMIT)) lines.push(`    ${key}`);
  if (keys.length > REPORT_KEY_LIMIT) lines.push(`    and ${keys.length - REPORT_KEY_LIMIT} more`);
  return lines;
}

function formatReport(name: string, dpr: number, phases: PhaseOutcome[]): string {
  const lines = [`"${name}" at device pixel ratio ${dpr}:`];
  for (const p of phases) {
    lines.push(
      `phase "${p.label}": ${p.why}.`,
      `  ${p.frames} frames, ${p.chunksSent} chunks (${p.bytesSent} bytes) sent to the worker; ` +
        `CPU cache holds detail ${p.detail.resident}/${p.detail.desired}, ` +
        `coarse ${p.coarse.resident}/${p.coarse.desired}; ${p.queued} queued, ${p.inFlight} in flight; ` +
        `the page reports ${Math.round(p.coverage * 100)}% coverage.`,
      ...formatKeys("wanted by the plan, not in the CPU cache", p.missingCpu),
      ...formatKeys("wanted by the worker, not on the GPU", p.missingGpu),
      ...formatKeys(`sent to the worker ${RESENT_THRESHOLD} or more times`, p.resent),
      ...formatKeys("held by the uploader to cut a feedback loop", p.held),
      ...formatKeys("failed for good, so the view settles without them", p.failed),
      ...formatKeys("label cells drawing another plane than the view's", p.staleLabelCells),
    );
  }
  return lines.join("\n");
}
