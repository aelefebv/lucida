/**
 * The planner's wanted chunks for the cold state, and what changed since the
 * last cold state, so a view move ships only the chunks that moved.
 */

import type { WantedChunkChanges, WantedMemberChunks } from "../../../renderer/workerProtocol.ts";
import { wantedEntryKey } from "../../../renderer/wantedChunks.ts";
import type { ChunkRequest } from "../../planning/index.ts";
import type { RequestDelta } from "../../planning/types.ts";
import type { ResidencyTier } from "../../residencyTier.ts";
import { workerMemberId } from "../delivery/dispatch.ts";

/** `${tier}|${memberId}` → that member's wanted chunks in that tier. */
export type WantedChunksByMember = Map<string, WantedMemberChunks>;

/** Whether the worker wants a request's chunk: the uploader delivers the detail and coarse lanes, never prefetch or minimap. */
function delivered(req: ChunkRequest): boolean {
  return req.lane === "detail" || req.lane === "coarse";
}

/**
 * The worker's entries a request's chunk is listed in: its member's in its
 * tier, and for an ancestor that member's ancestors too.
 */
function entriesOf(req: ChunkRequest): { key: string; memberId: string; ancestors: boolean }[] {
  const memberId = workerMemberId(req.imageId, req.c);
  const entries = [{ key: wantedEntryKey(req.tier, memberId), memberId, ancestors: false }];
  if (req.ancestor) entries.push({ key: wantedEntryKey(req.tier, memberId, true), memberId, ancestors: true });
  return entries;
}

/**
 * The chunks the uploader can deliver from a plan: its detail and coarse
 * lanes, under the member ids the delivery uses. Prefetch and minimap chunks
 * never reach the worker, so it never wants them.
 */
export function wantedChunksFromPlan(
  requests: readonly ChunkRequest[],
): WantedChunksByMember {
  const byMember: WantedChunksByMember = new Map();
  for (const req of requests) {
    if (!delivered(req)) continue;
    for (const { key, memberId, ancestors } of entriesOf(req)) {
      const entry = byMember.get(key);
      if (entry) entry.chunkKeys.push(req.chunkKey);
      else byMember.set(key, { memberId, tier: req.tier, chunkKeys: [req.chunkKey], ...(ancestors && { ancestors }) });
    }
  }
  return byMember;
}

interface MemberCounts {
  memberId: string;
  tier: ResidencyTier;
  ancestors: boolean;
  /** How many of the plan's requests name each chunk. */
  keys: Map<string, number>;
}

/**
 * The wanted chunks one view's worker holds, as the last cold state or delta
 * left them: per (member, tier), each chunk and how many of the plan's
 * requests name it. A plan that carried the last one's requests changes
 * them by its delta, so the delta to the worker costs what the plan changed.
 */
export class WantedChunkCounts {
  private readonly byMember = new Map<string, MemberCounts>();
  /** The requests counted, which a request delta names as its base. */
  private requests: readonly ChunkRequest[];

  constructor(requests: readonly ChunkRequest[], wanted: WantedChunksByMember = wantedChunksFromPlan(requests)) {
    this.requests = requests;
    for (const [key, { memberId, tier, chunkKeys, ancestors }] of wanted) {
      const keys = new Map<string, number>();
      for (const chunkKey of chunkKeys) keys.set(chunkKey, (keys.get(chunkKey) ?? 0) + 1);
      this.byMember.set(key, { memberId, tier, ancestors: ancestors ?? false, keys });
    }
  }

  /**
   * Count `requests`, which `delta` takes from the requests counted now, and
   * return what changed for the worker; null, changing nothing, when the
   * delta is on other requests.
   */
  apply(requests: readonly ChunkRequest[], delta: RequestDelta): WantedChunkChanges[] | null {
    if (delta.base !== this.requests) return null;
    this.requests = requests;
    const changes = new Map<string, WantedChunkChanges>();
    const change = (req: ChunkRequest, sign: 1 | -1): void => {
      if (!delivered(req)) return;
      for (const { key, memberId, ancestors } of entriesOf(req)) {
        let member = this.byMember.get(key);
        if (member === undefined) {
          this.byMember.set(key, (member = { memberId, tier: req.tier, ancestors, keys: new Map() }));
        }
        const count = (member.keys.get(req.chunkKey) ?? 0) + sign;
        if (count > 0) member.keys.set(req.chunkKey, count);
        else member.keys.delete(req.chunkKey);
        // A chunk changes for the worker when the first request names it or the last stops.
        if ((sign === 1 && count === 1) || (sign === -1 && count === 0)) {
          let changed = changes.get(key);
          if (changed === undefined) {
            changes.set(key, (changed = { memberId, tier: req.tier, added: [], removed: [], ...(ancestors && { ancestors }) }));
          }
          (sign === 1 ? changed.added : changed.removed).push(req.chunkKey);
        }
      }
    };
    for (const req of delta.removed) change(req, -1);
    for (const req of delta.added) change(req, 1);
    const out: WantedChunkChanges[] = [];
    for (const [key, changed] of changes) {
      // A chunk removed and added back by one delta is no change.
      const added = new Set(changed.added);
      const removed = changed.removed.filter((chunkKey) => !added.delete(chunkKey));
      if (added.size === 0 && removed.length === 0) continue;
      out.push({ ...changed, added: [...added], removed });
      if (this.byMember.get(key)!.keys.size === 0) this.byMember.delete(key);
    }
    return out;
  }

  /** What changes from these chunks to `next`'s, for the worker. */
  changesTo(next: WantedChunkCounts): WantedChunkChanges[] {
    const out: WantedChunkChanges[] = [];
    const change = (member: MemberCounts, added: string[], removed: string[]): WantedChunkChanges => ({
      memberId: member.memberId,
      tier: member.tier,
      added,
      removed,
      ...(member.ancestors && { ancestors: true as const }),
    });
    for (const [key, member] of next.byMember) {
      const held = this.byMember.get(key)?.keys;
      const added = [...member.keys.keys()].filter((chunkKey) => !held?.has(chunkKey));
      const removed = held === undefined ? [] : [...held.keys()].filter((chunkKey) => !member.keys.has(chunkKey));
      if (added.length > 0 || removed.length > 0) out.push(change(member, added, removed));
    }
    for (const [key, member] of this.byMember) {
      if (!next.byMember.has(key)) out.push(change(member, [], [...member.keys.keys()]));
    }
    return out;
  }
}
