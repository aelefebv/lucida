/**
 * Fixtures the HUD tests share: a sample builder, a recording 2D context, a
 * fake cache, and a recorder on a fake clock. Test support, not product code.
 */

import type { HudDrawContext } from "./hudDraw.ts";
import type { HudSample } from "./hudModel.ts";
import type { HudCacheReads } from "./hudSource.ts";
import type { LaneOutstanding } from "../pipeline/fetch/types.ts";
import { TraceRecorder } from "../trace/recorder.ts";
import type { GpuIdentity } from "../trace/types.ts";

export const MIB = 1024 * 1024;

export const HARDWARE: GpuIdentity = {
  vendor: "vendor",
  architecture: "arch",
  device: "",
  description: "Example Discrete Adapter",
  fallback: false,
  timestampQueries: true,
};

export const FALLBACK: GpuIdentity = {
  vendor: "",
  architecture: "",
  device: "",
  description: "Software Rasterizer",
  fallback: true,
  timestampQueries: false,
};

export function lanes(overrides: Partial<LaneOutstanding> = {}): LaneOutstanding {
  return {
    inFlight: { detail: 6, coarse: 1, minimap: 0, prefetch: 2, overview: 0 },
    pending: { detail: 40, coarse: 0, minimap: 3, prefetch: 120, overview: 0 },
    proxyInFlight: 0,
    proxyPending: 0,
    pendingTotal: 163,
    pendingUnclassified: false,
    pendingScanCap: 4096,
    ...overrides,
  };
}

/** A sample at `atMs` with a busy pipeline on a hardware adapter. */
export function hudSample(atMs: number, overrides: Partial<HudSample> = {}): HudSample {
  return {
    atMs,
    bytesSent: 0,
    bytesReceived: 0,
    reading: { seq: 1, frameTimeUs: 4_200, gpuPassUs: null },
    quiescence: { quiescent: false, reason: "chunks_in_flight" },
    lanes: lanes(),
    pools: {
      main: { bytes: 128 * MIB, budgetBytes: 512 * MIB },
      overview: { bytes: 63 * MIB, budgetBytes: 64 * MIB },
      proxy: { bytes: 0, budgetBytes: 256 * MIB },
    },
    levels: [
      { datasetId: "ds-a", name: "a.zarr", target: { min: 2, max: 2 }, pinned: false, displayed: { min: 3, max: 3 } },
    ],
    gpu: HARDWARE,
    runOpen: true,
    ...overrides,
  };
}

/** A 2D context that records the text it is asked to draw and counts every call. */
export class RecordingContext implements HudDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  lineWidth = 1;
  font = "";
  textBaseline: CanvasTextBaseline = "alphabetic";
  textAlign: CanvasTextAlign = "left";
  globalAlpha = 1;
  transforms: number[][] = [];
  texts: string[] = [];
  calls = 0;
  rects = 0;

  setTransform(...args: unknown[]): void {
    this.calls++;
    this.transforms.push(args as number[]);
  }
  clearRect(): void {
    this.calls++;
  }
  fillRect(): void {
    this.calls++;
    this.rects++;
  }
  beginPath(): void {
    this.calls++;
  }
  moveTo(): void {
    this.calls++;
  }
  lineTo(): void {
    this.calls++;
  }
  closePath(): void {
    this.calls++;
  }
  stroke(): void {
    this.calls++;
  }
  fill(): void {
    this.calls++;
  }
  arc(): void {
    this.calls++;
  }
  fillText(text: string): void {
    this.calls++;
    this.texts.push(text);
  }
}

/** The two reads the HUD makes on the cache, answered with fixed figures. */
export function fakeCache(): HudCacheReads & { calls: number } {
  return {
    calls: 0,
    poolResidency() {
      this.calls++;
      return {
        main: { bytes: 5 * MIB, budgetBytes: 512 * MIB },
        overview: { bytes: 1 * MIB, budgetBytes: 64 * MIB },
        proxy: { bytes: 0, budgetBytes: 256 * MIB },
      };
    },
    laneOutstanding(out: LaneOutstanding) {
      out.inFlight.detail = 3;
      out.pending.prefetch = 7;
      out.pendingTotal = 7;
      out.pendingScanCap = 4096;
      return out;
    },
  };
}

/** A recorder on a fake clock with an environment registered, so intervals open. */
export function makeRecorder() {
  let clock = 1_000;
  const recorder = new TraceRecorder({
    now: () => clock,
    epochNow: () => 1_700_000_000_000,
    quiescenceHoldMs: 500,
    timeoutMs: 3_600_000,
  });
  recorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0, detailBytes: 0, coarseChunks: 0, coarseBytes: 0, proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => ({
      pending: 0,
      inFlight: 0,
      speculativePending: 0,
      speculativeInFlight: 0,
      desiredDetailChunks: 0,
      residentDetailChunks: 0,
      desiredCoarseChunks: 0,
      residentCoarseChunks: 0,
      detailBytes: 0,
      detailBudgetBytes: 0,
      coarseBytes: 0,
      coarseBudgetBytes: 0,
    }),
  });
  return { recorder, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
