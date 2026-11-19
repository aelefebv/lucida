import { describe, expect, it } from "vitest";

import { WantedSetReporter } from "./wantedSetReport.ts";
import { attachView, fakeDraw } from "../viewIndirectionFixtures.ts";
import { createInitialState, type RendererState } from "./state.ts";
import { indexWantedChunks } from "../wantedChunks.ts";
import { EvictionOrder } from "../evictionOrder.ts";
import { SlotJournal } from "../slotJournal.ts";
import { dropSlot, holdSlot, type SharedChunkPool } from "../viewIndirection.ts";
import type { ColdStateMessage, MissingChunk, PoolMode, WorkerToMainMessage } from "../workerProtocol.ts";

const KEYS = ["0/0/0/0/0/0", "0/0/0/0/0/1", "0/0/0/0/1/0", "0/0/0/0/1/1"];

function coldState(mode: PoolMode, z: number, keys = KEYS): ColdStateMessage {
  const identity = new Float32Array(16);
  identity[0] = identity[5] = identity[10] = identity[15] = 1;
  return {
    type: "coldState",
    labels: [],
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    datasetId: "ds-0",
    currentT: 0,
    currentZ: z,
    visibleChannels: [0],
    visibleRegion: { xyBoundsVox: [0, 0, 128, 128], zRangeVox: [z, z + 1], effectiveZoom: 1, sortCenterVox: null, frustumPlanes: null },
    wantedChunks: [{ memberId: "img:ch0", tier: "detail", chunkKeys: keys }],
    activeSet: [{
      entityId: "img",
      imageId: "img",
      levels: [{ level: 0, chunkShape: [32, 32, 32], gridShape: [2, 4, 4], levelDims: [64, 128, 128] }],
      detailLevels: [0],
      coarseLevel: null,
      modelMatrix: identity,
      invModelMatrix: identity,
      displayStateByChannel: {},
    }],
    view: 0,
    viewMode: mode,
    drawnViews: [0],
    sampleFormat: "u16",
  };
}

/** One view drawing one member's level 0 from one pool, with a reporter over it. */
function world(mode: PoolMode = "volume", z = 0) {
  const state: RendererState = createInitialState();
  const cold = coldState(mode, z);
  const draw = fakeDraw({ datasetId: "ds-0", mode, z, wanted: indexWantedChunks(cold.wantedChunks) });
  draw.cold = cold;
  draw.routes.set("img:ch0", new Map([["detail:0", "pool"]]));
  state.draws.set("ds-0|0", draw);
  state.memberToDataset.set("img:ch0", "ds-0");
  const pool = {
    datasetId: "ds-0",
    slots: new Map<string, number>(),
    order: new EvictionOrder(),
    journal: new SlotJournal(),
    views: new Map(),
    freeSlots: [],
    totalSlots: 8,
    ...(mode === "slice" ? { planesByChunk: new Map() } : {}),
  };
  attachView(pool as SharedChunkPool, new Map([["img:ch0", [{ level: 0, gridDims: [2, 4, 4], chunkDims: [32, 32, 32], levelDims: [64, 128, 128], offset: 0 }]]]), { draw });
  if (mode === "volume") state.volumeAtlases.set("pool", pool as never);
  else state.sliceAtlases.set("pool", pool as never);
  const posts: WorkerToMainMessage[] = [];
  const reporter = new WantedSetReporter(state, (msg) => posts.push(msg));
  return {
    state,
    draw,
    pool,
    posts,
    reporter,
    /** What the posts since the last call named missing, and the level reports among them. */
    take(): { missing: string[]; levels: number; deltas: number } {
      const missing = posts.flatMap((m) => (m.type === "wantedSetDelta" ? m.missing : [])).map((m: MissingChunk) => m.chunkKey);
      const levels = posts.filter((m) => m.type === "entityLevels").length;
      const deltas = posts.filter((m) => m.type === "wantedSetDelta").length;
      posts.length = 0;
      return { missing, levels, deltas };
    },
  };
}

