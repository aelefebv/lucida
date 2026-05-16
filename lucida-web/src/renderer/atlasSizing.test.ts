/**
 * Unit tests for `computeAtlasGeometry`. Pure-TS, no GPU.
 *
 * Covers both arity variants (2D / 3D), and both bounding regimes:
 *   - budget-bound (texture limit is comfortably larger than the
 *     budget-implied slots-per-axis)
 *   - texture-limit-bound (budget would allow more, but the device
 *     limit clamps slots-per-axis down)
 */

import { describe, it, expect } from "vitest";
import { computeAtlasGeometry } from "./atlasSizing.ts";
import type { DeviceLimits } from "./gpuContext.ts";

// Default WebGPU spec-minimum limits.
const SPEC_LIMITS: DeviceLimits = {
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("computeAtlasGeometry — 3D", () => {
  it("32^3 chunks + 512 MB + default 2048 limit → 20 slots per axis (budget-bound)", () => {
    // chunkTexels = 32768; maxSlots = 512MB / (32768 * 2) = 8192;
    // slotsPerAxis = floor(cbrt(8192)) = 20;
    // texture-limit cap = floor(2048 / 32) = 64 → does not bite.
    const geom = computeAtlasGeometry(SPEC_LIMITS, [32, 32, 32], 512 * MB, "3d");
    expect(geom.slotsX).toBe(20);
    expect(geom.slotsY).toBe(20);
    expect(geom.slotsZ).toBe(20);
    expect(geom.totalSlots).toBe(8000);
    expect(geom.atlasW).toBe(640);
    expect(geom.atlasH).toBe(640);
    expect(geom.atlasD).toBe(640);
  });

  it("16^3 chunks + huge 32 GB budget → slots clamped by maxTextureDimension3D, not by budget", () => {
    // chunkTexels = 4096; maxSlots = 32GB / 8192 = 4_194_304;
    // slotsPerAxis (budget) = floor(cbrt(4_194_304)) = 161;
    // texture-limit cap = floor(2048 / 16) = 128 → bites.
    const geom = computeAtlasGeometry(SPEC_LIMITS, [16, 16, 16], 32 * GB, "3d");
    expect(geom.slotsX).toBe(128);
    expect(geom.slotsY).toBe(128);
    expect(geom.slotsZ).toBe(128);
    expect(geom.atlasW).toBe(2048);
    expect(geom.atlasH).toBe(2048);
    expect(geom.atlasD).toBe(2048);
  });

  it("low device limit (512) + 32^3 chunks → slots clamped accordingly", () => {
    // budget-implied slotsPerAxis = 20; texture-limit cap = floor(512/32) = 16 → bites.
    const lowLimits: DeviceLimits = { ...SPEC_LIMITS, maxTextureDimension3D: 512 };
    const geom = computeAtlasGeometry(lowLimits, [32, 32, 32], 512 * MB, "3d");
    expect(geom.slotsX).toBe(16);
    expect(geom.slotsY).toBe(16);
    expect(geom.slotsZ).toBe(16);
    expect(geom.totalSlots).toBe(16 * 16 * 16);
    expect(geom.atlasW).toBe(512);
    expect(geom.atlasD).toBe(512);
  });
});

describe("computeAtlasGeometry — 2D", () => {
  it("128x128 chunks + 64 MB + default 8192 limit → 45 slots per axis (budget-bound)", () => {
    // chunkTexels = 16384; maxSlots = 64MB / 32768 = 2048;
    // slotsPerAxis (budget) = floor(sqrt(2048)) = 45;
    // texture-limit cap = floor(8192 / 128) = 64 → does not bite.
    const geom = computeAtlasGeometry(SPEC_LIMITS, [128, 128], 64 * MB, "2d");
    expect(geom.slotsX).toBe(45);
    expect(geom.slotsY).toBe(45);
    expect(geom.slotsZ).toBeUndefined();
    expect(geom.totalSlots).toBe(45 * 45);
    expect(geom.atlasW).toBe(45 * 128);
    expect(geom.atlasH).toBe(45 * 128);
    expect(geom.atlasD).toBeUndefined();
  });

  it("chunk larger than half the 2D limit → totalSlots small but nonzero", () => {
    // 5000x5000 chunk vs 8192 limit: floor(8192/5000) = 1 slot per axis.
    const geom = computeAtlasGeometry(SPEC_LIMITS, [5000, 5000], 256 * MB, "2d");
    expect(geom.slotsX).toBe(1);
    expect(geom.slotsY).toBe(1);
    expect(geom.totalSlots).toBe(1);
    expect(geom.atlasW).toBe(5000);
    expect(geom.atlasH).toBe(5000);
  });
});
