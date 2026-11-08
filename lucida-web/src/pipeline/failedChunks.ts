/**
 * The chunks the source failed for good, per dataset: how many and why. The
 * renderer draws them hatched; this names them where the user looks.
 */

import type { FailedChunk } from "./fetch/index.ts";
import type { ChunkFailureKind } from "./fetch/contentSource.ts";

export interface FailedChunkSummary {
  count: number;
  /** How many failed for each reason, most first; `null` where the server gave none. */
  byReason: Array<{ failure: ChunkFailureKind | null; count: number }>;
}

export function summarizeFailedChunks(chunks: readonly FailedChunk[]): Map<string, FailedChunkSummary> {
  const counts = new Map<string, Map<ChunkFailureKind | null, number>>();
  for (const { datasetId, failure } of chunks) {
    let byReason = counts.get(datasetId);
    if (!byReason) {
      byReason = new Map();
      counts.set(datasetId, byReason);
    }
    byReason.set(failure, (byReason.get(failure) ?? 0) + 1);
  }
  const out = new Map<string, FailedChunkSummary>();
  for (const [datasetId, byReason] of counts) {
    const reasons = [...byReason].map(([failure, count]) => ({ failure, count }));
    reasons.sort((a, b) => b.count - a.count);
    out.set(datasetId, { count: reasons.reduce((n, r) => n + r.count, 0), byReason: reasons });
  }
  return out;
}

const FAILURE_WORDS: Record<ChunkFailureKind, string> = {
  malformed_key: "malformed key",
  unknown_dataset: "unknown dataset",
  unknown_image: "unknown image",
  unknown_level: "unknown level",
  corrupt_chunk: "corrupt",
  wrong_size: "wrong size",
  unsupported_codec: "unsupported compression",
  permission: "no permission",
  storage_backend: "store read failed",
};

function reasonWords(failure: ChunkFailureKind | null): string {
  return failure ? FAILURE_WORDS[failure] : "no reason given";
}

/** What the viewer says about a dataset's failed chunks, in one line that also explains the hatch. */
export function failedChunksNotice(summary: FailedChunkSummary): string {
  const one = summary.count === 1;
  const reasons = summary.byReason.length === 1
    ? reasonWords(summary.byReason[0].failure)
    : summary.byReason.map((r) => `${r.count} ${reasonWords(r.failure)}`).join(", ");
  return `${summary.count} chunk${one ? "" : "s"} could not be read (${reasons}), ` +
    `so ${one ? "its region shows" : "their regions show"} hatched.`;
}

type Listener = () => void;

/** The page's per-dataset summaries, which the render loop publishes when the failures change. */
class FailedChunkReport {
  private byDataset: ReadonlyMap<string, FailedChunkSummary> = new Map();
  private readonly listeners = new Set<Listener>();

  /** The same object until the next publication, as `useSyncExternalStore` needs. */
  get(datasetId: string): FailedChunkSummary | null {
    return this.byDataset.get(datasetId) ?? null;
  }

  publish(byDataset: ReadonlyMap<string, FailedChunkSummary>): void {
    if (byDataset.size === 0 && this.byDataset.size === 0) return;
    this.byDataset = byDataset;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const failedChunkReport = new FailedChunkReport();
