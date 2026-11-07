import { describe, expect, it } from "vitest";
import type { ReadyChunkDelivery } from "../../fetch/index.ts";
import { RESEND_GUARD_TICKS, ResendGuard } from "./resendGuard.ts";

function chunk(x: number, tier: "detail" | "coarse" = "detail"): ReadyChunkDelivery {
  return {
    kind: "chunk",
    entityId: "tile-0",
    imageId: "img-0",
    level: 0,
    t: 0,
    c: 0,
    z: 0,
    y: 0,
    x,
    chunkKey: `0/0/0/0/0/${x}`,
    data: new ArrayBuffer(8),
    dataType: "uint16",
    epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0 },
    lane: "detail",
    residencyTier: tier,
  };
}

/** One tick that sends `deliveries`, returning what the guard started holding. */
function tick(guard: ResendGuard, ...deliveries: ReadyChunkDelivery[]) {
  for (const d of deliveries) guard.noteSent(d);
  return guard.endTick();
}

describe("ResendGuard", () => {
  it("holds two chunks that keep trading a slot, once the bound of no-progress ticks passes", () => {
    const guard = new ResendGuard();
    const a = chunk(1);
    const b = chunk(2);
    expect(tick(guard, a, b)).toEqual([]);
    guard.noteReturned("img-0", 0, a.chunkKey, "evicted");
    guard.noteMissing("img-0", 0, a.chunkKey);
    guard.noteReturned("img-0", 0, b.chunkKey, "evicted");

    for (let i = 1; i < RESEND_GUARD_TICKS; i++) {
      expect(tick(guard, i % 2 === 0 ? a : b)).toEqual([]);
    }
    const held = tick(guard, a);
    expect(held.map((h) => [h.delivery.chunkKey, h.reason]).sort()).toEqual([
      [a.chunkKey, "evicted"],
      [b.chunkKey, "evicted"],
    ]);
    expect(guard.isHeld(a)).toBe(true);
    expect(guard.isHeld(b)).toBe(true);
    expect(guard.isHeld(chunk(2, "coarse"))).toBe(false);
  });

  it("names a chunk the worker only ever listed as missing as not resident", () => {
    const guard = new ResendGuard();
    const a = chunk(1);
    tick(guard, a);
    guard.noteMissing("img-0", 0, a.chunkKey);
    let held: ReturnType<ResendGuard["endTick"]> = [];
    for (let i = 0; i < RESEND_GUARD_TICKS; i++) held = tick(guard, a);
    expect(held.map((h) => h.reason)).toEqual(["not-resident"]);
  });

  it("starts over whenever a tick sends a chunk it has not sent since the last cold state", () => {
    const guard = new ResendGuard();
    const looping = chunk(0);
    tick(guard, looping);
    for (let i = 1; i <= 3 * RESEND_GUARD_TICKS; i++) {
      // A steady trickle of new chunks is progress, whatever repeats beside it.
      const sends = i % (RESEND_GUARD_TICKS - 1) === 0 ? [looping, chunk(i)] : [looping];
      expect(tick(guard, ...sends)).toEqual([]);
    }
    expect(guard.isHeld(looping)).toBe(false);
  });

  it("neither counts nor resets on a tick that sends nothing", () => {
    const guard = new ResendGuard();
    const a = chunk(1);
    tick(guard, a);
    for (let i = 1; i < RESEND_GUARD_TICKS; i++) {
      tick(guard, a);
      expect(guard.endTick()).toEqual([]);
    }
    expect(tick(guard, a).map((h) => h.delivery)).toEqual([a]);
  });

  it("lets every held chunk go at the next cold state", () => {
    const guard = new ResendGuard();
    const a = chunk(1);
    tick(guard, a);
    for (let i = 0; i < RESEND_GUARD_TICKS; i++) tick(guard, a);
    expect(guard.isHeld(a)).toBe(true);

    guard.onRebuild();
    expect(guard.isHeld(a)).toBe(false);
    // The first send after the cold state is progress again.
    expect(tick(guard, a)).toEqual([]);
  });
});
