/**
 * The timeline's palette: one colour per phase, lane, client message type,
 * event mark, and interval kind.
 *
 * Every entry is a theme token written as `var(--lc-...)`, so DOM
 * styles take it as it is and follow the theme on their own, and a canvas
 * reads it through {@link resolveColor}. A chart's own series take the
 * categorical slots in the chart's series order, because the slots are ordered
 * so that neighbours stay apart in both presets.
 *
 * Kept in a module of its own so a surface that colours the same states in
 * space, the overlay's phase mode, can import the same table. A chunk in the
 * wire phase should be one colour in space and in time, and two tables is
 * two chances for them to differ.
 */

import { subscribeAppearance } from "../theme/appearance.ts";
import { readColorToken, TOKEN_NAMES, type ResolvedColor, type TokenName } from "../theme/tokens.ts";
import { PHASES, type ClientMessageType, type LaneName, type Phase } from "../trace/types.ts";
import type { RowState, TimelineChartId } from "../trace/diagnose/types.ts";
import type { TimelineMark } from "../trace/diagnose/timeline.ts";

function token(name: TokenName): string {
  return `var(${name})`;
}

const CHART_SLOTS = [
  "--lc-chart-1",
  "--lc-chart-2",
  "--lc-chart-3",
  "--lc-chart-4",
  "--lc-chart-5",
  "--lc-chart-6",
  "--lc-chart-7",
  "--lc-chart-8",
] as const satisfies readonly TokenName[];

/** A series that is not one of a chart's own: "other", the default, a row not yet admitted. */
const NEUTRAL = token("--lc-chart-neutral");

/**
 * The slots in order, one per key. Slots are never cycled: a repeated colour
 * would read as the same series, so a key past the eighth takes the neutral.
 */
function slots<K extends string>(keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(
    keys.map((key, i) => [key, i < CHART_SLOTS.length ? token(CHART_SLOTS[i]) : NEUTRAL]),
  ) as Record<K, string>;
}

/** One colour per phase, in the order work moves through them. */
export const PHASE_COLORS: Record<Phase, string> = slots(PHASES);

/** Rows that have stamped no boundary yet: planned, not admitted. */
export const PLANNED_COLOR = NEUTRAL;

/**
 * The two ways a row ends. Only the overlay paints them: the live bar and
 * the occupancy chart show rows in flight, which a finished row has left.
 * They take the two slots after the six phases, so every row state is a
 * slot of its own.
 */
export const ENDING_COLORS = {
  complete: token("--lc-chart-7"),
  retired: token("--lc-chart-8"),
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

export const LANE_COLORS: Record<LaneName, string> = {
  ...slots(["minimap", "detail", "coarse", "prefetch"] as const),
  overview: NEUTRAL,
};

export const MESSAGE_COLORS: Record<ClientMessageType, string> = {
  ...slots(["chunkRequest", "assetRequest", "viewerInterest", "presence", "datasetPresence", "cursor", "command"] as const),
  other: NEUTRAL,
};

export const MARK_COLORS: Record<TimelineMark, string> = {
  ...slots(["eviction", "rejection", "retry", "failure", "level-change", "reconnect"] as const),
  plan: NEUTRAL,
};

const METADATA_COLORS: Record<string, string> = slots([
  "dataset-open",
  "cache-hit",
  "coalesced-wait",
  "backend-read",
] as const);

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

/** A series' colour, and the neutral for a series the table does not name. */
export function seriesColor(chart: TimelineChartId, series: string): string {
  return SERIES_COLORS[chart]?.[series] ?? NEUTRAL;
}

/** A run's band on the axis, the steady state's ribbon, and the run being read. */
export const BAND_COLORS = {
  run: token("--lc-accent-subtle"),
  "steady-state": token("--lc-border-strong"),
  current: token("--lc-accent"),
} as const;

/** The dock's canvas: background, plot wells, gridlines, and its text tones. */
export const CANVAS_COLORS = {
  background: token("--lc-surface-1"),
  row: token("--lc-field-bg"),
  grid: token("--lc-border-strong"),
  text: token("--lc-text-muted"),
  dim: token("--lc-text-subtle"),
  absent: token("--lc-warning"),
  /** A label on the band of the run being read. */
  onCurrent: token("--lc-text-on-accent"),
} as const;

// ---------------------------------------------------------------------------
// Resolving for a canvas
// ---------------------------------------------------------------------------

const TOKEN_REF = /^var\((--lc-[\w-]+)\)$/;
const KNOWN_TOKENS: ReadonlySet<string> = new Set(TOKEN_NAMES);
const UNRESOLVED: ResolvedColor = { r: 0, g: 0, b: 0, a: 0, css: "transparent" };

/**
 * Resolved colours, read once per appearance. The overlay asks for a colour
 * per chunk per tick, and a token read goes through layout, so the answer is
 * kept until the theme or accent changes.
 */
const resolved = new Map<string, ResolvedColor>();
subscribeAppearance(() => resolved.clear());

/**
 * A palette colour as sRGB, for a surface that paints pixels, read through
 * the browser. Without a document there are no tokens to read, and a colour
 * reads as nothing.
 */
export function resolveColor(color: string): ResolvedColor {
  const known = resolved.get(color);
  if (known) return known;
  const ref = TOKEN_REF.exec(color);
  const out =
    ref && KNOWN_TOKENS.has(ref[1]) && typeof document !== "undefined"
      ? readColorToken(ref[1] as TokenName)
      : UNRESOLVED;
  resolved.set(color, out);
  return out;
}

/** A palette colour with an alpha, as `rgba(r, g, b, a)`, for a surface that paints over pixels. */
export function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = resolveColor(color);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}
