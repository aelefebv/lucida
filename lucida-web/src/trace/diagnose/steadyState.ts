/**
 * The steady-state ruleset: what the pipeline did after the view settled.
 *
 * The other three threshold families judge a run — a stretch with a cause, a
 * settle and a critical path. None of them can answer the field report's
 * question, because a settled view has no stall to find: the view looks
 * loaded and the network monitor keeps moving. So this family reads the
 * unlabelled interval that opened when the run closed, and the run's own
 * settle block, and gives "is this expected" a named answer.
 *
 * Five rules, each with its floor and its rationale in {@link RULESET}:
 * sustained bytes received, chunks fetched again, a tier that cannot fit what
 * the view wants, planning passes woken by an availability update alone, and
 * sustained bytes sent. Every number a finding prints is a field of
 * {@link SteadyStateReading}, so the dock, the overlays and this text read one
 * document rather than three.
 *
 * Pure, like the rest of the derivation: everything it needs is in the run and
 * the interval it was handed.
 */

import { RESIDENCY_TIERS, type ResidencyTier } from "../../pipeline/residencyTier.ts";
import { UNLABELLED, type LaneName, type TraceRun } from "../types.ts";
import { usToMs } from "./phaseRollup.ts";
import { RULESET } from "./ruleset.ts";
import { summariseSent } from "./sent.ts";
import type {
  Finding,
  FindingObservation,
  ReceivedByLane,
  ReceivedSummary,
  RefetchSummary,
  ReplanSummary,
  SteadyStateInterval,
  SteadyStateReading,
  TierAtSettle,
} from "./types.ts";

const US_PER_SECOND = 1_000_000;

/** A steady-state finding before ranking, which is what assigns an id. */
export type SteadyStateFinding = Omit<Finding, "id" | "confidence" | "attribution"> & {
  severity: "steady-state";
};

/**
 * What the rules found, and the reading they found it in. Both come out of
 * one call because the reading's statement is what the rules concluded: a
 * document whose statement and whose findings were derived separately could
 * disagree with itself.
 */
export interface SteadyStateDerivation {
  reading: SteadyStateReading;
  findings: SteadyStateFinding[];
}

/**
 * Read the steady state around one closed run.
 *
 * `interval` is the unlabelled interval that opened when the run closed, or
 * null when the document holds none. `absence` says why in one phrase, so a
 * reading with nothing in it states which nothing it is. The tier rules read
 * the run's settle block either way: a tier that cannot fit what the view
 * wants is why a run failed to settle, and there may be no interval after it
 * at all.
 */
