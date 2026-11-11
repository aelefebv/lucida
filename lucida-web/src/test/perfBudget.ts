/**
 * Timing budgets that hold on any host.
 *
 * A wall-clock budget measures the host as much as the code: the same tick
 * times many times apart on an idle workstation and on a CI runner sharing
 * its cores with the rest of the suite. So every step is timed interleaved
 * with a fixed reference workload, sample by sample, and each step sample is
 * divided by how much slower than nominal the reference sample beside it ran.
 * Whatever slows the host evenly, a slower CPU, a busy machine, a collection,
 * slows both and cancels out of the ratio. A host that slows for a stretch
 * slows both samples of a pair, so each pair's own ratio cancels it too,
 * where the two medians taken apart would each catch it a different number
 * of times. Other test files contending for a few shared cores do not slow
 * everything evenly, so the perf tests also run in a phase of their own
 * (`vite.config.ts`).
 *
 * What is left is the step's cost on the nominal host, and budgets are stated
 * in those microseconds at about twice the typical figure. A step that gets
 * three times slower fails; a slow or busy host does not.
 *
 * The reference cancels the host, not the JavaScript engine. A Node major
 * with a different V8 can move a single figure several times over, so the
 * budgets are set on the Node that CI installs, and need setting again when
 * that changes.
 */

import { expect } from "vitest";

/**
 * One reference unit's median on the nominal host, an idle desktop. Only the
 * scale of the budgets depends on it, so it is not re-measured when hosts
 * change; the budgets were set against it.
 */
const NOMINAL_UNIT_US = 5;

/** Below this a reference sample is mostly call overhead and clock resolution. */
const MIN_UNITS = 16;

const KEYS = Array.from({ length: 32 }, (_, i) => `key-${i}`);
const scratch = new Float64Array(256);
let sink = 0;
let referenceWarm = false;

/**
 * A fixed mix of what the measured code does: string keys into a Map, small
 * objects, a sort, typed-array arithmetic. Linear in `units`, so a sample can
 * be sized to the step it runs beside.
 */
function reference(units: number): void {
  let acc = 0;
  for (let u = 0; u < units; u++) {
    const map = new Map<string, { at: number; n: number }>();
    for (let i = 0; i < KEYS.length; i++) map.set(`${KEYS[i]}/${(u + i) & 3}`, { at: i, n: u });
    for (let i = 0; i < KEYS.length; i++) acc += map.get(`${KEYS[(i * 7) & 31]}/${(u + i) & 3}`)?.at ?? 0;
    const items = Array.from(map.values());
    items.sort((a, b) => ((a.at * 13) & 31) - ((b.at * 13) & 31));
    acc += items[0].at;
    for (let i = 0; i < scratch.length; i++) {
      scratch[i] = scratch[(i * 17) & 255] * 0.5 + i;
      acc += scratch[i] > 100 ? 1 : 0;
    }
  }
  sink = (sink + acc) | 0;
}

export interface StepTiming {
  /** The step's own figures on this host, in microseconds. */
  p50Us: number;
  p95Us: number;
  maxUs: number;
  /** How much slower than nominal the reference ran beside the step, its median sample. */
  runnerFactor: number;
  /**
   * The step's median on the nominal host: the median over samples of each
   * step sample divided by the runner factor of the reference sample beside
   * it. Close to `p50Us / runnerFactor` on a steady host.
   */
  nominalUs: number;
}

export interface TimeStepOptions {
  /** Timed calls. */
  samples: number;
  /** Untimed calls first, past the JIT's first tiers. */
  warmup?: number;
  /** Untimed work before every call of the step, warmup included. */
  before?: () => void;
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/**
 * Call `step` `warmup + samples` times, exactly, and time the last `samples`
 * of those calls interleaved with the reference. Steps may count their calls.
 */
export function timeStep(step: () => void, options: TimeStepOptions): StepTiming {
  const { samples, warmup = Math.min(samples, 20), before } = options;
  const warmTimes: number[] = [];
  for (let i = 0; i < warmup; i++) {
    before?.();
    const t0 = performance.now();
    step();
    warmTimes.push(performance.now() - t0);
  }
  if (!referenceWarm) {
    // Past every tier of the JIT, so the first step timed is not also the
    // one paying for the reference's compilation.
    for (let i = 0; i < 400; i++) reference(MIN_UNITS);
    referenceWarm = true;
  }
  const unitProbe: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    reference(MIN_UNITS);
    unitProbe.push((performance.now() - t0) / MIN_UNITS);
  }
  // Size a reference sample to last about as long as a step sample, so a
  // descheduling or a collection is as likely to land in either.
  const warmSorted = warmTimes.slice(warmup >> 1).sort((a, b) => a - b);
  const stepGuess = warmSorted.length > 0 ? quantile(warmSorted, 0.5) : 0;
  const unitGuess = Math.max(quantile(unitProbe.sort((a, b) => a - b), 0.5), 1e-4);
  const units = Math.max(MIN_UNITS, Math.min(20_000, Math.round(stepGuess / unitGuess)));

