import { useMemo } from "react";
import { useLocale } from "react-aria-components";
import { RangeBar, ValueField } from "../ui/index.ts";
import { columnHeights, type ValueHistogram } from "../pipeline/valueHistogram.ts";
import {
  contrastBounds,
  narrowestSpan,
  orderLimits,
  spanHolding,
  typedLimit,
  visibleSpan,
  zoomSpan,
} from "./contrastLimits.ts";
import { shortestFloat32Text } from "./pixelReadout.ts";
import type { ContrastZoom } from "./useContrastZoom.ts";
import "./ContrastLimits.css";

interface Props {
  contrastMin: number;
  contrastMax: number;
  /** The range the loaded data spans, or `null` before any has loaded. */
  dataRange: { min: number; max: number } | null;
  /** Every value the data type holds, or `null` for a type without bounds. */
  valueRange: readonly [number, number] | null;
  /** Whole-number data steps by 1; other data by a thousandth of the span in view. */
  integer: boolean;
  /** Span the bar over the data type's whole range instead of the loaded data's. */
  fullRange: boolean;
  /** The loaded values, drawn behind the bar, or `null` before any have loaded. */
  histogram: ValueHistogram | null;
  onContrastChange: (min: number, max: number) => void;
  /** The bar's zoomed span, or `null` for its full span, as `useContrastZoom` holds it. */
  zoom: ContrastZoom | null;
  onZoomChange: (zoom: ContrastZoom | null) => void;
}

/**
 * The contrast limits as two fields over a bar with the channel's histogram
 * behind it. Scrolling zooms the bar's span and double-clicking resets it;
 * neither moves a limit. It fills its container's width, and the owner sets
 * the bar's height with `--lc-range-bar-h` and holds its zoom.
 */
export function ContrastLimits({
  contrastMin,
  contrastMax,
  dataRange,
  valueRange,
  integer,
  fullRange,
  histogram,
  onContrastChange,
  zoom,
  onZoomChange,
}: Props) {
  const { locale } = useLocale();
  // The fields show each limit whole. The renderer applies a limit in float32,
  // so a float limit shows the fewest digits that name the same float32, up to
  // the nine any float32 needs, and an integer limit shows every digit.
  const format: Intl.NumberFormatOptions = integer
    ? { maximumFractionDigits: 0, useGrouping: false }
    : { maximumSignificantDigits: 9, useGrouping: false };
  const formatter = new Intl.NumberFormat(locale, format);
  const shown = (limit: number) => (integer ? limit : Number(shortestFloat32Text(limit)));
  const shownMin = shown(contrastMin);
  const shownMax = shown(contrastMax);
  // The bar places the limits as shown, which can fall just past the float32
  // the data range ends on, so the span holds them as shown.
  const full = contrastBounds(shownMin, shownMax, dataRange, valueRange, fullRange);
  const zoomed = zoom && zoom.fullRange === fullRange ? zoom.span : null;
  const span = visibleSpan(zoomed, full);
  const width = span[1] - span[0];
  const step = integer ? 1 : width > 0 ? width / 1000 : 0.001;

  /** Sets the limits, keeping the minimum below the maximum; returns what it set. */
  const apply = (next: readonly [number, number]): [number, number] => {
    const [lo, hi] = orderLimits(next, shownMin, step);
    // A limit left where it showed keeps the value it holds.
    const nextMin = lo === shownMin ? contrastMin : lo;
    const nextMax = hi === shownMax ? contrastMax : hi;
    if (nextMin !== contrastMin || nextMax !== contrastMax) onContrastChange(nextMin, nextMax);
    return [nextMin, nextMax];
  };

  // A typed limit can sit anywhere the data type holds, so a zoomed span
  // grows to show it, as the full span does.
  const onTyped = (index: 0 | 1, typed: number) => {
    if (!Number.isFinite(typed)) return;
    const v = typedLimit(typed, integer, valueRange);
    const set = apply(index === 0 ? [Math.min(v, shownMax), shownMax] : [shownMin, Math.max(v, shownMin)]);
    const moved = set.filter((limit, i) => limit !== [contrastMin, contrastMax][i]).map(shown);
    if (!zoomed || moved.length === 0) return;
    const grown = spanHolding(zoomed, ...moved);
    const nextFull = contrastBounds(shown(set[0]), shown(set[1]), dataRange, valueRange, fullRange);
    onZoomChange(grown[0] <= nextFull[0] && grown[1] >= nextFull[1] ? null : { span: grown, fullRange });
  };

  return (
    <div className="lc-contrast-limits">
      <div className="lc-contrast-limits-header">
        <span className="lc-contrast-limits-label">Contrast</span>
        <span className="lc-contrast-limits-fields">
          <ValueField
            label="Contrast minimum"
            value={shownMin}
            step={step}
            formatOptions={format}
            onCommit={(v) => onTyped(0, v)}
          />
          <span className="lc-contrast-limits-separator">–</span>
          <ValueField
            label="Contrast maximum"
            value={shownMax}
            step={step}
            formatOptions={format}
            onCommit={(v) => onTyped(1, v)}
          />
        </span>
      </div>
      <RangeBar
        label="Contrast"
        value={[shownMin, shownMax]}
        span={span}
        step={step}
        formatValue={(v) => formatter.format(v)}
        isZoomed={zoomed !== null}
        onChange={apply}
        onZoom={(anchor, factor) => {
          const next = zoomSpan(span, anchor, factor, full, narrowestSpan(full, integer));
          onZoomChange(next ? { span: next, fullRange } : null);
        }}
        onZoomReset={() => onZoomChange(null)}
      >
        {histogram && <HistogramShape histogram={histogram} lo={span[0]} hi={span[1]} />}
      </RangeBar>
    </div>
  );
}

/** Columns the histogram draws across the bar, a pixel or two wide at the widths a bar takes. */
const COLUMNS = 256;

/** The histogram from `lo` to `hi`, as a filled outline that stretches to the bar. */
function HistogramShape({ histogram, lo, hi }: { histogram: ValueHistogram; lo: number; hi: number }) {
  const d = useMemo(() => {
    const heights = columnHeights(histogram, lo, hi, COLUMNS);
    let path = "M0 1";
    for (let c = 0; c < COLUMNS; c++) path += `V${(1 - heights[c]).toFixed(4)}h1`;
    return `${path}V1Z`;
  }, [histogram, lo, hi]);
  return (
    <svg
      className="lc-contrast-histogram"
      viewBox={`0 0 ${COLUMNS} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="contrast-histogram"
    >
      <path d={d} />
    </svg>
  );
}
