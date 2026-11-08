import { describe, it, expect } from "vitest";
import type { Annotation } from "./annotationDocument.ts";
import { isOffContext, offContextLabel, pinLabel } from "./annotationContext.ts";
import { deriveHandle } from "./annotationParticipants.ts";

/** A point pin at the given z/t/c (other fields irrelevant to the context calc). */
function pin(
  z: number | undefined,
  t: number | undefined,
  c: number | undefined,
  channels?: number[],
): Annotation {
  return { id: "p", position: [0, 0], z, t, c, author: "a", kind: "point", channels };
}

describe("annotationContext — isOffContext (pure decision)", () => {
  it("same z/t and a shared channel → on-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 5, t: 2, channels: [1] })).toBe(false);
  });

  it("differs in z → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 6, t: 2, channels: [1] })).toBe(true);
  });

  it("differs in t → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 5, t: 3, channels: [1] })).toBe(true);
  });

  it("shares no channel → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), { z: 5, t: 2, channels: [9] })).toBe(true);
  });

  it("a pin placed in the composite stays in context when one of its channels is soloed", () => {
    const composite = pin(0, 0, 0, [0, 1, 2]);
    expect(isOffContext(composite, { z: 0, t: 0, channels: [0, 1, 2] })).toBe(false);
    expect(isOffContext(composite, { z: 0, t: 0, channels: [1] })).toBe(false);
    expect(isOffContext(composite, { z: 0, t: 0, channels: [2] })).toBe(false);
  });

  it("a pin placed in a composite that hid a channel is off-context on a solo of it", () => {
    expect(isOffContext(pin(0, 0, 0, [0, 2]), { z: 0, t: 0, channels: [1] })).toBe(true);
  });

  it("a pin placed on a solo is in context in the composite that shows its channel", () => {
    expect(isOffContext(pin(0, 0, 1, [1]), { z: 0, t: 0, channels: [0, 1, 2] })).toBe(false);
    expect(isOffContext(pin(0, 0, 1, [1]), { z: 0, t: 0, channels: [2] })).toBe(true);
  });

  it("a pin with absent z/t/c is treated as 0/0/0", () => {
    // An older pin (no depth, no t/c) is on-context at the (z=0, t=0) view
    // showing channel 0…
    expect(isOffContext(pin(undefined, undefined, undefined), { z: 0, t: 0, channels: [0] })).toBe(false);
    // …and off-context anywhere else.
    expect(isOffContext(pin(undefined, undefined, undefined), { z: 1, t: 0, channels: [0] })).toBe(true);
  });

  it("a near-integer float z is rounded before comparing (a 2D slice depth)", () => {
    // A float slice index must compare equal to the view's integer z.
    expect(isOffContext(pin(3.0, 0, 0), { z: 3, t: 0, channels: [0] })).toBe(false);
  });

  it("ignoreZ (3D): a Z-only mismatch is on-context, since the volume shows all Z", () => {
    // 3D renders every slice, so a pin must not dim for Z alone.
    expect(isOffContext(pin(187, 0, 0), { z: 0, t: 0, channels: [0] }, { ignoreZ: true })).toBe(false);
    // …but T and channels still count even with ignoreZ.
    expect(isOffContext(pin(187, 2, 0), { z: 0, t: 0, channels: [0] }, { ignoreZ: true })).toBe(true);
    expect(isOffContext(pin(187, 0, 3), { z: 0, t: 0, channels: [0] }, { ignoreZ: true })).toBe(true);
  });
});

describe("annotationContext — offContextLabel (exact contract form)", () => {
  it("formats the pin's own integer z/t/c as `Z <z> · T <t> · Channel <c>`, counted from 1", () => {
    expect(offContextLabel(pin(12, 3, 2))).toBe("Z 13 · T 4 · Channel 3");
  });

  it("names every channel of a pin placed in the composite", () => {
    expect(offContextLabel(pin(0, 0, 0, [0, 2]))).toBe("Z 1 · T 1 · Channels 1, 3");
  });

  it("absent fields read as the first of each", () => {
    expect(offContextLabel(pin(undefined, undefined, undefined))).toBe("Z 1 · T 1 · Channel 1");
  });

  it("a float z is rendered as a rounded integer (no decimals leak)", () => {
    expect(offContextLabel(pin(7.0, 1, 0))).toBe("Z 8 · T 2 · Channel 1");
  });
});

describe("annotationContext — pinLabel (the marker's accessible name)", () => {
  it("says whose pin it is and how many comments it has", () => {
    expect(pinLabel(pin(0, 0, 0), true, false)).toBe("Pin by you");
    const commented = { ...pin(0, 0, 0), comments: [{ id: "c", author: "a", text: "x" }] };
    expect(pinLabel(commented, true, false)).toBe("Pin by you, 1 comment");
    expect(pinLabel(pin(0, 0, 0), false, false)).toBe(`Pin by ${deriveHandle("a")}`);
  });

  it("names where a pin off the view lives", () => {
    expect(pinLabel(pin(4, 0, 0), true, true)).toBe("Pin by you, Z 5 · T 1 · Channel 1");
  });
});
