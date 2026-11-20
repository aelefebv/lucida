/**
 * The planner's wanted chunks as the worker looks them up: one key set per
 * (member, tier). The worker never derives them from view geometry; a cold
 * state carries them, so what it wants is exactly what the page delivers.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { WantedChunkChanges, WantedMemberChunks } from "./workerProtocol.ts";

/**
 * `${tier}|${memberId}` → the chunk keys the planner wants for that member in
 * that tier, and `${tier}|${memberId}|ancestors` → those of them that are
 * ancestors ({@link WantedMemberChunks.ancestors}).
 */
export type WantedChunkIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function wantedEntryKey(tier: ResidencyTier, memberId: string, ancestors = false): string {
  return ancestors ? `${tier}|${memberId}|ancestors` : `${tier}|${memberId}`;
}

export function indexWantedChunks(entries: readonly WantedMemberChunks[]): WantedChunkIndex {
  const index = new Map<string, ReadonlySet<string>>();
  for (const entry of entries) {
    if (entry.chunkKeys.length === 0) continue;
    index.set(wantedEntryKey(entry.tier, entry.memberId, entry.ancestors), new Set(entry.chunkKeys));
  }
  return index;
}

/**
 * A delta's changes applied to an index. The index comes back new, and so
 * does each member's set that changed, since eviction's order and the
 * wanted-set tracker tell a changed one by identity.
 */
export function patchWantedIndex(index: WantedChunkIndex, changes: readonly WantedChunkChanges[]): WantedChunkIndex {
  const next = new Map(index);
  for (const { memberId, tier, added, removed, ancestors } of changes) {
    const key = wantedEntryKey(tier, memberId, ancestors);
    const keys = new Set(index.get(key));
    for (const chunkKey of removed) keys.delete(chunkKey);
    for (const chunkKey of added) keys.add(chunkKey);
    if (keys.size === 0) next.delete(key);
    else next.set(key, keys);
  }
  return next;
}

/**
 * The retained list a delta's changes leave, read from `index`, the index
 * {@link patchWantedIndex} made of the same changes: each changed entry takes
 * its keys from there, and one left with none drops.
 */
export function patchWantedChunks(
  retained: readonly WantedMemberChunks[],
  changes: readonly WantedChunkChanges[],
  index: WantedChunkIndex,
): WantedMemberChunks[] {
  const byKey = new Map<string, WantedMemberChunks>();
  for (const entry of retained) byKey.set(wantedEntryKey(entry.tier, entry.memberId, entry.ancestors), entry);
  for (const { memberId, tier, ancestors } of changes) {
    const key = wantedEntryKey(tier, memberId, ancestors);
    const keys = index.get(key);
    if (keys === undefined) byKey.delete(key);
    else byKey.set(key, { memberId, tier, chunkKeys: [...keys], ...(ancestors && { ancestors }) });
  }
  return [...byKey.values()];
}
