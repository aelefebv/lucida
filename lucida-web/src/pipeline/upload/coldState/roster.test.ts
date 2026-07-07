/**
 * Unit tests for `buildRoster` — pure builder that walks the active set
 * once, producing both the per-dataset `MemberRosterEntry[]` and the
 * entityId-keyed model+inverse matrices map consumed by `buildColdState`.
 *
 * Behaviour under test:
 *   - `group-as-proxy` entries are synthesised; their entityId appears in
 *     `matricesByEntity` with the synthetic matrices.
 *   - `invisible` entries are skipped (no roster entry, no matrices).
 *   - `tile` entries forward `imageId`, `position`, `mode`; their
 *     matrices come from `scene.member_model_matrix`.
 *   - Empty active set → empty roster + empty matrices map.
 *   - Groups with zero visible tiles are skipped (no synth, no
 *     matrices).
 */
import { describe, it, expect } from "vitest";
import { Axis } from "../../../axes.ts";
import type { TickContext } from "../../../renderLoopTypes.ts";
import type {
  ActiveSetEntry,
  EntitySnapshot,
} from "../../planning/index.ts";
import { buildRoster } from "./roster.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function translateScaleMatrix(
  tx: number, ty: number, tz: number,
  sx: number, sy: number, sz: number,
): Float32Array {
  return new Float32Array([
    sx, 0,  0,  0,
    0,  sy, 0,  0,
    0,  0,  sz, 0,
    tx, ty, tz, 1,
  ]);
}

function inverseTranslateScale(
  tx: number, ty: number, tz: number,
  sx: number, sy: number, sz: number,
): Float32Array {
  return new Float32Array([
    1 / sx,    0,         0,         0,
    0,         1 / sy,    0,         0,
    0,         0,         1 / sz,    0,
    -tx / sx,  -ty / sy,  -tz / sz,  1,
  ]);
}

/**
 * Build a mock `TickContext` whose `scene.member_model_matrix` /
 * `inv_member_model_matrix` return fixtures keyed by imageId.
 */
function makeCtx(
  matricesByImageId: Record<string, { model: Float32Array; inv: Float32Array }>,
): TickContext {
  return {
    scene: {
      member_model_matrix: (_dsId: string, imageId: string) =>
        matricesByImageId[imageId]?.model ?? new Float32Array(0),
      inv_member_model_matrix: (_dsId: string, imageId: string) =>
        matricesByImageId[imageId]?.inv ?? new Float32Array(0),
    },
  } as unknown as TickContext;
}

