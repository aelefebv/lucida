import { describe, it, expect } from "vitest";
import type { Annotation } from "./AnnotationOverlay.tsx";
import { isOffContext, offContextLabel } from "./annotationContext.ts";

/** A point pin at the given z/t/c (other fields irrelevant to the context calc). */
function pin(z: number | undefined, t: number | undefined, c: number | undefined): Annotation {
  return { id: "p", position: [0, 0], z, t, c, author: "a", kind: "point" };
}

describe("annotationContext — isOffContext (pure decision)", () => {
  it("all three equal → on-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 5, t: 2, c: 1 })).toBe(false);
  });

  it("differs in z → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 6, t: 2, c: 1 })).toBe(true);
  });

  it("differs in t → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 5, t: 3, c: 1 })).toBe(true);
  });

  it("differs in c → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 5, t: 2, c: 9 })).toBe(true);
  });

  it("a pin with absent z/t/c is treated as 0/0/0", () => {
    // An older pin (no depth, no t/c) is on-context at the (z=0, t=0, c=0) view…
    expect(isOffContext(pin(undefined, undefined, undefined), { z: 0, t: 0, c: 0 })).toBe(false);
    // …and off-context anywhere else.
    expect(isOffContext(pin(undefined, undefined, undefined), { z: 1, t: 0, c: 0 })).toBe(true);
  });

  it("a near-integer float z is rounded before comparing (a 2D slice depth)", () => {
    // A 2D-dropped pin's z is the slice index as a float (e.g. 3.0); the view's z
    // is the integer 3 — they must compare equal, not as 3.0 !== 3-by-epsilon.
    expect(isOffContext(pin(3.0, 0, 0), { z: 3, t: 0, c: 0 })).toBe(false);
  });
});

describe("annotationContext — offContextLabel (exact contract form)", () => {
  it("formats the pin's own integer z/t/c as `slice <z> · t=<t> · ch=<c>`", () => {
    expect(offContextLabel(pin(12, 3, 2))).toBe("slice 12 · t=3 · ch=2");
  });

  it("absent fields render as 0", () => {
    expect(offContextLabel(pin(undefined, undefined, undefined))).toBe("slice 0 · t=0 · ch=0");
  });

  it("a float z is rendered as a rounded integer (no decimals leak)", () => {
    expect(offContextLabel(pin(7.0, 1, 0))).toBe("slice 7 · t=1 · ch=0");
  });
});
