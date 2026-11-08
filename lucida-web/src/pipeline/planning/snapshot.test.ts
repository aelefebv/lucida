import { describe, it, expect } from "vitest";
import type { WasmScene } from "lucida-core";
import type { DatasetManifest, ImageSpec, LevelGeometry } from "../../manifestTypes.ts";
import { resolvedLayer } from "../../resolvedLayerFixtures.ts";
import type { ResolvedLayer } from "../../resolvedLayers.ts";
import type { SceneEpochs } from "../epochs.ts";
import { DEFAULT_PLANNING_CONFIG } from "./config.ts";
import {
  buildPlanningSnapshot,
  resolveCoarseLevel,
  type BuildPlanningSnapshotArgs,
  type SnapshotDatasetEntry,
} from "./snapshot.ts";

// `buildPlanningSnapshot` reads only `view_query`, `member_positions`,
// `visible_region`, and `c() / t() / z()`, so the stub covers just those
// and is cast to `WasmScene`; no WASM bundle is needed.

interface VisibleEntityRow {
  entity_id: string;
  image_id: string;
  kind: "Image" | "Group" | "Tile";
  visible: boolean;
  projected_diagonal_px: number;
  projected_area_px2: number;
  centroid_world: [number, number, number];
  target_level: number;
  level_pinned: boolean;
  importance: number;
}

interface VisibleRegionJson {
  xy_bounds: [number, number, number, number];
  z_range: [number, number];
  effective_zoom: number;
  radius_basis_vox?: number;
  sort_center: [number, number, number] | null;
  frustum_planes: [number, number, number, number][] | null;
}

interface StubSceneConfig {
  visibleEntities: VisibleEntityRow[];
  positions: Record<string, [number, number]>;
  visibleRegion: VisibleRegionJson | null;
  t: number;
  z: number;
}

function makeStubScene(overrides: Partial<StubSceneConfig> = {}): WasmScene {
  const config: StubSceneConfig = {
    visibleEntities: [
      {
        entity_id: "tile-0",
        image_id: "img-0",
        kind: "Tile",
        visible: true,
        projected_diagonal_px: 100,
        projected_area_px2: 10000,
        centroid_world: [10, 20, 30],
        target_level: 2,
        level_pinned: false,
        importance: 0.7,
      },
    ],
    positions: { "tile-0": [256, 512] },
    visibleRegion: {
      xy_bounds: [0, 0, 1024, 1024],
      z_range: [0, 1],
      effective_zoom: 1.0,
      sort_center: null,
      frustum_planes: null,
    },
    t: 0,
    z: 0,
    ...overrides,
  };

  const stub = {
    view_query: (_dsId: string) =>
      JSON.stringify({ visible_entities: config.visibleEntities }),
    member_positions: (_dsId: string) => JSON.stringify(config.positions),
    visible_region: (_dsId: string) =>
      config.visibleRegion === null ? "null" : JSON.stringify(config.visibleRegion),
    t: () => config.t,
    z: () => config.z,
    epochs: () =>
      JSON.stringify({ content: 1, layout: 1, view: 1, selection: 1 }),
  };
  return stub as unknown as WasmScene;
}

function makeLevels(): LevelGeometry[] {
  return [
    {
      level_index: 0,
      shape: [1, 1, 1, 1024, 1024],
      chunk_shape: [1, 1, 1, 256, 256],
      grid_shape: [1, 1, 1, 4, 4],
      scale: [1, 1, 1, 1, 1],
    },
    {
      level_index: 1,
      shape: [1, 1, 1, 512, 512],
      chunk_shape: [1, 1, 1, 256, 256],
      grid_shape: [1, 1, 1, 2, 2],
      scale: [1, 1, 1, 2, 2],
    },
  ];
}

function makeImageSpec(imageId: string, overrides?: Partial<ImageSpec["multiscale"]>): ImageSpec {
  return {
    image_id: imageId,
    owner: imageId,
    multiscale: { axes: [], data_type: "uint16", levels: makeLevels(), ...overrides },
  };
}

function makeDataset(
  overrides?: Partial<DatasetManifest>,
): SnapshotDatasetEntry {
  const manifest: DatasetManifest = {
    dataset_id: "ds1",
    name: "test",
    kind: "Single",
    // The default stub scene returns `tile-0` as a Tile, so the
    // default manifest must carry the matching parent edge or
    // `buildPlanningSnapshot` throws. Tests that exercise the
    // missing-edge throw branch override `entities` with `[]`.
    entities: [
      { id: "group-0", kind: "Group", parent: null, labels: {} },
      { id: "tile-0", kind: "Tile", parent: "group-0", labels: {} },
    ],
    transforms: [],
    images: [makeImageSpec("img-0")],
    source_layouts: [],
    default_layout_id: null,
    ...overrides,
  } as DatasetManifest;
  return { manifest };
}


