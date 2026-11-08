import { describe, expect, it, vi } from "vitest";

import { applyFailedMarks, cellIndex, failedCellsAt, failedKeysForImage, identityIndirection } from "./failedCells.ts";
import { INDIRECTION_FAILED, INDIRECTION_MISS } from "./remap.ts";
import { labelCellKey, markLabelSliceFailed, type LabelSlicePool } from "./slice/atlas.ts";
import { markLabelVolumeFailed, type LabelVolumePool } from "./volume/atlas.ts";
import { createInitialState } from "./worker/state.ts";
import type { WorkerCtx } from "./workerContext.ts";

const FAILED = INDIRECTION_FAILED;
const MISS = INDIRECTION_MISS;

describe("failedCellsAt", () => {
  const grid = { x: 3, y: 2, z: 2 };

  it("keeps the keys at the level, T and C asked for, by cell", () => {
    const failed = new Set(["1/0/0/1/1/2", "2/0/0/1/1/2", "1/1/0/1/1/2", "1/0/1/1/1/2", "1/0/0/0/0/0"]);
    expect(failedCellsAt(failed, grid, { level: 1, t: 0, c: 0 })).toEqual(
      new Map([
        [cellIndex(grid, 2, 1, 1), "1/0/0/1/1/2"],
        [cellIndex(grid, 0, 0, 0), "1/0/0/0/0/0"],
      ]),
    );
  });

  it("with a plane, keeps only that plane's keys, each at z 0", () => {
    const failed = new Set(["1/0/0/1/1/2", "1/0/0/0/1/2"]);
    const plane = { x: 3, y: 2, z: 1 };
    expect(failedCellsAt(failed, plane, { level: 1, t: 0, c: 0, z: 1 })).toEqual(
      new Map([[cellIndex(plane, 2, 1, 0), "1/0/0/1/1/2"]]),
    );
  });

  it("drops keys outside the grid and keys that don't parse", () => {
    const failed = new Set(["1/0/0/0/0/3", "1/0/0/2/0/0", "nonsense"]);
    expect(failedCellsAt(failed, grid, { level: 1, t: 0, c: 0 }).size).toBe(0);
  });
});

describe("applyFailedMarks", () => {
  const failedAt = (cells: number[]) => new Map(cells.map((cell) => [cell, `key${cell}`]));

  it("marks a failed cell the pool doesn't hold, and leaves one it holds", () => {
    const indirection = identityIndirection(4);
    const marked = new Set<number>();
    const changed = applyFailedMarks(indirection, marked, failedAt([1, 2]), (cell) => cell === 2, (cell) => cell);
    expect(changed).toBe(true);
    expect([...indirection]).toEqual([0, FAILED, 2, 3]);
    expect([...marked]).toEqual([1]);
  });

  it("gives a cell that is no longer failed what the pool reads without the mark", () => {
    const indirection = new Uint32Array([MISS, FAILED, MISS]);
    const marked = new Set([1]);
    expect(applyFailedMarks(indirection, marked, new Map(), () => false, () => MISS)).toBe(true);
    expect([...indirection]).toEqual([MISS, MISS, MISS]);
    expect(marked.size).toBe(0);
  });

  it("restores a mark something else overwrote, and reports nothing when all is in place", () => {
    const indirection = identityIndirection(2);
    const marked = new Set([1]);
    expect(applyFailedMarks(indirection, marked, failedAt([1]), () => false, (cell) => cell)).toBe(true);
    expect(indirection[1]).toBe(FAILED);
    expect(applyFailedMarks(indirection, marked, failedAt([1]), () => false, (cell) => cell)).toBe(false);
  });
});

describe("failedKeysForImage", () => {
  it("finds an image's keys in whichever dataset lists it", () => {
    const state = createInitialState();
    state.failedByDataset.set("a", new Map([["img-a", new Set(["0/0/0/0/0/0"])]]));
    state.failedByDataset.set("b", new Map([["img-b", new Set(["1/0/0/0/0/0"])]]));
    expect(failedKeysForImage(state, "img-b")).toEqual(new Set(["1/0/0/0/0/0"]));
    expect(failedKeysForImage(state, "img-c")).toBeUndefined();
  });
});

function fakeCtx(failed: Record<string, string[]>) {
  const state = createInitialState();
  state.failedByDataset.set("ds", new Map(Object.entries(failed).map(([id, keys]) => [id, new Set(keys)])));
  const writeBuffer = vi.fn();
  const ctx = { state, device: { queue: { writeBuffer } } } as unknown as WorkerCtx;
  return { ctx, writeBuffer };
}

describe("a label slice pool's failed marks", () => {
  function pool(): LabelSlicePool {
    const grid = { x: 2, y: 2, z: 1 };
    return {
      grid, chunkX: 4, chunkY: 4,
      indirection: identityIndirection(4),
      markedFailed: new Set(),
      keys: new Map(),
      indirectionBuf: {} as GPUBuffer,
    } as unknown as LabelSlicePool;
  }

  it("marks the drawn plane's failed cell, even over an older plane the cell still holds", () => {
    const p = pool();
    p.keys.set(labelCellKey(1, 0), "0/0/0/2/0/1"); // the plane at chunk-Z 2
    const { ctx, writeBuffer } = fakeCtx({ seg: ["0/0/0/3/0/1", "0/0/0/2/1/1"] });
    expect(markLabelSliceFailed(ctx, "seg", p, { level: 0, t: 0, z: 3 })).toBe(true);
    expect([...p.indirection]).toEqual([0, FAILED, 2, 3]);
    expect(writeBuffer).toHaveBeenCalledOnce();

    // Back at chunk-Z 2 the cell holds that plane's chunk, and the cell that
    // failed there holds nothing of it.
    markLabelSliceFailed(ctx, "seg", p, { level: 0, t: 0, z: 2 });
    expect([...p.indirection]).toEqual([0, 1, 2, FAILED]);
  });
});

describe("a label volume pool's failed marks", () => {
  function pool(): LabelVolumePool {
    return {
      gridX: 2, gridY: 1, gridZ: 2,
      indirectionData: new Uint32Array([MISS, MISS, MISS, MISS]),
      markedFailed: new Set(),
      slots: new Map(),
      keys: new Map(),
      indirectionBuf: {} as GPUBuffer,
    } as unknown as LabelVolumePool;
  }

  it("marks a failed cell no slot holds and gives it back its slot once one does", () => {
    const p = pool();
    p.slots.set(0, 5);
    p.keys.set(0, "1/0/0/0/0/0");
    p.indirectionData[0] = 5;
    const { ctx } = fakeCtx({ seg: ["1/0/0/1/0/1", "1/0/0/0/0/0", "1/1/0/1/0/0"] });
    markLabelVolumeFailed(ctx, "seg", p, { level: 1, t: 0 });
    // The resident cell keeps its slot; the other T's key marks nothing.
    expect([...p.indirectionData]).toEqual([5, MISS, MISS, FAILED]);

    p.slots.set(3, 7);
    p.keys.set(3, "1/0/0/1/0/1");
    p.indirectionData[3] = 7;
    expect(markLabelVolumeFailed(ctx, "seg", p, { level: 1, t: 0 })).toBe(false);
    expect([...p.indirectionData]).toEqual([5, MISS, MISS, 7]);
    expect(p.markedFailed.size).toBe(0);
  });
});
