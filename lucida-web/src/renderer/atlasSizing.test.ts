/**
 * Unit tests for `computeAtlasGeometry`. Pure-TS, no GPU.
 *
 * Covers both arity variants (2D / 3D) in both bounding regimes: cap-bound,
 * where the grid holds every slot the cap allows, and texture-limit-bound,
 * where the device limit clamps the slots per axis.
 */

import { describe, it, expect } from "vitest";
import { computeAtlasGeometry, poolCapBytes } from "./atlasSizing.ts";
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
  it("holds every slot the cap allows, in layers as small as the texture depth permits", () => {
    // 512 MiB of 64 KiB slots is 8192, all of them, where a 20³ cube kept 8000.
    const geom = computeAtlasGeometry(SPEC_LIMITS, [32, 32, 32], 512 * MB, "3d");
    expect(geom.totalSlots).toBe(8192);
    expect(geom.slotsZ).toBe(64);
    expect(geom.slotsX! * geom.slotsY!).toBe(128);
    expect(geom.atlasD).toBe(2048);
  });

  it("does not round a few large chunks down to a cube: 256³ in 512 MiB is 16 slots, not 8", () => {
    const geom = computeAtlasGeometry(SPEC_LIMITS, [256, 256, 256], 512 * MB, "3d");
    expect(geom.totalSlots).toBe(16);
    // As deep as the texture allows, so each layer it grows by is small.
    expect(geom.slotsZ).toBe(8);
    expect([geom.slotsX, geom.slotsY]).toEqual([2, 1]);
  });

  it("16^3 chunks + huge 32 GB cap → slots clamped by maxTextureDimension3D, not by the cap", () => {
    const geom = computeAtlasGeometry(SPEC_LIMITS, [16, 16, 16], 32 * GB, "3d");
    expect(geom.slotsX).toBe(128);
    expect(geom.slotsY).toBe(128);
    expect(geom.slotsZ).toBe(128);
    expect(geom.atlasW).toBe(2048);
    expect(geom.atlasH).toBe(2048);
    expect(geom.atlasD).toBe(2048);
  });

  it("low device limit (512) + 32^3 chunks → slots clamped accordingly", () => {
    const lowLimits: DeviceLimits = { ...SPEC_LIMITS, maxTextureDimension3D: 512 };
    const geom = computeAtlasGeometry(lowLimits, [32, 32, 32], 512 * MB, "3d");
    expect([geom.slotsX, geom.slotsY, geom.slotsZ]).toEqual([16, 16, 16]);
    expect(geom.totalSlots).toBe(16 * 16 * 16);
    expect(geom.atlasW).toBe(512);
    expect(geom.atlasD).toBe(512);
  });

  it("keeps one slot when one chunk alone is over the cap", () => {
    const geom = computeAtlasGeometry(SPEC_LIMITS, [512, 512, 512], 64 * MB, "3d");
    expect(geom.totalSlots).toBe(1);
  });
});

describe("computeAtlasGeometry — 2D", () => {
  it("holds every slot the cap allows: 128x128 chunks in 64 MB is 2048 slots, not 45²", () => {
    const geom = computeAtlasGeometry(SPEC_LIMITS, [128, 128], 64 * MB, "2d");
    expect(geom.totalSlots).toBe(2048);
    expect([geom.slotsX, geom.slotsY]).toEqual([64, 32]);
    expect(geom.slotsZ).toBeUndefined();
    expect(geom.atlasW).toBe(64 * 128);
    expect(geom.atlasH).toBe(32 * 128);
    expect(geom.atlasD).toBeUndefined();
  });

  it("does not round a few large chunks down to a square: 1024² in 16 MiB is 8 slots, not 4", () => {
    const geom = computeAtlasGeometry(SPEC_LIMITS, [1024, 1024], 16 * MB, "2d");
    expect(geom.totalSlots).toBe(8);
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

describe("computeAtlasGeometry — bytes-per-voxel (r32uint label atlas)", () => {
  it("4 bytes/voxel halves the cap-implied slot count vs. 2 bytes", () => {
    const r16 = computeAtlasGeometry(SPEC_LIMITS, [128, 128], 64 * MB, "2d", 2);
    const r32 = computeAtlasGeometry(SPEC_LIMITS, [128, 128], 64 * MB, "2d", 4);
    expect(r16.totalSlots).toBe(2048);
    expect(r32.totalSlots).toBe(1024);
    expect([r32.slotsX, r32.slotsY]).toEqual([32, 32]);
  });

  it("defaults to 2 bytes/voxel when the param is omitted", () => {
    const explicit = computeAtlasGeometry(SPEC_LIMITS, [64, 64], 64 * MB, "2d", 2);
    const implied = computeAtlasGeometry(SPEC_LIMITS, [64, 64], 64 * MB, "2d");
    expect(implied).toEqual(explicit);
  });
});

describe("poolCapBytes", () => {
  it("caps one pool at the GPU total and at the adapter's largest buffer", () => {
    expect(poolCapBytes(SPEC_LIMITS, 1536 * MB)).toBe(256 * MB);
    expect(poolCapBytes({ ...SPEC_LIMITS, maxBufferSize: 4 * GB }, 1536 * MB)).toBe(1536 * MB);
  });
});
