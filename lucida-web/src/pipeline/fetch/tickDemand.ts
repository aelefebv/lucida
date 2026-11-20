import type { ChunkRequest } from "../planning/index.ts";
import { deliveryTarget } from "../../renderer/poolKeys.ts";

const DETAIL = 1;
/** A detail chunk a lane other than prefetch asks for: what settling waits on. */
const VIEW_DETAIL = 2;
const COARSE = 4;
/** A coarse chunk the view's own coarse lane asks for, not only the minimap or overview. */
const COARSE_LANE = 8;

interface KeyDemand {
  flags: number;
  /** The requests for the chunk, held bare when there is one. */
  requests: ChunkRequest | ChunkRequest[];
}

function flagsOf(req: ChunkRequest): number {
  if (req.tier === "detail") return req.lane === "prefetch" ? DETAIL : DETAIL | VIEW_DETAIL;
  return req.lane === "coarse" ? COARSE | COARSE_LANE : COARSE;
}

/** Whether the view's own lanes ask for the chunk where `req` wants it delivered. */
function viewAsks(req: ChunkRequest): boolean {
  return req.lane === "detail" || req.lane === "coarse";
}

/**
 * What the plans ask of each chunk, by its scheduler key: which tier wants
 * it, whether the view or only prefetch and the minimap do, and the requests
 * themselves, the view's each naming where it wants the chunk delivered.
 *
 * A submit notes every request of a dataset's whole wanted set, tens of
 * thousands of them a few times a second, so a chunk costs one map entry
 * whatever its tier and lanes, and however many views ask for it. A replan
 * that carries the last one's requests notes what it added and forgets what
 * it removed.
 */
export class TickDemand {
  private readonly byKey = new Map<string, KeyDemand>();
  /** Keys more than one request asks for. */
  private readonly sharedKeys = new Set<string>();
  private detail = 0;
  private viewDetail = 0;
  private coarse = 0;

  note(key: string, req: ChunkRequest): void {
    const flags = flagsOf(req);
    const held = this.byKey.get(key);
    if (held === undefined) {
      this.byKey.set(key, { flags, requests: req });
      this.count(flags, 1);
      return;
    }
    const added = flags & ~held.flags;
    if (added !== 0) {
      held.flags |= added;
      this.count(added, 1);
    }
    if (Array.isArray(held.requests)) held.requests.push(req);
    else held.requests = [held.requests, req];
    this.sharedKeys.add(key);
  }

  /** `req` no longer asks for the chunk at `key`. */
  forget(key: string, req: ChunkRequest): void {
    const held = this.byKey.get(key);
    if (held === undefined) return;
    if (!Array.isArray(held.requests)) {
      if (held.requests !== req) return;
      this.byKey.delete(key);
      this.count(held.flags, -1);
      return;
    }
    const at = held.requests.indexOf(req);
    if (at < 0) return;
    held.requests.splice(at, 1);
    if (held.requests.length === 1) {
      held.requests = held.requests[0];
      this.sharedKeys.delete(key);
    }
    let flags = 0;
    for (const other of Array.isArray(held.requests) ? held.requests : [held.requests]) flags |= flagsOf(other);
    this.count(held.flags & ~flags, -1);
    held.flags = flags;
  }

  /** Whether a plan wants the chunk in either tier. */
  wants(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Every request for the chunk, in the order they were noted. */
  requestsOf(key: string): readonly ChunkRequest[] {
    const requests = this.byKey.get(key)?.requests;
    if (requests === undefined) return [];
    return Array.isArray(requests) ? requests : [requests];
  }

  /** The keys more than one request asks for. */
  shared(): ReadonlySet<string> {
    return this.sharedKeys;
  }

  /** Whether the view's own lanes want the detail chunk. */
  viewWantsDetail(key: string): boolean {
    return ((this.byKey.get(key)?.flags ?? 0) & VIEW_DETAIL) !== 0;
  }

  /** Whether the view's coarse lane wants the coarse chunk. */
  coarseLaneWants(key: string): boolean {
    return ((this.byKey.get(key)?.flags ?? 0) & COARSE_LANE) !== 0;
  }

  /**
   * The chunks whose failure the view shows: the detail chunks its own lanes
   * want, and every coarse chunk.
   */
  *viewShownKeys(): IterableIterator<string> {
    for (const [key, { flags }] of this.byKey) {
      if ((flags & (VIEW_DETAIL | COARSE)) !== 0) yield key;
    }
  }

  /** Whether {@link viewShownKeys} holds `key`. */
  viewShows(key: string): boolean {
    return ((this.byKey.get(key)?.flags ?? 0) & (VIEW_DETAIL | COARSE)) !== 0;
  }

  /**
   * Each place the view's detail and coarse requests want the chunk
   * delivered, by `deliveryTarget`, once, with a request that names it.
   */
  forEachViewTarget(key: string, visit: (target: string, req: ChunkRequest) => void): void {
    const requests = this.byKey.get(key)?.requests;
    if (requests === undefined) return;
    if (!Array.isArray(requests)) {
      if (viewAsks(requests)) visit(deliveryTarget(requests.mode, requests.cut), requests);
      return;
    }
    const seen = new Set<string>();
    for (const req of requests) {
      if (!viewAsks(req)) continue;
      const target = deliveryTarget(req.mode, req.cut);
      if (seen.has(target)) continue;
      seen.add(target);
      visit(target, req);
    }
  }

  get detailKeys(): number {
    return this.detail;
  }

  get viewDetailKeys(): number {
    return this.viewDetail;
  }

  get coarseKeys(): number {
    return this.coarse;
  }

  clear(): void {
    this.byKey.clear();
    this.sharedKeys.clear();
    this.detail = 0;
    this.viewDetail = 0;
    this.coarse = 0;
  }

  private count(flags: number, sign: 1 | -1): void {
    if (flags & DETAIL) this.detail += sign;
    if (flags & VIEW_DETAIL) this.viewDetail += sign;
    if (flags & COARSE) this.coarse += sign;
  }
}
