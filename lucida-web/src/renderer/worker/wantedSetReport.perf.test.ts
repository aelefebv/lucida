/**
 * What a frame's wanted-set report costs once the pools are full, at the
 * scale of a zoomed-in three-channel deep volume on a large canvas: each
 * channel's view wants the 2,560 chunks of its finest level and the coarse
 * tier, its pool holds about a thousand of them, and every chunk that
 * arrives takes the slot of one the view wants less.
 *
 * The step is one frame's report after one such arrival in each channel.
 * Read the logged p50: it follows the chunks that changed, where reading the
 * whole wanted set cost the view's size per report. The second step replaces
 * the view's entry, as a delta does for any change to it.
 */
import { describe, it } from "vitest";
import { describeTiming, expectWithinBudget, timeStep } from "../../test/perfBudget.ts";

import type { ColdStateActiveEntry, ColdStateMessage } from "../workerProtocol.ts";
import { WantedSetReporter } from "./wantedSetReport.ts";
import { createInitialState } from "./state.ts";
import { attachView, fakeDraw } from "../viewIndirectionFixtures.ts";
import { indexWantedChunks } from "../wantedChunks.ts";
import { EvictionOrder } from "../evictionOrder.ts";
import { SlotJournal } from "../slotJournal.ts";
import { dropSlot, holdSlot, type SharedChunkPool } from "../viewIndirection.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";

const CHANNELS = 3;
/** Level 0's chunk grid, [Z, Y, X]; level 1 halves it, and the coarse tier's level 2 halves it again. */
const GRID: [number, number, number] = [10, 16, 16];
const HELD = 1000;

/** In nominal microseconds, about twice the typical figure. */
const REPORT_BUDGET_US = 50;
/**
 * Also twice the typical figure. Planning every member again, as a replaced
 * entry once did, reads all 7,680 wanted chunks and costs about a hundred
 * times as much.
 */
const REPLACED_BUDGET_US = 100;

function gridOf(level: number): [number, number, number] {
  return GRID.map((n) => Math.ceil(n / 2 ** level)) as [number, number, number];
}

function keysOf(level: number, c: number): string[] {
  const [gz, gy, gx] = gridOf(level);
  const keys: string[] = [];
  for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) keys.push(`${level}/0/${c}/${z}/${y}/${x}`);
  return keys;
}

