/**
 * A pool's eviction order against the kernel it keeps: through random holds,
 * releases and changes to everything the classes read, its pick is always
 * the one `findEvictionSlot` makes classifying every slot, and its count of
 * wanted slots is the one reading every slot gives.
 */

import { describe, expect, it } from "vitest";
import { findEvictionSlot, readSlotKey, type EvictionView, type FindEvictionParams } from "./eviction.ts";
import { EvictionOrder } from "./evictionOrder.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";

const SLOTS = 24;
const MEMBERS = ["a", "b"];
const LEVELS: LodIndirectionMeta[] = [
  { level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], levelDims: [64, 128, 128], offset: 0 },
  { level: 1, gridDims: [1, 2, 2], chunkDims: [32, 32, 32], levelDims: [32, 64, 64], offset: 32 },
  { level: 2, gridDims: [1, 1, 1], chunkDims: [32, 32, 32], levelDims: [32, 32, 32], offset: 36 },
];

/** A small seeded generator, so a failure replays. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimView {
  slotGridIdx: Int32Array;
  entityMetas: ReadonlyMap<string, readonly LodIndirectionMeta[]>;
  wanted: ReadonlyMap<string, ReadonlySet<string>>;
  targets: ReadonlyMap<string, number>;
  cameras: Map<string, [number, number, number]>;
}

function simulate(seed: number, is3D: boolean, steps: number): void {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const chunkKeyAt = (meta: LodIndirectionMeta) =>
    `${meta.level}/${pick([0, 1])}/0/${Math.floor(rand() * meta.gridDims[0])}/${Math.floor(rand() * meta.gridDims[1])}/${Math.floor(rand() * meta.gridDims[2])}`;
  const someChunkKey = () => (rand() < 0.03 ? "bad" : chunkKeyAt(pick(LEVELS)));
  const slotKey = (member: string, chunkKey: string) => (is3D ? `${member}|${chunkKey}` : `${member}|${chunkKey}|${pick([0, 1])}`);
  const camera = (): [number, number, number] => [pick([0, 0.25, 0.5, 1]), pick([0, 0.5, 1]), pick([0, 0.5])];
  const someWanted = () => new Map(MEMBERS.map((member) => {
    const keys = new Set<string>();
    for (let i = 0; i < 12; i++) keys.add(chunkKeyAt(pick(LEVELS)));
    return [`detail|${member}`, keys] as const;
  }));
  const someTargets = () => new Map(MEMBERS.filter(() => rand() < 0.7).map((member) => [member, pick([0, 1, 2])] as const));
  const someMetas = () => new Map(MEMBERS.filter(() => rand() < 0.9).map((member) =>
    [member, LEVELS.filter(() => rand() < 0.8)] as const));
  const mapRandomly = (view: SimView, slot: number) => {
    view.slotGridIdx[slot] = rand() < 0.6 ? Math.floor(rand() * 37) : -1;
  };

  let slots = new Map<string, number>();
  let cameraRevision = 0;
  const views: SimView[] = [0, 1].map(() => ({
    slotGridIdx: new Int32Array(SLOTS).fill(-1),
    entityMetas: someMetas(),
    wanted: someWanted(),
    targets: someTargets(),
    cameras: new Map(MEMBERS.map((member) => [member, camera()])),
  }));
  const params = (): FindEvictionParams => ({
    slots,
    is3D,
    views: views.map((view): EvictionView => ({
      slotGridIdx: view.slotGridIdx,
      entityMetas: view.entityMetas,
      cameraFor: (member) => view.cameras.get(member) ?? [0.5, 0.5, 0.5],
      targetLevelFor: (member) => view.targets.get(member),
      isWanted: (member, chunkKey) => view.wanted.get(`detail|${member}`)?.has(chunkKey) ?? false,
      sources: [view.wanted, view.targets, cameraRevision],
    })),
  });
  const order = new EvictionOrder();

  for (let step = 0; step < steps; step++) {
    const op = rand();
    const held = [...slots];
    if (op < 0.4 && slots.size < SLOTS) {
      const used = new Set(slots.values());
      const free = Array.from({ length: SLOTS }, (_, i) => i).filter((i) => !used.has(i));
      const slot = pick(free);
      const key = slotKey(pick(MEMBERS), someChunkKey());
      if (slots.has(key)) continue;
      for (const view of views) mapRandomly(view, slot);
      slots.set(key, slot);
      order.hold(slot, key);
    } else if (op < 0.6 && held.length > 0) {
      const [key, slot] = pick(held);
      slots.delete(key);
      order.release(slot);
      for (const view of views) view.slotGridIdx[slot] = -1;
    } else if (op < 0.7) {
      pick(views).cameras.set(pick(MEMBERS), camera());
      cameraRevision++;
    } else if (op < 0.76) {
      pick(views).wanted = someWanted();
    } else if (op < 0.82) {
      pick(views).targets = someTargets();
    } else if (op < 0.88) {
      pick(views).entityMetas = someMetas();
    } else if (op < 0.94) {
      // A remap rewrites a view's slot map in place.
      const view = pick(views);
      for (const slot of slots.values()) mapRandomly(view, slot);
      order.invalidate();
    } else {
      slots = new Map(slots);
    }

    const now = params();
    expect(order.next(now), `step ${step}`).toEqual(findEvictionSlot(now));
    let wanted = 0;
    for (const key of slots.keys()) {
      const slot = readSlotKey(key);
      if (slot && now.views.some((view) => view.isWanted(slot.memberId, slot.chunkKey))) wanted++;
    }
    expect(order.wantedHeld(now), `step ${step}`).toBe(wanted);
  }
}

describe("EvictionOrder", () => {
  it.each([1, 2, 3, 4])("picks what classifying every volume slot picks, seed %i", (seed) => {
    simulate(seed, true, 1500);
  });

  it.each([5, 6, 7, 8])("picks what classifying every slice slot picks, seed %i", (seed) => {
    simulate(seed, false, 1500);
  });

  it("holds nothing to pick in an empty pool", () => {
    const order = new EvictionOrder();
    expect(order.next({ slots: new Map(), views: [], is3D: true })).toBeNull();
  });
});
