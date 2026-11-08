/**
 * The HUD model: what the strip in the viewport says, as pure data.
 *
 * Each tick's sample joins a rolling history, and the latest becomes readouts
 * that pair a label with a tone, so a state is never a color alone. Nothing
 * here touches a canvas, the recorder, or the cache, so fixtures can assert
 * the readouts. Bytes each way are differenced from page-scoped totals: the
 * aggregate's send tally is per planning pass, and passes can be seconds apart
 * while the socket stays busy. Pool and lane figures come from the cache
 * because the reading ring carries one resident total, and widening it
 * spends from the recorder's cost budget.
 */

import type { Lane, LaneOutstanding, PoolResidencyReport } from "../pipeline/fetch/types.ts";
import type { GpuMemoryReport, LevelRange } from "../renderer/workerProtocol.ts";
import { adapterKindOf, adapterName } from "../trace/diagnose/renderTiming.ts";
import type { GpuIdentity } from "../trace/types.ts";

/** How often the HUD samples and draws. It hooks nothing into the render
 *  loop, so its cost is per tick, never per frame. */
export const HUD_TICK_MS = 250;

/** How many ticks the sparklines show: fifteen seconds at the tick above. */
export const HUD_HISTORY = 60;

/** A state's color, always paired with a label. */
export type HudTone = "ok" | "busy" | "warn" | "absent" | "info";

/** One dataset's levels, from its latest per-tick aggregate sample. */
export interface HudLevelSample {
  datasetId: string;
  name: string;
  target: LevelRange | null;
  pinned: boolean;
  displayed: LevelRange | null;
}

/** What the strip takes from the latest reading, copied at the HUD tick. */
export interface HudReadingSample {
  /** The recorder's reading sequence, so a tick with no new reading is told from one with. */
  seq: number;
  frameTimeUs: number;
  gpuPassUs: number | null;
}

export interface HudQuiescenceSample {
  quiescent: boolean;
  reason: string;
}

/** Everything the strip reads, gathered once per HUD tick. */
export interface HudSample {
  atMs: number;
  /** Page-scoped totals; the model differences them. */
  bytesSent: number;
  bytesReceived: number;
  /** Null before the first reading. */
  reading: HudReadingSample | null;
  /** Null before the page publishes one. */
  quiescence: HudQuiescenceSample | null;
  /** Null with no session to ask. */
  lanes: LaneOutstanding | null;
  pools: PoolResidencyReport | null;
  /** Null with no render worker to ask. */
  gpuMemory: GpuMemoryReport | null;
  levels: readonly HudLevelSample[];
  gpu: GpuIdentity | null;
  runOpen: boolean;
}

/** The rolling history the strip draws from. Fixed buffers, so a long session grows nothing. */
export interface HudHistory {
  readonly capacity: number;
  head: number;
  length: number;
  readonly receivedRate: Float64Array;
  readonly sentRate: Float64Array;
  readonly frameMs: Float64Array;
  readonly gpuMs: Float64Array;
  last: HudSample | null;
  lastReadingSeq: number;
}

export function createHudHistory(capacity = HUD_HISTORY): HudHistory {
  return {
    capacity,
    head: 0,
    length: 0,
    receivedRate: new Float64Array(capacity),
    sentRate: new Float64Array(capacity),
    frameMs: new Float64Array(capacity),
    gpuMs: new Float64Array(capacity),
    last: null,
    lastReadingSeq: 0,
  };
}

/** Take one sample into the history. Absent values are `NaN`, never zero. */
export function pushSample(history: HudHistory, sample: HudSample): void {
  const previous = history.last;
  let received = Number.NaN;
  let sent = Number.NaN;
  if (previous) {
    const seconds = (sample.atMs - previous.atMs) / 1000;
    if (seconds > 0) {
      received = Math.max(0, sample.bytesReceived - previous.bytesReceived) / seconds;
      sent = Math.max(0, sample.bytesSent - previous.bytesSent) / seconds;
    }
  }

  let frame = Number.NaN;
  let gpu = Number.NaN;
  const reading = sample.reading;
  if (reading && reading.seq !== history.lastReadingSeq) {
    history.lastReadingSeq = reading.seq;
    // A zero frame time is dropped, as the render timing diagnostic drops it.
    if (reading.frameTimeUs > 0) frame = reading.frameTimeUs / 1000;
    if (reading.gpuPassUs != null) gpu = reading.gpuPassUs / 1000;
  }

  const slot = history.head;
  history.receivedRate[slot] = received;
  history.sentRate[slot] = sent;
  history.frameMs[slot] = frame;
  history.gpuMs[slot] = gpu;
  history.head = (slot + 1) % history.capacity;
  if (history.length < history.capacity) history.length++;
  history.last = sample;
}