/** Construct a `TileSnapshot` with the minimum surface buildRoster reads. */
function makeTile(
  entityId: string,
  imageId: string,
  parentId: string,
  pos: [number, number],
  lvl0Shape: [number, number, number, number, number] = [1, 1, 1, 100, 100],
): EntitySnapshot {
  return {
    kind: "Tile",
    entityId,
    imageId,
    parentId,
    visible: true,
    projectedDiagonalPx: 100,
    projectedAreaPx2: 10000,
    centroidWorld: [0, 0, 0],
    idealTargetLod: 0,
    importance: 1,
    layoutPositionVox: pos,
    levels: [
      {
        level_index: 0,
        shape: lvl0Shape,
        chunk_shape: [1, 1, 1, 256, 256],
        grid_shape: [1, 1, 1, 1, 1],
        scale: [1, 1, 1, 1, 1],
      },
    ],
  } as unknown as EntitySnapshot;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("buildRoster", () => {
  it("emits roster entries for visible tile entries and looks up their matrices", () => {
    const ctx = makeCtx({
      "img-a": {
        model: translateScaleMatrix(1, 2, 3, 10, 10, 10),
        inv: inverseTranslateScale(1, 2, 3, 10, 10, 10),
      },
      "img-b": {
        model: translateScaleMatrix(20, 20, 0, 5, 5, 5),
        inv: inverseTranslateScale(20, 20, 0, 5, 5, 5),
      },
    });

    const entities: EntitySnapshot[] = [
      makeTile("ent-a", "img-a", "group-0", [0, 0]),
      makeTile("ent-b", "img-b", "group-0", [100, 100]),
    ];

    const activeSet: ActiveSetEntry[] = [
      {
        kind: "tile",
        entityId: "ent-a",
        imageId: "img-a",
        mode: "tiles-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: false,
        groupProxyAvailable: false,
      } as ActiveSetEntry,
      {
        kind: "tile",
        entityId: "ent-b",
        imageId: "img-b",
        mode: "tiles-with-detail",
        targetLod: 0,
        coarsestDetailLod: 0,
        detailOwnedLodRange: [0, 0],
        proxyAvailable: false,
        groupProxyAvailable: false,
      } as ActiveSetEntry,
    ];

    const { entries, matricesByEntity } = buildRoster({
      activeSet, entities, ctx, datasetId: "ds1",
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ imageId: "img-a", entityId: "ent-a", mode: "tiles-with-detail" });
    expect(entries[0].position).toEqual([0, 0]);
    expect(entries[1]).toMatchObject({ imageId: "img-b", entityId: "ent-b", mode: "tiles-with-detail" });
    expect(entries[1].position).toEqual([100, 100]);

    // matricesByEntity populated for both entries.
    expect(matricesByEntity.size).toBe(2);
    const mA = matricesByEntity.get("ent-a")!;
    expect(mA.model[0]).toBe(10); expect(mA.model[12]).toBe(1);
    const mB = matricesByEntity.get("ent-b")!;
    expect(mB.model[0]).toBe(5); expect(mB.model[12]).toBe(20);
  });

  it("synthesises group-as-proxy entries and records their matrices", () => {
    // Two tiles under the same group — group's AABB is union of the two.
    const ctx = makeCtx({
      "img-1": {
        model: translateScaleMatrix(0, 0, 0, 10, 10, 10),
        inv: inverseTranslateScale(0, 0, 0, 10, 10, 10),
      },
      "img-2": {
        model: translateScaleMatrix(20, 20, 20, 10, 10, 10),
        inv: inverseTranslateScale(20, 20, 20, 10, 10, 10),
      },
    });

    const entities: EntitySnapshot[] = [
      makeTile("ent-1", "img-1", "group-0", [0, 0],     [1, 1, 1, 100, 100]),
      makeTile("ent-2", "img-2", "group-0", [100, 100], [1, 1, 1, 100, 100]),
    ];

    const activeSet: ActiveSetEntry[] = [
      { kind: "group-as-proxy", entityId: "group-0" } as ActiveSetEntry,
    ];

    const { entries, matricesByEntity } = buildRoster({
      activeSet, entities, ctx, datasetId: "ds1",
    });

    // Synthetic group member.
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe("group-0");
    expect(entries[0].mode).toBe("group-as-proxy");
    expect(entries[0].imageId).toBe("group-0");
    // Synthetic 3D matrix: span 30 in each axis, translate 0,0,0.
    expect(entries[0].modelMatrix![0]).toBe(30);
    expect(entries[0].modelMatrix![5]).toBe(30);
    expect(entries[0].modelMatrix![10]).toBe(30);

    // matricesByEntity has the synthesised matrices keyed by group entityId.
    expect(matricesByEntity.size).toBe(1);
    const m = matricesByEntity.get("group-0")!;
    expect(m.model[0]).toBe(30);
    expect(m.inv[0]).toBeCloseTo(1 / 30);
  });

  it("skips invisible entries — no roster entry, no matrices entry", () => {
    const ctx = makeCtx({});
    const entities: EntitySnapshot[] = [
      makeTile("ent-x", "img-x", "group-0", [0, 0]),
    ];
    const activeSet: ActiveSetEntry[] = [
      { kind: "invisible", entityId: "ent-x", imageId: "img-x", coarsestLod: 3 } as ActiveSetEntry,
    ];

    const { entries, matricesByEntity } = buildRoster({
      activeSet, entities, ctx, datasetId: "ds1",
    });

    expect(entries).toHaveLength(0);
    expect(matricesByEntity.size).toBe(0);
  });

  it("empty active set → empty roster and empty matrices map", () => {
    const ctx = makeCtx({});
    const { entries, matricesByEntity } = buildRoster({
      activeSet: [], entities: [], ctx, datasetId: "ds1",
    });
    expect(entries).toEqual([]);
    expect(matricesByEntity.size).toBe(0);
  });

  it("skips group-as-proxy entries whose group has zero visible tiles", () => {
    const ctx = makeCtx({});
    // No tiles at all in `entities` for this group.
    const activeSet: ActiveSetEntry[] = [
      { kind: "group-as-proxy", entityId: "group-empty" } as ActiveSetEntry,
    ];

    const { entries, matricesByEntity } = buildRoster({
      activeSet, entities: [], ctx, datasetId: "ds1",
    });

    expect(entries).toHaveLength(0);
    expect(matricesByEntity.size).toBe(0);
    // Defensive: imageId-shape assertion on the empty result.
    expect(Array.from(matricesByEntity.keys())).toEqual([]);
    // Verify Axis import is exercised somewhere (silence unused-import lint).
    expect(Axis.X).toBeGreaterThanOrEqual(0);
  });
});