function makeEpochs(): SceneEpochs {
  return { content: 1, layout: 1, view: 1, selection: 1, request: 0 };
}

interface MakeArgsOverrides {
  scene?: WasmScene;
  dataset?: SnapshotDatasetEntry;
  layer?: ResolvedLayer | undefined;
  mode?: "slice" | "volume";
}

function makeArgs(overrides?: MakeArgsOverrides): BuildPlanningSnapshotArgs {
  return {
    scene: overrides?.scene ?? makeStubScene(),
    datasetId: "ds1",
    dataset: overrides?.dataset ?? makeDataset(),
    layer: overrides && "layer" in overrides ? overrides.layer : resolvedLayer("ds1"),
    minimapPending: new Map(),
    mode: overrides?.mode ?? "slice",
    currentEpochs: makeEpochs(),
    requestEpoch: 0,
    config: DEFAULT_PLANNING_CONFIG,
  };
}

describe("buildPlanningSnapshot — typical case", () => {
  it("produces an EntitySnapshot joined with manifest data", () => {
    const built = buildPlanningSnapshot(makeArgs());
    expect(built).not.toBeNull();
    const { snapshot, entities } = built!;
    expect(entities).toHaveLength(1);
    expect(entities[0].entityId).toBe("tile-0");
    expect(entities[0].imageId).toBe("img-0");
    expect(entities[0].kind).toBe("Tile");
    expect(entities[0].levels).toHaveLength(2);
    expect(entities[0].layoutPositionVox).toEqual([256, 512]);
    // Snapshot embeds the same entities as a freshly-built array.
    expect(snapshot.entities).toBe(entities);
  });

  it("returns null when view_query has no visible entities", () => {
    const scene = makeStubScene({ visibleEntities: [] });
    // visible_entities present but empty array → still a list, not missing.
    // To exercise the null-payload branch we need view_query to omit the
    // tile entirely.
    const stub = {
      ...(scene as unknown as Record<string, unknown>),
      view_query: () => JSON.stringify(null),
    } as unknown as WasmScene;
    const built = buildPlanningSnapshot(makeArgs({ scene: stub }));
    expect(built).toBeNull();
  });
});

describe("buildPlanningSnapshot — snake_case → camelCase", () => {
  it("renames every wire tile to its camelCase counterpart", () => {
    const scene = makeStubScene({
      visibleEntities: [
        {
          entity_id: "img-7",
          image_id: "img-7",
          kind: "Image",
          visible: true,
          projected_diagonal_px: 234.5,
          projected_area_px2: 5678,
          centroid_world: [1, 2, 3],
          target_level: 1,
          level_pinned: false,
          importance: 0.42,
        },
      ],
      positions: { "img-7": [11, 22] },
    });
    const dataset = makeDataset({ images: [makeImageSpec("img-7")] });
    const built = buildPlanningSnapshot(makeArgs({ scene, dataset }));
    const e = built!.entities[0];
    expect(e.entityId).toBe("img-7");
    expect(e.imageId).toBe("img-7");
    expect(e.projectedDiagonalPx).toBe(234.5);
    expect(e.projectedAreaPx2).toBe(5678);
    expect(e.centroidWorld).toEqual([1, 2, 3]);
    expect(e.targetLevel).toBe(1);
    expect(e.importance).toBeCloseTo(0.42);
  });
});

