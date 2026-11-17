type Span = readonly [number, number];

/**
 * The contrast bar's full span: the data type's whole range, or the loaded
 * data's, and always wide enough to hold the current limits so a handle
 * never sits off its bar.
 *
 * A float type has no whole range a bar could resolve, so its span is the
 * loaded data's, or only the limits before any has loaded.
 */
export function contrastBounds(
  contrastMin: number,
  contrastMax: number,
  dataRange: { min: number; max: number } | null,
  valueRange: Span | null,
  fullRange: boolean,
): [number, number] {
  const [lo, hi] = (fullRange || !dataRange) && valueRange
    ? valueRange
    : dataRange
      ? [dataRange.min, dataRange.max]
      : [contrastMin, contrastMax];
  return [Math.min(lo, contrastMin), Math.max(hi, contrastMax)];
}

/**
 * Keeps the minimum strictly below the maximum, moving whichever limit the
 * user did not just set.
 */
export function orderLimits(
  next: readonly [number, number],
  previousMin: number,
  step: number,
): [number, number] {
  const [lo, hi] = next;
  if (hi - lo >= step) return [lo, hi];
  return lo !== previousMin ? [hi - step, hi] : [lo, lo + step];
}

/**
 * A typed limit as the data type holds it: an integer type's rounded and
 * held to the values the type holds, a float type's as typed. The bar's
 * span plays no part, since it grows to show whatever is typed.
 */
export function typedLimit(value: number, integer: boolean, valueRange: Span | null): number {
  if (!integer) return value;
  const whole = Math.round(value);
  return valueRange ? Math.min(valueRange[1], Math.max(valueRange[0], whole)) : whole;
}

/**
 * The narrowest span a zoom reaches: ten values of an integer type. A float
 * type has no smallest step, so it stops at a ten-thousandth of the full span.
 */
export function narrowestSpan(full: Span, integer: boolean): number {
  return integer ? 10 : (full[1] - full[0]) / 10_000;
}

/**
 * `span` zoomed by `factor` about `anchor`, which keeps its place on the
 * bar, and held inside `full`. `null` once it would cover all of `full`,
 * which is the span unzoomed.
 */
export function zoomSpan(span: Span, anchor: number, factor: number, full: Span, narrowest: number): [number, number] | null {
  const fullWidth = full[1] - full[0];
  const width = Math.max(narrowest, (span[1] - span[0]) * factor);
  if (!(width < fullWidth)) return null;
  const at = span[1] > span[0] ? (anchor - span[0]) / (span[1] - span[0]) : 0.5;
  const lo = Math.min(full[1] - width, Math.max(full[0], anchor - at * width));
  return [lo, lo + width];
}

/** A zoomed span as the bar shows it: the part inside `full`, or all of `full` once none of it is. */
export function visibleSpan(zoom: Span | null, full: Span): [number, number] {
  if (!zoom) return [full[0], full[1]];
  const lo = Math.max(zoom[0], full[0]);
  const hi = Math.min(zoom[1], full[1]);
  return hi > lo ? [lo, hi] : [full[0], full[1]];
}

/** `span` grown to hold `values`. */
export function spanHolding(span: Span, ...values: number[]): [number, number] {
  return [Math.min(span[0], ...values), Math.max(span[1], ...values)];
}
