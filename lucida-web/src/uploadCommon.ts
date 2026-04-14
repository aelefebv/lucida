/** Shared types for the chunk rendering pipeline (slice + volume). */
import type { ChunkCoord } from "./zarr/chunkStore.ts";

/** A single member's chunk plan, consumed by the render layer builders. */
export interface MemberChunkPlan {
  image_id: string;
  position: [number, number];
  needed: ChunkCoord[];
  prefetch: ChunkCoord[];
}
