/**
 * One view's indirection over one shared chunk pool. A pool's slots are the
 * dataset's, held once; every view that draws the dataset from the pool lays
 * its members out in sections of its own and maps the slots its cut, timepoint
 * and levels sample, so two views read one set of slots each their own way.
 */

import type { LodIndirectionMeta } from "./volume/atlas.ts";
import type { SectionSpace } from "./coldState/sectionLayout.ts";
import type { ViewDraw } from "./worker/state.ts";
import { INDIRECTION_MISS } from "./remap.ts";
import { remapSlotEntries, type CompactionPlan } from "./poolCompaction.ts";

export interface ViewIndirection {
  /** The view's draw of the pool's dataset: its cut, timepoint, wanted chunks and target levels. */
  draw: ViewDraw;
  /** Per-entity level sections, at absolute offsets into {@link indirectionData}. */
  entityMetas: Map<string, LodIndirectionMeta[]>;
  /** The cells {@link entityMetas} leaves free, where the next sections go. */
  space: SectionSpace;
  indirectionData: Uint32Array<ArrayBuffer>;
  indirectionBuf: GPUBuffer;
  /** slot index → the cell it fills here, or -1 where this view samples it nowhere. */
  slotGridIdx: Int32Array<ArrayBuffer>;
  /** The CPU mirror changed since it was last written to {@link indirectionBuf}. */
  dirty: boolean;
}

/** What every chunk pool has, slice or volume: its slots, and the views that sample them. */
export interface SharedChunkPool {
  datasetId: string;
  slots: Map<string, number>;
  freeSlots: number[];
  totalSlots: number;
  /** view id → that view's indirection over the pool. */
  views: Map<number, ViewIndirection>;
}

/** A view's empty indirection over a pool of `totalSlots` slots. */
export function createViewIndirection(device: GPUDevice, draw: ViewDraw, totalSlots: number): ViewIndirection {
  const indirectionData = new Uint32Array(1).fill(INDIRECTION_MISS);
  const indirectionBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  return {
    draw,
    entityMetas: new Map(),
    space: { free: [], end: 0, used: 0 },
    indirectionData,
    indirectionBuf,
    slotGridIdx: new Int32Array(totalSlots).fill(-1),
    dirty: true,
  };
}

