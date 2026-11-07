/**
 * Delivery state for CPU-cache-backed worker uploads.
 *
 * Tracks optimistic "sent" facts: a chunk/proxy is considered sent
 * once posted to the worker, and worker feedback clears that fact when
 * the worker later reports eviction, refusal, or a missing chunk or proxy.
 * A cold-state rebuild clears nothing: the worker keeps its pools and slots
 * across one, and its wanted set names anything it no longer holds.
 *
 * Pure collaborator: no I/O, no clocks, no worker-member-id knowledge.
 */

import type { ResidencyTier } from "../residencyTier.ts";

function channelKeyFor(imageId: string, c: number): string {
  return `${imageId}|${c}`;
}

function sentKeyFor(chunkKey: string, tier?: ResidencyTier): string {
  return `${tier ?? "detail"}|${chunkKey}`;
}

export class DeliveryState {
  private chunkSent = new Map<string, Set<string>>();
  private proxySent = new Set<string>();

  markChunkSent(
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): void {
    const key = channelKeyFor(imageId, c);
    let set = this.chunkSent.get(key);
    if (!set) {
      set = new Set();
      this.chunkSent.set(key, set);
    }
    set.add(sentKeyFor(chunkKey, tier));
  }

  wasChunkSent(
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): boolean {
    return this.chunkSent.get(channelKeyFor(imageId, c))?.has(sentKeyFor(chunkKey, tier)) ?? false;
  }

  clearChunkSent(
    imageId: string,
    c: number,
    chunkKey: string,
    tier?: ResidencyTier,
  ): void {
    const key = channelKeyFor(imageId, c);
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

  clearChunksForImage(imageId: string): void {
    const prefix = `${imageId}|`;
    for (const key of this.chunkSent.keys()) {
      if (key.startsWith(prefix)) this.chunkSent.delete(key);
    }
  }

  markProxySent(key: string): void {
    this.proxySent.add(key);
  }

  wasProxySent(key: string): boolean {
    return this.proxySent.has(key);
  }

  clearProxySent(key: string): void {
    this.proxySent.delete(key);
  }

  clearProxySentForDataset(datasetId: string): void {
    const prefix = `${datasetId}|`;
    for (const key of this.proxySent) {
      if (key.startsWith(prefix)) this.proxySent.delete(key);
    }
  }

  reset(): void {
    this.chunkSent.clear();
    this.proxySent.clear();
  }
}
