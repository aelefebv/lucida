/**
 * The timeline's palette: one colour per phase, lane, client message type,
 * event mark, and interval kind.
 *
 * Kept in a module of its own so a surface that colours the same states in
 * space, the overlay's phase mode, can import the same table. A chunk in the
 * wire phase should be one colour in space and in time, and two tables is
 * two chances for them to differ. The phase colours are the ones the live
 * view's phase bar has used since it shipped.
 */

import type { ClientMessageType, LaneName, Phase } from "../trace/types.ts";
import type { RowState, TimelineChartId } from "../trace/diagnose/types.ts";
import type { TimelineMark } from "../trace/diagnose/timeline.ts";

/** One colour per phase, in the order work moves through them. */
export const PHASE_COLORS: Record<Phase, string> = {
  plan: "#8a7fb0",
  queue: "#c9a227",
  wire: "#6f8fd1",
  decode: "#7fb07f",
  upload: "#d18f6f",
  present: "#d1c46f",
};

/** Rows that have stamped no boundary yet: planned, not admitted. */
export const PLANNED_COLOR = "#4a4a4a";

/**
 * The two ways a row ends. Only the overlay paints them: the live bar and
 * the occupancy chart show rows in flight, which a finished row has left.
 */
export const ENDING_COLORS = {
  complete: "#4f8f5f",
  retired: "#8f4f4f",
} as const;

/**
 * One colour per row state, for the overlay's phase colour mode: the phases
 * from {@link PHASE_COLORS}, the planned residual, and the two endings. The
 * phases are the bar's and the occupancy chart's own entries, not copies, so
 * a chunk in the wire phase is one colour in space and in time.
 */
export const ROW_STATE_COLORS: Record<RowState, string> = {
  ...PHASE_COLORS,
  unstamped: PLANNED_COLOR,
  ...ENDING_COLORS,
};

/** A palette colour with an alpha, as `rgba(r, g, b, a)`, for a surface that paints over pixels. */
export function withAlpha(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const LANE_COLORS: Record<LaneName, string> = {
  minimap: "#d1c46f",
  detail: "#6f8fd1",
  coarse: "#8a7fb0",
  prefetch: "#7fb07f",
  overview: "#7d8288",
};

export const MESSAGE_COLORS: Record<ClientMessageType, string> = {
  chunkRequest: "#6f8fd1",
  assetRequest: "#8a7fb0",
  viewerInterest: "#7fb07f",
  presence: "#d1c46f",
  datasetPresence: "#c9a227",
  cursor: "#d18f6f",
  command: "#d1665b",
  other: "#7d8288",
};

export const MARK_COLORS: Record<TimelineMark, string> = {
  eviction: "#d1665b",
  rejection: "#c9a227",
  retry: "#d18f6f",
  failure: "#ff6b6b",
  "level-change": "#6f8fd1",
  reconnect: "#8a7fb0",
  plan: "#5a5a5a",
};

const METADATA_COLORS: Record<string, string> = {
  "dataset-open": "#8a7fb0",
  "cache-hit": "#7fb07f",
  "coalesced-wait": "#c9a227",
  "backend-read": "#6f8fd1",
};

const SERIES_COLORS: Partial<Record<TimelineChartId, Record<string, string>>> = {
  "occupancy.browser": PHASE_COLORS,
  "occupancy.server": { bracket: PHASE_COLORS.wire },
  "occupancy.metadata": METADATA_COLORS,
  "in-flight": { "in-flight": PHASE_COLORS.wire, pending: PHASE_COLORS.queue },
  "in-flight.lane": LANE_COLORS,
  "planned.lane": LANE_COLORS,
  "bytes.sent": MESSAGE_COLORS,
  "bytes.received": MESSAGE_COLORS,
  resident: { total: PHASE_COLORS.upload },
  events: MARK_COLORS,
  frame: { "main-thread": PHASE_COLORS.present, "gpu-pass": PHASE_COLORS.decode },
};

/** A series' colour, and a neutral grey for a series the table does not name. */
export function seriesColor(chart: TimelineChartId, series: string): string {
  return SERIES_COLORS[chart]?.[series] ?? "#9aa0a6";
}

/** A run's band on the axis, the steady state's ribbon, and the run being read. */
export const BAND_COLORS = {
  run: "#3b4a6b",
  "steady-state": "#262626",
  current: "#6f8fd1",
} as const;

/** The dock's canvas: background, gridlines, and the two text tones. */
export const CANVAS_COLORS = {
  background: "#141414",
  row: "#1a1a1a",
  grid: "#2c2c2c",
  text: "#b9bcc0",
  dim: "#7d8288",
  absent: "#c9a227",
} as const;
