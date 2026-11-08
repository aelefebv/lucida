/**
 * The planner's wanted chunks for the cold state, and what changed since the
 * last cold state, so a view move ships only the members whose chunks moved.
 */

import type { WantedMemberChunks } from "../../../renderer/workerProtocol.ts";
import { wantedEntryKey } from "../../../renderer/wantedChunks.ts";
import type { ChunkRequest } from "../../planning/index.ts";
import { workerMemberId } from "../delivery/dispatch.ts";

/** `${tier}|${memberId}` → that member's wanted chunks in that tier. */
export type WantedChunksByMember = Map<string, WantedMemberChunks>;

/**
 * The chunks the uploader can deliver from a plan: its detail and coarse
 * lanes, under the member ids the delivery uses. Prefetch and minimap chunks
 * never reach the worker, so it never wants them.
 */
export function wantedChunksFromPlan(
  requests: readonly ChunkRequest[],
  multiChannel: boolean,
): WantedChunksByMember {
  const byMember: WantedChunksByMember = new Map();
  for (const req of requests) {
    if (req.lane !== "detail" && req.lane !== "coarse") continue;
    const memberId = workerMemberId(req.imageId, req.c, multiChannel);
    const key = wantedEntryKey(req.tier, memberId);
    const entry = byMember.get(key);
    if (entry) entry.chunkKeys.push(req.chunkKey);
    else byMember.set(key, { memberId, tier: req.tier, chunkKeys: [req.chunkKey] });
  }
  return byMember;
}

/**
 * The entries of `next` whose chunks differ from `prev`, plus an empty entry
 * for each one `next` dropped, as a cold-state delta carries them.
 */
export function diffWantedChunks(
  prev: WantedChunksByMember,
  next: WantedChunksByMember,
): WantedMemberChunks[] {
  const changed: WantedMemberChunks[] = [];
  for (const [key, entry] of next) {
    const old = prev.get(key);
    if (old === undefined || !sameKeys(old.chunkKeys, entry.chunkKeys)) changed.push(entry);
  }
  for (const [key, old] of prev) {
    if (!next.has(key)) changed.push({ memberId: old.memberId, tier: old.tier, chunkKeys: [] });
  }
  return changed;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((key) => set.has(key));
}
