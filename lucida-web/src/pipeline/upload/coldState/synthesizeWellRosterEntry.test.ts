/**
 * Tests for `synthesizeWellRosterEntry`.
 *
 * Pure-function tests — no orchestrator state.
 *
 * Contract under test:
 *   - Union the 3D AABB of every child field's `[0,1]^3` cube transformed
 *     by its `member_model_matrix`.
 *   - Union the 2D AABB of every child field's `(layoutPositionVox, lvl0 X/Y)`.
 *   - Return `null` if either AABB is degenerate (zero span on any axis,
 *     no contributing fields, or all matrices were the wrong length).
 *   - On success, the 3D AABB drives `modelMatrix` (scale + translate
 *     mapping `[0,1]^3` → world AABB) and the 2D AABB drives
 *     `position` + `dataW` + `dataH`.
 */
import { describe, it, expect } from "vitest";
import type { TickContext } from "../../../renderLoopTypes.ts";
import type { EntitySnapshot } from "../../planning/index.ts";
import { synthesizeWellRosterEntry } from "./roster.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ctx` whose `scene.member_model_matrix` returns the
 * supplied matrices keyed by `imageId`. Other ctx fields are unused by
 * `synthesizeWellRosterEntry` and are stubbed as `unknown`.
 */
function makeCtx(
  matricesByImageId: Record<string, Float32Array>,
): TickContext {
  return {
    scene: {
      member_model_matrix: (_dsId: string, imageId: string) =>
        matricesByImageId[imageId] ?? new Float32Array(0),
    },
  } as unknown as TickContext;
}

/**
 * Construct a `FieldSnapshot`-shaped object with the minimum surface
 * the helper reads: `imageId`, `layoutPositionVox`, and `levels[0].shape`.
 * Other fields are filled with defensive defaults so the type-erased
 * call site compiles cleanly.
 */
