import { describe, it, expect } from "vitest";

import { clampStamp, UNSET_STAMP, BOUNDARY_COUNT, PHASES } from "./types.ts";

describe("clampStamp", () => {
  it("keeps an ordinary offset intact", () => {
    expect(clampStamp(1_234_567)).toBe(1_234_567);
  });

  it("floors a negative or non-finite offset at zero", () => {
    expect(clampStamp(-1)).toBe(0);
    expect(clampStamp(Number.NaN)).toBe(0);
  });

  it("stays positive past the signed 32-bit boundary", () => {
    // A run over ~36 minutes. Bitwise coercion would come back negative here,
    // and a run's duration is a plain number, not a Uint32Array slot.
    const beyondSigned = 2 ** 31 + 5;
    expect(clampStamp(beyondSigned)).toBe(beyondSigned);
  });

  it("clamps rather than wrapping at the top of the slot range", () => {
    expect(clampStamp(UNSET_STAMP)).toBe(UNSET_STAMP - 1);
    expect(clampStamp(Number.MAX_SAFE_INTEGER)).toBe(UNSET_STAMP - 1);
  });

  it("truncates a fractional microsecond rather than storing it", () => {
    expect(clampStamp(10.9)).toBe(10);
  });
});

describe("the phase model", () => {
  it("holds one boundary slot per phase, plus the closing one", () => {
    expect(BOUNDARY_COUNT).toBe(PHASES.length + 1);
  });
});