/** Resize a view's indirection to `totalEntries` cells, emptied for the remap that follows. */
export function resizeViewIndirection(device: GPUDevice, view: ViewIndirection, totalEntries: number): void {
  if (totalEntries === view.indirectionData.length) return;
  view.indirectionData = new Uint32Array(totalEntries);
  view.indirectionBuf.destroy();
  view.indirectionBuf = device.createBuffer({
    size: Math.max(totalEntries * 4, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

/**
 * Give a view's indirection room for `totalEntries` cells, keeping what its
 * cells hold. Every draw's bind group names the buffer, so it never shrinks
 * and grows by half again at least: a zoom that adds sections a few at a
 * time replaces it a few times, not on every replan.
 */
export function growViewIndirection(device: GPUDevice, view: ViewIndirection, totalEntries: number): void {
  const held = view.indirectionData.length;
  if (totalEntries <= held) return;
  const length = Math.max(totalEntries, Math.ceil(held * 1.5));
  const data = new Uint32Array(length).fill(INDIRECTION_MISS);
  data.set(view.indirectionData);
  view.indirectionData = data;
  view.indirectionBuf.destroy();
  view.indirectionBuf = device.createBuffer({
    size: length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  view.dirty = true;
}

/**
 * Empty the cells of sections a view no longer lays out and forget the slots
 * they mapped, so a section placed there later starts empty and an eviction
 * of one of those slots leaves it alone. A slice section is one plane of its
 * grid (`dimArity` 2), a volume section the whole grid.
 */
export function clearSections(view: ViewIndirection, sections: readonly LodIndirectionMeta[], dimArity: 2 | 3): void {
  const data = view.indirectionData;
  for (const section of sections) {
    const [gridZ, gridY, gridX] = section.gridDims;
    const end = Math.min(data.length, section.offset + gridX * gridY * (dimArity === 3 ? gridZ : 1));
    for (let cell = section.offset; cell < end; cell++) {
      const slot = data[cell];
      if (slot < view.slotGridIdx.length && view.slotGridIdx[slot] === cell) view.slotGridIdx[slot] = -1;
      data[cell] = INDIRECTION_MISS;
    }
    view.dirty = true;
  }
}

/** Write a view's indirection to the GPU when it changed. */
export function flushViewIndirection(device: GPUDevice, view: ViewIndirection): void {
  if (!view.dirty) return;
  device.queue.writeBuffer(view.indirectionBuf, 0, view.indirectionData);
  view.dirty = false;
}

/** Point a view's cell at `slot`. */
export function mapSlot(view: ViewIndirection, cell: number, slot: number): void {
  if (cell < 0 || cell >= view.indirectionData.length) return;
  view.indirectionData[cell] = slot;
  view.slotGridIdx[slot] = cell;
  view.dirty = true;
}

/** Unmap `slot` from every view's indirection: it is about to hold something else, or nothing. */
export function unmapSlot(pool: SharedChunkPool, slot: number): void {
  for (const view of pool.views.values()) {
    const cell = view.slotGridIdx[slot];
    if (cell >= 0) {
      view.indirectionData[cell] = INDIRECTION_MISS;
      view.dirty = true;
    }
    view.slotGridIdx[slot] = -1;
  }
}

/** Give every view's slot map room for a pool grown to `totalSlots`. */
export function growViewSlots(pool: SharedChunkPool, totalSlots: number): void {
  for (const view of pool.views.values()) {
    const slotGridIdx = new Int32Array(totalSlots).fill(-1);
    slotGridIdx.set(view.slotGridIdx.subarray(0, Math.min(totalSlots, view.slotGridIdx.length)));
    view.slotGridIdx = slotGridIdx;
  }
}

/**
 * Move every view's cells to the slots a compaction gave the chunks it kept.
 * `slots` is the pool's map before the shrink.
 */
export function compactViewSlots(
  pool: SharedChunkPool,
  slots: ReadonlyMap<string, number>,
  plan: CompactionPlan,
  capacity: number,
): void {
  for (const view of pool.views.values()) {
    view.slotGridIdx = remapSlotEntries(slots, view.slotGridIdx, view.indirectionData, plan, capacity);
    view.dirty = true;
  }
}

/** Empty every view's indirection, for a pool that lost its slots, sized to `totalSlots`. */
export function emptyViewIndirections(pool: SharedChunkPool, totalSlots: number): void {
  for (const view of pool.views.values()) {
    view.indirectionData.fill(INDIRECTION_MISS);
    view.slotGridIdx = new Int32Array(totalSlots).fill(-1);
    view.dirty = true;
  }
}

/** The bytes every view's indirection over `pool` holds, which count against the GPU total with it. */
export function viewIndirectionBytes(pool: SharedChunkPool): number {
  let bytes = 0;
  for (const view of pool.views.values()) bytes += view.indirectionData.length * 4;
  return bytes;
}

/** Free one view's indirection over a pool. */
export function destroyViewIndirection(view: ViewIndirection): void {
  view.indirectionBuf.destroy();
}

/** The section a view lays out for one member's level, if it has one. */
export function sectionOf(view: ViewIndirection, memberId: string, level: number): LodIndirectionMeta | undefined {
  return view.entityMetas.get(memberId)?.find((meta) => meta.level === level);
}

/** Whether any view of `pool` has a section for one member's level, and the first it finds. */
export function anySection(pool: SharedChunkPool, memberId: string, level: number): LodIndirectionMeta | undefined {
  for (const view of pool.views.values()) {
    const meta = sectionOf(view, memberId, level);
    if (meta) return meta;
  }
  return undefined;
}

/** Whether any view of `pool` lays out sections for `memberId`. */
export function anyViewHolds(pool: SharedChunkPool, memberId: string): boolean {
  for (const view of pool.views.values()) {
    if ((view.entityMetas.get(memberId)?.length ?? 0) > 0) return true;
  }
  return false;
}
