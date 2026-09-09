/**
 * Where the HUD's sample comes from.
 *
 * The source watches the recorder's per-tick aggregate as it is committed,
 * keeping the latest levels per dataset, and at the HUD tick gathers one
 * {@link HudSample} from the recorder's cheap reads and two cheap reads on
 * the CPU cache. It never walks a row, never exports the trace, and never
 * closes a run: every read here is a getter or a bounded scan.
 */

import { LANES, type Lane, type LaneOutstanding, type PoolResidencyReport } from "../pipeline/fetch/types.ts";
import { traceRecorder, type TraceRecorder } from "../trace/recorder.ts";
import type { TickScratch } from "../trace/tickRing.ts";
import type { HudLevelSample, HudSample } from "./hudModel.ts";

/** The two reads the HUD makes on the CPU cache. */
export interface HudCacheReads {
  poolResidency(): PoolResidencyReport;
  laneOutstanding(out: LaneOutstanding): LaneOutstanding;
}

export interface HudSourceOptions {
  recorder?: TraceRecorder;
  /** The session's cache, or null while there is no session. Read at each tick. */
  getCache: () => HudCacheReads | null;
  /** A dataset's display name, for the levels column. */
  datasetName?: (datasetId: string) => string;
  now?: () => number;
}

/** A zeroed lane tally for the cache to fill. */
export function emptyLaneOutstanding(): LaneOutstanding {
  const zero = () => Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  return {
    inFlight: zero(),
    pending: zero(),
    proxyInFlight: 0,
    proxyPending: 0,
    pendingTotal: 0,
    pendingUnclassified: false,
    pendingScanCap: 0,
  };
}

/** One dataset's latest levels, mutated in place by the tick listener. */
interface LevelMemory {
  hasTarget: boolean;
  targetMin: number;
  targetMax: number;
  pinned: boolean;
  hasDisplayed: boolean;
  displayedMin: number;
  displayedMax: number;
}

export class HudSource {
  private readonly recorder: TraceRecorder;
  private readonly getCache: () => HudCacheReads | null;
  private readonly datasetName: (datasetId: string) => string;
  private readonly now: () => number;
  private readonly levels = new Map<string, LevelMemory>();
  private stopWatching: (() => void) | null = null;

  constructor(options: HudSourceOptions) {
    this.recorder = options.recorder ?? traceRecorder;
    this.getCache = options.getCache;
    this.datasetName = options.datasetName ?? ((id) => id);
    this.now = options.now ?? (() => performance.now());
  }

  /** Start watching tick samples. Idempotent. */
  start(): void {
    if (this.stopWatching) return;
    this.stopWatching = this.recorder.onTick(this.onTick);
  }

  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.levels.clear();
  }

  /**
   * Gather one sample. `datasetIds`, when given, prunes datasets that are no
   * longer open: a dataset's last sample otherwise stays, because the
   * planner's epoch cache means an unchanged view produces no new one.
   */
  sample(datasetIds: ReadonlySet<string> | null = null): HudSample {
    if (datasetIds) {
      for (const id of this.levels.keys()) if (!datasetIds.has(id)) this.levels.delete(id);
    }
    const levels: HudLevelSample[] = [];
    for (const [datasetId, memory] of this.levels) {
      levels.push({
        datasetId,
        name: this.datasetName(datasetId),
        target: memory.hasTarget ? { min: memory.targetMin, max: memory.targetMax } : null,
        pinned: memory.pinned,
        displayed: memory.hasDisplayed ? { min: memory.displayedMin, max: memory.displayedMax } : null,
      });
    }

    const cache = this.getCache();
    const reading = this.recorder.latestReading;
    const quiescence = this.recorder.quiescence;
    return {
      atMs: this.now(),
      bytesSent: this.recorder.bytesSent,
      bytesReceived: this.recorder.bytesReceived,
      reading:
        reading.seq === 0
          ? null
          : { seq: reading.seq, frameTimeUs: reading.frameTimeUs, gpuPassUs: reading.gpuPassUs },
      quiescence: quiescence ? { quiescent: quiescence.quiescent, reason: quiescence.reason } : null,
      lanes: cache ? cache.laneOutstanding(emptyLaneOutstanding()) : null,
      pools: cache ? cache.poolResidency() : null,
      levels,
      gpu: this.recorder.gpu,
      runOpen: this.recorder.isRunOpen,
    };
  }

  /**
   * Runs on the planning pass under the recorder's `onTick` contract: field
   * copies only, and an allocation only on a dataset's first sample.
   */
  private readonly onTick = (sample: TickScratch): void => {
    let memory = this.levels.get(sample.datasetId);
    if (!memory) {
      memory = {
        hasTarget: false,
        targetMin: 0,
        targetMax: 0,
        pinned: false,
        hasDisplayed: false,
        displayedMin: 0,
        displayedMax: 0,
      };
      this.levels.set(sample.datasetId, memory);
    }
    memory.hasTarget = sample.hasTarget;
    if (sample.hasTarget) {
      memory.targetMin = sample.targetMin;
      memory.targetMax = sample.targetMax;
    }
    memory.pinned = sample.levelPinned;
    memory.hasDisplayed = sample.hasDisplayed;
    if (sample.hasDisplayed) {
      memory.displayedMin = sample.displayedMin;
      memory.displayedMax = sample.displayedMax;
    }
  };
}
