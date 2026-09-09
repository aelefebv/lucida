/**
 * The overlay's draw list: what color each chunk cell wears, what it says on
 * hover, and which cell the pointer is over. Pure, so the same function
 * serves the slice overlay, the volume overlay once its boxes are projected,
 * and a test over fixture documents.
 *
 * Two of the modes read the trace rather than the cache. Phase color paints
 * the phase the chunk's newest row is in, from the shared palette, so a
 * chunk in the wire phase is the color the timeline gives the wire phase.
 * Churn tint paints how many times the chunk was fetched in a stated window,
 * so an eviction and refetch loop is a picture. Both read a
 * {@link ChunkReading}, which the recorder answers for the open interval and
 * the derivation answers for a document, and both say in words what they
 * cannot show: a chunk with no row was resident before the interval opened,
 * is still queued, or was never wanted, and the cell says so rather than
 * wearing a color.
 */

import type { EvictionTier } from "../pipeline/fetch/index.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { formatMs } from "../monitor/monitorModel.ts";
import { ROW_STATE_COLORS, withAlpha } from "../monitor/timelinePalette.ts";
import type { ChunkReading } from "../trace/diagnose/chunkStates.ts";
import { describeState } from "../trace/diagnose/rowState.ts";
import type { ChunkLookup, RowState } from "../trace/diagnose/types.ts";

export type ChunkStatus = "cached" | "in-flight" | "planned";
export type DisplayTier = ResidencyTier | "missing";

/**
 * One chunk cell the overlay projected: which chunk it is, where it is on
 * screen, and what the cache says about it. The identity fields are the
 * trace's `ChunkCoordinates`, so a cell is handed to the recorder as it is.
 */
export interface ChunkCell {
  key: string;
  datasetId: string;
  entityId: string;
  chunkKey: string;
  level: number;
  t: number;
  c: number;
  z: number;
  /** Chunk indices along the two image axes. */
  y: number;
  x: number;
  /** CSS pixels, relative to the viewer canvas. */
  left: number;
  top: number;
  width: number;
  height: number;
  status: ChunkStatus;
  /** Current render tier visible to the shader, or missing fallback. */
  sourceTier?: DisplayTier;
  /** For a planned cell: zero-based rank in the pending fetch queue, or undefined when not queued. */
  priorityRank?: number;
  /** For a cached cell: its eviction tier, or null when the lookup failed. */
  tier?: EvictionTier | null;
  /**
   * True for the one rectangle a group served by a proxy asset gets. Not a
   * chunk, so it has no row: the trace-reading modes leave it to the cache
   * colors and say what it is. Its identity fields are placeholders.
   */
  proxyAsset?: boolean;
}

/** The color modes over the chunk grid. Each gates on its own toggle. */
export interface OverlayModes {
  chunkTier: boolean;
  cachedTier: boolean;
  plannedRank: boolean;
  phaseColor: boolean;
  churnTint: boolean;
}

export interface ChunkDrawItem {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fill: string;
  border: string;
  /** The cell's tier and cache status in one phrase. */
  status: string;
  /** The cell in one line: the status, then phase and churn when those modes are on. */
  tooltip: string;
  /** What the trace says about the chunk, or null when no row carries it. */
  reading: ChunkReading | null;
  cell: ChunkCell;
}

export interface ChunkDrawList {
  items: ChunkDrawItem[];
  /** Cells the trace had a row for. */
  withRow: number;
  /** Cells fetched more than once in the window. */
  churned: number;
}

export interface DrawListInput {
  cells: readonly ChunkCell[];
  modes: OverlayModes;
  /**
   * The trace's reading for a cell, or null when no row carries the chunk.
   * Asked only when phase color or churn tint is on, so the other modes cost
   * the trace nothing.
   */
  readingOf: (cell: ChunkCell) => ChunkReading | null;
  /** The window the churn counts are over, in milliseconds, or null when no interval is open. */
  windowMs: number | null;
}

const SOLID_CACHED = "rgba(80, 220, 120, 0.30)";
const SOLID_IN_FLIGHT = "rgba(240, 200, 70, 0.35)";
const SOLID_PLANNED = "rgba(240, 90, 90, 0.30)";
const TIER_DETAIL = "rgba(80, 220, 120, 0.36)";
const TIER_COARSE = "rgba(245, 205, 70, 0.34)";
const TIER_MISSING = "rgba(245, 70, 70, 0.38)";

