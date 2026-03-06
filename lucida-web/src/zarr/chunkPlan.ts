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

export { sampleIntensityRange } from "./intensitySampler.ts";
