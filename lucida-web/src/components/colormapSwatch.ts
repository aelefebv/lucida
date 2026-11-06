import { getColormapData } from "../colormaps.ts";

const rampCache = new Map<string, string>();

/**
 * A CSS gradient of a colormap's ramp from `from` (0..255) to the top.
 * Colormaps are data colors, never themed.
 */
export function rampGradient(name: string, from = 0): string {
  const key = `${name}@${from}`;
  const cached = rampCache.get(key);
  if (cached) return cached;
  let data: Uint8Array;
  try {
    data = getColormapData(name);
  } catch {
    return "transparent";
  }
  const stops: string[] = [];
  const count = 8;
  for (let i = 0; i <= count; i++) {
    const index = Math.round(from + ((255 - from) * i) / count);
    const o = index * 4;
    stops.push(`rgb(${data[o]} ${data[o + 1]} ${data[o + 2]}) ${(i / count) * 100}%`);
  }
  const gradient = `linear-gradient(90deg, ${stops.join(", ")})`;
  rampCache.set(key, gradient);
  return gradient;
}

export function colormapTitle(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