export interface HudSeriesView {
  key: "received" | "sent" | "frame" | "gpu";
  label: string;
  /** Oldest first; `NaN` where the tick had nothing to say. */
  values: number[];
  /** The latest value formatted, or empty when absent. */
  latest: string;
  tone: HudTone;
  /** The word for the tone when the tone judges the value; null when it only colors a number. */
  state: string | null;
  /** Why the latest value is absent, or null when it is there. */
  absent: string | null;
}

/** A label in a tone, with a detail after it. */
export interface HudStatusView {
  label: string;
  detail: string;
  tone: HudTone;
}

export interface HudPoolView {
  label: string;
  text: string;
  /** Resident over budget, or null when there is no figure to draw. */
  fill: number | null;
  state: string;
  tone: HudTone;
}

export interface HudLaneView {
  label: string;
  inFlight: number;
  pending: number;
}

export interface HudLevelView {
  name: string;
  text: string;
  state: string;
  tone: HudTone;
}

export interface HudView {
  window: string;
  series: HudSeriesView[];
  lanes: {
    rows: HudLaneView[];
    inFlightTotal: number;
    pendingTotal: number;
    note: { text: string; tone: HudTone } | null;
  };
  pools: HudPoolView[];
  levels: HudLevelView[];
  quiescence: HudStatusView;
  run: HudStatusView;
  adapter: HudStatusView & { warning: boolean };
}

/** Read the strip from the history. Pure, and safe before the first sample. */
export function buildHudView(history: HudHistory, tickMs = HUD_TICK_MS): HudView {
  const last = history.last;
  return {
    window: `${(history.capacity * tickMs) / 1000} s rolling window · ${tickMs} ms tick`,
    series: [
      rateSeries("received", history.receivedRate, history),
      rateSeries("sent", history.sentRate, history),
      frameSeries(history),
      gpuSeries(history),
    ],
    lanes: lanesOf(last),
    pools: poolsOf(last),
    levels: last ? last.levels.map(levelOf) : [],
    quiescence: quiescenceOf(last?.quiescence ?? null),
    run: last?.runOpen
      ? { label: "run open", detail: "a run is recording", tone: "info" }
      : { label: "steady state", detail: "no run open", tone: "absent" },
    adapter: adapterOf(last?.gpu ?? null),
  };
}

function values(buffer: Float64Array, history: HudHistory): number[] {
  const out = new Array<number>(history.length);
  const start = (history.head - history.length + history.capacity) % history.capacity;
  for (let i = 0; i < history.length; i++) out[i] = buffer[(start + i) % history.capacity];
  return out;
}

function latestOf(buffer: Float64Array, history: HudHistory): number {
  if (history.length === 0) return Number.NaN;
  return buffer[(history.head - 1 + history.capacity) % history.capacity];
}

function rateSeries(key: "received" | "sent", buffer: Float64Array, history: HudHistory): HudSeriesView {
  const latest = latestOf(buffer, history);
  const present = !Number.isNaN(latest);
  return {
    key,
    label: key,
    values: values(buffer, history),
    latest: present ? formatRate(latest) : "",
    tone: present ? "info" : "absent",
    state: null,
    absent: present ? null : history.length === 0 ? "no sample yet" : "no rate until a second sample",
  };
}

function frameSeries(history: HudHistory): HudSeriesView {
  const latest = latestOf(history.frameMs, history);
  const present = !Number.isNaN(latest);
  let absent: string | null = null;
  if (!present) {
    absent = history.length === 0 ? "no sample yet" : history.last?.reading ? "no frame since the last tick" : "no reading yet";
  }
  const judged = present ? frameState(latest) : null;
  return {
    key: "frame",
    label: "frame (main thread)",
    values: values(history.frameMs, history),
    latest: present ? formatMs(latest) : "",
    tone: judged?.tone ?? "absent",
    state: judged?.state ?? null,
    absent,
  };
}

