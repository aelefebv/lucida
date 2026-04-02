/** Shared helpers for chunk planning and intensity sampling. */
import type { WasmScene } from "lucida-core";
import type { ChunkCoord } from "./chunkStore.ts";

/** A single member's chunk plan, as returned by the Rust WASM scene. */
export interface MemberChunkPlan {
  member_id: string;
  position: [number, number];
  store_prefix: string | null;
  needed: ChunkCoord[];
  prefetch: ChunkCoord[];
}

/** Parse the chunk plan from the Rust scene. Returns null on error. */
export function evaluateChunkPlan(scene: WasmScene): { needed: ChunkCoord[]; prefetch: ChunkCoord[] } | null {
  try {
    return JSON.parse(scene.chunk_plan());
  } catch {
    return null;
  }
}

/** Parse the per-member chunk plans for a specific dataset. Returns null on error. */
export function evaluateChunkPlanFor(scene: WasmScene, datasetId: string): MemberChunkPlan[] | null {
  try {
    return JSON.parse(scene.chunk_plan_for(datasetId));
  } catch {
    return null;
  }
}

export { sampleIntensityRange } from "./intensitySampler.ts";
