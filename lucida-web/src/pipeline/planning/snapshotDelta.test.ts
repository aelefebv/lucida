import { describe, it, expect } from "vitest";
import type { ImageSpec, LevelGeometry } from "../../manifestTypes.ts";
import type { DatasetSettings } from "../../tickCommon.ts";
import type { EntitySnapshot } from "./types.ts";
import {
  applyViewQueryDelta,
  makeEntitySnapshot,
  type SnapshotEntityDeps,
  type ViewQueryDeltaJson,
  type ViewQueryEntityJson,
} from "./snapshotDelta.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeImageSpec(imageId: string): ImageSpec {
  return {
    image_id: imageId,
    owner: imageId,
    multiscale: { axes: [], data_type: "uint16", levels: makeLevels() },
  } as ImageSpec;
}

function makeDsSettings(overrides?: Partial<DatasetSettings>): DatasetSettings {
  return {
    visible: true,
    opacity: 1,
    contrast_min: 0,
    contrast_max: 1,
    gamma: 1,
    blend_mode: "alpha",
    channel_settings: [],
    channel_blend_mode: "additive",
    ...overrides,
  };
}

function row(overrides: Partial<ViewQueryEntityJson> = {}): ViewQueryEntityJson {
  return {
    entity_id: "e-0",
    image_id: "img-0",
    kind: "Image",
    visible: true,
    projected_diagonal_px: 100,
    projected_area_px2: 10000,
    centroid_world: [0, 0, 0],
    target_level: 0,
    importance: 1,
    ...overrides,
  };
}

/** Deps for a dataset whose images are all `Image` kind (no parent edges). */
function makeDeps(
  imageIds: string[],
  dsSettings?: DatasetSettings,
): SnapshotEntityDeps {
  const imageSpecById = new Map<string, ImageSpec>();
  for (const id of imageIds) imageSpecById.set(id, makeImageSpec(id));
  return {
    imageSpecById,
    parentByEntityId: new Map<string, string | null>(),
    positions: {},
    dsSettings,
  };
}

function full(rows: ViewQueryEntityJson[]): ViewQueryDeltaJson {
  return {
    Full: {
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 1, request: 0 },
      visible_entities: rows,
    },
  };
}

function delta(
  entered: ViewQueryEntityJson[],
  left: string[],
  changed: ViewQueryEntityJson[],
): ViewQueryDeltaJson {
  return {
    Delta: {
      epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 1, request: 0 },
      entered,
      left,
      changed,
    },
  };
}

/** The render-affecting projection the fold must reconstruct exactly. */
function projection(map: ReadonlyMap<string, EntitySnapshot>) {
  return [...map.entries()]
    .map(([imageId, e]) => ({
      imageId,
      visible: e.visible,
      targetLevel: e.targetLevel,
      kind: e.kind,
      detailLevel: e.detailLevel,
      coarseLevel: e.coarseLevel,
      parentId: e.kind === "Tile" ? e.parentId : null,
    }))
    .sort((a, b) => a.imageId.localeCompare(b.imageId));
}

/** A fresh full build for comparison — the equivalence oracle. */
function freshBuild(
  rows: ViewQueryEntityJson[],
  deps: SnapshotEntityDeps,
): Map<string, EntitySnapshot> {
  const map = new Map<string, EntitySnapshot>();
  for (const r of rows) map.set(r.image_id, makeEntitySnapshot(r, deps));
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyViewQueryDelta — Full", () => {
  it("builds a fresh map keyed by image_id, ignoring any prior", () => {
    const deps = makeDeps(["img-0", "img-1"]);
    const prior = new Map<string, EntitySnapshot>([
      ["stale", makeEntitySnapshot(row({ image_id: "stale" }), makeDeps(["stale"]))],
    ]);
    const next = applyViewQueryDelta(
      prior,
      full([row({ image_id: "img-0" }), row({ image_id: "img-1" })]),
      deps,
    );
    expect([...next.keys()].sort()).toEqual(["img-0", "img-1"]);
    expect(next.has("stale")).toBe(false);
  });

  it("treats prev === null as a fresh Full build", () => {
    const deps = makeDeps(["img-0"]);
    const next = applyViewQueryDelta(null, full([row()]), deps);
    expect(next.get("img-0")?.imageId).toBe("img-0");
  });
});

