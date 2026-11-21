/**
 * How many fetched bytes the page keeps in flight, sized to what its
 * connection delivers.
 *
 * Every frame the server sends crosses the link in the order it was read, so
 * a request sent behind a full allowance waits for all of it before its own
 * bytes cross. The allowance is a queue that a view the person moved to waits
 * behind. Near the link's bandwidth-delay product it keeps the link busy
 * while a request's round trip stays its own transfer, and what is not yet
 * sent waits in the page's queue, where the next plan can reorder it.
 *
 * Measured from arrivals, as a congestion controller measures acknowledgments:
 * each landed fetch gives a round trip and a delivery rate, the wire bytes
 * that landed while it was in flight over how long it was. The allowance is
 * the fastest recent rate over a little more than the shortest round trip.
 */

/**
 * The shortest round trip is a store's fastest read, and the rest take up to
 * twice as long: an object store's first byte takes 100 to 200 ms. Twice the
 * shortest keeps the link busy through the slowest of them.
 */
const ROUND_TRIP_GAIN = 2;

/**
 * The allowance never holds less than the link delivers in this time. The
 * shortest round trip can come from a read the server had cached, far faster
 * than the store reads every other request waits on, and an allowance sized
 * to it would leave the link idle. A queue that drains this fast costs a
 * person nothing. On one machine, where round trips take milliseconds, it
 * leaves the bytes cap in charge.
 */
const DRAIN_FLOOR_MS = 250;

/**
 * How long a delivery rate counts toward the fastest. Long enough to span
 * reads whose times vary by a round trip, short enough that a link which
 * slowed stops being overfilled within a few seconds.
 */
const RATE_WINDOW_MS = 4_000;

/**
 * How much of the charged-to-wire ratio each landed fetch keeps of the ones
 * before it: about the last thirty fetches. Chunks of empty regions compress
 * to almost nothing and dense ones barely, so the ratio follows the chunks
 * now in flight, and a burst of empty ones cannot widen the allowance the
 * way a fastest rate counted in charged bytes would.
 */
const RATIO_DECAY = 0.97;

/** Taken when a fetch is sent, and handed back when it lands. */
export interface SendStamp {
  sentAtMs: number;
  /** The wire bytes that had landed when it was sent. */
  deliveredAtSend: number;
  /**
   * Sent while the page had nothing more to send, which the sender marks once
   * it knows. Its rate says only that the link delivers at least that much,
   * so it can raise the fastest rate but never stands in for it.
   */
  appLimited: boolean;
}

interface RateSample {
  atMs: number;
  wireBytesPerMs: number;
}

export class InFlightAllowance {
  private readonly initialBytes: number;
  private delivered = 0;
  private shortestRoundTripMs = Infinity;
  /** Recent rates, oldest first, each faster than every one after it: the fastest is first. */
  private rates: RateSample[] = [];
  /** Decaying sums of what landed fetches were charged and what the wire carried. */
  private charged = 0;
  private carried = 0;

  /** `initialBytes` is the allowance before a rate is known. */
  constructor(initialBytes: number) {
    this.initialBytes = initialBytes;
  }

  stamp(nowMs: number): SendStamp {
    return { sentAtMs: nowMs, deliveredAtSend: this.delivered, appLimited: false };
  }

  /**
   * The fetch `stamp` was taken for landed, charged `bytes` in flight, after
   * the wire carried `wireBytes` of it: fewer when it came still compressed.
   */
  landed(stamp: SendStamp, bytes: number, wireBytes: number, nowMs: number): void {
    this.delivered += wireBytes;
    this.charged = this.charged * RATIO_DECAY + bytes;
    this.carried = this.carried * RATIO_DECAY + wireBytes;
    const elapsedMs = nowMs - stamp.sentAtMs;
    if (!(elapsedMs > 0)) return;
    if (elapsedMs < this.shortestRoundTripMs) this.shortestRoundTripMs = elapsedMs;
    // A fetch sent before anything landed measures the round trip but not the
    // rate: its interval starts before the link had anything to carry.
    if (stamp.deliveredAtSend === 0) return;
    const wireBytesPerMs = (this.delivered - stamp.deliveredAtSend) / elapsedMs;
    if (stamp.appLimited && wireBytesPerMs <= this.fastestWireBytesPerMs()) return;
    this.addRate({ atMs: nowMs, wireBytesPerMs });
  }

  /**
   * The bytes allowed in flight, charged as fetches are, before any cap.
   * Samples expire only as newer ones arrive, so a page that stops fetching
   * keeps the allowance it had.
   */
  bytes(): number {
    const wireBytesPerMs = this.fastestWireBytesPerMs();
    if (wireBytesPerMs === 0 || this.shortestRoundTripMs === Infinity) return this.initialBytes;
    const ms = Math.max(DRAIN_FLOOR_MS, ROUND_TRIP_GAIN * this.shortestRoundTripMs);
    return wireBytesPerMs * ms * (this.charged / this.carried);
  }

  reset(): void {
    this.delivered = 0;
    this.shortestRoundTripMs = Infinity;
    this.rates = [];
    this.charged = 0;
    this.carried = 0;
  }

  private fastestWireBytesPerMs(): number {
    return this.rates.length > 0 ? this.rates[0].wireBytesPerMs : 0;
  }

  private addRate(sample: RateSample): void {
    const rates = this.rates;
    while (rates.length > 0 && rates[rates.length - 1].wireBytesPerMs <= sample.wireBytesPerMs) rates.pop();
    rates.push(sample);
    while (rates.length > 1 && sample.atMs - rates[0].atMs > RATE_WINDOW_MS) rates.shift();
  }
}