function makeField(
  imageId: string,
  pos: [number, number],
  lvl0Shape: [number, number, number, number, number],
): EntitySnapshot {
  return {
    kind: "Field",
    entityId: imageId,
    imageId,
    parentId: "well-0",
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

/** Column-major 4x4 translate+scale matrix for `[0,1]^3` → `[tx..tx+sx]` etc. */
function translateScaleMatrix(
  tx: number,
  ty: number,
  tz: number,
  sx: number,
  sy: number,
  sz: number,
): Float32Array {
  return new Float32Array([
    sx, 0,  0,  0,
    0,  sy, 0,  0,
    0,  0,  sz, 0,
    tx, ty, tz, 1,
  ]);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("synthesizeWellRosterEntry", () => {
  it("unions 3D AABB and 2D footprint across two visible fields", () => {
    // Field A: 3D cube [0..10] on each axis; 2D footprint origin (0,0) sized 100x100.
    // Field B: 3D cube [20..30] on each axis; 2D footprint origin (100,100) sized 100x100.
    // Expected 3D union: [0..30] on each axis → scale 30, translate (0,0,0).
    // Expected 2D union: position (0,0), dataW=200, dataH=200.
    const ctx = makeCtx({
      "img-a": translateScaleMatrix(0, 0, 0, 10, 10, 10),
      "img-b": translateScaleMatrix(20, 20, 20, 10, 10, 10),
    });
    const fields: EntitySnapshot[] = [
      makeField("img-a", [0, 0],     [1, 1, 1, 100, 100]),
      makeField("img-b", [100, 100], [1, 1, 1, 100, 100]),
    ];

    const result = synthesizeWellRosterEntry(ctx, "ds1", "well-0", fields);

    expect(result).not.toBeNull();
    const r = result!;
    expect(r.entityId).toBe("well-0");
    expect(r.imageId).toBe("well-0");
    expect(r.mode).toBe("well-as-proxy");
    expect(r.position).toEqual([0, 0]);
    expect(r.dataW).toBe(200);
    expect(r.dataH).toBe(200);
    // Column-major scale (diagonal) and translate (last column).
    expect(r.modelMatrix![0]).toBe(30);
    expect(r.modelMatrix![5]).toBe(30);
    expect(r.modelMatrix![10]).toBe(30);
    expect(r.modelMatrix![12]).toBe(0);
    expect(r.modelMatrix![13]).toBe(0);
    expect(r.modelMatrix![14]).toBe(0);
    // Inverse should be reciprocal scale + negated translate / scale.
    expect(r.invModelMatrix![0]).toBeCloseTo(1 / 30);
    expect(r.invModelMatrix![5]).toBeCloseTo(1 / 30);
    expect(r.invModelMatrix![10]).toBeCloseTo(1 / 30);
  });

  it("matches the single field's AABB when only one field is visible", () => {
    // Single field at world translate (5,7,9), scale (4,4,4); 2D origin (10,20).
    // Manifest shape array is TCZYX (Axis.X=4, Axis.Y=3) → with shape
    // [1,1,1,30,40] the helper reads X=40 → dataW=40, Y=30 → dataH=30.
    const ctx = makeCtx({
      "img-only": translateScaleMatrix(5, 7, 9, 4, 4, 4),
    });
    const fields: EntitySnapshot[] = [
      makeField("img-only", [10, 20], [1, 1, 1, 30, 40]),
    ];

    const result = synthesizeWellRosterEntry(ctx, "ds1", "well-0", fields);

    expect(result).not.toBeNull();
    const r = result!;
    expect(r.modelMatrix![0]).toBe(4);
    expect(r.modelMatrix![5]).toBe(4);
    expect(r.modelMatrix![10]).toBe(4);
    expect(r.modelMatrix![12]).toBe(5);
    expect(r.modelMatrix![13]).toBe(7);
    expect(r.modelMatrix![14]).toBe(9);
    expect(r.position).toEqual([10, 20]);
    expect(r.dataW).toBe(40);
    expect(r.dataH).toBe(30);
  });

  it("returns null when no fields are passed (zero visible fields)", () => {
    const ctx = makeCtx({});
    const result = synthesizeWellRosterEntry(ctx, "ds1", "well-0", []);
    expect(result).toBeNull();
  });

  it("returns null when the field's matrix yields a degenerate (zero-span) AABB", () => {
    // Scale 0 on every axis → the 8 corners collapse to the translate
    // → sx === sy === sz === 0 → helper returns null.
    const ctx = makeCtx({
      "img-degen": translateScaleMatrix(5, 5, 5, 0, 0, 0),
    });
    const fields: EntitySnapshot[] = [
      makeField("img-degen", [0, 0], [1, 1, 1, 100, 100]),
    ];

    const result = synthesizeWellRosterEntry(ctx, "ds1", "well-0", fields);
    expect(result).toBeNull();
  });

  it("skips fields whose model matrix has length !== 16", () => {
    // Field A returns a length-9 matrix → skipped (no 3D corners contributed).
    // Field B returns a valid 16-length matrix → drives the 3D AABB alone.
    const ctx = makeCtx({
      "img-bad":  new Float32Array(9),                              // wrong length
      "img-good": translateScaleMatrix(0, 0, 0, 10, 10, 10),        // valid
    });
    const fields: EntitySnapshot[] = [
      makeField("img-bad",  [0, 0],     [1, 1, 1, 100, 100]),
      makeField("img-good", [200, 200], [1, 1, 1, 100, 100]),
    ];

    const result = synthesizeWellRosterEntry(ctx, "ds1", "well-0", fields);

    // 2D still unions both (independent of the matrix length check).
    // 3D only sees img-good → [0..10] on each axis → scale 10, translate 0.
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.modelMatrix![0]).toBe(10);
    expect(r.modelMatrix![5]).toBe(10);
    expect(r.modelMatrix![10]).toBe(10);
    expect(r.modelMatrix![12]).toBe(0);
    // 2D union covers both fields → origin (0,0), span (300, 300).
    expect(r.position).toEqual([0, 0]);
    expect(r.dataW).toBe(300);
    expect(r.dataH).toBe(300);
  });
});
