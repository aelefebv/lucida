/**
 * The send side of one interval, in the diagnostic's units. One function for
 * a run and the steady-state interval after it, because the two are the same
 * object differing only by cause (ADR 0047). The rate's denominator is the
 * interval's own span.
 *
 * Read from the interval's totals rather than summed off the tick samples: a
 * sample is published only by a planning pass, and the sends worth explaining
 * come after the last pass, when the view looks loaded.
 */

import { CLIENT_MESSAGES, type SendTallies } from "../types.ts";
import type { SentSummary } from "./types.ts";

export function summariseSent(sent: SendTallies, wallUs: number): SentSummary {
  const spanUs = Math.max(1, wallUs);
  const perSecond = (bytes: number): number => Math.round((bytes * 1_000_000) / spanUs);
  let messages = 0;
  let bytes = 0;
  const byType = CLIENT_MESSAGES.map(({ type, label }) => {
    const tally = sent[type];
    messages += tally.messages;
    bytes += tally.bytes;
    return {
      type,
      label,
      messages: tally.messages,
      bytes: tally.bytes,
      bytesPerS: perSecond(tally.bytes),
    };
  });
  return { messages, bytes, bytesPerS: perSecond(bytes), byType };
}
