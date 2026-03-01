export type ContrastWindow = {
  min: number;
  max: number;
};

const MIN_SAMPLE_VALUE = 0;
const MAX_SAMPLE_VALUE = 255;

export function normalizeContrastWindow(
  window: ContrastWindow,
  sampleMax = MAX_SAMPLE_VALUE,
): ContrastWindow {
  const normalizedSampleMax = normalizeSampleMax(sampleMax);
  let min = clampSampleValue(window.min, normalizedSampleMax);
  let max = clampSampleValue(window.max, normalizedSampleMax);
  if (max <= min) {
    if (min >= normalizedSampleMax) {
      min = normalizedSampleMax - 1;
      max = normalizedSampleMax;
    } else {
      max = min + 1;
    }
  }
  return { min, max };
}

export function autoContrastWindow(
  min: number,
  max: number,
  sampleMax = MAX_SAMPLE_VALUE,
): ContrastWindow {
  const normalizedSampleMax = normalizeSampleMax(sampleMax);
  const minClamped = clampSampleValue(min, normalizedSampleMax);
  const maxClamped = clampSampleValue(max, normalizedSampleMax);
  if (maxClamped <= minClamped) {
    return {
      min: MIN_SAMPLE_VALUE,
      max: normalizedSampleMax,
    };
  }
  return {
    min: minClamped,
    max: maxClamped,
  };
}

export function applyContrastWindowToSamples(
  samples: Uint16Array,
  window: ContrastWindow,
  sampleMax = MAX_SAMPLE_VALUE,
): Uint8ClampedArray {
  const normalized = normalizeContrastWindow(window, sampleMax);
  const out = new Uint8ClampedArray(samples.length * 4);
  const span = normalized.max - normalized.min;
  for (let i = 0; i < samples.length; i += 1) {
    const value = remapSample(samples[i] ?? 0, normalized.min, span);
    const offset = i * 4;
    out[offset] = value;
    out[offset + 1] = value;
    out[offset + 2] = value;
    out[offset + 3] = 255;
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

function clampSampleValue(value: number, sampleMax: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SAMPLE_VALUE;
  }
  if (value < MIN_SAMPLE_VALUE) {
    return MIN_SAMPLE_VALUE;
  }
  if (value > sampleMax) {
    return sampleMax;
  }
  return Math.round(value);
}

function normalizeSampleMax(value: number): number {
  if (!Number.isFinite(value)) {
    return MAX_SAMPLE_VALUE;
  }
  const rounded = Math.round(value);
  if (rounded < 1) {
    return 1;
  }
  return rounded;
}