/** The default cell border, and the fill a trace-reading mode gives a cell with no row. */
export const CELL_BORDER = "1px solid rgba(255, 255, 255, 0.22)";
export const NO_ROW_FILL = "rgba(255, 255, 255, 0.04)";
const NO_ROW_BORDER = "1px dashed rgba(255, 255, 255, 0.28)";

/** How opaque a phase color is painted over the pixels. */
export const PHASE_FILL_ALPHA = 0.42;

/**
 * The churn bands: one fetch is the normal case and barely tinted; two is
 * the first refetch, and from there the tint warms. The bands are discrete
 * so a loop reads at a glance.
 */
export const CHURN_BANDS: readonly { minFetches: number; fill: string; border: string; label: string }[] = [
  { minFetches: 4, fill: "rgba(230, 50, 50, 0.56)", border: "2px solid rgba(255, 80, 80, 0.95)", label: "4 or more fetches" },
  { minFetches: 3, fill: "rgba(245, 120, 50, 0.48)", border: "2px solid rgba(255, 140, 70, 0.9)", label: "3 fetches" },
  { minFetches: 2, fill: "rgba(240, 190, 60, 0.40)", border: "2px solid rgba(255, 210, 90, 0.85)", label: "2 fetches" },
  { minFetches: 1, fill: "rgba(120, 160, 200, 0.16)", border: CELL_BORDER, label: "1 fetch" },
];

/** The band a fetch count falls in, or null for a chunk the window never fetched. */
export function churnBand(fetches: number): (typeof CHURN_BANDS)[number] | null {
  for (const band of CHURN_BANDS) if (fetches >= band.minFetches) return band;
  return null;
}

/** The churn window as the legend and the tooltips state it. */
export function churnWindowLabel(windowMs: number | null): string {
  if (windowMs === null) return "no interval open";
  return `over the open interval, ${formatSeconds(windowMs)}`;
}

export function buildChunkDrawList(input: DrawListInput): ChunkDrawList {
  const { cells, modes } = input;
  const readsTrace = modes.phaseColor || modes.churnTint;
  const items: ChunkDrawItem[] = [];
  let withRow = 0;
  let churned = 0;

  for (const cell of cells) {
    const status = statusText(cell, modes);
    if (cell.proxyAsset) {
      items.push({
        key: cell.key,
        left: cell.left,
        top: cell.top,
        width: cell.width,
        height: cell.height,
        fill: cacheFill(cell, modes),
        border: CELL_BORDER,
        status,
        tooltip: `${status} · group proxy asset: not a chunk, so it has no row`,
        reading: null,
        cell,
      });
      continue;
    }
    const reading = readsTrace ? input.readingOf(cell) : null;
    if (reading) withRow += 1;
    const band = modes.churnTint && reading ? churnBand(reading.fetches) : null;
    if (band && reading && reading.fetches >= 2) churned += 1;

    let fill: string;
    let border = CELL_BORDER;
    if (modes.phaseColor) {
      fill = reading ? withAlpha(ROW_STATE_COLORS[reading.state], PHASE_FILL_ALPHA) : NO_ROW_FILL;
      if (!reading) border = NO_ROW_BORDER;
      if (band) border = band.border;
    } else if (modes.churnTint) {
      fill = band ? band.fill : NO_ROW_FILL;
      if (!reading) border = NO_ROW_BORDER;
    } else {
      fill = cacheFill(cell, modes);
    }

    items.push({
      key: cell.key,
      left: cell.left,
      top: cell.top,
      width: cell.width,
      height: cell.height,
      fill,
      border,
      status,
      tooltip: tooltipFor(status, modes, reading, input.windowMs),
      reading,
      cell,
    });
  }
  return { items, withRow, churned };
}

function cacheFill(cell: ChunkCell, modes: OverlayModes): string {
  const tierFill = modes.chunkTier ? tierColor(cell.sourceTier) : null;
  if (tierFill) return tierFill;
  if (cell.status === "cached") return modes.cachedTier ? cachedColor(cell.tier) : SOLID_CACHED;
  if (cell.status === "in-flight") return SOLID_IN_FLIGHT;
  return modes.plannedRank ? plannedColor(cell.priorityRank) : SOLID_PLANNED;
}