describe("the wanted-set report", () => {
  it("reports a chunk held only at another plane missing at the plane the view cuts", () => {
    const w = world("slice", 11);
    // Cut at plane 10, in the same chunk as plane 11.
    w.pool.slots.set("img:ch0|0/0/0/0/0/0|10", 0);
    (w.pool as { planesByChunk: Map<string, Map<number, number>> }).planesByChunk.set("img:ch0|0/0/0/0/0/0", new Map([[10, 0]]));

    w.reporter.request("ds-0");
    w.reporter.flush();

    // The plane another view may draw stays held: only the view's own plane is asked for.
    expect(w.posts.map((m) => m.type)).toEqual(["wantedSetDelta", "entityLevels"]);
    const missing = w.posts[0].type === "wantedSetDelta" ? w.posts[0].missing : [];
    expect(missing.map((m) => [m.chunkKey, m.cut])).toEqual(KEYS.map((key) => [key, { axis: "z", plane: 11 }]));
  });

  it("goes out at the flush, once for every request and upload before it", () => {
    const w = world();
    w.reporter.request("ds-0");
    w.reporter.request("ds-0", "volume");
    holdSlot(w.pool, `img:ch0|${KEYS[0]}`, 0);
    holdSlot(w.pool, `img:ch0|${KEYS[1]}`, 1);
    expect(w.posts).toEqual([]);

    w.reporter.flush();

    expect(w.take()).toEqual({ missing: KEYS.slice(2), levels: 1, deltas: 1 });
    w.reporter.flush();
    expect(w.posts).toEqual([]);
  });

  it("names a lacking chunk once, and again only when its slot changes", () => {
    const w = world();
    w.reporter.request("ds-0");
    w.reporter.flush();
    expect(w.take().missing).toEqual(KEYS);

    // Held: nothing new lacks, and the view shows level 0 where it showed nothing.
    for (const [slot, key] of KEYS.entries()) holdSlot(w.pool, `img:ch0|${key}`, slot);
    w.reporter.flush();
    expect(w.take()).toEqual({ missing: [], levels: 1, deltas: 0 });

    // A slot let go with no loss reported: the page hears of that chunk alone.
    dropSlot(w.pool, `img:ch0|${KEYS[2]}`);
    w.reporter.flush();
    expect(w.take().missing).toEqual([KEYS[2]]);

    // A cold state that changes nothing the view wants or holds names nothing.
    w.reporter.request("ds-0");
    w.reporter.flush();
    expect(w.take()).toEqual({ missing: [], levels: 0, deltas: 0 });
  });

  it("names the chunks a view newly wants and lacks, and not those it already lacked", () => {
    const w = world();
    w.reporter.request("ds-0");
    w.reporter.flush();
    w.take();

    const extra = "0/0/0/1/0/0";
    w.draw.wanted = indexWantedChunks([{ memberId: "img:ch0", tier: "detail", chunkKeys: [...KEYS, extra] }]);
    w.reporter.request("ds-0");
    w.reporter.flush();

    expect(w.take().missing).toEqual([extra]);
  });

  it("reads a whole pool again when its slot map is replaced", () => {
    const w = world();
    for (const [slot, key] of KEYS.entries()) holdSlot(w.pool, `img:ch0|${key}`, slot);
    w.reporter.request("ds-0");
    w.reporter.flush();
    expect(w.take().missing).toEqual([]);

    // A shrink compacts the pool into a new map, keeping one chunk.
    w.pool.slots = new Map([[`img:ch0|${KEYS[0]}`, 0]]);
    w.reporter.request("ds-0");
    w.reporter.flush();

    expect(w.take().missing).toEqual(KEYS.slice(1));
  });

  it("posts nothing for a view released since it was asked for", () => {
    const w = world();
    w.reporter.request("ds-0");
    w.state.draws.delete("ds-0|0");

    w.reporter.flush();

    expect(w.posts).toEqual([]);
  });

  it("lists everything a dataset's views lack, computed now", () => {
    const w = world();
    w.reporter.request("ds-0");
    w.reporter.flush();
    holdSlot(w.pool, `img:ch0|${KEYS[3]}`, 0);

    expect(w.reporter.lackingNow("ds-0").map((m) => m.chunkKey)).toEqual(KEYS.slice(0, 3));
  });
});
