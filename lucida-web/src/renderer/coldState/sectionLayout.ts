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

/** What a layout leaves of the indirection, for the next one to place sections in. */
export interface SectionSpace {
  /** Free stretches below {@link end}, in offset order, none touching the next. */
  free: Array<{ start: number; size: number }>;
  /** Past the last cell any section has taken. */
  end: number;
  /** Cells the sections take. */
  used: number;
}

export interface SectionLayout {
  /** Each request's section, in request order. A section kept from before is the same object. */
  placed: LodIndirectionMeta[];
  /** The same sections by member, in request order. */
  metas: Map<string, LodIndirectionMeta[]>;
  /** The sections placed by this layout, by member: every one when {@link repacked}. */
  added: Map<string, LodIndirectionMeta[]>;
  /** The sections held before that this layout leaves out. */
  removed: LodIndirectionMeta[];
  /** Every section was placed afresh, end to end, so none kept its cells. */
  repacked: boolean;
  space: SectionSpace;
}

/** The cells a section takes: one plane of its grid in a slice pool (`dimArity` 2), all of it in a volume pool. */
export function sectionCells(meta: Pick<LodIndirectionMeta, "gridDims">, dimArity: 2 | 3): number {
  const [gridZ, gridY, gridX] = meta.gridDims;
  return gridX * gridY * (dimArity === 3 ? gridZ : 1);
}

/**
 * Lay out `requests`, keeping each section `held` places at the same level
 * and grid where it is. A new one takes the first gap that fits it, or goes
 * after the last. When gaps would leave the indirection mostly unused (see
 * {@link wantsRepack}), every section is placed afresh, end to end, as a
 * first layout is.
 */
export function layoutSections(
  held: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
  requests: readonly SectionRequest[],
): SectionLayout {
  const keptSize = new Map<LodIndirectionMeta, number>();
  const keep = requests.map(({ memberId, meta, size }) => {
    const was = held.get(memberId)?.find((m) => sameSection(m, meta));
    if (!was || keptSize.has(was)) return null;
    keptSize.set(was, size);
    return was;
  });
  if (keptSize.size === 0) return packed(held, requests);

  const removed: LodIndirectionMeta[] = [];
  for (const metas of held.values()) for (const meta of metas) if (!keptSize.has(meta)) removed.push(meta);

  const space: SectionSpace = { free: [], end: 0, used: 0 };
  for (const [meta, size] of [...keptSize].sort(([a], [b]) => a.offset - b.offset)) {
    if (meta.offset > space.end) space.free.push({ start: space.end, size: meta.offset - space.end });
    space.end = Math.max(space.end, meta.offset + size);
    space.used += size;
  }
  const placed = requests.map((request, i) => keep[i] ?? { ...request.meta, offset: take(space, request.size) });
  if (wantsRepack(space)) return packed(held, requests);

  const metas = new Map<string, LodIndirectionMeta[]>();
  const added = new Map<string, LodIndirectionMeta[]>();
  requests.forEach(({ memberId }, i) => {
    push(metas, memberId, placed[i]);
    if (!keep[i]) push(added, memberId, placed[i]);
  });
  return { placed, metas, added, removed, repacked: false, space };
}

/**
 * Lay out one member's sections again, in `space`, leaving every other
 * section where it is: keep the held sections it still asks for, free the
 * rest, and place the new ones as {@link layoutSections} does. Updates
 * `space`; see {@link wantsRepack} once every member has moved.
 */
export function relayMember(
  held: readonly LodIndirectionMeta[],
  requests: readonly Omit<SectionRequest, "memberId">[],
  space: SectionSpace,
  dimArity: 2 | 3,
): { metas: LodIndirectionMeta[]; added: LodIndirectionMeta[]; removed: LodIndirectionMeta[] } {
  const kept = new Set<LodIndirectionMeta>();
  const keep = requests.map(({ meta }) => {
    const was = held.find((m) => sameSection(m, meta));
    if (!was || kept.has(was)) return null;
    kept.add(was);
    return was;
  });
  const removed = held.filter((meta) => !kept.has(meta));
  for (const meta of removed) release(space, meta.offset, sectionCells(meta, dimArity));
  const added: LodIndirectionMeta[] = [];
  const metas = requests.map((request, i) => {
    const was = keep[i];
    if (was) return was;
    const meta = { ...request.meta, offset: take(space, request.size) };
    added.push(meta);
    return meta;
  });
  return { metas, added, removed };
}

/**
 * Cells a layout may leave unused before it packs again, at 4 bytes each.
 * A collection's tiles take a few cells each, so a zoom that leaves most of
 * them with their coarsest level alone frees far more than it keeps, and
 * packing again on that would move every section on a zoom in and out.
 */
const UNUSED_CELLS_ALLOWED = 1 << 16;

/**
 * Whether gaps leave more of `space` unused than in use, and more than
 * {@link UNUSED_CELLS_ALLOWED}, so the sections want laying out afresh.
 */
export function wantsRepack(space: SectionSpace): boolean {
  const unused = space.end - space.used;
  return unused > space.used && unused > UNUSED_CELLS_ALLOWED;
}

/** Every request placed end to end in order. */
function packed(
  held: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
  requests: readonly SectionRequest[],
): SectionLayout {
  const placed: LodIndirectionMeta[] = [];
  const metas = new Map<string, LodIndirectionMeta[]>();
  let end = 0;
  for (const { memberId, meta, size } of requests) {
    const at = { ...meta, offset: end };
    placed.push(at);
    push(metas, memberId, at);
    end += size;
  }
  const removed: LodIndirectionMeta[] = [];
  for (const list of held.values()) removed.push(...list);
  return { placed, metas, added: metas, removed, repacked: true, space: { free: [], end, used: end } };
}

/** Take `size` cells: from the first gap that holds them, or after the last section. */
function take(space: SectionSpace, size: number): number {
  space.used += size;
  const at = space.free.findIndex((gap) => gap.size >= size);
  if (at < 0) {
    space.end += size;
    return space.end - size;
  }
  const gap = space.free[at];
  const start = gap.start;
  gap.start += size;
  gap.size -= size;
  if (gap.size === 0) space.free.splice(at, 1);
  return start;
}

/** Give back the cells `[start, start + size)`, joining the gaps beside them. */
function release(space: SectionSpace, start: number, size: number): void {
  space.used -= size;
  let at = space.free.findIndex((gap) => gap.start > start);
  if (at < 0) at = space.free.length;
  space.free.splice(at, 0, { start, size });
  const next = space.free[at + 1];
  if (next && start + size === next.start) {
    space.free[at].size += next.size;
    space.free.splice(at + 1, 1);
  }
  const prev = space.free[at - 1];
  if (prev && prev.start + prev.size === start) {
    prev.size += space.free[at].size;
    space.free.splice(at, 1);
  }
}

function push(map: Map<string, LodIndirectionMeta[]>, memberId: string, meta: LodIndirectionMeta): void {
  const list = map.get(memberId);
  if (list) list.push(meta);
  else map.set(memberId, [meta]);
}

function sameSection(a: Omit<LodIndirectionMeta, "offset">, b: Omit<LodIndirectionMeta, "offset">): boolean {
  return a.level === b.level &&
    a.gridDims[0] === b.gridDims[0] && a.gridDims[1] === b.gridDims[1] && a.gridDims[2] === b.gridDims[2];
}
