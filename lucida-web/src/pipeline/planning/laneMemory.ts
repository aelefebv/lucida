/**
 * Carrying a view's requests from one plan to the next.
 *
 * A gesture replans every 200 ms, and the level selection's hysteresis keeps
 * most of what a view draws where it was: an orbit changes a few dozen of
 * thousands of chunks between two plans. A plan that emitted every request
 * again would hand every stage after it the whole set to redo. Instead each
 * request whose chunk is still selected, and whose lane inputs held, is the
 * previous plan's object, at the previous plan's priority, and the plan says
 * which requests it added and removed ({@link RequestDelta}), so each stage
 * after it can update over the change alone.
 *
 * A kept request keeps the place in its band the previous plan gave it. The
 * band, which puts each lane wholly ahead of the next, never moves, and the
 * in-lane order of the chunks a view already holds is what drifts, which
 * decides nothing once they are resident.
 *
 * Only a view that plans its dataset alone carries its requests: with
 * several, their requests for one chunk fold into one, and the plan emits
 * them all again.
 */

import type { EntitySnapshot, LaneMemory, LaneScope, EntityDetailRequests, ChunkRequest, RequestDelta, DatasetView } from "./types.ts";
import type { SceneEpochs } from "../epochs.ts";
import { compareChunkRequests } from "./emit.ts";

/** A cell of one entity as one number: level, then Z, Y and X, each under 2^16 chunks. */
export function cellKey(level: number, x: number, y: number, z: number): number {
  return ((level * 65536 + z) * 65536 + y) * 65536 + x;
}

/** What every request of `view`'s lanes depends on beyond its own chunk. */
export function laneScope(view: DatasetView, epochs: SceneEpochs, config: object): LaneScope {
  const { selection } = view;
  return {
    datasetId: view.datasetId,
    content: epochs.content,
    layout: epochs.layout,
    t: selection.t,
    visibleChannels: selection.visibleChannels,
    renderMode: selection.renderMode,
    cut: selection.cut,
    config,
  };
}

function sameScope(a: LaneScope, b: LaneScope): boolean {
  return (
    a.datasetId === b.datasetId &&
    a.content === b.content &&
    a.layout === b.layout &&
    a.t === b.t &&
    a.renderMode === b.renderMode &&
    a.cut.axis === b.cut.axis &&
    a.cut.index === b.cut.index &&
    a.config === b.config &&
    a.visibleChannels.length === b.visibleChannels.length &&
    a.visibleChannels.every((c, i) => c === b.visibleChannels[i])
  );
}

/** One plan of a view: what it carries from the previous plan's lanes, and what it records for the next. */
export class LaneCarry {
  private readonly previous: LaneMemory | null;
  private readonly scope: LaneScope;
  private readonly detail = new Map<string, EntityDetailRequests>();
  private readonly others: OtherRequests = new Map();
  /** The previous plan's requests of the other lanes this plan kept. */
  private readonly kept = new Set<ChunkRequest>();

  /** Carries from `previous` when its scope is `scope`, and otherwise emits everything anew. */
  constructor(previous: LaneMemory | null, scope: LaneScope) {
    this.previous = previous !== null && sameScope(previous.scope, scope) ? previous : null;
    this.scope = scope;
  }

  /** The previous plan's detail requests of `entity` by cell, when its levels are the ones they came from. */
  detailOf(entity: EntitySnapshot): ReadonlyMap<number, readonly ChunkRequest[]> | undefined {
    const held = this.previous?.detail.get(entity.entityId);
    return held !== undefined && held.levels === entity.levels ? held.cells : undefined;
  }

  /** `entity`'s detail requests in this plan, by cell. */
  setDetail(entity: EntitySnapshot, cells: ReadonlyMap<number, readonly ChunkRequest[]>): void {
    this.detail.set(entity.entityId, { levels: entity.levels, cells });
  }

  /**
   * The previous plan's request alike `req`, in its lane and `band`, which
   * this plan keeps in its place; or undefined, and `req` is new.
   */
  takeOther(req: ChunkRequest, band: number): ChunkRequest | undefined {
    const alike = this.previous?.others.get(req.entityId)?.get(req.chunkKey);
    const kept = alike?.find((other) => other.band === band && !this.kept.has(other.req) && sameAsk(other.req, req))?.req;
    if (kept !== undefined) this.kept.add(kept);
    let byChunk = this.others.get(req.entityId);
    if (byChunk === undefined) this.others.set(req.entityId, (byChunk = new Map()));
    const entry = { req: kept ?? req, band };
    const list = byChunk.get(req.chunkKey);
    if (list === undefined) byChunk.set(req.chunkKey, [entry]);
    else list.push(entry);
    return kept;
  }

  /**
   * The plan's requests in planner order, given those it emitted anew, in
   * planner order; how they differ from the previous plan's when it carried
   * them; and what the next plan carries from.
   */
  finish(added: ChunkRequest[]): { requests: readonly ChunkRequest[]; delta?: RequestDelta; memory: LaneMemory } {
    const previous = this.previous;
    if (previous === null) {
      return { requests: added, memory: this.memory(added) };
    }
    const removed: ChunkRequest[] = [];
    for (const [entityId, held] of previous.detail) {
      const now = this.detail.get(entityId)?.cells;
      if (now === held.cells) continue;
      for (const [cell, requests] of held.cells) {
        if (now?.get(cell) !== requests) removed.push(...requests);
      }
    }
    for (const byChunk of previous.others.values()) {
      for (const list of byChunk.values()) {
        for (const { req } of list) if (!this.kept.has(req)) removed.push(req);
      }
    }
    if (added.length === 0 && removed.length === 0) {
      return { requests: previous.requests, delta: { base: previous.requests, added, removed }, memory: this.memory(previous.requests) };
    }
    const gone = new Set(removed);
    const kept = removed.length === 0 ? previous.requests : previous.requests.filter((req) => !gone.has(req));
    const requests = mergeInOrder(kept, added);
    return { requests, delta: { base: previous.requests, added, removed }, memory: this.memory(requests) };
  }

  private memory(requests: readonly ChunkRequest[]): LaneMemory {
    return { scope: this.scope, detail: this.detail, others: this.others, requests };
  }
}

/** The other lanes' requests of a plan, by entity, then chunk key, each with the band it asks in. */
type OtherRequests = Map<string, Map<string, { req: ChunkRequest; band: number }[]>>;

/**
 * Whether two requests of one entity's chunk, in one band, ask alike: the
 * fields `requestIdentity` reads beyond the chunk, and the lane. Compared
 * rather than joined into a key, since a plan names every request of its
 * coarse, prefetch and minimap lanes this way.
 */
function sameAsk(a: ChunkRequest, b: ChunkRequest): boolean {
  return (
    a.lane === b.lane &&
    a.tier === b.tier &&
    a.mode === b.mode &&
    a.imageId === b.imageId &&
    a.plane === b.plane &&
    a.planeAxis === b.planeAxis &&
    a.planes?.[0] === b.planes?.[0] &&
    a.planes?.[1] === b.planes?.[1] &&
    a.cut?.axis === b.cut?.axis &&
    a.cut?.plane === b.cut?.plane
  );
}

/** Two lists each in planner order, as one. */
function mergeInOrder(a: readonly ChunkRequest[], b: readonly ChunkRequest[]): ChunkRequest[] {
  const out = new Array<ChunkRequest>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compareChunkRequests(b[j], a[i]) < 0 ? b[j++] : a[i++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}
