import type { ChunkRequest } from "../planning/index.ts";

const DETAIL = 1;
/** A detail chunk a lane other than prefetch asks for: what settling waits on. */
const VIEW_DETAIL = 2;
const COARSE = 4;
/** A coarse chunk the view's own coarse lane asks for, not only the minimap or overview. */
const COARSE_LANE = 8;

interface KeyDemand {
  flags: number;
  /** The view's detail and coarse requests for the chunk, held bare when there is one. */
  view: ChunkRequest | ChunkRequest[] | undefined;
}

/**
 * What the plans since the last rebuild ask of each chunk, by its scheduler
 * key: which tier wants it, whether the view or only prefetch and the minimap
 * do, and the view's own requests, each naming where it wants the chunk
 * delivered.
 *
 * A submit notes every request of a dataset's whole wanted set, tens of
 * thousands of them a few times a second, so a chunk costs one map entry
 * whatever its tier and lanes, and however many views ask for it.
 */
export class TickDemand {
  private readonly byKey = new Map<string, KeyDemand>();
  private detail = 0;
  private viewDetail = 0;
  private coarse = 0;

  note(key: string, req: ChunkRequest): void {
    let flags: number;
    if (req.tier === "detail") flags = req.lane === "prefetch" ? DETAIL : DETAIL | VIEW_DETAIL;
    else flags = req.lane === "coarse" ? COARSE | COARSE_LANE : COARSE;
    const viewAsks = req.lane === "detail" || req.lane === "coarse";
    const held = this.byKey.get(key);
    if (held === undefined) {
      this.byKey.set(key, { flags, view: viewAsks ? req : undefined });
      this.count(flags);
      return;
    }
    const added = flags & ~held.flags;
    if (added !== 0) {
      held.flags |= added;
      this.count(added);
    }
    if (!viewAsks) return;
    if (held.view === undefined) held.view = req;
    else if (Array.isArray(held.view)) held.view.push(req);
    else held.view = [held.view, req];
  }

  /** Whether a plan wants the chunk in either tier. */
  wants(key: string): boolean {
    return this.byKey.has(key);
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

  /** Each of the view's detail and coarse requests for the chunk. */
  forEachViewRequest(key: string, visit: (req: ChunkRequest) => void): void {
    const view = this.byKey.get(key)?.view;
    if (view === undefined) return;
    if (Array.isArray(view)) view.forEach(visit);
    else visit(view);
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
    this.detail = 0;
    this.viewDetail = 0;
    this.coarse = 0;
  }

  private count(added: number): void {
    if (added & DETAIL) this.detail++;
    if (added & VIEW_DETAIL) this.viewDetail++;
    if (added & COARSE) this.coarse++;
  }
}
