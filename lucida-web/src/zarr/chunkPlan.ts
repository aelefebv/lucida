/** Shared helpers for chunk planning. */
import type { WasmScene } from "lucida-core";
import type { ChunkCoord } from "./chunkStore.ts";

/** A single member's chunk plan, as returned by the Rust WASM scene. */
export interface MemberChunkPlan {
  image_id: string;
  position: [number, number];
  needed: ChunkCoord[];
  prefetch: ChunkCoord[];
}

/** Parse the per-member chunk plans for a specific dataset. Returns null on error. */
export function evaluateChunkPlanFor(scene: WasmScene, datasetId: string): MemberChunkPlan[] | null {
  try {
    return JSON.parse(scene.chunk_plan_for(datasetId));
  } catch {
    return null;
  }
}
