import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RENDER_SURFACE_DIMENSION,
  validateRenderSurfaceSize,
  validateRenderViewportSize,
} from "./renderSurfaceContract.ts";

describe("render surface dimension contract", () => {
  it("normalizes positive device-pixel dimensions exactly once", () => {
    expect(validateRenderSurfaceSize(1279.6, 719.5)).toEqual({
      ok: true,
      size: { width: 1280, height: 720 },
    });
  });

  it.each([
    [0, 720, "non-positive"],
    [1280, 0, "non-positive"],
    [-1, 720, "non-positive"],
    [Number.NaN, 720, "non-finite"],
    [1280, Number.POSITIVE_INFINITY, "non-finite"],
  ] as const)("suppresses invalid dimensions %s × %s", (width, height, reason) => {
    expect(validateRenderSurfaceSize(width, height)).toEqual({ ok: false, reason });
  });

  it("uses the live device limit without applying it to pre-DPR CSS geometry", () => {
    expect(validateRenderSurfaceSize(4096, 4096, 4096).ok).toBe(true);
    expect(validateRenderSurfaceSize(4097, 4096, 4096)).toEqual({
      ok: false,
      reason: "exceeds-device-limit",
    });
    expect(validateRenderSurfaceSize(
      DEFAULT_MAX_RENDER_SURFACE_DIMENSION,
      1,
    ).ok).toBe(true);
  });

  it("allows non-allocation viewport geometry above the texture limit", () => {
    expect(validateRenderViewportSize(16_000, 9_000)).toEqual({
      ok: true,
      size: { width: 16_000, height: 9_000 },
    });
    expect(validateRenderViewportSize(Number.NaN, 9_000)).toEqual({
      ok: false,
      reason: "non-finite",
    });
  });
});
