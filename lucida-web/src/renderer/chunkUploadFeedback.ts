import type { WorkerCtx } from "./workerContext.ts";
import type { ChunkFeedbackReason } from "./workerProtocol.ts";

type ChunkLike = { key: string };

export function postChunksRequeued(
  ctx: WorkerCtx,
  datasetId: string,
  memberId: string,
  tier: "detail" | "coarse",
  chunks: ChunkLike[],
  reason: ChunkFeedbackReason,
): void {
  const keys = chunks.map(c => c.key);
  if (keys.length === 0) return;
  ctx.post({ type: "chunksEvicted", datasetId, memberId, tier, keys, skipped: [], reason });
}

export function postChunksRejected(
  ctx: WorkerCtx,
  datasetId: string,
  memberId: string,
  tier: "detail" | "coarse",
  chunks: ChunkLike[],
): void {
  const skipped = chunks.map(c => c.key);
  if (skipped.length === 0) return;
  ctx.post({
    type: "chunksEvicted",
    datasetId,
    memberId,
    tier,
    keys: [],
    skipped,
    reason: "atlas-policy",
  });
}