describe("buildPlanningSnapshot — parent-id stitching", () => {
  it("populates parentId for tiles with a manifest parent edge", () => {
    const scene = makeStubScene({
      visibleEntities: [
        {
          entity_id: "tile-A",
          image_id: "img-A",
          kind: "Tile",
          visible: true,
          projected_diagonal_px: 90,
          projected_area_px2: 9000,
          centroid_world: [0, 0, 0],
          target_level: 0,
          level_pinned: false,
          importance: 1,
        },
      ],
      positions: { "tile-A": [0, 0] },
    });
    const dataset = makeDataset({
      images: [makeImageSpec("img-A")],
      entities: [
        { id: "group-1", kind: "Group", parent: null, labels: {} },
        { id: "tile-A", kind: "Tile", parent: "group-1", labels: {} },
      ],
    });
    const built = buildPlanningSnapshot(makeArgs({ scene, dataset }));
    const ent = built!.entities[0];
    // Narrow on `kind === "Tile"` to read parentId.
    expect(ent.kind).toBe("Tile");
    if (ent.kind === "Tile") {
      expect(ent.parentId).toBe("group-1");
    }
  });

  it("throws when a Tile-kind entity has no manifest parent edge", () => {
    // A Tile without a parent is an invariant violation; the
    // builder surfaces it explicitly rather than silently coercing
    // to null. Override the dataset to drop the parent edge for the
    // default `tile-0` scene entity.
    const dataset = makeDataset({ entities: [] });
    expect(() =>
      buildPlanningSnapshot(makeArgs({ dataset })),
    ).toThrow(/TileSnapshot\.parentId is required/);
  });

  it("Image and Group variants do not declare a parentId tile", () => {
    // Sanity check: the snake_case→camelCase translator branches on
    // `kind` and the resulting object is the matching variant.
    const scene = makeStubScene({
      visibleEntities: [
        {
          entity_id: "img-7",
          image_id: "img-7",
          kind: "Image",
          visible: true,
          projected_diagonal_px: 100,
          projected_area_px2: 10000,
          centroid_world: [0, 0, 0],
          target_level: 0,
          level_pinned: false,
          importance: 1,
        },
      ],
      positions: { "img-7": [0, 0] },
    });
    const dataset = makeDataset({ images: [makeImageSpec("img-7")] });
    const built = buildPlanningSnapshot(makeArgs({ scene, dataset }));
    const ent = built!.entities[0];
    expect(ent.kind).toBe("Image");
    // No `parentId` key on Image / Group variants — confirm absence
    // structurally so future regressions surface here.
    expect(Object.prototype.hasOwnProperty.call(ent, "parentId")).toBe(false);
  });
});

