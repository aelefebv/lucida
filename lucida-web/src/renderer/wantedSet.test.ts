import { describe, it, expect } from "vitest";
import { computeWantedSet, type AtlasSnapshot } from "./wantedSet.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
} from "./workerProtocol.ts";
import type { PlanningEpochs, VisibleRegion } from "../pipeline/planning.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpochs(): PlanningEpochs {
  return {
    content: 1,
    layout: 1,
    view: 1,
    selection: 1,
    asset: 0,
    request: 1,
  };
}

function makeVisibleRegion(
  overrides?: Partial<VisibleRegion>,
): VisibleRegion {
  return {
    xyBounds: [0, 0, 256, 256],
    zRange: [0, 64],
    effectiveZoom: 1,
    sortCenter: null,
    frustumPlanes: null,
    ...overrides,
  };
}

function makeActiveEntry(
  overrides?: Partial<ColdStateActiveEntry>,
): ColdStateActiveEntry {
  return {
    entityId: "entity-0",
    imageId: "img",
    targetLod: 0,
    detailOwnedLodRange: [0, 0],
    levels: [
      {
        level: 0,
        chunkShape: [32, 32, 32], // [Z, Y, X]
        gridShape: [2, 4, 4], // 64 deep, 128 high, 128 wide
      },
    ],
    ...overrides,
  };
}

function makeColdState(
  overrides?: Partial<ColdStateMessage>,
): ColdStateMessage {
  return {
    type: "coldState",
    epochs: makeEpochs(),
    currentT: 0,
    visibleChannels: [0],
    visibleRegion: makeVisibleRegion(),
    activeSet: [makeActiveEntry()],
    viewMode: "volume",
    ...overrides,
  };
}

function makeAtlas(overrides?: Partial<AtlasSnapshot>): AtlasSnapshot {
  return {
    level: 0,
    t: 0,
    c: 0,
    slots: new Map(),
    gridX: 4,
    gridY: 4,
    gridZ: 2,
    chunkX: 32,
    chunkY: 32,
    chunkZ: 32,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeWantedSet", () => {
  it("empty atlas -> all visible chunks missing", () => {
    // Visible region covers [0,0,64,64] -> 2x2 in XY, zRange [0,32] -> 1 in Z
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBounds: [0, 0, 64, 64],
        zRange: [0, 32],
      }),
    });
    const atlas = makeAtlas(); // empty slots
    const volumeAtlases = new Map([["img", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map());

    expect(result.missing).toHaveLength(4); // 2x2x1 = 4 chunks
    // Verify chunk keys follow the correct format
    for (const entry of result.missing) {
      expect(entry.entityId).toBe("entity-0");
      expect(entry.chunkKey).toMatch(/^0\/0\/0\/\d+\/\d+\/\d+$/);
    }
  });

  it("full atlas -> empty wanted-set", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBounds: [0, 0, 64, 64],
        zRange: [0, 32],
      }),
    });
    // Pre-populate atlas with all expected chunks
    const slots = new Map<string, number>();
    slots.set("0/0/0/0/0/0", 0);
    slots.set("0/0/0/0/0/1", 1);
    slots.set("0/0/0/0/1/0", 2);
    slots.set("0/0/0/0/1/1", 3);
    const atlas = makeAtlas({ slots });
    const volumeAtlases = new Map([["img", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map());

    expect(result.missing).toHaveLength(0);
  });

  it("partial atlas -> only missing chunks reported", () => {
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBounds: [0, 0, 64, 64],
        zRange: [0, 32],
      }),
    });
    // 2 of 4 chunks present
    const slots = new Map<string, number>();
    slots.set("0/0/0/0/0/0", 0);
    slots.set("0/0/0/0/1/1", 1);
    const atlas = makeAtlas({ slots });
    const volumeAtlases = new Map([["img", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map());

    expect(result.missing).toHaveLength(2);
    const keys = result.missing.map((m) => m.chunkKey).sort();
    expect(keys).toEqual(["0/0/0/0/0/1", "0/0/0/0/1/0"]);
  });

  it("spatial culling - only visible region chunks", () => {
    // Grid is 4x4, but visible region only covers first 2x2
    const coldState = makeColdState({
      visibleRegion: makeVisibleRegion({
        xyBounds: [0, 0, 64, 64], // 64/32=2 chunks in each axis
        zRange: [0, 32],
      }),
    });
    const atlas = makeAtlas(); // empty
    const volumeAtlases = new Map([["img", atlas]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map());

    // Should be 2x2x1 = 4, not 4x4x2 = 32
    expect(result.missing).toHaveLength(4);
    // Verify no chunk index exceeds the visible bounds
    for (const entry of result.missing) {
      const parts = entry.chunkKey.split("/").map(Number);
      const [, , , iz, iy, ix] = parts;
      expect(ix).toBeLessThan(2);
      expect(iy).toBeLessThan(2);
      expect(iz).toBeLessThan(1);
    }
  });

  it("multi-channel - per-channel atlas keying", () => {
    const coldState = makeColdState({
      visibleChannels: [0, 2],
      visibleRegion: makeVisibleRegion({
        xyBounds: [0, 0, 32, 32], // 1x1 in XY
        zRange: [0, 32], // 1 in Z
      }),
    });
    // Separate atlases for each channel
    const ch0Atlas = makeAtlas({ c: 0 }); // empty
    const ch2Atlas = makeAtlas({ c: 2 }); // empty
    const volumeAtlases = new Map<string, AtlasSnapshot>([
      ["img:ch0", ch0Atlas],
      ["img:ch2", ch2Atlas],
    ]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map());

    // 1 chunk per channel, 2 channels = 2 missing
    expect(result.missing).toHaveLength(2);

    const keys = result.missing.map((m) => m.chunkKey).sort();
    // channel 0 and channel 2
    expect(keys).toEqual(["0/0/0/0/0/0", "0/0/2/0/0/0"]);
  });

  it("slice mode - only current Z slice", () => {
    const coldState = makeColdState({
      viewMode: "slice",
      visibleRegion: makeVisibleRegion({
        xyBounds: [0, 0, 64, 64],
        zRange: [0, 64], // full Z range in visible region (ignored for slice)
      }),
    });
    // Atlas is in slice mode at z=10 (chunk index 0 since 10/32 = 0)
    const atlas = makeAtlas({ z: 10 });
    const sliceAtlases = new Map([["img", atlas]]);

    const result = computeWantedSet(coldState, new Map(), sliceAtlases);

    // Only Z chunk 0 (containing slice z=10), 2x2 in XY = 4 chunks
    expect(result.missing).toHaveLength(4);
    for (const entry of result.missing) {
      const parts = entry.chunkKey.split("/").map(Number);
      expect(parts[3]).toBe(0); // z chunk index
    }
  });

  it("no active set -> empty wanted-set", () => {
    const coldState = makeColdState({ activeSet: [] });
    const volumeAtlases = new Map([["img", makeAtlas()]]);

    const result = computeWantedSet(coldState, volumeAtlases, new Map());

    expect(result.missing).toHaveLength(0);
  });

  it("entity with no matching atlas -> skipped", () => {
    const coldState = makeColdState();
    // No atlas for "img" — both maps are empty
    const result = computeWantedSet(coldState, new Map(), new Map());

    expect(result.missing).toHaveLength(0);
  });
});
