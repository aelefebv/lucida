export type ContrastWindow = {
  min: number;
  max: number;
};

const MIN_SAMPLE_VALUE = 0;
const MAX_SAMPLE_VALUE = 255;

export function normalizeContrastWindow(window: ContrastWindow): ContrastWindow {
  let min = clampSampleValue(window.min);
  let max = clampSampleValue(window.max);
  if (max <= min) {
    if (min >= MAX_SAMPLE_VALUE) {
      min = MAX_SAMPLE_VALUE - 1;
      max = MAX_SAMPLE_VALUE;
    } else {
      max = min + 1;
    }
  }
  return { min, max };
}

export function autoContrastWindow(min: number, max: number): ContrastWindow {
  const minClamped = clampSampleValue(min);
  const maxClamped = clampSampleValue(max);
  if (maxClamped <= minClamped) {
    return {
      min: MIN_SAMPLE_VALUE,
      max: MAX_SAMPLE_VALUE,
    };
  }
  return {
    min: minClamped,
    max: maxClamped,
  };
}

export function applyContrastWindowToRgba(
  rgba: Uint8ClampedArray,
  window: ContrastWindow,
): Uint8ClampedArray {
  const normalized = normalizeContrastWindow(window);
  const out = new Uint8ClampedArray(rgba.length);
  const span = normalized.max - normalized.min;
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = remapSample(rgba[i] ?? 0, normalized.min, span);
    out[i + 1] = remapSample(rgba[i + 1] ?? 0, normalized.min, span);
    out[i + 2] = remapSample(rgba[i + 2] ?? 0, normalized.min, span);
    out[i + 3] = rgba[i + 3] ?? 255;
  }
  return out;
}

function remapSample(value: number, min: number, span: number): number {
  if (value <= min) {
    return 0;
  }
  if (value >= min + span) {
    return 255;
  }
  return Math.round(((value - min) * 255) / span);
}

function clampSampleValue(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SAMPLE_VALUE;
  }
  if (value < MIN_SAMPLE_VALUE) {
    return MIN_SAMPLE_VALUE;
  }
  if (value > MAX_SAMPLE_VALUE) {
    return MAX_SAMPLE_VALUE;
  }
  return Math.round(value);
}
