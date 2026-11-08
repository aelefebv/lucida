import { describe, it, expect } from "vitest";
import { positionLabel, positionNumber } from "./axes.ts";

describe("positionLabel", () => {
  it("counts from 1", () => {
    expect(positionLabel("Z", 0)).toBe("Z 1");
    expect(positionLabel("T", 4)).toBe("T 5");
    expect(positionLabel("Channel", 2)).toBe("Channel 3");
  });

  it("appends the axis length when given", () => {
    expect(positionLabel("Z", 170, 340)).toBe("Z 171/340");
    expect(positionLabel("C", 0, 3)).toBe("C 1/3");
  });

  it("rounds a fractional index to its slice", () => {
    expect(positionNumber(6.6)).toBe(8);
    expect(positionLabel("Z", 6.4)).toBe("Z 7");
  });
});
