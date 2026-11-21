/**
 * Handing a plan's changes to the stages after it a budget at a time.
 *
 * A plan that carried the last one's requests says what it added and
 * removed, and admission, the CPU cache and the render worker's wanted set
 * each update over that change, at a cost per request it names. A zoom of a
 * view that holds many chunks changes thousands of them in one plan, and the
 * refinement once it stops changes more, so a plan's cost would grow with
 * what the view holds and land on one frame.
 *
 * {@link RequestPacing} holds, per dataset, what the stages hold and what the
 * plans have changed since, and gives the stages at most a budget of those
 * changes a tick; the coordinator gives them the rest on the ticks after.
 * A plan made while changes are still owed is weighed against what the
 * stages hold, not against the plan before it.
 *
 * Removals go first, so the stages give up what the plans no longer want
 * before they take more: until every removal is taken, what they hold is
 * within what they held, and after, within what the plans want now, and
 * each fits the budgets the plan it came from fits. A removal of a chunk an
 * owed addition asks for again, as when a chunk fetched ahead becomes one
 * the view draws, goes with that addition instead, so no chunk the plans
 * want is ever left unwanted between two of them.
 */

import { mergeInOrder } from "./laneMemory.ts";
import type { ChunkRequest, RequestDelta } from "./types.ts";

/** What the stages take this tick for one dataset: the requests to hold, and how they differ from what they held. */
export interface PacedRequests {
  requests: readonly ChunkRequest[];
  delta: RequestDelta;
}

/**
 * What pairs a removal with an addition: the chunk's key alone, which every
 * request already carries. Two requests for one chunk of one tier always
 * share it, so no pair is missed; requests of other entities or tiers that
 * share it only hold a removal back until that addition goes.
 */
function pairKey(req: ChunkRequest): string {
  return req.chunkKey;
}

/** The share of a budget left over that goes with the rest rather than on a tick of its own. */
const SMALL_REMAINDER = 0.25;

/** One dataset's requests between what the stages hold and what its plans want. */
class DatasetPacing {
  /** What the plans want now: the last plan's requests. */
  private target: readonly ChunkRequest[];
  /** What the stages hold. */
  private held: readonly ChunkRequest[];
  /** Owed removals no owed addition asks for again, by {@link pairKey}. */
  private readonly unpaired = new Map<string, ChunkRequest[]>();
  /** Owed removals of chunks an owed addition asks for again, by {@link pairKey}. */
  private readonly paired = new Map<string, ChunkRequest[]>();
  /** How many owed removals there are. */
  private removing = 0;
  /** Owed additions in planner order; an entry no longer in {@link pending} was withdrawn. */
  private adding: ChunkRequest[] = [];
  private readonly pending = new Set<ChunkRequest>();
  /**
   * How many owed additions there are of each {@link pairKey}, kept only
   * while removals are owed: a dataset's first plan, all additions, pairs
   * nothing.
   */
  private addingChunks: Map<string, number> | null = null;

  constructor(held: readonly ChunkRequest[]) {
    this.target = held;
    this.held = held;
  }

  get owed(): number {
    return this.removing + this.pending.size;
  }

  /** Whether a plan whose delta is on `base` follows the plan this pacing heads for. */
  follows(base: readonly ChunkRequest[]): boolean {
    return base === this.target;
  }

  /** The stages took a plan whole, with nothing owed: they hold what it wants. */
  adopt(requests: readonly ChunkRequest[]): void {
    this.target = requests;
    this.held = requests;
  }

  /** Owe a plan's changes, which `delta` gives on the last plan's requests. */
  plan(requests: readonly ChunkRequest[], delta: RequestDelta): void {
    for (const req of delta.removed) {
      if (this.pending.delete(req)) {
        this.withdrawAddition(pairKey(req));
      } else {
        this.owe(req);
      }
    }
    if (delta.added.length > 0) {
      const index = this.addingChunks;
      for (const req of delta.added) {
        this.pending.add(req);
        if (index === null) continue;
        const chunk = pairKey(req);
        index.set(chunk, (index.get(chunk) ?? 0) + 1);
        const unpaired = this.unpaired.get(chunk);
        if (unpaired !== undefined) {
          this.unpaired.delete(chunk);
          this.paired.set(chunk, unpaired);
        }
      }
      this.adding = mergeInOrder(this.adding, delta.added);
    }
    this.target = requests;
  }

