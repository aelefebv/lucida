/**
 * Delivery state for CPU-cache-backed worker uploads.
 *
 * Tracks optimistic "sent" facts: a chunk is considered sent once posted
 * to the worker, and worker feedback clears that fact after eviction.
 *
 * Pure collaborator: no I/O, no clocks, no worker-member-id knowledge.
 */

import type { ResidencyTier } from "./types.ts";

function channelKeyFor(datasetId: string, imageId: string, c: number): string {
  return `${datasetId.length}:${datasetId}${imageId.length}:${imageId}${c}`;
}

function sentKeyFor(chunkKey: string, tier?: ResidencyTier): string {
  return `${tier ?? "detail"}|${chunkKey}`;
}

export class DeliveryState {
  private chunkSent = new Map<string, Set<string>>();

  markChunkSent(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): void {
    const key = channelKeyFor(datasetId, imageId, c);
    let set = this.chunkSent.get(key);
    if (!set) {
      set = new Set();
      this.chunkSent.set(key, set);
    }
    set.add(sentKeyFor(chunkKey, tier));
  }

  wasChunkSent(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): boolean {
    return this.chunkSent.get(channelKeyFor(datasetId, imageId, c))?.has(sentKeyFor(chunkKey, tier)) ?? false;
  }

  clearChunkSent(
    datasetId: string,
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): void {
    const key = channelKeyFor(datasetId, imageId, c);
    const set = this.chunkSent.get(key);
    if (!set) return;
    if (tier === undefined) {
      for (const sentKey of Array.from(set)) {
        if (sentKey.endsWith(`|${chunkKey}`)) set.delete(sentKey);
      }
    } else {
      set.delete(sentKeyFor(chunkKey, tier));
    }
    if (set.size === 0) this.chunkSent.delete(key);
  }

  clearChunksForImage(datasetId: string, imageId: string): void {
    const prefix = `${datasetId.length}:${datasetId}${imageId.length}:${imageId}`;
    for (const key of this.chunkSent.keys()) {
      if (key.startsWith(prefix)) this.chunkSent.delete(key);
    }
  }

  clearDataset(datasetId: string): void {
    const prefix = `${datasetId.length}:${datasetId}`;
    for (const key of this.chunkSent.keys()) {
      if (key.startsWith(prefix)) this.chunkSent.delete(key);
    }
  }

  /** Cold-state rebuilds clear delivery because chunk atlases are rebuilt. */
  onPlanRebuildStart(): void {
    this.chunkSent.clear();
  }

  reset(): void {
    this.chunkSent.clear();
  }
}
