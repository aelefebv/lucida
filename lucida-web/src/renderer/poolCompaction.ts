/**
 * Which slots a chunk pool keeps, and where, when it shrinks. Pure, so the
 * slot bookkeeping is testable without a device; the atlas modules move the
 * texels and the indirection to match.
 */

export interface CompactionPlan {
  /** Composite key → slot index after the shrink, in the old map's order. */
  slots: Map<string, number>;
  /** Keys the shrunk pool no longer holds. */
  dropped: string[];
  /** Kept chunks whose slot lay past the new capacity, and the slot each moves to. */
  moves: Array<{ key: string; from: number; to: number }>;
  /** Slots under the new capacity that hold nothing, as a stack. */
  freeSlots: number[];
}

/**
 * Plan shrinking a pool to `capacity` slots. `keep` lists keys in the order
 * they should survive; the first `capacity` of them that the pool holds stay.
 * A kept chunk already under the new capacity stays in its slot, so only the
 * ones past it are copied.
 */
export function planCompaction(
  slots: ReadonlyMap<string, number>,
  capacity: number,
  keep: Iterable<string>,
): CompactionPlan {
  const kept = new Set<string>();
  for (const key of keep) {
    if (kept.size >= capacity) break;
    if (slots.has(key)) kept.add(key);
  }
  const taken = new Set<number>();
  for (const key of kept) {
    const slot = slots.get(key)!;
    if (slot < capacity) taken.add(slot);
  }
  const open: number[] = [];
  for (let i = capacity - 1; i >= 0; i--) if (!taken.has(i)) open.push(i);

  const next = new Map<string, number>();
  const dropped: string[] = [];
  const moves: CompactionPlan["moves"] = [];
  for (const [key, slot] of slots) {
    if (!kept.has(key)) {
      dropped.push(key);
      continue;
    }
    if (slot < capacity) {
      next.set(key, slot);
    } else {
      const to = open.pop()!;
      moves.push({ key, from: slot, to });
      next.set(key, to);
    }
  }
  return { slots: next, dropped, moves, freeSlots: open };
}

/**
 * Apply a plan to a pool's slot → indirection-entry map and its indirection:
 * a dropped chunk's entry goes back to the sentinel and a moved chunk's entry
 * names its new slot. Returns the slot → entry map for the new capacity.
 * `slots` is the map before the shrink.
 */
export function remapSlotEntries(
  slots: ReadonlyMap<string, number>,
  slotGridIdx: Int32Array,
  indirection: Uint32Array,
  plan: CompactionPlan,
  capacity: number,
): Int32Array<ArrayBuffer> {
  // Dropped entries first, so a kept chunk's entry always wins.
  for (const key of plan.dropped) {
    const gridIdx = slotGridIdx[slots.get(key)!];
    if (gridIdx >= 0 && gridIdx < indirection.length) indirection[gridIdx] = 0xFFFFFFFF;
  }
  const next = new Int32Array(capacity).fill(-1);
  for (const [key, slot] of plan.slots) {
    const gridIdx = slotGridIdx[slots.get(key)!];
    next[slot] = gridIdx;
    if (gridIdx >= 0 && gridIdx < indirection.length) indirection[gridIdx] = slot;
  }
  return next;
}