export function deriveSteadyState(
  run: TraceRun,
  interval: TraceRun | null,
  absence: string,
): SteadyStateDerivation {
  const tiers = tiersAtSettle(run);
  const replans = interval ? summariseReplans(interval) : null;
  const described = interval && replans ? describeInterval(interval, replans) : null;
  const received = interval ? summariseReceived(interval) : null;
  const refetch = interval ? summariseRefetch(interval) : null;
  const sent = interval ? summariseSent(interval.sent, interval.header.durationUs) : null;

  const findings: SteadyStateFinding[] = [
    ...receivedFinding(described, received),
    ...refetchFinding(refetch),
    ...budgetBoundFindings(tiers),
    ...replanFinding(described, replans),
    ...sentFinding(described, sent),
  ];

  return {
    reading: {
      interval: described,
      received,
      refetch,
      replans,
      sent,
      tiers,
      statement: statementFor(described, findings, absence),
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// The interval
// ---------------------------------------------------------------------------

function describeInterval(interval: TraceRun, replans: ReplanSummary): SteadyStateInterval {
  return {
    id: interval.header.runId,
    endReason: interval.header.endReason,
    startedAtEpochMs: interval.header.startedAtEpochMs,
    windowMs: usToMs(interval.header.durationUs),
    rows: interval.rows.length,
    passes: replans.passes,
  };
}

/** One wire request's delivery: when it landed, what it carried, on which lane. */
interface Delivery {
  atUs: number;
  bytes: number;
  lane: LaneName;
}

/**
 * The interval's deliveries, one per wire request.
 *
 * Several rows can ride one request — the transport coalesces duplicate
 * in-flight fetches onto the first sender's — and each carries that request's
 * bytes, so a sum over rows would multiply what the wire actually delivered.
 * A row with no wire request of its own has no generation to join on and is
 * counted once, as itself.
 */
function deliveries(interval: TraceRun): Delivery[] {
  const out: Delivery[] = [];
  const seen = new Set<string>();
  for (const row of interval.rows) {
    const wire = row.phases.wire;
    if (!wire || row.bytes === 0) continue;
    if (row.connectionGeneration !== UNLABELLED.connectionGeneration) {
      const label = `${row.connectionGeneration}/${row.rid}`;
      if (seen.has(label)) continue;
      seen.add(label);
    }
    out.push({ atUs: wire.endUs, bytes: row.bytes, lane: row.lane });
  }
  return out;
}

/**
 * Bytes in, binned by the second they landed in. Seconds are counted one by
 * one rather than averaged, because a burst that finishes in two seconds is a
 * tail and an average over the interval would hide the difference.
 */
function summariseReceived(interval: TraceRun): ReceivedSummary {
  const spanUs = Math.max(1, interval.header.durationUs);
  const floor = RULESET.steadyState.received.minBytesPerS;
  const bySecond = new Map<number, number>();
  const byLaneBytes = new Map<LaneName, { bytes: number; requests: number }>();
  let bytes = 0;
  const found = deliveries(interval);
  for (const delivery of found) {
    bytes += delivery.bytes;
    const second = Math.floor(delivery.atUs / US_PER_SECOND);
    bySecond.set(second, (bySecond.get(second) ?? 0) + delivery.bytes);
    const lane = byLaneBytes.get(delivery.lane) ?? { bytes: 0, requests: 0 };
    lane.bytes += delivery.bytes;
    lane.requests += 1;
    byLaneBytes.set(delivery.lane, lane);
  }

  let busySeconds = 0;
  let busyBytes = 0;
  for (const secondBytes of bySecond.values()) {
    if (secondBytes < floor) continue;
    busySeconds += 1;
    busyBytes += secondBytes;
  }

  const byLane: ReceivedByLane[] = [...byLaneBytes]
    .map(([lane, tally]) => ({
      lane,
      bytes: tally.bytes,
      requests: tally.requests,
      bytesPerS: ratePerSecond(tally.bytes, spanUs),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    bytes,
    requests: found.length,
    bytesPerS: ratePerSecond(bytes, spanUs),
    busySeconds,
    busyBytesPerS: busySeconds === 0 ? 0 : Math.round(busyBytes / busySeconds),
    byLane,
  };
}

/**
 * Churn over the interval, by row identity: the dataset, the entity and the
 * chunk key together, which is what makes two fetches of one member's chunk
 * the same chunk rather than two. A row whose wire never closed was never
 * fetched and is not counted.
 */
function summariseRefetch(interval: TraceRun): RefetchSummary {
  const fetches = new Map<string, number[]>();
  for (const row of interval.rows) {
    if (!row.phases.wire) continue;
    const identity = `${row.datasetId}/${row.entityId}/${row.chunkKey}`;
    const seen = fetches.get(identity);
    if (seen) seen.push(row.bytes);
    else fetches.set(identity, [row.bytes]);
  }
  let chunks = 0;
  let refetches = 0;
  let bytes = 0;
  for (const seen of fetches.values()) {
    if (seen.length < 2) continue;
    chunks += 1;
    refetches += seen.length - 1;
    // Rows are appended in dispatch order, so everything past the first is a
    // fetch of something the interval already had.
    for (let i = 1; i < seen.length; i += 1) bytes += seen[i];
  }
  return { windowMs: usToMs(interval.header.durationUs), chunks, refetches, bytes };
}

function summariseReplans(interval: TraceRun): ReplanSummary {
  const passes = new Map<string, number>();
  const woken = new Map<string, number>();
  for (const tick of interval.ticks) {
    passes.set(tick.datasetId, (passes.get(tick.datasetId) ?? 0) + 1);
    if (tick.availabilityWoken) woken.set(tick.datasetId, (woken.get(tick.datasetId) ?? 0) + 1);
  }
  return { passes: busiest(passes), availabilityWoken: busiest(woken) };
}

// ---------------------------------------------------------------------------
// The tiers at settle
// ---------------------------------------------------------------------------

function tiersAtSettle(run: TraceRun): TierAtSettle[] {
  const settle = run.header.outstandingAtSettle;
  const minFillPct = RULESET.steadyState.budgetBound.minFillPct;
  const held: Record<ResidencyTier, { wanted: number; resident: number; bytes: number; budgetBytes: number }> = {
    detail: {
      wanted: settle.desiredDetailChunks,
      resident: settle.residentDetailChunks,
      bytes: settle.detailBytes,
      budgetBytes: settle.detailBudgetBytes,
    },
    coarse: {
      wanted: settle.desiredCoarseChunks,
      resident: settle.residentCoarseChunks,
      bytes: settle.coarseBytes,
      budgetBytes: settle.coarseBudgetBytes,
    },
  };
  return RESIDENCY_TIERS.map((tier) => {
    const at = held[tier];
    const fillPct = at.budgetBytes > 0 ? Math.floor((at.bytes / at.budgetBytes) * 100) : 0;
    const coverageLossChunks = Math.max(0, at.wanted - at.resident);
    return {
      tier,
      wanted: at.wanted,
      resident: at.resident,
      bytes: at.bytes,
      budgetBytes: at.budgetBytes,
      fillPct,
      pending: settle.pending,
      inFlight: settle.inFlight,
      // Nothing queued and nothing out, a tier all but full, and chunks the
      // view still wants: the tier stopped asking because the rest cannot fit.
      budgetBound:
        fillPct >= minFillPct &&
        coverageLossChunks > 0 &&
        settle.pending === 0 &&
        settle.inFlight === 0,
      coverageLossChunks,
      coverageLossPct: at.wanted > 0 ? Math.floor((coverageLossChunks / at.wanted) * 100) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// The five rules
// ---------------------------------------------------------------------------

/**
 * What each rule fires on. Distinct strings, because the findings list keeps
 * one finding per subject, and named for the interval rather than for a phase
 * so a reader never looks for "receive after settle" in the phase table.
 */
export const RECEIVE_SUBJECT = "receive after settle";
export const REFETCH_SUBJECT = "refetch after settle";
export const REPLAN_SUBJECT = "replans after settle";
export const SEND_SUBJECT = "send after settle";
export function tierSubject(tier: ResidencyTier): string {
  return `${tier} tier`;
}

function receivedFinding(
  interval: SteadyStateInterval | null,
  received: ReceivedSummary | null,
): SteadyStateFinding[] {
  const rule = RULESET.steadyState.received;
  if (!interval || !received || received.busySeconds < rule.minSeconds) return [];
  return [
    {
      severity: "steady-state",
      rule: rule.id,
      subject: RECEIVE_SUBJECT,
      observed: {
        windowMs: interval.windowMs,
        bytes: received.bytes,
        bytesPerS: received.busyBytesPerS,
        seconds: received.busySeconds,
        breakdown: Object.fromEntries(received.byLane.map((lane) => [lane.lane, lane.bytes])),
      },
      threshold: { kind: "sustained", value: rule.minBytesPerS, why: rule.why },
    },
  ];
}

function refetchFinding(refetch: RefetchSummary | null): SteadyStateFinding[] {
  const rule = RULESET.steadyState.refetch;
  if (!refetch || refetch.chunks < rule.minChunks) return [];
  return [
    {
      severity: "steady-state",
      rule: rule.id,
      subject: REFETCH_SUBJECT,
      observed: {
        windowMs: refetch.windowMs,
        chunks: refetch.chunks,
        refetches: refetch.refetches,
        bytes: refetch.bytes,
      },
      threshold: { kind: "churn", value: rule.minChunks, why: rule.why },
    },
  ];
}

function budgetBoundFindings(tiers: TierAtSettle[]): SteadyStateFinding[] {
  const rule = RULESET.steadyState.budgetBound;
  return tiers
    .filter((tier) => tier.budgetBound)
    .map((tier) => ({
      severity: "steady-state" as const,
      rule: rule.id,
      subject: tierSubject(tier.tier),
      observed: {
        wanted: tier.wanted,
        resident: tier.resident,
        residentBytes: tier.bytes,
        budgetBytes: tier.budgetBytes,
        fillPct: tier.fillPct,
        lossChunks: tier.coverageLossChunks,
        lossPct: tier.coverageLossPct,
      },
      threshold: { kind: "budget", value: rule.minFillPct, why: rule.why },
    }));
}

function replanFinding(
  interval: SteadyStateInterval | null,
  replans: ReplanSummary | null,
): SteadyStateFinding[] {
  const rule = RULESET.steadyState.replans;
  if (!interval || !replans || replans.availabilityWoken < rule.minPasses) return [];
  return [
    {
      severity: "steady-state",
      rule: rule.id,
      subject: REPLAN_SUBJECT,
      observed: {
        windowMs: interval.windowMs,
        passes: replans.passes,
        wokenPasses: replans.availabilityWoken,
      },
      threshold: { kind: "replans", value: rule.minPasses, why: rule.why },
    },
  ];
}

function sentFinding(
  interval: SteadyStateInterval | null,
  sent: SteadyStateReading["sent"],
): SteadyStateFinding[] {
  const rule = RULESET.steadyState.sent;
  if (!interval || !sent) return [];
  const seconds = Math.floor(interval.windowMs / 1_000);
  if (seconds < rule.minSeconds || sent.bytesPerS < rule.minBytesPerS) return [];
  return [
    {
      severity: "steady-state",
      rule: rule.id,
      subject: SEND_SUBJECT,
      observed: {
        windowMs: interval.windowMs,
        bytes: sent.bytes,
        bytesPerS: sent.bytesPerS,
        seconds,
        breakdown: Object.fromEntries(
          sent.byType.filter((type) => type.bytes > 0).map((type) => [type.label, type.bytes]),
        ),
      },
      threshold: { kind: "sustained", value: rule.minBytesPerS, why: rule.why },
    },
  ];
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

/**
 * One steady-state finding as a sentence, for the verdict and the reading's
 * statement. The renderer prints the same numbers as a list with a document
 * path recorded for each; this is the prose twin, and both read the one
 * observation so they cannot disagree.
 */
export function describeSteadyStateFinding(finding: SteadyStateFinding | Finding): string {
  const observed = finding.observed;
  const rules = RULESET.steadyState;
  switch (finding.rule) {
    case rules.received.id:
      return (
        `the view settled and the pipeline kept receiving: ` +
        `${count(observed.bytesPerS)} B/s across ${count(observed.seconds)} busy second(s) of the ` +
        `${count(observed.windowMs)} ms after the run closed${byLane(observed)}`
      );
    case rules.refetch.id:
      return (
        `${count(observed.chunks)} chunk(s) were fetched again after the view settled — ` +
        `${count(observed.refetches)} refetch(es) costing ${count(observed.bytes)} B over the ` +
        `${count(observed.windowMs)} ms window`
      );
    case rules.budgetBound.id:
      return (
        `the ${finding.subject} is budget-bound at ${count(observed.residentBytes)} B of ` +
        `${count(observed.budgetBytes)} B (${count(observed.fillPct)}% full) with nothing pending and ` +
        `nothing in flight, so ${count(observed.lossChunks)} of ${count(observed.wanted)} wanted chunk(s) ` +
        `cannot fit — a coverage loss of ${count(observed.lossPct)}%, not a timeout`
      );
    case rules.replans.id:
      return (
        `${count(observed.wokenPasses)} of ${count(observed.passes)} planning pass(es) in the ` +
        `${count(observed.windowMs)} ms after the run closed were woken by an availability update alone`
      );
    case rules.sent.id:
      return (
        `the socket did not go quiet after the view settled: ${count(observed.bytesPerS)} B/s over ` +
        `${count(observed.seconds)} s${byMessageType(observed)}`
      );
    default:
      return `${finding.subject} crossed ${finding.rule}`;
  }
}

function statementFor(
  interval: SteadyStateInterval | null,
  findings: SteadyStateFinding[],
  absence: string,
): string {
  const rotated = handedOver(interval);
  if (findings.length > 0) {
    return `${findings.map(describeSteadyStateFinding).join("; ")}.${rotated}`;
  }
  if (!interval) {
    return (
      `Nothing to read after the run — ${absence} — and neither residency tier was budget-bound ` +
      `when it closed.`
    );
  }
  return (
    `The ${interval.windowMs} ms after the run closed crossed no steady-state threshold: nothing ` +
    `sustained on the wire in either direction, no chunk fetched twice, no planning pass woken by ` +
    `an availability update alone, and neither residency tier budget-bound.${rotated}`
  );
}

/**
 * A steady-state interval rotates rather than truncates when it fills the
 * per-run cap: it hands over to a fresh one and keeps recording. Every rule
 * here reads the first interval after the run, so what the successor holds is
 * outside these numbers, and a reading that did not say so would be read as
 * covering everything after the run.
 */
function handedOver(interval: SteadyStateInterval | null): string {
  if (interval?.endReason !== "rotated") return "";
  return (
    " This interval filled the per-run cap and handed over to a fresh one, so anything after that" +
    " handover is not counted here."
  );
}

/** Which lane received the most of it, so the traffic has a name and not just a size. */
function byLane(observed: FindingObservation): string {
  const ranked = heaviest(observed);
  if (!ranked) return "";
  return ranked.rest === 0
    ? `, all of it on the ${ranked.name} lane`
    : `, most of it on the ${ranked.name} lane of ${ranked.rest + 1}`;
}

/** Which client message type sent the most of it. */
function byMessageType(observed: FindingObservation): string {
  const ranked = heaviest(observed);
  if (!ranked) return "";
  return ranked.rest === 0
    ? `, all of it ${ranked.name} messages`
    : `, mostly ${ranked.name} messages, beside ${ranked.rest} other type(s)`;
}

/** The heaviest contributor in a breakdown, and how many others there were. */
function heaviest(observed: FindingObservation): { name: string; rest: number } | null {
  const breakdown = observed.breakdown;
  if (!breakdown) return null;
  const ranked = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  return { name: ranked[0][0], rest: ranked.length - 1 };
}

function count(value: number | undefined): string {
  return (value ?? 0).toLocaleString();
}

function ratePerSecond(bytes: number, spanUs: number): number {
  return Math.round((bytes * US_PER_SECOND) / Math.max(1, spanUs));
}

function busiest(counts: Map<string, number>): number {
  let most = 0;
  for (const seen of counts.values()) if (seen > most) most = seen;
  return most;
}
