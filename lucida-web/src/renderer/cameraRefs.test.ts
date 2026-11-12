import { describe, expect, it } from "vitest";
import { CameraRefs } from "./cameraRefs.ts";

describe("CameraRefs", () => {
  it("moves a view's revision only when that view's references change", () => {
    const refs = new CameraRefs<[number, number]>();
    refs.set(0, "a", [0.5, 0.5]);
    refs.set(1, "a", [0.5, 0.5]);
    const other = refs.revisionOf(1);
    const before = refs.revisionOf(0);

    refs.set(0, "a", [0.5, 0.5]);
    expect(refs.revisionOf(0)).toBe(before);

    refs.set(0, "a", [0.25, 0.5]);
    expect(refs.revisionOf(0)).not.toBe(before);
    refs.forget("a", 0);
    refs.forget("a", 0);
    expect(refs.revisionOf(1)).toBe(other);
  });

  it("never gives a view a revision it had before, across forgetting and clearing", () => {
    const refs = new CameraRefs<[number, number]>();
    const seen = new Set([refs.revisionOf(0)]);
    const step = (change: () => void) => {
      change();
      expect(seen.has(refs.revisionOf(0))).toBe(false);
      seen.add(refs.revisionOf(0));
    };
    step(() => refs.set(0, "a", [0, 0]));
    step(() => refs.forget("a"));
    step(() => refs.set(0, "b", [1, 1]));
    step(() => refs.clear());
    step(() => refs.set(0, "b", [1, 1]));
  });
});