function gpuSeries(history: HudHistory): HudSeriesView {
  const latest = latestOf(history.gpuMs, history);
  const present = !Number.isNaN(latest);
  let absent: string | null = null;
  if (!present) {
    const gpu = history.last?.gpu ?? null;
    if (history.length === 0) absent = "no sample yet";
    else if (gpu && !gpu.timestampQueries) absent = "not recorded: the adapter offers no timestamp queries";
    else if (!gpu) absent = "not recorded: no adapter identified";
    else absent = "no GPU pass read back since the last tick";
  }
  const judged = present ? frameState(latest) : null;
  return {
    key: "gpu",
    label: "GPU pass",
    values: values(history.gpuMs, history),
    latest: present ? formatMs(latest) : "",
    tone: judged?.tone ?? "absent",
    state: judged?.state ?? null,
    absent,
  };
}

function frameState(ms: number): { tone: HudTone; state: string } {
  if (ms < 1000 / 60) return { tone: "ok", state: "within a frame" };
  if (ms < 2000 / 60) return { tone: "busy", state: "over a frame" };
  return { tone: "warn", state: "over two frames" };
}

/** `LANES` without the historical `overview` lane, which is listed only when it carries work. */
const LANE_ROWS: readonly Lane[] = ["detail", "coarse", "minimap", "prefetch"];

function lanesOf(last: HudSample | null): HudView["lanes"] {
  if (!last) return { rows: [], inFlightTotal: 0, pendingTotal: 0, note: { text: "no sample yet", tone: "absent" } };
  const lanes = last.lanes;
  if (!lanes) return { rows: [], inFlightTotal: 0, pendingTotal: 0, note: { text: "no session", tone: "absent" } };

  const rows: HudLaneView[] = LANE_ROWS.map((lane) => ({
    label: lane,
    inFlight: lanes.inFlight[lane],
    pending: lanes.pending[lane],
  }));
  // The historical lane appears only when it carries work, so a permanent
  // zero is not read as a measurement.
  if (lanes.inFlight.overview > 0 || lanes.pending.overview > 0) {
    rows.push({ label: "overview", inFlight: lanes.inFlight.overview, pending: lanes.pending.overview });
  }

  let inFlightTotal = lanes.inFlight.overview;
  for (const lane of LANE_ROWS) inFlightTotal += lanes.inFlight[lane];

  return {
    rows,
    inFlightTotal,
    pendingTotal: lanes.pendingTotal,
    note: lanes.pendingUnclassified
      ? { text: `pending not split by lane: queue deeper than ${formatCount(lanes.pendingScanCap)}`, tone: "busy" }
      : null,
  };
}

const POOL_KEYS = ["main", "overview"] as const;

function poolsOf(last: HudSample | null): HudPoolView[] {
  const pools = last?.pools ?? null;
  const out: HudPoolView[] = POOL_KEYS.map((label) => {
    if (!pools) return { label, text: "no session", fill: null, state: "no session", tone: "absent" };
    const pool = pools[label];
    const text = `${formatMiB(pool.bytes)} / ${formatMiB(pool.budgetBytes)} MiB`;
    if (!Number.isFinite(pool.budgetBytes) || pool.budgetBytes <= 0) {
      return { label, text: `${formatMiB(pool.bytes)} MiB`, fill: null, state: "no budget", tone: "absent" };
    }
    const fill = pool.bytes / pool.budgetBytes;
    if (fill >= 0.98) return { label, text, fill, state: "at budget", tone: "busy" };
    if (fill >= 0.9) return { label, text, fill, state: "near budget", tone: "busy" };
    return { label, text, fill, state: "under budget", tone: "ok" };
  });
  out.push(gpuPoolOf(last?.gpuMemory ?? null));
  return out;
}

/**
 * Everything the render worker holds on the GPU against its one budget, with
 * the chunk pools' slot occupancy and the minimap overviews the budget left
 * out.
 */