describe("applyViewQueryDelta — Delta", () => {
  it("deletes left, upserts entered and changed; leaves prev untouched", () => {
    const deps = makeDeps(["img-0", "img-1", "img-2"]);
    const prev = freshBuild([row({ image_id: "img-0" }), row({ image_id: "img-1" })], deps);
    const next = applyViewQueryDelta(
      prev,
      delta(
        [row({ image_id: "img-2", target_level: 3 })],
        ["img-0"],
        [row({ image_id: "img-1", visible: false })],
      ),
      deps,
    );
    expect([...next.keys()].sort()).toEqual(["img-1", "img-2"]);
    expect(next.get("img-1")?.visible).toBe(false);
    expect(next.get("img-2")?.targetLevel).toBe(3);
    // prev is not mutated.
    expect([...prev.keys()].sort()).toEqual(["img-0", "img-1"]);
    expect(prev.get("img-1")?.visible).toBe(true);
  });

  it("throws when folding a Delta with no prior snapshot", () => {
    const deps = makeDeps(["img-0"]);
    expect(() => applyViewQueryDelta(null, delta([row()], [], []), deps)).toThrow();
  });
});

describe("applyViewQueryDelta — keying", () => {
  it("keeps two images of one entity distinct (keyed by image_id, not entity_id)", () => {
    const deps = makeDeps(["img-a", "img-b"]);
    const next = applyViewQueryDelta(
      null,
      full([
        row({ entity_id: "shared", image_id: "img-a", target_level: 1 }),
        row({ entity_id: "shared", image_id: "img-b", target_level: 4 }),
      ]),
      deps,
    );
    expect(next.size).toBe(2);
    expect(next.get("img-a")?.targetLevel).toBe(1);
    expect(next.get("img-b")?.targetLevel).toBe(4);
  });
});

describe("applyViewQueryDelta — equivalence over a sequence", () => {
  it("folding deltas reconstructs the same projection as a fresh full build", () => {
    const deps = makeDeps(["img-0", "img-1", "img-2", "img-3"], makeDsSettings());

    // Step 0 — Full with two images.
    let folded = applyViewQueryDelta(
      null,
      full([row({ image_id: "img-0" }), row({ image_id: "img-1" })]),
      deps,
    );
    let oracleRows = [row({ image_id: "img-0" }), row({ image_id: "img-1" })];
    expect(projection(folded)).toEqual(projection(freshBuild(oracleRows, deps)));

    // Step 1 — img-2 enters, img-0 leaves, img-1 changes LOD.
    folded = applyViewQueryDelta(
      folded,
      delta(
        [row({ image_id: "img-2" })],
        ["img-0"],
        [row({ image_id: "img-1", target_level: 2 })],
      ),
      deps,
    );
    oracleRows = [row({ image_id: "img-1", target_level: 2 }), row({ image_id: "img-2" })];
    expect(projection(folded)).toEqual(projection(freshBuild(oracleRows, deps)));

    // Step 2 — no quantized change (empty delta) — projection holds steady.
    folded = applyViewQueryDelta(folded, delta([], [], []), deps);
    expect(projection(folded)).toEqual(projection(freshBuild(oracleRows, deps)));

    // Step 3 — img-3 enters, img-1 flips visibility, img-2 leaves.
    folded = applyViewQueryDelta(
      folded,
      delta(
        [row({ image_id: "img-3" })],
        ["img-2"],
        [row({ image_id: "img-1", target_level: 2, visible: false })],
      ),
      deps,
    );
    oracleRows = [
      row({ image_id: "img-1", target_level: 2, visible: false }),
      row({ image_id: "img-3" }),
    ];
    expect(projection(folded)).toEqual(projection(freshBuild(oracleRows, deps)));
  });
});

describe("makeEntitySnapshot — Tile parent edge", () => {
  it("throws when a Tile has no parent edge in the manifest", () => {
    const deps: SnapshotEntityDeps = {
      imageSpecById: new Map([["img-0", makeImageSpec("img-0")]]),
      parentByEntityId: new Map(),
      positions: {},
      dsSettings: undefined,
    };
    expect(() => makeEntitySnapshot(row({ kind: "Tile" }), deps)).toThrow(/parent edge/);
  });
});
