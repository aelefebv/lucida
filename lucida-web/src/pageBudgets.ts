/**
 * The page's memory budgets: fitted to the device it runs on, under the GPU
 * memory a person set in Settings. The CPU cache and the render worker
 * follow them as they change: when the adapter becomes known, and when the
 * setting does.
 */

import {
  GPU_TOTAL_FLOOR_BYTES,
  fitBudgets,
  readDeviceFacts,
  type DeviceBudgets,
  type DeviceFacts,
} from "./deviceBudget.ts";
import { definePreference, getPreference, subscribePreferences } from "./theme/preferences.ts";

/**
 * The GPU memory budget a person set, in bytes, or null for the device's
 * own. A preference of this browser rather than of the person, since it
 * describes this machine's GPU: a total set on a workstation must not follow
 * its owner to a phone.
 */
export const gpuBudgetPreference = definePreference<number | null>("memory.gpuBudgetBytes", null, (raw) =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.max(GPU_TOTAL_FLOOR_BYTES, raw) : undefined,
);

/**
 * Null until the adapter is known. Until then the page takes it for a
 * hardware one: it is known well before any dataset opens, and a software
 * one shrinks the budgets before anything fills them.
 */
let fallbackAdapter: boolean | null = null;
let facts: DeviceFacts | null = null;
let current: { set: number | null; facts: DeviceFacts; budgets: DeviceBudgets } | null = null;
const listeners = new Set<() => void>();

function pageFacts(): DeviceFacts {
  facts ??= { ...readDeviceFacts(), fallbackAdapter };
  return facts;
}

/** The budgets the page runs under now. */
export function pageDeviceBudgets(): DeviceBudgets {
  const set = getPreference(gpuBudgetPreference);
  const now = pageFacts();
  if (current === null || current.set !== set || current.facts !== now) {
    current = { set, facts: now, budgets: fitBudgets(now, set) };
  }
  return current.budgets;
}

/** The budgets the device would get with no GPU memory set, for Settings to show as automatic. */
export function pageDefaultBudgets(): DeviceBudgets {
  return fitBudgets(pageFacts());
}

/** The adapter the page found: whether it is a software rasterizer, null when the browser doesn't say. */
export function noteAdapter(fallback: boolean | null): void {
  if (fallback === fallbackAdapter) return;
  fallbackAdapter = fallback;
  facts = null;
  notifyIfChanged();
}

let notified: DeviceBudgets | null = null;

function notifyIfChanged(): void {
  const next = pageDeviceBudgets();
  if (notified !== null && sameBudgets(notified, next)) return;
  notified = next;
  for (const listener of [...listeners]) listener();
}

function sameBudgets(a: DeviceBudgets, b: DeviceBudgets): boolean {
  return (Object.keys(a) as (keyof DeviceBudgets)[]).every((key) => a[key] === b[key]);
}

let stopFollowingSetting: (() => void) | null = null;

/** Calls `listener` each time {@link pageDeviceBudgets} changes. */
export function subscribePageBudgets(listener: () => void): () => void {
  notified ??= pageDeviceBudgets();
  listeners.add(listener);
  stopFollowingSetting ??= subscribePreferences(notifyIfChanged);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopFollowingSetting?.();
      stopFollowingSetting = null;
    }
  };
}

/** Forget the adapter and the facts read, as a fresh page would. Tests only. */
export function __resetPageBudgetsForTesting(): void {
  fallbackAdapter = null;
  facts = null;
  current = null;
  notified = null;
  listeners.clear();
  stopFollowingSetting?.();
  stopFollowingSetting = null;
}
