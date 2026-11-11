/**
 * Each view's own settle, when several views share the canvas: a view has
 * settled once every chunk admission let through for it is held and on the
 * GPU and nothing is left to draw. The page settles when every view has,
 * since the cache drives toward the union of their plans, so this only says
 * which view finished when, and how much of what it asked for it covers.
 */
import type { ChunkRequest } from "./planning/types.ts";
import type { ViewCoverage } from "./planning/viewCoverage.ts";

export interface ViewSettle {
  view: number;
  /** Every chunk let through for it is held and on the GPU, and nothing is left to draw. */
  settled: boolean;
  /** Its own detail and coarse requests. */
  wanted: number;
  /** Those admission left out for want of room: under pressure, what it covers less of. */
  short: number;
}

/** What a view's chunks are checked against: the CPU cache and what reached the GPU. */
export interface ChunkResidency {
  holds(req: ChunkRequest): boolean;
  onGpu(req: ChunkRequest): boolean;
}

/**
 * Each view's settle from its coverage. `drawing` says the page still has a
 * view change or a frame to draw, which no view has settled through.
 */
export function evaluateViewSettles(
  coverage: ReadonlyMap<number, ViewCoverage>,
  residency: ChunkResidency,
  drawing: boolean,
): ViewSettle[] {
  return [...coverage].map(([view, { wanted, short, admitted }]) => ({
    view,
    settled: !drawing && admitted.every((req) => residency.holds(req) && residency.onGpu(req)),
    wanted,
    short,
  }));
}

type Listener = () => void;

/** The latest per-view settle, for the views' notices and the recorder. */
export class ViewSettleSignal {
  private current: readonly ViewSettle[] = [];
  private readonly listeners = new Set<Listener>();

  get = (): readonly ViewSettle[] => this.current;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Publish when anything a reader shows changed. */
  publish(next: readonly ViewSettle[]): void {
    if (sameSettles(next, this.current)) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}

function sameSettles(a: readonly ViewSettle[], b: readonly ViewSettle[]): boolean {
  return a.length === b.length && a.every((s, i) =>
    s.view === b[i].view && s.settled === b[i].settled && s.wanted === b[i].wanted && s.short === b[i].short);
}

export const viewSettleSignal = new ViewSettleSignal();
