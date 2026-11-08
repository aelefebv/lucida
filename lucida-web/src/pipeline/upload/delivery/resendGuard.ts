/**
 * The bound on the uploader's feedback loop with the render worker.
 *
 * Every chunk the worker refuses or reports lost, or lists as missing while
 * the page holds it, comes back eligible to send, so any lasting disagreement
 * between the two sides re-sends the same chunks every tick. A tick whose
 * every send repeats a chunk already sent since the last cold state adds no
 * resident bytes: whatever the worker takes in, it gives back. Past {@link RESEND_GUARD_TICKS} such ticks in a row
 * the guard holds the repeated chunks until the next cold state, so the view
 * settles covering less instead of drawing at frame rate, and hands them to
 * the caller to name in the trace.
 */

import type { ReadyChunkDelivery } from "../../fetch/index.ts";
import type { HeldReason } from "../../../trace/types.ts";

/**
 * Consecutive no-progress ticks before the guard holds. About half a second
 * at 60 Hz: a real delivery repeats a chunk once or twice after an eviction,
 * never for this many ticks with nothing new between.
 */
export const RESEND_GUARD_TICKS = 30;

export interface HeldChunk {
  delivery: ReadyChunkDelivery;
  /** The worker's last account of why the chunk came back. */
  reason: HeldReason;
}

function deliveryKey(d: ReadyChunkDelivery): string {
  return `${d.residencyTier}|${d.imageId}|${d.c}|${d.chunkKey}`;
}

function reasonKey(imageId: string, c: number, chunkKey: string): string {
  return `${imageId}|${c}|${chunkKey}`;
}

export class ResendGuard {
  private readonly sentSinceRebuild = new Set<string>();
  /** Chunks re-sent during the current run of no-progress ticks. */
  private readonly repeated = new Map<string, ReadyChunkDelivery>();
  private readonly held = new Set<string>();
  private readonly lastReason = new Map<string, HeldReason>();
  private noProgressTicks = 0;
  private tickSent = false;
  private tickAddedNew = false;

  /** A cold state went out: the worker's wanted set changed, so every chunk gets a fresh chance. */
  onRebuild(): void {
    this.sentSinceRebuild.clear();
    this.repeated.clear();
    this.held.clear();
    this.lastReason.clear();
    this.noProgressTicks = 0;
  }

  isHeld(delivery: ReadyChunkDelivery): boolean {
    return this.held.size > 0 && this.held.has(deliveryKey(delivery));
  }

  noteSent(delivery: ReadyChunkDelivery): void {
    const key = deliveryKey(delivery);
    this.tickSent = true;
    if (this.sentSinceRebuild.has(key)) {
      this.repeated.set(key, delivery);
    } else {
      this.sentSinceRebuild.add(key);
      this.tickAddedNew = true;
    }
  }

  /** The worker handed a chunk back, evicted or refused, and said why. */
  noteReturned(imageId: string, c: number, chunkKey: string, reason: HeldReason): void {
    this.lastReason.set(reasonKey(imageId, c, chunkKey), reason);
  }

  /**
   * The worker's wanted set lists a chunk the page held. The report can
   * follow a refusal or loss of the same chunk, so it must not overwrite the
   * reason that gave.
   */
  noteMissing(imageId: string, c: number, chunkKey: string): void {
    const key = reasonKey(imageId, c, chunkKey);
    if (!this.lastReason.has(key)) this.lastReason.set(key, "not-resident");
  }

  /**
   * Close one tick. Returns the chunks the guard has just started holding,
   * empty on every other tick. A tick that sent no chunk neither counts nor
   * resets: it cannot be a turn of the loop.
   */
  endTick(): HeldChunk[] {
    const sent = this.tickSent;
    const addedNew = this.tickAddedNew;
    this.tickSent = false;
    this.tickAddedNew = false;
    if (!sent) return [];
    if (addedNew) {
      this.noProgressTicks = 0;
      this.repeated.clear();
      return [];
    }
    this.noProgressTicks++;
    if (this.noProgressTicks < RESEND_GUARD_TICKS) return [];

    const held: HeldChunk[] = [];
    for (const [key, delivery] of this.repeated) {
      this.held.add(key);
      held.push({
        delivery,
        reason: this.lastReason.get(reasonKey(delivery.imageId, delivery.c, delivery.chunkKey)) ?? "not-resident",
      });
    }
    this.repeated.clear();
    this.noProgressTicks = 0;
    return held;
  }
}
