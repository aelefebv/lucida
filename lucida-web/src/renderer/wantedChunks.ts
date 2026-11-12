/**
 * The planner's wanted chunks as the worker looks them up: one key set per
 * (member, tier). The worker never derives them from view geometry; a cold
 * state carries them, so what it wants is exactly what the page delivers.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { WantedMemberChunks } from "./workerProtocol.ts";

/** `${tier}|${memberId}` → the chunk keys the planner wants for that member in that tier. */
export type WantedChunkIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function wantedEntryKey(tier: ResidencyTier, memberId: string): string {
  return `${tier}|${memberId}`;
}

export function indexWantedChunks(entries: readonly WantedMemberChunks[]): WantedChunkIndex {
  const index = new Map<string, ReadonlySet<string>>();
  for (const entry of entries) {
    if (entry.chunkKeys.length === 0) continue;
    index.set(wantedEntryKey(entry.tier, entry.memberId), new Set(entry.chunkKeys));
  }
  return index;
}

/**
 * Apply a delta's replacements to a retained list. Each replacement takes the
 * place of the entry for its (member, tier), and one with no keys drops it.
 */
export function patchWantedChunks(
  retained: readonly WantedMemberChunks[],
  replacements: readonly WantedMemberChunks[],
): WantedMemberChunks[] {
  const byKey = new Map<string, WantedMemberChunks>();
  for (const entry of retained) byKey.set(wantedEntryKey(entry.tier, entry.memberId), entry);
  for (const entry of replacements) {
    const key = wantedEntryKey(entry.tier, entry.memberId);
    if (entry.chunkKeys.length === 0) byKey.delete(key);
    else byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * A delta's replacements applied to an index, as {@link patchWantedChunks}
 * applies them to the list. The index comes back new, since eviction's order
 * tells a changed one by identity.
 */
export function patchWantedIndex(index: WantedChunkIndex, replacements: readonly WantedMemberChunks[]): WantedChunkIndex {
  const next = new Map(index);
  for (const entry of replacements) {
    const key = wantedEntryKey(entry.tier, entry.memberId);
    if (entry.chunkKeys.length === 0) next.delete(key);
    else next.set(key, new Set(entry.chunkKeys));
  }
  return next;
}
