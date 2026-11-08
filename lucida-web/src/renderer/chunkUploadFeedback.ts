import type { WorkerCtx } from "./workerContext.ts";
import type { ChunkFeedbackReason } from "./workerProtocol.ts";
import { parseCompositeKey } from "./chunkKeys.ts";

type ChunkLike = { key: string };

export function postChunksRequeued(
  ctx: WorkerCtx,
  memberId: string,
  chunks: ChunkLike[],
  reason: ChunkFeedbackReason,
): void {
  const keys = chunks.map(c => c.key);
  if (keys.length === 0) return;
  ctx.post({ type: "chunksEvicted", memberId, keys, skipped: [], reason });
}

export function postChunksRejected(
  ctx: WorkerCtx,
  memberId: string,
  chunks: ChunkLike[],
): void {
  const skipped = chunks.map(c => c.key);
  if (skipped.length === 0) return;
  ctx.post({ type: "chunksEvicted", memberId, keys: [], skipped, reason: "atlas-policy" });
}

/** Hand back every chunk a lost pool held, by composite key, one message per member. */
export function postPoolChunksLost(
  ctx: WorkerCtx,
  compositeKeys: Iterable<string>,
  reason: ChunkFeedbackReason,
): void {
  const byMember = new Map<string, string[]>();
  for (const compositeKey of compositeKeys) {
    const parsed = parseCompositeKey(compositeKey);
    if (!parsed) continue;
    const keys = byMember.get(parsed.memberId);
    if (keys) keys.push(parsed.chunkKey);
    else byMember.set(parsed.memberId, [parsed.chunkKey]);
  }
  for (const [memberId, keys] of byMember) {
    ctx.post({ type: "chunksEvicted", memberId, keys, skipped: [], reason });
  }
}
