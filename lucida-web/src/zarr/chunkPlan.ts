/** Shared helpers for chunk planning and intensity sampling. */
import type { WasmScene } from "lucida-core";
import type { ChunkCoord } from "./chunkStore.ts";

/** Parse the chunk plan from the Rust scene. Returns null on error. */
export function evaluateChunkPlan(scene: WasmScene): { needed: ChunkCoord[] } | null {
  try {
    return JSON.parse(scene.chunk_plan());
  } catch {
    return null;
  }
}

/** Sample min/max intensity from a Uint16Array, examining at most `maxSamples` elements. */
export function sampleIntensityRange(
  data: Uint16Array,
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
