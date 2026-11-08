/**
 * The upload telemetry's publish under a full window, in the perf phase
 * because both gates are timings: a ratio against the `shift()`-pruned window
 * it replaced, which catches a return to that shape, and a budget held on any
 * host the way `perfBudget.ts` describes, which catches a slower ring.
 */

import { describe, expect, it } from "vitest";

import { describeTiming, expectWithinBudget, timeStep } from "../../../test/perfBudget.ts";
import { UPLOAD_WINDOW_MS } from "../constants.ts";
import { emptyUploadTickStats, UploadTelemetry, type UploadTickStats } from "./upload.ts";

/** One tick of 128 events into a full window and its publish, in nominal microseconds: about twice the typical figure. */
const RING_TICK_BUDGET_US = 170;

function makeTickStats(over: Partial<UploadTickStats> = {}): UploadTickStats {
  return { ...emptyUploadTickStats(), ...over };
}

describe("UploadTelemetry publish cost", () => {
  it("publishes far faster than the shift()-pruned window it replaced", async ({ annotate }) => {
    // `Array.shift()` in a loop becomes a full memmove per shift once V8's
    // backing store outgrows a regular heap object. 128 events per tick on
    // 8 ms ticks puts the 1s window at ~16k entries, past that cliff.
    //
    // The assertion is a ratio against a shift()-pruned window measured in
    // the same run, not an absolute bound, so it holds on a slow CI box.
    // A promoted store also pays the generational write barrier on every
    // shift, and a session-lived store is promoted within seconds, so the
    // test forces promotion rather than leaving it to GC timing.
    //
    // Both windows advance in lockstep, each tick timed separately, so they
    // see the same heap phases. The assertion compares per-round minimums,
    // because noise only ever adds time.
    const perTick = 128;
    const tickMs = 8;
    const warmTicks = 200;
    const roundTicks = 25;
    const roundCount = 4;
    const ratioFloor = 4;

    const tel = new UploadTelemetry();
    const ringTick = (now: number): void => {
      for (let e = 0; e < perTick; e++) tel.recordEvent(now, 10);
      tel.publish(now, makeTickStats());
    };

    // The pre-fix shape: a plain array pruned with `shift()`, then scanned.
    const events: Array<{ at: number; bytes: number }> = [];
    const shiftTick = (now: number): void => {
      for (let e = 0; e < perTick; e++) events.push({ at: now, bytes: 10 });
      const cutoff = now - UPLOAD_WINDOW_MS;
      while (events.length > 0 && events[0].at < cutoff) events.shift();
      let bytes = 0;
      for (const e of events) bytes += e.bytes;
      if (bytes < 0) throw new Error("unreachable");
    };

    /** Milliseconds per tick for each side. */
    interface SideMs {
      ring: number;
      shift: number;
    }

    let now = 100_000;
    /** Advance both windows one tick and time each side. */
    const step = (): SideMs => {
      const t0 = performance.now();
      ringTick(now);
      const t1 = performance.now();
      shiftTick(now);
      const t2 = performance.now();
      now += tickMs;
      return { ring: t1 - t0, shift: t2 - t1 };
    };

    // Warm until the window is full, so every timed tick prunes.
    for (let i = 0; i < warmTicks; i++) step();

    // Promote both backing stores. About 128 MB of short-lived objects forces
    // several scavenges even at V8's largest default semi-space, in about
    // 35 ms.
    const churn = new Array<object | undefined>(4096);
    for (let i = 0; i < 4_000_000; i++) churn[i & 4095] = { i };

    const rounds: SideMs[] = [];
    for (let r = 0; r < roundCount; r++) {
      const sum: SideMs = { ring: 0, shift: 0 };
      for (let i = 0; i < roundTicks; i++) {
        const t = step();
        sum.ring += t.ring;
        sum.shift += t.shift;
      }
      rounds.push({ ring: sum.ring / roundTicks, shift: sum.shift / roundTicks });
    }
    const ringMs = Math.min(...rounds.map((r) => r.ring));
    const shiftMs = Math.min(...rounds.map((r) => r.shift));

    // Both windows hold the same events, so this is like for like.
    expect(events.length).toBeGreaterThan(15_000);
    const perRound = (side: keyof SideMs): string =>
      rounds.map((r) => r[side].toFixed(3)).join("/");
    const readout =
      `ring ${perRound("ring")} ms, shift ${perRound("shift")} ms per tick; ` +
      `ratio of minimums ${(shiftMs / ringMs).toFixed(1)}x`;
    // The default reporter drops this. The GitHub Actions reporter shows it
    // as a notice, so CI records the ratio on every run.
    await annotate(readout);
    // Ratio of minimums observed. GitHub's ubuntu-latest runners, Node 24:
    // 11.0x to 17.6x over 6 runs. A 22-vCPU x86 VM, Node 24 and 26: 13.9x to
    // 16.1x over 32 idle runs, 10.8x to 15.4x over 11 runs pinned to one
    // hyperthread with its sibling busy, and 12.5x with the semi-space forced
    // down to 1 MB. The ring swapped back to the shift() shape: 0.95x to
    // 0.97x.
    expect(shiftMs / ringMs, readout).toBeGreaterThan(ratioFloor);
  }, 20_000);

  it("records and publishes a tick into a full window inside the budget", () => {
    const perTick = 128;
    const tickMs = 8;
    const tel = new UploadTelemetry();
    let now = 100_000;
    // The warmup fills the window, so every timed tick prunes as much as it records.
    const tick = timeStep(() => {
      for (let e = 0; e < perTick; e++) tel.recordEvent(now, 10);
      tel.publish(now, makeTickStats());
      now += tickMs;
    }, { samples: 200, warmup: Math.ceil(UPLOAD_WINDOW_MS / tickMs) + 20 });
    console.log(`[upload] ring tick: ${perTick} events into a full window | ${describeTiming(tick, RING_TICK_BUDGET_US)}`);
    expectWithinBudget("ring tick", tick, RING_TICK_BUDGET_US);
  });
});
