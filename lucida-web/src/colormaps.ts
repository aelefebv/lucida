/**
 * Colormap lookup table generation for GPU rendering.
 *
 * Each colormap is a 256-entry RGBA8 ramp (1024 bytes) suitable for upload
 * as a 256x1 texture used by shaders for color lookup.
 */

export const COLORMAP_NAMES: readonly string[] = [
  "gray",
  "magenta",
  "green",
  "cyan",
  "red",
  "blue",
  "yellow",
  "viridis",
  "inferno",
  "plasma",
  "magma",
  "turbo",
  "hot",
  "cool",
  "jet",
] as const;

export const DEFAULT_CHANNEL_COLORMAPS: readonly string[] = [
  "magenta",
  "green",
  "cyan",
] as const;

type RGB = [number, number, number];

const VIRIDIS_SAMPLES: RGB[] = [
  [0.267, 0.004, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.53],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.134, 0.658, 0.518],
  [0.208, 0.718, 0.472],
  [0.327, 0.774, 0.407],
  [0.478, 0.821, 0.318],
  [0.647, 0.858, 0.21],
  [0.825, 0.885, 0.115],
  [0.993, 0.906, 0.144],
];

const INFERNO_SAMPLES: RGB[] = [
  [0.001, 0.0, 0.014],
  [0.09, 0.035, 0.232],
  [0.232, 0.037, 0.387],
  [0.38, 0.044, 0.433],
  [0.523, 0.086, 0.403],
  [0.659, 0.162, 0.328],
  [0.778, 0.268, 0.226],
  [0.871, 0.398, 0.116],
  [0.935, 0.553, 0.051],
  [0.963, 0.72, 0.098],
  [0.947, 0.886, 0.312],
  [0.988, 0.998, 0.645],
  [0.988, 1.0, 0.644],
];

const PLASMA_SAMPLES: RGB[] = [
  [0.05, 0.03, 0.528],
  [0.186, 0.018, 0.59],
  [0.317, 0.012, 0.614],
  [0.445, 0.025, 0.601],
  [0.563, 0.072, 0.551],
  [0.672, 0.133, 0.479],
  [0.764, 0.21, 0.394],
  [0.845, 0.303, 0.299],
  [0.91, 0.411, 0.198],
  [0.957, 0.535, 0.099],
  [0.981, 0.67, 0.035],
  [0.976, 0.813, 0.15],
  [0.94, 0.975, 0.131],
];

const MAGMA_SAMPLES: RGB[] = [
  [0.001, 0.0, 0.014],
  [0.078, 0.042, 0.206],
  [0.209, 0.063, 0.355],
  [0.341, 0.071, 0.432],
  [0.478, 0.094, 0.45],
  [0.613, 0.15, 0.417],
  [0.735, 0.24, 0.35],
  [0.843, 0.364, 0.282],
  [0.926, 0.517, 0.247],
  [0.972, 0.686, 0.322],
  [0.987, 0.845, 0.5],
  [0.987, 0.96, 0.719],
  [0.987, 0.991, 0.75],
];

const TURBO_SAMPLES: RGB[] = [
  [0.19, 0.072, 0.232],
  [0.248, 0.289, 0.596],
  [0.218, 0.498, 0.835],
  [0.145, 0.674, 0.895],
  [0.116, 0.796, 0.775],
  [0.202, 0.878, 0.58],
  [0.383, 0.937, 0.371],
  [0.58, 0.962, 0.213],
  [0.747, 0.942, 0.143],
  [0.878, 0.868, 0.143],
  [0.959, 0.745, 0.165],
  [0.993, 0.586, 0.164],
  [0.982, 0.405, 0.137],
  [0.92, 0.227, 0.098],
  [0.81, 0.093, 0.063],
  [0.659, 0.024, 0.082],
];

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Linearly interpolate an array of normalised RGB samples into a 256-entry
 * RGBA8 Uint8Array (1024 bytes).
 */
