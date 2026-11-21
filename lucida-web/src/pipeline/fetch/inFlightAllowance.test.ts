import { describe, it, expect } from "vitest";

import { InFlightAllowance } from "./inFlightAllowance.ts";

const MB = 1_000_000;

/**
 * A link that delivers `bytesPerMs`, where a fetch with nothing queued ahead
 * of it takes `roundTripMs`. `inFlight` fetches of `bytes` each go out at
 * `startMs`, and each one that lands sends the next, `count` in all. The wire
 * carries `wireBytes` of each, all of it unless that says otherwise. Returns
 * when the last landed.
 */
function fill(
  allowance: InFlightAllowance,
  opts: {
    bytesPerMs: number;
    roundTripMs: number;
    bytes: number;
    count: number;
    inFlight?: number;
    startMs?: number;
    wireBytes?: number;
  },
): number {
  const { bytesPerMs, roundTripMs, bytes, count } = opts;
  const wireBytes = opts.wireBytes ?? bytes;
  const transferMs = wireBytes / bytesPerMs;
  let linkFreeAt = opts.startMs ?? 0;
  const flying: { stamp: ReturnType<InFlightAllowance["stamp"]>; landsAt: number }[] = [];
  const send = (now: number) => {
    const landsAt = Math.max(now + roundTripMs, linkFreeAt + transferMs);
    linkFreeAt = landsAt;
    flying.push({ stamp: allowance.stamp(now), landsAt });
  };
  let sent = 0;
  for (; sent < (opts.inFlight ?? 8); sent++) send(opts.startMs ?? 0);
  let now = opts.startMs ?? 0;
  while (flying.length > 0) {
    const { stamp, landsAt } = flying.shift()!;
    now = landsAt;
    allowance.landed(stamp, bytes, wireBytes, now);
    if (sent++ < count) send(now);
  }
  return now;
}

describe("InFlightAllowance", () => {
  it("starts at the initial bytes and widens by what lands until a rate is known", () => {
    const allowance = new InFlightAllowance(4 * MB);
    expect(allowance.bytes()).toBe(4 * MB);

    // Sent before anything landed, they measure the round trip and not the rate.
    const first = allowance.stamp(0);
    const second = allowance.stamp(0);
    allowance.landed(first, MB, MB, 200);
    allowance.landed(second, MB, MB, 280);
    expect(allowance.bytes()).toBe(6 * MB);
  });

  it("allows twice the shortest round trip at the fastest rate", () => {
    const allowance = new InFlightAllowance(4 * MB);
    // 12.5 MB/s, 200 ms when nothing is ahead.
    fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 20 });
    const bytes = allowance.bytes();
    expect(bytes).toBeGreaterThan(12_500 * 400 * 0.9);
    expect(bytes).toBeLessThan(12_500 * 400 * 1.2);
  });

  it("allows at least what the link delivers in a quarter second when round trips are short", () => {
    const allowance = new InFlightAllowance(4 * MB);
    // 1 GB/s, 2 ms.
    fill(allowance, { bytesPerMs: 1 * MB, roundTripMs: 2, bytes: 500_000, count: 20 });
    expect(allowance.bytes()).toBeGreaterThanOrEqual(250 * MB * 0.9);
  });

  it("keeps the shortest round trip, so a queue its own allowance built cannot grow it", () => {
    const allowance = new InFlightAllowance(4 * MB);
    fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 20 });
    const before = allowance.bytes();
    // The same link with 20 MB in flight, so every fetch waits over a second.
    fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 200, inFlight: 40, startMs: 3_000 });
    expect(allowance.bytes()).toBeLessThan(before * 1.2);
  });

  it("does not let a fetch sent with nothing more to send lower the rate", () => {
    const allowance = new InFlightAllowance(4 * MB);
    const end = fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 20 });
    const before = allowance.bytes();

    // One lone fetch every few seconds for a long while, well past the
    // window a rate counts for.
    for (let at = end + 1_000; at < end + 30_000; at += 3_000) {
      const stamp = allowance.stamp(at);
      stamp.appLimited = true;
      allowance.landed(stamp, 500_000, 500_000, at + 240);
    }
    expect(allowance.bytes()).toBe(before);
  });

  it("follows a link that slowed, once the faster rate is older than its window", () => {
    const allowance = new InFlightAllowance(4 * MB);
    const end = fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 20 });
    const fast = allowance.bytes();

    fill(allowance, { bytesPerMs: 3_000, roundTripMs: 200, bytes: 500_000, count: 60, startMs: end + 1_000 });
    expect(allowance.bytes()).toBeLessThan(fast / 3);
  });

  it("charges what the wire's rate allows as the chunks now landing compress", () => {
    const allowance = new InFlightAllowance(4 * MB);
    // Chunks that compress tenfold, then ones that do not compress at all.
    const end = fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, wireBytes: 50_000, count: 200, inFlight: 100 });
    expect(allowance.bytes()).toBeGreaterThan(12_500 * 400 * 9);

    fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 200, startMs: end });
    const bytes = allowance.bytes();
    expect(bytes).toBeGreaterThan(12_500 * 400 * 0.9);
    expect(bytes).toBeLessThan(12_500 * 400 * 1.3);
  });

  it("starts over after a reset", () => {
    const allowance = new InFlightAllowance(4 * MB);
    fill(allowance, { bytesPerMs: 12_500, roundTripMs: 200, bytes: 500_000, count: 20 });
    allowance.reset();
    expect(allowance.bytes()).toBe(4 * MB);
  });
});