describe("buildPlanningSnapshot — visible region fallback", () => {
  it("falls back to the default region when scene.visible_region returns null", () => {
    const scene = makeStubScene({ visibleRegion: null });
    const built = buildPlanningSnapshot(makeArgs({ scene }));
    expect(built!.visibleRegion).toEqual({
      xyBoundsVox: [0, 0, 1024, 1024],
      zRangeVox: [0, 1],
      effectiveZoom: 1,
      sortCenterVox: null,
      frustumPlanes: null,
    });
  });

  it("translates a populated visible region into camelCase", () => {
    const scene = makeStubScene({
      visibleRegion: {
        xy_bounds: [10, 20, 30, 40],
        z_range: [5, 6],
        effective_zoom: 2.5,
        radius_basis_vox: 12.5,
        sort_center: [1, 2, 3],
        frustum_planes: [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
      },
    });
    const built = buildPlanningSnapshot(makeArgs({ scene }));
    expect(built!.visibleRegion).toEqual({
      xyBoundsVox: [10, 20, 30, 40],
      zRangeVox: [5, 6],
      effectiveZoom: 2.5,
      radiusBasisVox: 12.5,
      sortCenterVox: [1, 2, 3],
      frustumPlanes: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
    });
  });
});

describe("buildPlanningSnapshot — selection state", () => {
  it("plans the channels the resolved layer shows", () => {
    const built = buildPlanningSnapshot(
      makeArgs({ layer: resolvedLayer("ds1", [0, 2]) }),
    );
    expect(built!.selection.visibleChannels).toEqual([0, 2]);
  });

  it("plans a solo's one channel", () => {
    const built = buildPlanningSnapshot(
      makeArgs({ layer: resolvedLayer("ds1", [3], { solo: 3, channel_count: 4 }) }),
    );
    expect(built!.selection.visibleChannels).toEqual([3]);
  });

  it("plans the layer's clamped t and z, not the scene's", () => {
    const scene = makeStubScene();
    const layer = resolvedLayer("ds1", [0], {
      t: 1, z_range: { start: 4, end: 5 }, t_clamped: true, z_clamped: true,
    });
    const built = buildPlanningSnapshot(makeArgs({ scene, layer }));
    expect(built!.selection.t).toBe(1);
    expect(built!.selection.z).toBe(4);
  });

  it("falls back to channel 0 at the scene's selectors for a layer the scene lacks", () => {
    const built = buildPlanningSnapshot(makeArgs({ layer: undefined }));
    expect(built!.selection.visibleChannels).toEqual([0]);
  });

  it("threads renderMode from the args mode tile", () => {
    const builtSlice = buildPlanningSnapshot(makeArgs({ mode: "slice" }));
    const builtVolume = buildPlanningSnapshot(makeArgs({ mode: "volume" }));
    expect(builtSlice!.selection.renderMode).toBe("slice");
    expect(builtVolume!.selection.renderMode).toBe("volume");
  });

  it("interactionState is always idle", () => {
    const built = buildPlanningSnapshot(makeArgs());
    expect(built!.selection.interactionState).toBe("idle");
  });
});

describe("buildPlanningSnapshot — pass-through tiles", () => {

  it("threads the epoch counters through into the snapshot", () => {
    const built = buildPlanningSnapshot(makeArgs());
    expect(built!.snapshot.epochs).toEqual(makeEpochs());
  });

  it("returns the same visibleRegion object embedded in the snapshot", () => {
    const built = buildPlanningSnapshot(makeArgs());
    expect(built!.snapshot.visibleRegion).toBe(built!.visibleRegion);
  });
});

describe("buildPlanningSnapshot — target level", () => {
  function sceneAtScreenLevel(screenLevel: number): WasmScene {
    return makeStubScene({
      visibleEntities: [
        {
          entity_id: "tile-0",
          image_id: "img-0",
          kind: "Tile",
          visible: true,
          projected_diagonal_px: 100,
          projected_area_px2: 10000,
          centroid_world: [10, 20, 30],
          target_level: screenLevel,
          level_pinned: false,
          importance: 0.7,
        },
      ],
    });
  }

  it("reads the target level the core reports, pin folded in, and clamps nothing", () => {
    // The browser neither applies the pin nor clamps. Level 7 is one the
    // two-level manifest lacks.
    for (const level of [0, 1, 7]) {
      expect(
        buildPlanningSnapshot(makeArgs({ scene: sceneAtScreenLevel(level) }))!.entities[0]
          .targetLevel,
      ).toBe(level);
    }
  });

  it("uses an explicit valid coarse pointer", () => {
    const dataset = makeDataset({
      images: [makeImageSpec("img-0", { coarse_level_index: 1 })],
    });
    const built = buildPlanningSnapshot(makeArgs({ dataset }));
    expect(built!.entities[0].coarseLevel).toBe(1);
  });

  it("does not guess a coarse level when metadata omits the pointer", () => {
    const built = buildPlanningSnapshot(makeArgs());
    expect(built!.entities[0].coarseLevel).toBeNull();
  });

  it("does not use an invalid coarse pointer", () => {
    const img = makeImageSpec("img-0", { coarse_level_index: 99 });
    expect(resolveCoarseLevel(img)).toBeNull();
  });
});

describe("buildPlanningSnapshot — minimapPending tile", () => {
  it("threads a non-empty minimapPending through into the snapshot unchanged", () => {
    const minimapPending = new Map([
      [
        "img-0",
        [{ level: 0, x: 0, y: 0, z: 0, t: 0, c: 0, key: "0/0/0/0/0/0" }],
      ],
    ]);
    const built = buildPlanningSnapshot({
      ...makeArgs(),
      minimapPending,
    });
    expect(built).not.toBeNull();
    // The slot is on the snapshot so `plan()`'s `emitMinimapLane` can read it.
    expect(built!.snapshot.minimapPending).toBe(minimapPending);
    expect(built!.snapshot.minimapPending.get("img-0")).toEqual([
      { level: 0, x: 0, y: 0, z: 0, t: 0, c: 0, key: "0/0/0/0/0/0" },
    ]);
  });

  it("empty minimapPending is forwarded as an empty map", () => {
    const empty = new Map();
    const built = buildPlanningSnapshot({
      ...makeArgs(),
      minimapPending: empty,
    });
    expect(built!.snapshot.minimapPending).toBe(empty);
    expect(built!.snapshot.minimapPending.size).toBe(0);
  });
});

describe("buildPlanningSnapshot — purity", () => {
  it("produces identical output across two calls with identical inputs", () => {
    const args = makeArgs();
    const a = buildPlanningSnapshot(args)!;
    const b = buildPlanningSnapshot(args)!;
    // Different object references, identical wire-shape content.
    expect(JSON.stringify(a.snapshot.entities)).toBe(
      JSON.stringify(b.snapshot.entities),
    );
    expect(a.snapshot.visibleRegion).toEqual(b.snapshot.visibleRegion);
    expect(a.snapshot.selection).toEqual(b.snapshot.selection);
  });
});
