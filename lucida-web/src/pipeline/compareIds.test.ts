import { describe, expect, it } from "vitest";
import { compareIds } from "./compareIds.ts";

describe("compareIds", () => {
  it("orders by code unit, whatever the locale would say", () => {
    expect(compareIds("B", "a")).toBeLessThan(0);
    expect(compareIds("a", "B")).toBeGreaterThan(0);
    expect(compareIds("0/0/1", "0/0/1")).toBe(0);
  });
});
