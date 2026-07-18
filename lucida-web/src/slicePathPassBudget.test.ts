// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_INDIVIDUAL_MEMBER_PASSES,
  MAX_SLICE_BACKING_PIXELS,
  MEMBER_AGGREGATE_MAX_DIAG_PX,
  createSliceState,
  pushMemberLayers,
  sliceBackingScale,
  tickSlice,
} from "./slicePath.ts";
import type { SliceLayerParams } from "./renderer/workerProtocol.ts";
import type { MemberRosterEntry, TickCoordinator, TickCoordinatorResult } from "./pipeline/tickCoordinator.ts";
import type { TickContext } from "./renderLoopTypes.ts";
import type { Uploader } from "./pipeline/upload/uploader.ts";
import { compositeKey } from "./tickCommon.ts";

// ---------------------------------------------------------------------------
// pushMemberLayers — the per-(dataset, channel) member-pass budget
// ---------------------------------------------------------------------------

function rosterGrid(n: number, cols: number, pitch: number): MemberRosterEntry[] {
  const out: MemberRosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      imageId: `img-${i}`,
      position: [(i % cols) * pitch, Math.floor(i / cols) * pitch],
      entityId: `tile-${i}`,
    });
  }
  return out;
}

function indexFor(members: MemberRosterEntry[], channel: number | null): Map<string, number> {
  const m = new Map<string, number>();
  members.forEach((entry, i) => {
    m.set(channel === null ? entry.imageId : compositeKey(entry.imageId, channel), i);
  });
  return m;
}

