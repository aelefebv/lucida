/**
 * Delivery state for CPU-cache-backed worker uploads: the page's mirror of
 * what the render worker holds.
 *
 * The worker owns its slots and acknowledges every chunk delivery as held or
 * refused, and every later loss of a held chunk. A chunk is `sent` from the
 * post until its answer, then `held` until a loss. Neither is ever assumed: a
 * cold-state rebuild changes nothing here, and a chunk the worker holds is
 * never sent again until it reports the chunk lost.
 *
 * Pure collaborator: no I/O, no clocks, no worker-member-id knowledge.
 */

import type { ResidencyTier } from "../residencyTier.ts";

type ChunkDelivery = "sent" | "held";

function channelKeyFor(imageId: string, c: number): string {
  return `${imageId}|${c}`;
}

function tierKeyFor(chunkKey: string, tier?: ResidencyTier): string {
  return `${tier ?? "detail"}|${chunkKey}`;
}

export class DeliveryState {
  private chunks = new Map<string, Map<string, ChunkDelivery>>();

  /** Posted to the worker; awaits its answer. */
  markChunkSent(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): void {
    const byKey = this.channel(imageId, c, true)!;
    const key = tierKeyFor(chunkKey, tier);
    if (byKey.get(key) !== "held") byKey.set(key, "sent");
  }

  /** The worker wrote the chunk, or already held it. */
  markChunkHeld(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): void {
    this.channel(imageId, c, true)!.set(tierKeyFor(chunkKey, tier), "held");
  }

  /** The worker did not place the chunk, so it may be sent again. */
  markChunkRefused(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): void {
    this.drop(imageId, c, tierKeyFor(chunkKey, tier));
  }

  /**
   * The worker stopped holding the chunk. A copy sent since stays `sent`: the
   * loss is of the slot it replaces, and its own answer is still to come.
   */
  markChunkLost(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): void {
    const key = tierKeyFor(chunkKey, tier);
    if (this.channel(imageId, c, false)?.get(key) === "held") this.drop(imageId, c, key);
  }

  /**
   * The worker's wanted set lists the chunk as not held. Returns whether this
   * mirror held it, a disagreement, after which the chunk may be sent again.
   * A `sent` chunk is left alone: the report predates its answer.
   */
  markChunkMissing(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): boolean {
    const key = tierKeyFor(chunkKey, tier);
    if (this.channel(imageId, c, false)?.get(key) !== "held") return false;
    this.drop(imageId, c, key);
    return true;
  }

  /** Sent and not yet answered, or held: either way, not to be sent again. */
  wasChunkSent(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): boolean {
    return this.channel(imageId, c, false)?.has(tierKeyFor(chunkKey, tier)) ?? false;
  }

  isChunkHeld(imageId: string, c: number, chunkKey: string, tier?: ResidencyTier): boolean {
    return this.channel(imageId, c, false)?.get(tierKeyFor(chunkKey, tier)) === "held";
  }

  clearChunksForImage(imageId: string): void {
    const prefix = `${imageId}|`;
    for (const key of this.chunks.keys()) {
      if (key.startsWith(prefix)) this.chunks.delete(key);
    }
  }

  reset(): void {
    this.chunks.clear();
  }

  private channel(imageId: string, c: number, create: boolean): Map<string, ChunkDelivery> | undefined {
    const key = channelKeyFor(imageId, c);
    let byKey = this.chunks.get(key);
    if (!byKey && create) {
      byKey = new Map();
      this.chunks.set(key, byKey);
    }
    return byKey;
  }

  private drop(imageId: string, c: number, tierKey: string): void {
    const channelKey = channelKeyFor(imageId, c);
    const byKey = this.chunks.get(channelKey);
    if (!byKey) return;
    byKey.delete(tierKey);
    if (byKey.size === 0) this.chunks.delete(channelKey);
  }
}
