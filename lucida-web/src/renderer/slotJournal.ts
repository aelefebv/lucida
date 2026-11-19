/**
 * The slot keys a shared pool held or let go since the wanted-set report
 * last read them, so the report reads again only those
 * (`worker/wantedSetReport.ts`).
 *
 * Bounded: past {@link SLOT_JOURNAL_CAP} keys it keeps none and says only
 * that the pool changed, and the report reads the whole pool again. A frame
 * drains it, so the cap is met only by a pool that changed with no frame for
 * a long while.
 */

import type { SlotChanges } from "./wantedSet.ts";

export const SLOT_JOURNAL_CAP = 4096;

export class SlotJournal {
  private keys = new Set<string>();
  private overflowed = false;

  /** The slot `key` names was held or let go. */
  note(key: string): void {
    if (this.overflowed) return;
    this.keys.add(key);
    if (this.keys.size > SLOT_JOURNAL_CAP) {
      this.overflowed = true;
      this.keys = new Set();
    }
  }

  get empty(): boolean {
    return !this.overflowed && this.keys.size === 0;
  }

  /** What was noted since the last drain, and start again. */
  drain(): SlotChanges {
    const changes: SlotChanges = this.overflowed ? "all" : this.keys;
    this.keys = new Set();
    this.overflowed = false;
    return changes;
  }
}