/** The views' first report made, over pools holding what the header says. */
function fullPools() {
  const state = createInitialState();
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  const entry: ColdStateActiveEntry = {
    entityId: "img",
    imageId: "img",
    levels: [0, 1, 2].map((level) => {
      const grid = gridOf(level);
      return {
        level,
        chunkShape: [64, 64, 64] as [number, number, number],
        gridShape: grid,
        levelDims: grid.map((n) => n * 64) as [number, number, number],
      };
    }),
    detailLevels: [0, 1],
    coarseLevel: 2,
    modelMatrix: identity,
    invModelMatrix: identity,
    displayStateByChannel: {},
  };
  const wantedChunks = Array.from({ length: CHANNELS }, (_, c) => [
    { memberId: `img:ch${c}`, tier: "detail" as const, chunkKeys: keysOf(0, c) },
    { memberId: `img:ch${c}`, tier: "coarse" as const, chunkKeys: keysOf(2, c) },
  ]).flat();
  const cold = {
    type: "coldState",
    datasetId: "ds",
    currentT: 0,
    currentZ: 0,
    visibleChannels: Array.from({ length: CHANNELS }, (_, c) => c),
    wantedChunks,
    activeSet: [entry],
    view: 0,
    viewMode: "volume",
    drawnViews: [0],
  } as unknown as ColdStateMessage;
  const draw = fakeDraw({ datasetId: "ds", wanted: indexWantedChunks(wantedChunks) });
  draw.cold = cold;
  state.draws.set("ds|0", draw);

  const meta = (level: number, offset: number): LodIndirectionMeta => {
    const grid = gridOf(level);
    return { level, gridDims: grid, chunkDims: [64, 64, 64], levelDims: grid.map((n) => n * 64) as [number, number, number], offset };
  };
  const pools: SharedChunkPool[] = [];
  for (let c = 0; c < CHANNELS; c++) {
    const member = `img:ch${c}`;
    state.memberToDataset.set(member, "ds");
    draw.routes.set(member, new Map([["detail:0", `detail-${c}`], ["detail:1", `detail-${c}`], ["coarse:2", `coarse-${c}`]]));
    const pool = (key: string, metas: LodIndirectionMeta[]) => {
      const p = {
        datasetId: "ds", slots: new Map<string, number>(), order: new EvictionOrder(), journal: new SlotJournal(),
        views: new Map(), freeSlots: [], totalSlots: 4096,
      };
      attachView(p as SharedChunkPool, new Map([[member, metas]]), { draw });
      state.volumeAtlases.set(key, p as never);
      return p as SharedChunkPool;
    };
    const detail = pool(`detail-${c}`, [meta(0, 0), meta(1, 2560)]);
    const coarse = pool(`coarse-${c}`, [meta(2, 0)]);
    keysOf(2, c).forEach((key, slot) => holdSlot(coarse, `${member}|${key}`, slot));
    keysOf(1, c).forEach((key, slot) => holdSlot(detail, `${member}|${key}`, slot));
    keysOf(0, c).slice(0, HELD).forEach((key, slot) => holdSlot(detail, `${member}|${key}`, 400 + slot));
    pools.push(detail);
  }
  const reporter = new WantedSetReporter(state, () => {});
  reporter.request("ds");
  reporter.flush();
  return { state, entry, cold, draw, pools, reporter };
}

describe("a frame's wanted-set report", () => {
  it("costs what changed, not what the views hold or want", () => {
    const { pools, reporter } = fullPools();
    // Each channel's next wanted chunk takes the slot of its oldest held one.
    const level0 = Array.from({ length: CHANNELS }, (_, c) => keysOf(0, c));
    let next = 0;
    const step = () => {
      for (let c = 0; c < CHANNELS; c++) {
        const keys = level0[c];
        const leaving = keys[next % keys.length];
        const arriving = keys[(next + HELD) % keys.length];
        const slot = dropSlot(pools[c], `img:ch${c}|${leaving}`) ?? 0;
        holdSlot(pools[c], `img:ch${c}|${arriving}`, slot);
      }
      next++;
      reporter.flush();
    };
    const timing = timeStep(step, { samples: 400, warmup: 40 });
    console.log(`[wanted-set report] ${CHANNELS} channels, ${HELD} of 2,560 held each: ${describeTiming(timing, REPORT_BUDGET_US)}`);

    expectWithinBudget("a frame's wanted-set report", timing, REPORT_BUDGET_US);
  });

  it("costs what changed when an entry is replaced by one its lookups read alike", () => {
    const { draw, cold, entry, reporter } = fullPools();
    // A delta replaces an entry for any change, here one more coarse level
    // past the finest and another display state, as a gesture's replans and
    // a contrast fit do.
    let n = 0;
    const step = () => {
      n++;
      const display = { contrastMin: 0, contrastMax: n, gamma: 1, opacity: 1, colormapName: "gray", channelMask: 1 };
      const replaced: ColdStateActiveEntry = { ...entry, detailLevels: n % 2 ? [0, 1] : [0, 1, 2], displayStateByChannel: { 0: display } };
      draw.cold = { ...cold, activeSet: [replaced] };
      reporter.request("ds");
      reporter.flush();
    };
    const timing = timeStep(step, { samples: 200, warmup: 20 });
    console.log(`[wanted-set report] an entry replaced: ${describeTiming(timing, REPLACED_BUDGET_US)}`);

    expectWithinBudget("a report after an entry is replaced", timing, REPLACED_BUDGET_US);
  });
});