function gpuPoolOf(report: GpuMemoryReport | null): HudPoolView {
  // With no worker to ask, absent rather than a confident zero.
  if (!report) return { label: "GPU", text: "not reported", fill: null, state: "not reported", tone: "absent" };
  const text = `${formatMiB(report.bytes)} / ${formatMiB(report.budgetBytes)} MiB`;
  const slots = `${formatCount(report.slotsHeld)} of ${formatCount(report.slots)} slots`;
  const refused = report.overviewsRefused > 0 ? ` · ${formatCount(report.overviewsRefused)} minimap overviews left out` : "";
  const fill = report.budgetBytes > 0 ? report.bytes / report.budgetBytes : null;
  if (fill === null) return { label: "GPU", text: `${formatMiB(report.bytes)} MiB`, fill, state: slots + refused, tone: "info" };
  if (fill >= 0.98) return { label: "GPU", text, fill, state: `at budget · ${slots}${refused}`, tone: "busy" };
  if (fill >= 0.9) return { label: "GPU", text, fill, state: `near budget · ${slots}${refused}`, tone: "busy" };
  return { label: "GPU", text, fill, state: `under budget · ${slots}${refused}`, tone: "ok" };
}

function levelOf(level: HudLevelSample): HudLevelView {
  const target = level.target
    ? `${formatRange(level.target)}${level.pinned ? " (pinned)" : ""}`
    : "none";
  const displayed = level.displayed ? formatRange(level.displayed) : "none";
  const text = `target ${target} · displayed ${displayed}`;
  if (!level.target) return { name: level.name, text, state: "no target", tone: "absent" };
  if (!level.displayed) return { name: level.name, text, state: "nothing on screen", tone: "absent" };
  if (level.displayed.max > level.target.max) {
    return { name: level.name, text, state: "coarser than target", tone: "busy" };
  }
  if (level.displayed.min < level.target.min) {
    return { name: level.name, text, state: "finer than target", tone: "info" };
  }
  return { name: level.name, text, state: "at target", tone: "ok" };
}

const REASONS: Record<string, string> = {
  interactive_dirty: "view changed, frame pending",
  residency_dirty: "chunks arrived, frame pending",
  frame_in_flight: "frame in flight",
  pending_unclassified: "queue too deep to classify",
  chunks_in_flight: "chunks in flight",
  chunks_pending: "chunks pending",
  uploads_unanswered: "renderer still placing chunks",
  detail_not_resident: "detail not yet resident",
  coarse_not_resident: "coarse not yet resident",
};

function quiescenceOf(quiescence: HudQuiescenceSample | null): HudStatusView {
  if (!quiescence) {
    return { label: "unpublished", detail: "the page has not published quiescence yet", tone: "absent" };
  }
  if (quiescence.quiescent && quiescence.reason === "coverage_limited") {
    return { label: "quiescent", detail: "settled covering what the memory budgets hold", tone: "ok" };
  }
  if (quiescence.quiescent) {
    return { label: "quiescent", detail: "nothing pending, nothing in flight, the view resident", tone: "ok" };
  }
  return {
    label: "working",
    detail: REASONS[quiescence.reason] ?? quiescence.reason.replace(/_/g, " "),
    tone: "busy",
  };
}

function adapterOf(gpu: GpuIdentity | null): HudView["adapter"] {
  if (!gpu) {
    return { label: "adapter not identified", detail: "no WebGPU adapter resolved", tone: "absent", warning: false };
  }
  const name = gpu.description.length > 0 ? gpu.description : adapterName(gpu);
  const kind = adapterKindOf(gpu).kind;
  if (kind === "software-fallback") {
    // The warning leads and the name follows: this is the live fallback-adapter
    // warning in the product, so the line must read as one.
    return { label: "software fallback", detail: `warning: ${name} renders on the CPU`, tone: "warn", warning: true };
  }
  if (kind === "hardware") return { label: name, detail: "hardware adapter", tone: "ok", warning: false };
  return { label: name, detail: "adapter kind not recorded", tone: "absent", warning: false };
}

function formatRange(range: LevelRange): string {
  return range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e9) return `${(bytesPerSecond / 1e9).toFixed(1)} GB/s`;
  if (bytesPerSecond >= 1e6) return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1e3) return `${(bytesPerSecond / 1e3).toFixed(1)} kB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

export function formatMiB(bytes: number): string {
  if (!Number.isFinite(bytes)) return "no";
  const mib = bytes / (1024 * 1024);
  if (mib === 0 || mib >= 10) return String(Math.round(mib));
  return mib.toFixed(1).replace(/\.0$/, "");
}

export function formatMs(ms: number): string {
  return `${ms >= 100 ? Math.round(ms) : ms.toFixed(1)} ms`;
}

// Kept rather than built per call, for the reason `formatCount.ts` gives.
const COUNTS = new Intl.NumberFormat("en-US");

function formatCount(n: number): string {
  return COUNTS.format(n);
}
