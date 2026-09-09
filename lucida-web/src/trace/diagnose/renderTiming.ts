/**
 * Render timing and the adapter: what the readings say about the main thread
 * and the GPU, and what the header says about the hardware.
 *
 * Two clocks, kept apart on purpose. The main-thread figure is the tick's own
 * duration, sampled on every reading. The GPU figure is a pass time the render
 * worker read back through timestamp queries, present only on the readings
 * that received one. A run on an adapter without timestamp queries has the
 * first and not the second, and the document says why rather than leaving a
 * gap to be read as a fast GPU.
 *
 * Headers written before the adapter record carried a fallback flag or a
 * timestamp-query flag are read as not having recorded them. A trace outlives
 * the code that wrote it, and a missing fact is reported as missing rather
 * than as whichever value the type's default would suggest.
 */

import type { GpuIdentity, TraceRun } from "../types.ts";
import type { RunIdentity } from "./types.ts";
import { percentile, usToMs } from "./phaseRollup.ts";
import type { GpuPassAbsenceReason, GpuPassTiming, RenderTiming, TimingSummary } from "./types.ts";

const ABSENCE_STATEMENTS: Record<GpuPassAbsenceReason, string> = {
  "no-timestamp-queries":
    "the adapter offers no timestamp queries, so frame time is main-thread time",
  "no-frame-read-back":
    "the adapter offers timestamp queries but no frame was read back before the run closed, so frame time is main-thread time",
  "adapter-unknown":
    "no adapter was identified before the run closed, so frame time is main-thread time",
  "not-recorded":
    "the header does not say whether the adapter offers timestamp queries, so frame time is main-thread time",
};

const ADAPTER_KIND_LABELS: Record<RunIdentity["adapterKind"]["kind"], string> = {
  hardware: "hardware adapter",
  "software-fallback": "software fallback adapter",
  "not-identified": "adapter not identified",
  "not-recorded": "adapter kind not recorded",
};

export function deriveRenderTiming(run: TraceRun): RenderTiming {
  const mainThreadUs: number[] = [];
  const gpuPassUs: number[] = [];
  for (const reading of run.readings) {
    // The same filter the `render.frame` aggregate applies, so the two
    // main-thread figures in one document cannot disagree.
    if (reading.frameTimeUs > 0) mainThreadUs.push(reading.frameTimeUs);
    if (reading.gpuPassUs != null) gpuPassUs.push(reading.gpuPassUs);
  }

  return {
    mainThread: summarise(mainThreadUs),
    gpuPass: gpuPass(gpuPassUs, run.header.gpu),
  };
}

/** The adapter named for a line that has room for one phrase. */
export function adapterName(gpu: GpuIdentity | null): string {
  if (!gpu) return "unknown";
  const name = [gpu.vendor, gpu.architecture, gpu.device].filter((part) => part.length > 0).join(" ");
  if (gpu.description.length > 0) return name.length > 0 ? `${name} (${gpu.description})` : gpu.description;
  return name.length > 0 ? name : "unnamed adapter";
}

export function adapterKindOf(gpu: GpuIdentity | null): RunIdentity["adapterKind"] {
  const kind =
    gpu === null
      ? "not-identified"
      : typeof gpu.fallback !== "boolean"
        ? "not-recorded"
        : gpu.fallback
          ? "software-fallback"
          : "hardware";
  return { kind, label: ADAPTER_KIND_LABELS[kind] };
}

function summarise(us: number[]): TimingSummary | null {
  if (us.length === 0) return null;
  const sorted = [...us].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: usToMs(percentile(sorted, 0.5)),
    p95Ms: usToMs(percentile(sorted, 0.95)),
    maxMs: usToMs(sorted[sorted.length - 1]),
  };
}

function gpuPass(us: number[], gpu: GpuIdentity | null): GpuPassTiming {
  const summary = summarise(us);
  if (summary) return { recorded: true, ...summary };
  const reason: GpuPassAbsenceReason =
    gpu === null
      ? "adapter-unknown"
      : typeof gpu.timestampQueries !== "boolean"
        ? "not-recorded"
        : gpu.timestampQueries
          ? "no-frame-read-back"
          : "no-timestamp-queries";
  return { recorded: false, reason, statement: ABSENCE_STATEMENTS[reason] };
}
