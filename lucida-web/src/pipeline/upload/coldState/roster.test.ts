import { describe, expect, it, vi } from "vitest";
import type { TickContext } from "../../../renderLoopTypes.ts";
import {
  createSyntheticEntity,
  type ActiveSetEntry,
  type EntitySnapshot,
  type TileEntry,
} from "../../planning/index.ts";
import { buildRoster } from "./roster.ts";

function tile(entityId: string, imageId: string): TileEntry {
  return {
    kind: "tile",
    entityId,
    imageId,
    mode: "tiles-with-detail",
    targetLod: 0,
    coarsestDetailLod: 0,
    detailOwnedLodRange: [0, 0],
    detailLevel: 0,
    coarseLevel: null,
    wantedLodLevels: [0],
  };
}

function entity(entityId: string, imageId: string, position: [number, number]): EntitySnapshot {
  return createSyntheticEntity({
    kind: "Image",
    entityId,
    imageId,
    layoutPositionVox: position,
  });
}

function matrix(scale: number): Float32Array {
  const result = new Float32Array(16);
  result[0] = result[5] = result[10] = scale;
  result[15] = 1;
  return result;
}

function context(): TickContext {
  return {
    scene: {
      member_model_matrix: vi.fn((_datasetId: string, imageId: string) =>
        matrix(imageId === "image-a" ? 2 : 3)),
      inv_member_model_matrix: vi.fn((_datasetId: string, imageId: string) =>
        matrix(imageId === "image-a" ? 0.5 : 1 / 3)),
    },
  } as unknown as TickContext;
}

describe("buildRoster", () => {
  it("builds render entries and matrices in one active-set walk", () => {
    const ctx = context();
    const activeSet: ActiveSetEntry[] = [
      tile("entity-a", "image-a"),
      tile("entity-b", "image-b"),
    ];
    const entities = [
      entity("entity-a", "image-a", [10, 20]),
      entity("entity-b", "image-b", [30, 40]),
    ];

    const result = buildRoster({ activeSet, entities, ctx, datasetId: "ds-1" });

    expect(result.entries).toEqual([
      { imageId: "image-a", position: [10, 20], entityId: "entity-a" },
      { imageId: "image-b", position: [30, 40], entityId: "entity-b" },
    ]);
    expect(result.matricesByEntity.get("entity-a")?.model[0]).toBe(2);
    expect(result.matricesByEntity.get("entity-b")?.model[0]).toBe(3);
  });

  it("keeps two images with one owner as distinct roster entries", () => {
    const owner = "shared-owner";
    const result = buildRoster({
      activeSet: [tile(owner, "image-a"), tile(owner, "image-b")],
      entities: [
        entity(owner, "image-a", [10, 20]),
        entity(owner, "image-b", [30, 40]),
      ],
      ctx: context(),
      datasetId: "ds-1",
    });

    expect(result.entries).toEqual([
      { imageId: "image-a", position: [10, 20], entityId: owner },
      { imageId: "image-b", position: [30, 40], entityId: owner },
    ]);
  });

  it("skips invisible and missing entities", () => {
    const activeSet: ActiveSetEntry[] = [
      { kind: "invisible", entityId: "hidden", imageId: "hidden-image", coarsestLod: 0 },
      tile("missing", "missing-image"),
    ];
    const result = buildRoster({
      activeSet,
      entities: [],
      ctx: context(),
      datasetId: "ds-1",
    });
    expect(result.entries).toEqual([]);
    expect(result.matricesByEntity.size).toBe(0);
  });

  it("reuses the caller-owned matrix cache across view rebuilds", () => {
    const ctx = context();
    const cache = new Map<string, { model: Float32Array; inv: Float32Array }>();
    const args = {
      activeSet: [tile("entity-a", "image-a")],
      entities: [entity("entity-a", "image-a", [0, 0])],
      ctx,
      datasetId: "ds-1",
      tileMatrixCache: cache,
    };

    const first = buildRoster(args);
    const second = buildRoster(args);

    expect(first.matricesByEntity.get("entity-a"))
      .toBe(second.matricesByEntity.get("entity-a"));
    expect(ctx.scene.member_model_matrix).toHaveBeenCalledTimes(1);
    expect(ctx.scene.inv_member_model_matrix).toHaveBeenCalledTimes(1);
  });

  it("handles an empty active set", () => {
    const result = buildRoster({
      activeSet: [],
      entities: [],
      ctx: context(),
      datasetId: "ds-1",
    });
    expect(result.entries).toEqual([]);
    expect(result.matricesByEntity.size).toBe(0);
  });
});
