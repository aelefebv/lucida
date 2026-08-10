// PROTOTYPE — throwaway. Deterministic RNG so every sample in the docs is byte-stable.

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Draw from a distribution described the way the research notes describe one:
 * by its percentiles. Piecewise-linear between the quoted points, which is
 * enough realism for a sample and keeps the numbers traceable to the source.
 */
export function fromPercentiles(next, { min, p50, p90, p95, p99, max }) {
  const u = next();
  const seg = (lo, hi, ulo, uhi) => lo + ((u - ulo) / (uhi - ulo)) * (hi - lo);
  if (u < 0.5) return seg(min, p50, 0, 0.5);
  if (u < 0.9) return seg(p50, p90, 0.5, 0.9);
  if (u < 0.95) return seg(p90, p95, 0.9, 0.95);
  if (u < 0.99) return seg(p95, p99, 0.95, 0.99);
  return seg(p99, max, 0.99, 1);
}