function tierColor(tier: DisplayTier | undefined): string | null {
  switch (tier) {
    case "detail":
      return TIER_DETAIL;
    case "coarse":
      return TIER_COARSE;
    case "missing":
      return TIER_MISSING;
    default:
      return null;
  }
}

/**
 * Rank 0 is next to fetch. Discrete bands rather than a gradient, so the
 * grid reads at a glance: orange is imminent, red is soon, dim red is far back.
 */
function plannedColor(rank: number | undefined): string {
  if (rank === undefined) return "rgba(140, 140, 140, 0.20)";
  if (rank < 5) return "rgba(255, 180, 60, 0.50)";
  if (rank < 20) return "rgba(245, 110, 70, 0.40)";
  if (rank < 60) return "rgba(220, 70, 70, 0.32)";
  return "rgba(160, 40, 40, 0.24)";
}

/**
 * Stays in the green family so cached still reads as green, with hue shifts
 * for how at risk the chunk is: active detail bright green, demoted detail
 * pale sage, prefetch teal.
 */
function cachedColor(tier: EvictionTier | null | undefined): string {
  switch (tier) {
    case "active-detail":
      return "rgba(80, 220, 120, 0.36)";
    case "demoted-detail":
      return "rgba(150, 200, 140, 0.30)";
    case "prefetch":
      return "rgba(70, 200, 200, 0.32)";
    default:
      return SOLID_CACHED;
  }
}

function statusText(cell: ChunkCell, modes: OverlayModes): string {
  const status =
    cell.status === "cached"
      ? modes.cachedTier && cell.tier
        ? `cached · tier ${cell.tier}`
        : "cached"
      : cell.status === "in-flight"
        ? "in-flight"
        : modes.plannedRank && cell.priorityRank !== undefined
          ? `planned · queue rank ${cell.priorityRank}`
          : modes.plannedRank
            ? "planned · not in pending queue"
            : "planned";
  return cell.sourceTier ? `${cell.sourceTier} · ${status}` : status;
}

function tooltipFor(
  status: string,
  modes: OverlayModes,
  reading: ChunkReading | null,
  windowMs: number | null,
): string {
  const parts: string[] = [status];
  if (modes.phaseColor || modes.churnTint) {
    if (!reading) parts.push(noRowStatement(windowMs));
    else {
      if (modes.phaseColor) parts.push(`phase ${stateLabel(reading.state)}`);
      if (modes.churnTint) parts.push(churnStatement(reading, windowMs));
    }
  }
  return parts.join(" · ");
}

/** A row state as the legend names it: the table's `unstamped` is the bar's `planned`. */
export function stateLabel(state: RowState): string {
  return state === "unstamped" ? "planned" : state;
}

/** What a cell with no row means, in the words the spatial summary uses. */
export function noRowStatement(windowMs: number | null): string {
  if (windowMs === null) return "no interval open, so no row to read";
  return "no row in the open interval: resident before it opened, still queued, or never wanted";
}

/** A chunk's fetch count with its window, so the count has a denominator. */
export function churnStatement(reading: ChunkReading, windowMs: number | null): string {
  const times = reading.fetches === 1 ? "once" : `${reading.fetches}×`;
  return `fetched ${times} ${churnWindowLabel(windowMs)}`;
}

/**
 * The cell under a point, or null. Cells overlap where a coarse chunk sits
 * behind the detail chunks it covers, so the smallest cell containing the
 * point wins: it is the most specific thing the pointer is over.
 */
export function hitTestChunk(items: readonly ChunkDrawItem[], x: number, y: number): ChunkDrawItem | null {
  let best: ChunkDrawItem | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (x < item.left || y < item.top || x > item.left + item.width || y > item.top + item.height) continue;
    const area = item.width * item.height;
    if (area < bestArea) {
      best = item;
      bestArea = area;
    }
  }
  return best;
}

/** What the hover inspector shows for one cell. */
export interface InspectorView {
  title: string;
  lines: string[];
}

