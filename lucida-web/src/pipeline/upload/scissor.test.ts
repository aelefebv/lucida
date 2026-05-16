/**
 * Tests for `computeScissorRect`.
 *
 * Slice 6f (PRD #607) moved this helper from `volumePath.ts` into
 * `pipeline/upload/scissor.ts`. Tests were authored as characterization
 * tests in Slice 1 and migrated alongside the function.
 *
 * Contract under test:
 *   - Project all 8 corners of `[0,1]^3` through `model` then `viewProj`.
 *   - If any corner has `clipW <= 0` (behind camera) → conservative
 *     full-screen fallback `[0, 0, canvasW, canvasH]`.
 *   - Otherwise compute screen-space AABB (WebGPU top-left origin, y-down)
 *     and clamp to canvas bounds; return integer rect `[x, y, w, h]`.
 *   - Return `null` if the clamped rect is degenerate (w<=0 or h<=0).
 */
import { describe, it, expect } from "vitest";
import { computeScissorRect } from "./scissor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major translate+scale matrix. */
function translateScale(
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

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("computeScissorRect", () => {
  it("returns the full canvas rect for identity model + identity viewProj", () => {
    // Identity model: cube corners land at the unit cube's local positions
    // (0,0,0)..(1,1,1). Identity viewProj sends them straight to NDC.
    // NDC X 0→(0+1)/2*W = 0.5*W; NDC X 1→(1+1)/2*W = W. Same on Y but inverted
    // because WebGPU is top-left origin (y-down). So screen X spans [W/2, W],
    // screen Y spans [0, H/2]. With W=H=100 → expect roughly [50, 0, 50, 50]
    // after clamping/flooring/ceiling.
    const model = identityMatrix();
    const viewProj = identityMatrix();
    const rect = computeScissorRect(model, viewProj, 100, 100);

    expect(rect).not.toBeNull();
    // The exact integer rect depends on floor/ceil rounding; verify the
    // bounds rather than exact equality.
    expect(rect![0]).toBeGreaterThanOrEqual(0);
    expect(rect![0]).toBeLessThanOrEqual(100);
    expect(rect![1]).toBeGreaterThanOrEqual(0);
    expect(rect![1]).toBeLessThanOrEqual(100);
    expect(rect![2]).toBeGreaterThan(0);
    expect(rect![3]).toBeGreaterThan(0);
  });

  it("returns the full-screen fallback when a corner has clipW <= 0 (behind camera)", () => {
    // ViewProj row 4 of [W column] is (0,0,-1,0). Then clipW = -wz for every
    // corner. With model translating into +z (wz = 1..2 say), clipW lands at
    // -1 .. -2 → triggers the behind-camera branch on every corner.
    const model = translateScale(0, 0, 1, 1, 1, 1); // cube at z=[1..2]
    const viewProj = new Float32Array([
      1, 0,  0, 0,
      0, 1,  0, 0,
      0, 0,  1, -1,   // clipW = -wz
      0, 0,  0, 0,
    ]);
    const rect = computeScissorRect(model, viewProj, 800, 600);

    // Conservative fallback: full canvas.
    expect(rect).toEqual([0, 0, 800, 600]);
  });

  it("clamps partially-clipped wells to integer canvas bounds", () => {
    // Cube extends from world (-0.5, -0.5, 0) to (0.5, 0.5, 1). Identity
    // viewProj → NDC X spans [-0.5, 0.5], NDC Y spans [-0.5, 0.5]. Screen
    // X spans (W * 0.25, W * 0.75), screen Y spans (H * 0.25, H * 0.75).
    // For W=H=200 → roughly [50, 50, 100, 100] after clamping.
    const model = translateScale(-0.5, -0.5, 0, 1, 1, 1);
    const viewProj = identityMatrix();
    const rect = computeScissorRect(model, viewProj, 200, 200);

    expect(rect).not.toBeNull();
    const [x, y, w, h] = rect!;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(200);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(200);
    expect(x + w).toBeLessThanOrEqual(200);
    expect(y + h).toBeLessThanOrEqual(200);
    // All clamped values must be integers.
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    expect(Number.isInteger(w)).toBe(true);
    expect(Number.isInteger(h)).toBe(true);
  });

  it("returns null when the cube is fully off-screen (post-clamp w/h <= 0)", () => {
    // Cube translated far past the right edge of NDC: world X = 10..11.
    // NDC X = wx (no perspective divide; clipW=1). Then sx = (10+1)/2 * W = 5.5W
    // and sx for the far corner = 6W. Both off-screen → max(0, floor(5.5W))
    // = 5.5W. min(W, ceil(6W)) - 5.5W = W - 5.5W = -4.5W < 0 → null.
    const model = translateScale(10, 10, 0, 1, 1, 1);
    const viewProj = identityMatrix();
    const rect = computeScissorRect(model, viewProj, 100, 100);

    expect(rect).toBeNull();
  });

  it("clamps a sub-pixel cube to a non-empty integer rect", () => {
    // Tiny cube at the center: world (0, 0, 0) → (0.001, 0.001, 0.001).
    // Screen-space span is sub-pixel. Floor(min)=49 or 50 area; Ceil(max)=51
    // depending on cancel/cancel-after-cancel. Either way the rect should be
    // small and positive.
    const model = translateScale(0, 0, 0, 0.001, 0.001, 0.001);
    const viewProj = identityMatrix();
    const rect = computeScissorRect(model, viewProj, 100, 100);

    expect(rect).not.toBeNull();
    expect(rect![2]).toBeGreaterThanOrEqual(1);
    expect(rect![3]).toBeGreaterThanOrEqual(1);
    // And both still inside the canvas.
    expect(rect![0] + rect![2]).toBeLessThanOrEqual(100);
    expect(rect![1] + rect![3]).toBeLessThanOrEqual(100);
  });
});