function interpolateSamples(samples: RGB[]): Uint8Array {
  const data = new Uint8Array(1024);
  const n = samples.length;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const scaled = t * (n - 1);
    const lo = Math.floor(scaled);
    const hi = Math.min(lo + 1, n - 1);
    const frac = scaled - lo;
    const sLo = samples[lo]!;
    const sHi = samples[hi]!;
    const off = i * 4;
    data[off] = clamp((sLo[0] + (sHi[0] - sLo[0]) * frac) * 255);
    data[off + 1] = clamp((sLo[1] + (sHi[1] - sLo[1]) * frac) * 255);
    data[off + 2] = clamp((sLo[2] + (sHi[2] - sLo[2]) * frac) * 255);
    data[off + 3] = 255;
  }
  return data;
}

type ColormapGenerator = () => Uint8Array;

function makeLinear(
  rFn: (i: number) => number,
  gFn: (i: number) => number,
  bFn: (i: number) => number,
): ColormapGenerator {
  return () => {
    const data = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
      const off = i * 4;
      data[off] = clamp(rFn(i));
      data[off + 1] = clamp(gFn(i));
      data[off + 2] = clamp(bFn(i));
      data[off + 3] = 255;
    }
    return data;
  };
}

function generateHot(): Uint8Array {
  const data = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const off = i * 4;
    let r: number, g: number, b: number;
    if (i <= 95) {
      r = i * (255 / 95);
      g = 0;
      b = 0;
    } else if (i <= 190) {
      r = 255;
      g = (i - 96) * (255 / 94);
      b = 0;
    } else {
      r = 255;
      g = 255;
      b = (i - 191) * (255 / 64);
    }
    data[off] = clamp(r);
    data[off + 1] = clamp(g);
    data[off + 2] = clamp(b);
    data[off + 3] = 255;
  }
  return data;
}

function generateJet(): Uint8Array {
  const data = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const off = i * 4;
    let r: number, g: number, b: number;
    if (i <= 31) {
      r = 0;
      g = 0;
      b = 128 + i * 4;
    } else if (i <= 95) {
      r = 0;
      g = (i - 32) * 4;
      b = 255;
    } else if (i <= 159) {
      r = (i - 96) * 4;
      g = 255;
      b = 255 - (i - 96) * 4;
    } else if (i <= 223) {
      r = 255;
      g = 255 - (i - 160) * 4;
      b = 0;
    } else {
      r = 255 - (i - 224) * 4;
      g = 0;
      b = 0;
    }
    data[off] = clamp(r);
    data[off + 1] = clamp(g);
    data[off + 2] = clamp(b);
    data[off + 3] = 255;
  }
  return data;
}

const GENERATORS: Record<string, ColormapGenerator> = {
  gray: makeLinear((i) => i, (i) => i, (i) => i),
  magenta: makeLinear((i) => i, () => 0, (i) => i),
  green: makeLinear(() => 0, (i) => i, () => 0),
  cyan: makeLinear(() => 0, (i) => i, (i) => i),
  red: makeLinear((i) => i, () => 0, () => 0),
  blue: makeLinear(() => 0, () => 0, (i) => i),
  yellow: makeLinear((i) => i, (i) => i, () => 0),
  cool: makeLinear((i) => i, (i) => 255 - i, () => 255),
  hot: generateHot,
  jet: generateJet,
  viridis: () => interpolateSamples(VIRIDIS_SAMPLES),
  inferno: () => interpolateSamples(INFERNO_SAMPLES),
  plasma: () => interpolateSamples(PLASMA_SAMPLES),
  magma: () => interpolateSamples(MAGMA_SAMPLES),
  turbo: () => interpolateSamples(TURBO_SAMPLES),
};

const cache = new Map<string, Uint8Array>();

/**
 * Return a 1024-byte Uint8Array (256 RGBA8 entries) for the named colormap.
 * Results are cached so repeated calls return the same instance.
 *
 * @throws if `name` is not a recognised colormap.
 */
export function getColormapData(name: string): Uint8Array {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const gen = GENERATORS[name];
  if (gen === undefined) {
    throw new Error(`Unknown colormap: "${name}"`);
  }

  const data = gen();
  cache.set(name, data);
  return data;
}
