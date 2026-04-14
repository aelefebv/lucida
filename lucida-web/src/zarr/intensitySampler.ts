/** Sample min/max intensity from a typed array, examining at most `maxSamples` elements. */
export function sampleIntensityRange(
  data: Uint8Array | Uint16Array,
  maxSamples = 100000,
): { min: number; max: number } {
  let min = 65535, max = 0;
  const step = Math.max(1, Math.floor(data.length / maxSamples));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
