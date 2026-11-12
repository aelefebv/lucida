/**
 * Where one view's indirection over a pool lays out each (member, level)
 * section. A section keeps its offset for as long as the view lays it out,
 * so a view move that changes a few members' levels moves only their
 * sections, and the cells every other member holds stay mapped. Pure.
 */

import type { LodIndirectionMeta } from "../volume/atlas.ts";

/** A section a cold state lays out, before it has a place. */
export interface SectionRequest {
  memberId: string;
  meta: Omit<LodIndirectionMeta, "offset">;
  /** Cells it takes: a volume section its whole grid, a slice section one plane of it. */
  size: number;
}

export interface SectionLayout {
  /** Each request's section, in request order. A section kept from before is the same object. */
  placed: LodIndirectionMeta[];
  /** The same sections by member, in request order. */
  metas: Map<string, LodIndirectionMeta[]>;
  /** Cells the indirection needs: past the end of the last section. */
  total: number;
  /** The sections placed by this layout, by member: every one when {@link repacked}. */
  added: Map<string, LodIndirectionMeta[]>;
  /** The sections held before that this layout leaves out. */
  removed: LodIndirectionMeta[];
  /** Every section was placed afresh, end to end, so none kept its cells. */
  repacked: boolean;
}

/**
 * Lay out `requests`, keeping each section `held` places at the same level
 * and grid where it is. A new one takes the first gap that fits it, or goes
 * after the last. When gaps would leave more than half the indirection
 * unused, every section is placed afresh, end to end, as a first layout is.
 */
export function layoutSections(
  held: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
  requests: readonly SectionRequest[],
): SectionLayout {
  const keptSize = new Map<LodIndirectionMeta, number>();
  const keep = requests.map(({ memberId, meta, size }) => {
    const was = held.get(memberId)?.find((m) => m.level === meta.level && sameDims(m.gridDims, meta.gridDims));
    if (!was || keptSize.has(was)) return null;
    keptSize.set(was, size);
    return was;
  });
  if (keptSize.size === 0) return packed(held, requests);

  const removed: LodIndirectionMeta[] = [];
  for (const metas of held.values()) for (const meta of metas) if (!keptSize.has(meta)) removed.push(meta);

  // The free stretches between kept sections, in offset order.
  const gaps: Array<{ start: number; size: number }> = [];
  let end = 0;
  for (const [meta, size] of [...keptSize].sort(([a], [b]) => a.offset - b.offset)) {
    if (meta.offset > end) gaps.push({ start: end, size: meta.offset - end });
    end = Math.max(end, meta.offset + size);
  }

  let used = 0;
  const placed = requests.map((request, i) => {
    used += request.size;
    const kept = keep[i];
    if (kept) return kept;
    const gap = gaps.find((g) => g.size >= request.size);
    let offset = end;
    if (gap) {
      offset = gap.start;
      gap.start += request.size;
      gap.size -= request.size;
    } else {
      end += request.size;
    }
    return { ...request.meta, offset };
  });
  if (end > 2 * used) return packed(held, requests);

  const metas = new Map<string, LodIndirectionMeta[]>();
  const added = new Map<string, LodIndirectionMeta[]>();
  requests.forEach(({ memberId }, i) => {
    push(metas, memberId, placed[i]);
    if (!keep[i]) push(added, memberId, placed[i]);
  });
  return { placed, metas, total: end, added, removed, repacked: false };
}

/** Every request placed end to end in order. */
function packed(
  held: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
  requests: readonly SectionRequest[],
): SectionLayout {
  const placed: LodIndirectionMeta[] = [];
  const metas = new Map<string, LodIndirectionMeta[]>();
  let total = 0;
  for (const { memberId, meta, size } of requests) {
    const at = { ...meta, offset: total };
    placed.push(at);
    push(metas, memberId, at);
    total += size;
  }
  const removed: LodIndirectionMeta[] = [];
  for (const list of held.values()) removed.push(...list);
  return { placed, metas, total, added: metas, removed, repacked: true };
}

function push(map: Map<string, LodIndirectionMeta[]>, memberId: string, meta: LodIndirectionMeta): void {
  const list = map.get(memberId);
  if (list) list.push(meta);
  else map.set(memberId, [meta]);
}

function sameDims(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