/**
 * The hover inspector's text for the cell under the pointer, from the
 * document's chunk lookup: the newest row's phase, its queue rank and its
 * age, and how many times the window fetched it. `lookup` is null when no
 * interval is open, and a lookup with no rows says the chunk is not in the
 * interval rather than showing a blank.
 *
 * The lookup lists a chunk's oldest rows and caps the list, so on a chunk
 * fetched more times than the cap its newest listed row is not the newest
 * row. The phase and the age come from the cell's reading when there is one,
 * which the identity index takes from the true newest row and which is what
 * the cell's color came from; the lookup's newest listed row supplies the
 * rank, and the text says when that row is not the newest.
 */
export function describeHoverInspector(
  item: ChunkDrawItem,
  lookup: ChunkLookup | null,
  windowMs: number | null,
): InspectorView {
  const { cell, reading } = item;
  const title = `${cell.entityId} · ${cell.chunkKey}`;
  const lines: string[] = [item.status];
  if (!lookup) {
    lines.push(noRowStatement(null));
    return { title, lines };
  }
  if (lookup.rowCount === 0) {
    lines.push(noRowStatement(windowMs));
    return { title, lines };
  }
  const listed = lookup.rows[lookup.rows.length - 1];
  const capped = lookup.rowCount > lookup.rows.length;
  const state = reading ? reading.state : listed.state;
  const lastPhase = !capped && listed.phases.length > 0 ? listed.phases[listed.phases.length - 1] : null;
  lines.push(
    `phase: ${describeState(state)}` +
      (lastPhase && state !== lastPhase.phase ? ` · ${lastPhase.phase} took ${formatMs(lastPhase.durationMs)}` : ""),
  );
  const rankOf = capped ? "queue rank of the newest listed row" : "queue rank";
  lines.push(
    listed.queue
      ? `${rankOf}: ${listed.queue.aheadAtAdmission.toLocaleString()} ahead at admission · ` +
          `${listed.queue.overtaken.toLocaleString()} overtook it · waited ${formatMs(listed.queue.waitedMs)}` +
          (listed.queue.dispatched ? "" : " · not dispatched yet")
      : `${rankOf}: never entered the queue`,
  );
  const ageMs = reading ? reading.ageMs : listed.ageMs;
  lines.push(ageMs === null ? "age: no boundary reached" : `age: ${formatMs(ageMs)}`);
  if (reading) lines.push(churnStatement(reading, windowMs));
  if (capped) {
    lines.push(
      `${lookup.rowCount} rows carry this chunk; the ${lookup.rows.length} oldest are listed, and the newest is not among them`,
    );
  } else if (lookup.rowCount > 1) {
    lines.push(`${lookup.rowCount} rows carry this chunk; the newest is shown`);
  }
  if (lookup.eventCount > 0) {
    const last = lookup.events[lookup.events.length - 1];
    lines.push(`${lookup.eventCount} event(s), last ${last.kind} (${last.reason}) at ${formatMs(last.atMs)}`);
  }
  lines.push("ranks and ages count recorded rows only");
  return { title, lines };
}

/**
 * What an empty picture means, for the caption the overlay shows when a
 * trace-reading mode is on and paints nothing. Null when there is nothing
 * to say: the mode is off, or the picture has something in it.
 */
export function overlayAbsence(modes: OverlayModes, list: ChunkDrawList, windowMs: number | null): string | null {
  if (!modes.phaseColor && !modes.churnTint) return null;
  if (windowMs === null) return "no interval is open, so the trace has no row to color a chunk by";
  if (list.items.length === 0) return "no chunk on screen to color: nothing is planned for this view";
  if (list.withRow === 0) {
    const mode = modes.phaseColor ? "phase" : "churn";
    return (
      `${mode}: no chunk on screen has a row in the open interval (${formatSeconds(windowMs)}); ` +
      "each was resident before it opened, is still queued, or was never wanted"
    );
  }
  // With phase color on, the picture is painted, so a quiet churn is not an
  // empty picture and gets no caption.
  if (modes.churnTint && !modes.phaseColor && list.churned === 0) {
    return `churn: no chunk on screen was fetched more than once in the open interval (${formatSeconds(windowMs)})`;
  }
  return null;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)} s`;
}