describe("pushMemberLayers", () => {
  it("aggregates a wide collection of sub-pixel members into ONE layer", () => {
    const members = rosterGrid(5000, 100, 1024);
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.0005, // diag ≈ 0.7 device px per member
    });
    expect(layers).toHaveLength(1);
    const agg = layers[0].aggregate;
    expect(agg).toBeDefined();
    expect(agg!.count).toBe(5000);
  });

  it("reuses aggregate geometry across camera-only frames and invalidates on its basis", () => {
    const members = rosterGrid(5000, 100, 1024);
    const indexByMember = indexFor(members, null);
    const state = createSliceState();
    const input = {
      members,
      indexByMember,
      channel: null,
      blendMode: "alpha" as const,
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.0005,
      cache: { state, datasetId: "ds-0", epochKey: "1|1|1" },
    };
    const first: SliceLayerParams[] = [];
    const second: SliceLayerParams[] = [];
    pushMemberLayers(first, input);
    pushMemberLayers(second, input);

    expect(second[0]).toBe(first[0]);
    expect(second[0].aggregate?.quads).toBe(first[0].aggregate?.quads);
    expect(second[0].aggregate?.cacheKey).toBe(first[0].aggregate?.cacheKey);

    const nearbyZoom: SliceLayerParams[] = [];
    pushMemberLayers(nearbyZoom, { ...input, zoom: input.zoom * 1.1 });
    expect(nearbyZoom[0].aggregate?.quads).toBe(first[0].aggregate?.quads);
    expect(nearbyZoom[0].aggregate?.cacheKey).toBe(
      first[0].aggregate?.cacheKey,
    );

    const changed: SliceLayerParams[] = [];
    pushMemberLayers(changed, {
      ...input,
      cache: { ...input.cache, epochKey: "1|2|1" },
    });
    expect(changed[0].aggregate?.quads).not.toBe(first[0].aggregate?.quads);
    expect(changed[0].aggregate?.cacheKey).not.toBe(first[0].aggregate?.cacheKey);
  });

  it("keeps per-member passes for members at normal zoom (no aggregate)", () => {
    const members = rosterGrid(9, 3, 1024);
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 1, // diag ≈ 1448 px per member
    });
    expect(layers).toHaveLength(9);
    for (const layer of layers) {
      expect(layer.aggregate).toBeUndefined();
    }
    // Standard per-member layer shape: ids, offsets, entity indices.
    expect(layers[0].datasetId).toBe("img-0");
    expect(layers[0].entityIndex).toBe(0);
    expect(layers[4].offsetX).toBe(1024);
    expect(layers[4].offsetY).toBe(1024);
  });

  it("keeps a LONE tiny member as an individual pass (single small dataset unchanged)", () => {
    const members = rosterGrid(1, 1, 1024);
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.001,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].aggregate).toBeUndefined();
    expect(layers[0].datasetId).toBe("img-0");
  });

  it("caps individual passes at the budget and folds the excess into the aggregate", () => {
    // 600 members all ABOVE the aggregate threshold: without a hard cap
    // the pass count would track member count.
    const zoom = (MEMBER_AGGREGATE_MAX_DIAG_PX + 8) / Math.hypot(1024, 1024);
    const members = rosterGrid(600, 25, 1024);
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom,
    });
    const individual = layers.filter((l) => !l.aggregate);
    const aggregate = layers.filter((l) => l.aggregate);
    expect(individual.length).toBeLessThanOrEqual(MAX_INDIVIDUAL_MEMBER_PASSES);
    expect(aggregate).toHaveLength(1);
    expect(individual.length + aggregate[0].aggregate!.count).toBe(600);
  });

  it("aggregate layer covers the members' union extent with per-member quads", () => {
    const members: MemberRosterEntry[] = [
      { imageId: "img-0", position: [100, 200], entityId: "tile-0" },
      { imageId: "img-1", position: [2148, 200], entityId: "tile-1" },
      { imageId: "img-2", position: [100, 2248], entityId: "tile-2" },
    ];
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "max",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.001,
    });
    expect(layers).toHaveLength(1);
    const layer = layers[0];
    expect(layer.blendMode).toBe("max");
    // Union AABB: x ∈ [100, 2148+1024], y ∈ [200, 2248+1024].
    expect(layer.offsetX).toBe(100);
    expect(layer.offsetY).toBe(200);
    expect(layer.dataW).toBe(2148 + 1024 - 100);
    expect(layer.dataH).toBe(2248 + 1024 - 200);
    const agg = layer.aggregate!;
    expect(agg.count).toBe(3);
    const f32 = new Float32Array(agg.quads);
    const u32 = new Uint32Array(agg.quads);
    // First member: origin of the union → rect starts at (0, 0).
    expect(f32[0]).toBeCloseTo(0);
    expect(f32[1]).toBeCloseTo(0);
    expect(f32[2]).toBeCloseTo(1024 / layer.dataW);
    expect(f32[3]).toBeCloseTo(1024 / layer.dataH);
    expect(u32[4]).toBe(0);
    // Second member: offset (2148 - 100) in x, entity index 1.
    expect(f32[8]).toBeCloseTo((2148 - 100) / layer.dataW);
    expect(u32[12]).toBe(1);
    // Third member: offset (2248 - 200) in y, entity index 2.
    expect(f32[17]).toBeCloseTo((2248 - 200) / layer.dataH);
    expect(u32[20]).toBe(2);
  });

  it("skips members without an entity index (matches the per-member path)", () => {
    const members = rosterGrid(4, 2, 1024);
    const index = indexFor(members, null);
    index.delete("img-3");
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: index,
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.001,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].aggregate!.count).toBe(3);
  });

  it("uses composite member keys per channel in multi-channel mode", () => {
    const members = rosterGrid(50, 10, 1024);
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, 2),
      channel: 2,
      blendMode: "additive",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.001,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].aggregate!.poolMemberId).toBe("img-0:ch2");
    expect(layers[0].blendMode).toBe("additive");
  });

  it("holds the pass cap EXACTLY at the 257-member boundary (folds two, never unfolds past the cap)", () => {
    // One member over the cap, all above the size threshold. Unfolding the
    // lone overflow member (aggregation "needs 2 to engage") would emit 257
    // individual passes — the cap must instead fold a second member so the
    // budget holds: 255 individual + 1 aggregate of 2 = 256 layers.
    const zoom = (MEMBER_AGGREGATE_MAX_DIAG_PX + 8) / Math.hypot(1024, 1024);
    const members = rosterGrid(MAX_INDIVIDUAL_MEMBER_PASSES + 1, 20, 1024);
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom,
    });
    const individual = layers.filter((l) => !l.aggregate);
    const aggregate = layers.filter((l) => l.aggregate);
    expect(individual.length).toBeLessThanOrEqual(MAX_INDIVIDUAL_MEMBER_PASSES);
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0].aggregate!.count).toBe(2);
    expect(layers.length).toBe(MAX_INDIVIDUAL_MEMBER_PASSES);
    expect(individual.length + aggregate[0].aggregate!.count)
      .toBe(MAX_INDIVIDUAL_MEMBER_PASSES + 1);
  });

  it("culls zero-extent members instead of falling back to unbounded per-member passes", () => {
    const members: MemberRosterEntry[] = [];
    for (let i = 0; i < 5000; i++) {
      members.push({
        imageId: `img-${i}`,
        position: [0, 0],
        entityId: `tile-${i}`,
        dataW: 0,
        dataH: 0,
      });
    }
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.001,
    });
    expect(layers).toHaveLength(0);
  });

  it("excludes zero-extent members from an otherwise valid aggregate", () => {
    const members = rosterGrid(5, 5, 1024);
    members.push(
      { imageId: "img-flat-0", position: [0, 4096], entityId: "tile-flat-0", dataW: 0, dataH: 512 },
      { imageId: "img-flat-1", position: [512, 4096], entityId: "tile-flat-1", dataW: 512, dataH: 0 },
      { imageId: "img-flat-2", position: [1024, 4096], entityId: "tile-flat-2", dataW: 0, dataH: 0 },
    );
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.001,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].aggregate!.count).toBe(5);
  });

  it("folds cap overflow in roster order so aggregate quad z-order is stable", () => {
    // Sizes INCREASE with roster index, so the overflow (smallest) members
    // are roster indices 0..3. Their quads must appear in roster order —
    // not size order — because quad order is the aggregate's draw order.
    const members: MemberRosterEntry[] = [];
    const n = MAX_INDIVIDUAL_MEMBER_PASSES + 4;
    for (let i = 0; i < n; i++) {
      members.push({
        imageId: `img-${i}`,
        position: [(i % 20) * 4096, Math.floor(i / 20) * 4096],
        entityId: `tile-${i}`,
        dataW: 1000 + i * 4,
        dataH: 1000 + i * 4,
      });
    }
    const layers: SliceLayerParams[] = [];
    pushMemberLayers(layers, {
      members,
      indexByMember: indexFor(members, null),
      channel: null,
      blendMode: "alpha",
      fullResWidth: 1024,
      fullResHeight: 1024,
      zoom: 0.03, // smallest diag ≈ 42 px — everyone above the threshold
    });
    const agg = layers.find((l) => l.aggregate);
    expect(agg).toBeDefined();
    expect(agg!.aggregate!.count).toBe(4);
    const u32 = new Uint32Array(agg!.aggregate!.quads);
    const entityOrder = [0, 1, 2, 3].map((i) => u32[i * 8 + 4]);
    expect(entityOrder).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// sliceBackingScale — bounded render-resolution fallback
// ---------------------------------------------------------------------------

describe("sliceBackingScale", () => {
  it("leaves ordinary backings (including 800×600 CSS at DPR 2) at full resolution", () => {
    expect(sliceBackingScale(800, 600)).toBe(1);
    expect(sliceBackingScale(1600, 1200)).toBe(1);
    expect(sliceBackingScale(3840, 2160)).toBe(1);
  });

  it("scales an oversized backing down to the pixel cap", () => {
    const s = sliceBackingScale(6000, 4000);
    expect(s).toBeLessThan(1);
    expect(6000 * s * (4000 * s)).toBeLessThanOrEqual(MAX_SLICE_BACKING_PIXELS + 1);
  });
});

// ---------------------------------------------------------------------------
// tickSlice → posted sliceRenderMultiPass (the render-message seam)
// ---------------------------------------------------------------------------

interface SeamHarness {
  ctx: TickContext;
  tickCoordinator: TickCoordinator;
  uploader: Uploader;
  posted: () => {
    layers: SliceLayerParams[];
    zoom: number;
    canvasW: number;
    canvasH: number;
  };
  resize: ReturnType<typeof vi.fn>;
}

function makeSeamHarness(opts: {
  memberCount: number;
  zoom: number;
  clientWidth?: number;
  clientHeight?: number;
}): SeamHarness {
  const members = rosterGrid(opts.memberCount, 100, 1024);
  const orchResult: TickCoordinatorResult = {
    memberRoster: new Map([["ds1", members]]),
    memberPositionsByDataset: new Map([
      ["ds1", Object.fromEntries(members.map((m) => [m.imageId, m.position]))],
    ]),
    settings: {
      layerOrder: ["ds1"],
      allSettings: {
        ds1: {
          visible: true,
          opacity: 1,
          contrast_min: 0,
          contrast_max: 65535,
          gamma: 1,
          blend_mode: "alpha",
          channel_settings: [],
          channel_blend_mode: "additive",
        },
      },
    },
    multiChannel: false,
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    entityIndexByDataset: new Map([["ds1", indexFor(members, null)]]),
  };
  const tickCoordinator = {
    planAndFetch: vi.fn(() => orchResult),
  } as unknown as TickCoordinator;
  const uploader = { deliverToWorker: vi.fn(() => false) } as unknown as Uploader;

  const sliceRenderMultiPass = vi.fn();
  const resize = vi.fn();
  const scene = {
    set_z: vi.fn(),
    set_t: vi.fn(),
    set_c: vi.fn(),
    set_viewport: vi.fn(),
    zoom: () => opts.zoom,
    center: () => new Float32Array([512, 512]),
    epochs: () => JSON.stringify({ content: 1, layout: 1, view: 1, selection: 1 }),
  };
  const manifest = {
    dataset_id: "ds1",
    name: "test",
    kind: "Single",
    entities: [],
    transforms: [],
    source_layouts: [],
    default_layout_id: null,
    images: [
      {
        image_id: "img-0",
        owner: "tile-0",
        multiscale: {
          axes: [],
          data_type: "uint16",
          levels: [
            {
              level_index: 0,
              shape: [1, 1, 1, 1024, 1024],
              chunk_shape: [1, 1, 1, 256, 256],
              grid_shape: [1, 1, 1, 4, 4],
              scale: [1, 1, 1, 1, 1],
            },
          ],
        },
      },
    ],
  };
  const ctx = {
    scene,
    datasets: new Map([["ds1", { manifest }]]),
    client: { resize, sliceRenderMultiPass },
    canvas: {
      clientWidth: opts.clientWidth ?? 800,
      clientHeight: opts.clientHeight ?? 600,
    },
    mode: "slice",
    renderScale: 1,
  } as unknown as TickContext;

  return {
    ctx,
    tickCoordinator,
    uploader,
    posted: () => {
      expect(sliceRenderMultiPass).toHaveBeenCalled();
      const call = sliceRenderMultiPass.mock.calls.at(-1)!;
      return { layers: call[0], zoom: call[1], canvasW: call[4], canvasH: call[5] };
    },
    resize,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tickSlice render-message seam", () => {
  it("posts a bounded layer count at overview zoom on a wide synthetic collection", () => {
    const h = makeSeamHarness({ memberCount: 5000, zoom: 0.0005 });
    tickSlice(h.ctx, h.tickCoordinator, h.uploader, 0, 0, 0, new Map());
    const { layers } = h.posted();
    expect(layers.length).toBeLessThanOrEqual(MAX_INDIVIDUAL_MEMBER_PASSES + 1);
    // Aggregate coverage: the single aggregate layer carries every member.
    const agg = layers.filter((l) => l.aggregate);
    expect(agg).toHaveLength(1);
    expect(agg[0].aggregate!.count).toBe(5000);
  });

  it("posts per-member layers for a small collection at close-up zoom", () => {
    const h = makeSeamHarness({ memberCount: 6, zoom: 1 });
    tickSlice(h.ctx, h.tickCoordinator, h.uploader, 0, 0, 0, new Map());
    const { layers } = h.posted();
    expect(layers).toHaveLength(6);
    for (const layer of layers) expect(layer.aggregate).toBeUndefined();
  });

  it("clamps the backing resolution at high DPR instead of rendering an unbounded target", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const h = makeSeamHarness({
      memberCount: 6,
      zoom: 1,
      clientWidth: 3000,
      clientHeight: 2000,
    });
    tickSlice(h.ctx, h.tickCoordinator, h.uploader, 0, 0, 0, new Map());
    const { zoom, canvasW, canvasH } = h.posted();
    expect(canvasW * canvasH).toBeLessThanOrEqual(MAX_SLICE_BACKING_PIXELS * 1.01);
    // The logical 3000 CSS-pixel viewport still spans 3000 world units.
    expect(canvasW / zoom).toBeCloseTo(3000 / 1, 0);
    // The presented canvas is resized to the same clamped backing.
    expect(h.resize).toHaveBeenCalledWith(canvasW, canvasH, "slice");
    // Planning sees the canonical CSS-logical viewport, independent of DPR.
    expect((h.ctx.scene as unknown as { set_viewport: ReturnType<typeof vi.fn> }).set_viewport)
      .toHaveBeenCalledWith(3000, 2000);
  });

  it("keeps full backing at DPR 2 for the fixed-size canvas (no needless degrade)", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const h = makeSeamHarness({ memberCount: 6, zoom: 1 });
    tickSlice(h.ctx, h.tickCoordinator, h.uploader, 0, 0, 0, new Map());
    const { canvasW, canvasH, zoom } = h.posted();
    expect(canvasW).toBe(1600);
    expect(canvasH).toBe(1200);
    expect(zoom).toBe(2);
  });

  it("keeps planning, aggregate crossover, and CSS field of view identical across DPR", () => {
    vi.stubGlobal("devicePixelRatio", 1);
    const dpr1 = makeSeamHarness({ memberCount: 11, zoom: 0.02 });
    tickSlice(dpr1.ctx, dpr1.tickCoordinator, dpr1.uploader, 0, 0, 0, new Map());
    const first = dpr1.posted();

    vi.stubGlobal("devicePixelRatio", 2);
    const dpr2 = makeSeamHarness({ memberCount: 11, zoom: 0.02 });
    tickSlice(dpr2.ctx, dpr2.tickCoordinator, dpr2.uploader, 0, 0, 0, new Map());
    const second = dpr2.posted();

    expect((dpr1.ctx.scene as unknown as { set_viewport: ReturnType<typeof vi.fn> }).set_viewport)
      .toHaveBeenCalledWith(800, 600);
    expect((dpr2.ctx.scene as unknown as { set_viewport: ReturnType<typeof vi.fn> }).set_viewport)
      .toHaveBeenCalledWith(800, 600);
    expect(second.layers.map((layer) => layer.aggregate?.count ?? layer.datasetId))
      .toEqual(first.layers.map((layer) => layer.aggregate?.count ?? layer.datasetId));
    expect(second.canvasW * second.canvasH).toBe(first.canvasW * first.canvasH * 4);
    expect(first.canvasW / first.zoom).toBeCloseTo(second.canvasW / second.zoom, 10);
  });
});