  const stepTimes: number[] = [];
  const unitTimes: number[] = [];
  const nominalTimes: number[] = [];
  for (let i = 0; i < samples; i++) {
    before?.();
    // Alternate the order, so neither always runs on the other's cache.
    if (i % 2 === 0) {
      const t0 = performance.now();
      reference(units);
      const t1 = performance.now();
      step();
      const t2 = performance.now();
      unitTimes.push((t1 - t0) / units);
      stepTimes.push(t2 - t1);
    } else {
      const t0 = performance.now();
      step();
      const t1 = performance.now();
      reference(units);
      const t2 = performance.now();
      stepTimes.push(t1 - t0);
      unitTimes.push((t2 - t1) / units);
    }
    nominalTimes.push((stepTimes[i] * NOMINAL_UNIT_US) / (unitTimes[i] * 1_000));
  }
  stepTimes.sort((a, b) => a - b);
  unitTimes.sort((a, b) => a - b);
  nominalTimes.sort((a, b) => a - b);
  return {
    p50Us: quantile(stepTimes, 0.5) * 1_000,
    p95Us: quantile(stepTimes, 0.95) * 1_000,
    maxUs: stepTimes[stepTimes.length - 1] * 1_000,
    runnerFactor: (quantile(unitTimes, 0.5) * 1_000) / NOMINAL_UNIT_US,
    nominalUs: quantile(nominalTimes, 0.5) * 1_000,
  };
}

/** One log line's worth: the host's figure, the runner factor, and the nominal figure against its budget. */
export function describeTiming(timing: StepTiming, budgetUs: number): string {
  return (
    `p50=${timing.p50Us.toFixed(1)}µs p95=${timing.p95Us.toFixed(1)}µs max=${timing.maxUs.toFixed(1)}µs | ` +
    `runner ${timing.runnerFactor.toFixed(2)}x nominal | nominal p50=${timing.nominalUs.toFixed(1)}µs, ` +
    `budget ${budgetUs}µs (${(timing.nominalUs / budgetUs).toFixed(2)} of it)`
  );
}

/** Assert the step's nominal median is inside `budgetUs`. */
export function expectWithinBudget(label: string, timing: StepTiming, budgetUs: number): void {
  expect(timing.nominalUs, `${label}: ${describeTiming(timing, budgetUs)}`).toBeLessThan(budgetUs);
}

export interface RelativeTiming {
  stepUs: number;
  baselineUs: number;
  /** `stepUs / baselineUs`, what a budget holds. */
  ratio: number;
}

/**
 * Time `step` interleaved with `baseline`, a stand-in doing the same kind of
 * work over the same data, and compare their medians. For a step the generic
 * reference does not track across hosts: hosts differ in what is cheap, and a
 * baseline of the same kind is charged the same.
 */
export function timeAgainstBaseline(
  step: () => void,
  baseline: () => void,
  options: { samples: number; warmup?: number },
): RelativeTiming {
  const { samples, warmup = Math.min(samples, 20) } = options;
  for (let i = 0; i < warmup; i++) {
    baseline();
    step();
  }
  const stepTimes: number[] = [];
  const baselineTimes: number[] = [];
  for (let i = 0; i < samples; i++) {
    const first = i % 2 === 0 ? baseline : step;
    const second = first === step ? baseline : step;
    const t0 = performance.now();
    first();
    const t1 = performance.now();
    second();
    const t2 = performance.now();
    (first === step ? stepTimes : baselineTimes).push(t1 - t0);
    (second === step ? stepTimes : baselineTimes).push(t2 - t1);
  }
  stepTimes.sort((a, b) => a - b);
  baselineTimes.sort((a, b) => a - b);
  const stepUs = quantile(stepTimes, 0.5) * 1_000;
  const baselineUs = quantile(baselineTimes, 0.5) * 1_000;
  return { stepUs, baselineUs, ratio: stepUs / Math.max(baselineUs, 1e-3) };
}
