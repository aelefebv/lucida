/**
 * The chunk a request asks for, as one string, built once per request.
 *
 * A carried plan keeps its requests from one plan to the next, and the
 * stages after the plan key each one they touch: admission charges it, the
 * CPU cache notes its demand, walks it and keeps it queued, and pacing pairs
 * its removal with an addition. Built anew each time, the key is a string to
 * allocate and hash on every touch; kept with the request, it is hashed once.
 */

import type { ChunkRequest } from "./types.ts";

const keys = new WeakMap<ChunkRequest, string>();

/** `entityId/tier/chunkKey`: one chunk of one tier, which the CPU cache holds once whatever lanes ask for it. */
export function requestChunkKey(req: ChunkRequest): string {
  let key = keys.get(req);
  if (key === undefined) {
    key = `${req.entityId}/${req.tier}/${req.chunkKey}`;
    keys.set(req, key);
  }
  return key;
}
