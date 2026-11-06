import { describe, it, expect } from "vitest";
import type { Annotation } from "./annotationDocument.ts";
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
    // A float slice index must compare equal to the view's integer z.
    expect(isOffContext(pin(3.0, 0, 0), { z: 3, t: 0, c: 0 })).toBe(false);
  });

  it("ignoreZ (3D): a Z-only mismatch is on-context, since the volume shows all Z", () => {
    // 3D renders every slice, so a pin must not dim for Z alone.
    expect(isOffContext(pin(187, 0, 0), { z: 0, t: 0, c: 0 }, { ignoreZ: true })).toBe(false);
    // …but T/C still count even with ignoreZ.
    expect(isOffContext(pin(187, 2, 0), { z: 0, t: 0, c: 0 }, { ignoreZ: true })).toBe(true);
    expect(isOffContext(pin(187, 0, 3), { z: 0, t: 0, c: 0 }, { ignoreZ: true })).toBe(true);
  });
});

describe("annotationContext — offContextLabel (exact contract form)", () => {
  it("formats the pin's own integer z/t/c as `Z <z> · T <t> · Channel <c>`, counted from 1", () => {
    expect(offContextLabel(pin(12, 3, 2))).toBe("Z 13 · T 4 · Channel 3");
  });

  it("absent fields read as the first of each", () => {
    expect(offContextLabel(pin(undefined, undefined, undefined))).toBe("Z 1 · T 1 · Channel 1");
  });

  it("a float z is rendered as a rounded integer (no decimals leak)", () => {
    expect(offContextLabel(pin(7.0, 1, 0))).toBe("Z 8 · T 2 · Channel 1");
  });
});
