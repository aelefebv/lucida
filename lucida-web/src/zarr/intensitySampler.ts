/**
 * Sample the min/max of the finite values in `data`, examining at most
 * `maxSamples` elements. NaN and infinities have no place on a contrast
 * window's axis, so they are skipped. With no finite value examined the range
 * is `{ min: Infinity, max: -Infinity }`, which widens no running range.
 */
export function sampleIntensityRange(
  data: ArrayLike<number>,
  maxSamples = 100000,
): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  const step = Math.max(1, Math.floor(data.length / maxSamples));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
