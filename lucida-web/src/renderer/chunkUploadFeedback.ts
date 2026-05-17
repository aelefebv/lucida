import type { WorkerCtx } from "./workerContext.ts";
import type { ChunkFeedbackReason } from "./workerProtocol.ts";

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
