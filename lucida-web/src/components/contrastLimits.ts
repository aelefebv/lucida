/**
 * The contrast slider's span: the data type's whole range, or the loaded
 * data's, and always wide enough to hold the current limits so a thumb never
 * sits off its track. Typed limits clamp to the same span as the thumbs.
 *
 * A float type has no whole range a slider could resolve, so its span is the
 * loaded data's, or only the limits before any has loaded.
 */
export function contrastBounds(
  contrastMin: number,
  contrastMax: number,
  dataRange: { min: number; max: number } | null,
  valueRange: readonly [number, number] | null,
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