  /**
   * Take at most `budget` owed changes, or every one when they fit it or
   * what would be left is too little to be worth a tick of its own.
   */
  take(budget: number): PacedRequests {
    const base = this.held;
    const removed: ChunkRequest[] = [];
    const added: ChunkRequest[] = [];
    if (this.owed <= budget * (1 + SMALL_REMAINDER)) {
      for (const list of this.unpaired.values()) removed.push(...list);
      for (const list of this.paired.values()) removed.push(...list);
      for (const req of this.adding) if (this.pending.has(req)) added.push(req);
      this.clearOwed();
      this.held = this.target;
      return { requests: this.held, delta: { base, added, removed } };
    }
    for (const [chunk, list] of this.unpaired) {
      if (removed.length >= budget) break;
      removed.push(...list);
      this.unpaired.delete(chunk);
    }
    let next = 0;
    if (this.unpaired.size === 0) {
      while (next < this.adding.length && removed.length + added.length < budget) {
        const req = this.adding[next++];
        if (!this.pending.delete(req)) continue;
        added.push(req);
        // The removals it pairs with go once every addition sharing its key has.
        if (this.addingChunks === null) continue;
        const chunk = pairKey(req);
        if (!this.countDown(chunk)) continue;
        const pairs = this.paired.get(chunk);
        if (pairs !== undefined) {
          removed.push(...pairs);
          this.paired.delete(chunk);
        }
      }
    }
    this.adding = this.adding.slice(next);
    this.removing -= removed.length;
    if (this.removing === 0) this.addingChunks = null;
    if (this.owed === 0) {
      // A chunk's removals go together, so the last of them can overrun the budget.
      this.held = this.target;
    } else {
      const gone = new Set(removed);
      const kept = removed.length === 0 ? base : base.filter((req) => !gone.has(req));
      this.held = added.length === 0 ? kept : mergeInOrder(kept, added);
    }
    return { requests: this.held, delta: { base, added, removed } };
  }

  /** Owe the removal of `req`, which the stages hold. */
  private owe(req: ChunkRequest): void {
    const chunk = pairKey(req);
    const into = this.indexAdditions().has(chunk) ? this.paired : this.unpaired;
    const list = into.get(chunk);
    if (list === undefined) into.set(chunk, [req]);
    else list.push(req);
    this.removing++;
  }

  /** {@link addingChunks}, counted from the owed additions when it is not kept yet. */
  private indexAdditions(): Map<string, number> {
    if (this.addingChunks !== null) return this.addingChunks;
    const index = new Map<string, number>();
    for (const req of this.adding) {
      if (!this.pending.has(req)) continue;
      const chunk = pairKey(req);
      index.set(chunk, (index.get(chunk) ?? 0) + 1);
    }
    return (this.addingChunks = index);
  }

  /** An owed addition of `chunk` was withdrawn before the stages took it. */
  private withdrawAddition(chunk: string): void {
    if (this.addingChunks === null || !this.countDown(chunk)) return;
    const pairs = this.paired.get(chunk);
    if (pairs !== undefined) {
      this.paired.delete(chunk);
      this.unpaired.set(chunk, pairs);
    }
  }

  /** One owed addition of `chunk` fewer in {@link addingChunks}; whether none is left. */
  private countDown(chunk: string): boolean {
    const index = this.addingChunks!;
    const n = (index.get(chunk) ?? 0) - 1;
    if (n > 0) {
      index.set(chunk, n);
      return false;
    }
    index.delete(chunk);
    return true;
  }

  private clearOwed(): void {
    this.unpaired.clear();
    this.paired.clear();
    this.removing = 0;
    this.adding = [];
    this.pending.clear();
    this.addingChunks = null;
  }
}

/**
 * Per dataset, what the stages after the plan hold and what its plans have
 * changed since that they have yet to take.
 */
export class RequestPacing {
  private readonly datasets = new Map<string, DatasetPacing>();

  /**
   * What the stages take for `dsId`'s new plan, which carried the last one's
   * requests and changed them by `delta`: every change when the owed ones
   * fit `budget`, and otherwise the first `budget` of them, the rest owed.
   * A plan that does not follow the one pacing heads for, as after a plan
   * the stages took whole, starts over from the requests the plan carried.
   */
  offer(dsId: string, requests: readonly ChunkRequest[], delta: RequestDelta, budget: number): PacedRequests {
    let pacing = this.datasets.get(dsId);
    if (pacing === undefined || !pacing.follows(delta.base)) {
      pacing = new DatasetPacing(delta.base);
      this.datasets.set(dsId, pacing);
    }
    // Most plans change less than a tick takes, with nothing owed: the
    // stages take the plan as it is.
    if (pacing.owed === 0 && delta.added.length + delta.removed.length <= budget * (1 + SMALL_REMAINDER)) {
      pacing.adopt(requests);
      return { requests, delta };
    }
    pacing.plan(requests, delta);
    return pacing.take(budget);
  }

  /**
   * What the stages take for `dsId` on a tick that plans nothing new: the
   * next `budget` owed changes, or an empty change on what they hold.
   */
  take(dsId: string, budget: number): PacedRequests | null {
    return this.datasets.get(dsId)?.take(budget) ?? null;
  }

  /** Whether any dataset has changes the stages have yet to take. */
  owes(): boolean {
    for (const pacing of this.datasets.values()) if (pacing.owed > 0) return true;
    return false;
  }

  /** Nothing is owed for a dataset outside `dsIds`, which no longer plan. */
  retain(dsIds: ReadonlySet<string>): void {
    for (const dsId of [...this.datasets.keys()]) if (!dsIds.has(dsId)) this.datasets.delete(dsId);
  }

  /** Nothing is owed for any dataset. */
  clear(): void {
    this.datasets.clear();
  }
}
