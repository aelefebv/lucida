/**
 * The chunk a request asks for, as one string, built once per request.
 *
 * A carried plan keeps its requests from one plan to the next, and the
 * stages after the plan key each one they touch: admission charges it, and
 * the CPU cache notes its demand, walks it and keeps it queued. Built anew
 * each time, the key is a string to allocate and hash on every touch; kept
 * with the request, it is hashed once.
 */

import type { ResidencyTier } from "../residencyTier.ts";
import type { ChunkRequest } from "./types.ts";

const keys = new WeakMap<ChunkRequest, string>();

/** One chunk of one tier, which the CPU cache holds once whatever lanes ask for it. */
export function tierChunkKey(entityId: string, tier: ResidencyTier, chunkKey: string): string {
  return `${entityId}/${tier}/${chunkKey}`;
}

/** {@link tierChunkKey} of the chunk `req` asks for, at its tier. */
export function requestChunkKey(req: ChunkRequest): string {
  let key = keys.get(req);
  if (key === undefined) {
    key = tierChunkKey(req.entityId, req.tier, req.chunkKey);
    keys.set(req, key);
  }
  return key;
}
