import { describe, expect, it } from "vitest";
import { INITIAL_UPLOAD_BYTES_PER_MS, UPLOAD_COST_HALF_LIFE_MS } from "./constants.ts";
import { UploadPacer } from "./pacing.ts";

const MIB = 1024 * 1024;

describe("UploadPacer", () => {
  it("costs a delivery at the initial rate before the worker reports", () => {
    const pacer = new UploadPacer();
    expect(pacer.costMs("volume", 4 * INITIAL_UPLOAD_BYTES_PER_MS)).toBeCloseTo(4);
    expect(pacer.costMs("slice", INITIAL_UPLOAD_BYTES_PER_MS)).toBeCloseTo(1);
  });

  it("moves halfway to a report that measured a half-life of work", () => {
    const pacer = new UploadPacer();
    // Four times the initial rate, over one half-life of measured time.
    pacer.noteDone("volume", 4 * INITIAL_UPLOAD_BYTES_PER_MS * UPLOAD_COST_HALF_LIFE_MS, UPLOAD_COST_HALF_LIFE_MS);
    // Half the initial half-life's bytes and time, plus the new: 4.5x the bytes in 1.5x the time.
    expect(pacer.costMs("volume", MIB)).toBeCloseTo((1.5 / 4.5) * (MIB / INITIAL_UPLOAD_BYTES_PER_MS));
  });

  it("counts a run of small reports about as one report of the same bytes and time", () => {
    const few = new UploadPacer();
    const many = new UploadPacer();
    few.noteDone("volume", 64 * MIB, 16);
    for (let i = 0; i < 64; i++) many.noteDone("volume", MIB, 0.25);
    expect(many.costMs("volume", MIB)).toBeCloseTo(few.costMs("volume", MIB), 1);
  });

  it("follows a device that slows down", () => {
    const pacer = new UploadPacer();
    pacer.noteDone("volume", 1000 * MIB, 250);
    expect(pacer.costMs("volume", MIB)).toBeCloseTo(0.25, 2);
    for (let i = 0; i < 40; i++) pacer.noteDone("volume", 4 * MIB, 8);
    expect(pacer.costMs("volume", MIB)).toBeCloseTo(2, 1);
  });

  it("keeps each mode's rate apart", () => {
    const pacer = new UploadPacer();
    pacer.noteDone("slice", MIB, 1000);
    expect(pacer.costMs("volume", MIB)).toBeCloseTo(MIB / INITIAL_UPLOAD_BYTES_PER_MS);
    expect(pacer.costMs("slice", MIB)).toBeGreaterThan(900);
  });

  it("leaves room for what the worker has not reported done, at each mode's rate", () => {
    const pacer = new UploadPacer();
    expect(pacer.roomMs(16)).toBe(16);
    expect(pacer.posted("volume", 10 * INITIAL_UPLOAD_BYTES_PER_MS)).toBeCloseTo(10);
    pacer.posted("slice", 2 * INITIAL_UPLOAD_BYTES_PER_MS);
    expect(pacer.roomMs(16)).toBeCloseTo(4);
    expect(pacer.roomMs(4)).toBeCloseTo(-8);
    pacer.noteDone("volume", 6 * INITIAL_UPLOAD_BYTES_PER_MS, 6);
    expect(pacer.roomMs(16)).toBeCloseTo(10);
    // A report of more than is counted frees no more than all of it.
    pacer.noteDone("volume", 100 * INITIAL_UPLOAD_BYTES_PER_MS, 100);
    pacer.noteDone("slice", 2 * INITIAL_UPLOAD_BYTES_PER_MS, 2);
    expect(pacer.roomMs(16)).toBe(16);
  });

  it("ignores a report that carried nothing", () => {
    const pacer = new UploadPacer();
    pacer.noteDone("volume", 0, 50);
    pacer.noteDone("volume", MIB, Number.NaN);
    expect(pacer.costMs("volume", MIB)).toBeCloseTo(MIB / INITIAL_UPLOAD_BYTES_PER_MS);
  });
});
