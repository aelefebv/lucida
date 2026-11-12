import { describe, it, expect } from "vitest";
import type { WasmScene } from "lucida-core";
import type { Annotation } from "./annotationDocument.ts";
import { isOffContext, offContextLabel, pinLabel, viewContextsOf, viewCut, type ViewContext } from "./annotationContext.ts";
import type { ResolvedLayer } from "../resolvedLayers.ts";
import { resolvedLayer } from "../resolvedLayerFixtures.ts";
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

/** A view cutting plane `z` along Z, at T `t`, showing `channels`. */
function at(z: number, t: number, channels: number[]): ViewContext {
  return { cut: { axis: "z", start: z, end: z + 1 }, t, channels };
}

describe("annotationContext — isOffContext (pure decision)", () => {
  it("same z/t and a shared channel → on-context", () => {
    expect(isOffContext(pin(5, 2, 1), at(5, 2, [1]))).toBe(false);
  });

  it("differs in z → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), at(6, 2, [1]))).toBe(true);
  });

  it("differs in t → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), at(5, 3, [1]))).toBe(true);
  });

  it("shares no channel → off-context", () => {
    expect(isOffContext(pin(5, 2, 1), at(5, 2, [9]))).toBe(true);
  });

  it("a pin placed in the composite stays in context when one of its channels is soloed", () => {
    const composite = pin(0, 0, 0, [0, 1, 2]);
    expect(isOffContext(composite, at(0, 0, [0, 1, 2]))).toBe(false);
    expect(isOffContext(composite, at(0, 0, [1]))).toBe(false);
    expect(isOffContext(composite, at(0, 0, [2]))).toBe(false);
  });

  it("a pin placed in a composite that hid a channel is off-context on a solo of it", () => {
    expect(isOffContext(pin(0, 0, 0, [0, 2]), at(0, 0, [1]))).toBe(true);
  });

  it("a pin placed on a solo is in context in the composite that shows its channel", () => {
    expect(isOffContext(pin(0, 0, 1, [1]), at(0, 0, [0, 1, 2]))).toBe(false);
    expect(isOffContext(pin(0, 0, 1, [1]), at(0, 0, [2]))).toBe(true);
  });

  it("a pin with absent z/t/c is treated as 0/0/0", () => {
    // An older pin (no depth, no t/c) is on-context at the (z=0, t=0) view
    // showing channel 0…
    expect(isOffContext(pin(undefined, undefined, undefined), at(0, 0, [0]))).toBe(false);
    // …and off-context anywhere else.
    expect(isOffContext(pin(undefined, undefined, undefined), at(1, 0, [0]))).toBe(true);
  });

  it("a pin belongs to the plane holding its depth, the sample i spanning i up to i + 1", () => {
    // A plane's index, a mark placed before marks stood in a plane's middle…
    expect(isOffContext(pin(3.0, 0, 0), at(3, 0, [0]))).toBe(false);
    // …its middle, where a slice view places one now…
    expect(isOffContext(pin(3.5, 0, 0), at(3, 0, [0]))).toBe(false);
    // …and a picked depth past the middle all belong to that plane.
    expect(isOffContext(pin(3.9, 0, 0), at(3, 0, [0]))).toBe(false);
    expect(isOffContext(pin(3.9, 0, 0), at(4, 0, [0]))).toBe(true);
  });

  it("a slab is in context with every plane it reads", () => {
    const slab: ViewContext = { cut: { axis: "z", start: 2, end: 6 }, t: 0, channels: [0] };
    expect(isOffContext(pin(5.5, 0, 0), slab)).toBe(false);
    expect(isOffContext(pin(6.5, 0, 0), slab)).toBe(true);
  });

  it("a volume view cuts no plane, so only T and channels count", () => {
    expect(isOffContext(pin(187, 0, 0), { cut: null, t: 0, channels: [0] })).toBe(false);
    expect(isOffContext(pin(187, 2, 0), { cut: null, t: 0, channels: [0] })).toBe(true);
    expect(isOffContext(pin(187, 0, 3), { cut: null, t: 0, channels: [0] })).toBe(true);
  });

  it("a side view reads the plane along the axis it cuts", () => {
    const xz = (y: number): ViewContext => ({ cut: { axis: "y", start: y, end: y + 1 }, t: 0, channels: [0] });
    const point: Annotation = { ...pin(9, 0, 0), position: [12.5, 40.5] };
    expect(isOffContext(point, xz(40))).toBe(false);
    expect(isOffContext(point, xz(41))).toBe(true);
  });

  it("a shape is in context wherever the cut falls within its extent", () => {
    // Drawn in XZ: it spans depths 2 to 7, at Y 40.5.
    const box: Annotation = {
      id: "b", kind: "box", author: "a", position: [10, 40.5], z: 2.5, end: [30, 40.5], end_z: 7.5,
    };
    expect(isOffContext(box, at(2, 0, [0]))).toBe(false);
    expect(isOffContext(box, at(5, 0, [0]))).toBe(false);
    expect(isOffContext(box, at(7, 0, [0]))).toBe(false);
    expect(isOffContext(box, at(8, 0, [0]))).toBe(true);
    expect(isOffContext(box, at(1, 0, [0]))).toBe(true);
    // In a YZ view it spans X 10 to 30.
    const yz = (x: number): ViewContext => ({ cut: { axis: "x", start: x, end: x + 1 }, t: 0, channels: [0] });
    expect(isOffContext(box, yz(20))).toBe(false);
    expect(isOffContext(box, yz(31))).toBe(true);
  });
});

describe("annotationContext — viewCut", () => {
  const layer = { z_range: { start: 4, end: 6 }, y: 17, x: 23 } as ResolvedLayer;
  it("reads the planes a view of each plane cuts", () => {
    expect(viewCut(layer, "xy")).toEqual({ axis: "z", start: 4, end: 6 });
    expect(viewCut(layer, "xz")).toEqual({ axis: "y", start: 17, end: 18 });
    expect(viewCut(layer, "yz")).toEqual({ axis: "x", start: 23, end: 24 });
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

  it("a float z names the plane holding it (no decimals leak)", () => {
    expect(offContextLabel(pin(7.0, 1, 0))).toBe("Z 8 · T 2 · Channel 1");
    expect(offContextLabel(pin(7.5, 1, 0))).toBe("Z 8 · T 2 · Channel 1");
  });

  it("names the planes along the axis the view cuts, a span for a shape across several", () => {
    const box: Annotation = {
      id: "b", kind: "box", author: "a", position: [10, 40.5], z: 2.5, end: [30, 40.5], end_z: 7.5,
    };
    expect(offContextLabel(box, "y")).toBe("Y 41 · T 1 · Channel 1");
    expect(offContextLabel(box, "z")).toBe("Z 3–8 · T 1 · Channel 1");
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

describe("annotationContext — viewContextsOf (the datasets whose marks a view draws)", () => {
  /** A scene whose view resolves `alpha` at Z 2, `beta` at Z 5 showing
   * channel 1, and `tiles`, a collection a side view lays out in cells. */
  function scene(plane: string): WasmScene {
    return {
      epochs: () => "no epochs",
      resolved_layers: () =>
        JSON.stringify([
          resolvedLayer("alpha", [0], { z_range: { start: 2, end: 3 }, y: 7 }),
          resolvedLayer("beta", [1], { z_range: { start: 5, end: 6 }, y: 9 }),
          resolvedLayer("tiles"),
        ]),
      slice_plane: () => plane,
      draws_annotations: (_view: number, datasetId: string) => plane === "xy" || datasetId !== "tiles",
    } as unknown as WasmScene;
  }

  it("holds every dataset the view draws, in its order, each cut where the view cuts it", () => {
    const contexts = viewContextsOf(scene("xy"), { id: 1, draws: ["beta", "alpha", "tiles"], cameraMode: "slice" }, 3);
    expect([...contexts.keys()]).toEqual(["beta", "alpha", "tiles"]);
    expect(contexts.get("alpha")).toEqual({ cut: { axis: "z", start: 2, end: 3 }, t: 3, channels: [0] });
    expect(contexts.get("beta")).toEqual({ cut: { axis: "z", start: 5, end: 6 }, t: 3, channels: [1] });
  });

  it("leaves out a dataset the view lays out apart from its frame", () => {
    const contexts = viewContextsOf(scene("xz"), { id: 1, draws: ["alpha", "tiles"], cameraMode: "slice" }, 0);
    expect([...contexts.keys()]).toEqual(["alpha"]);
    expect(contexts.get("alpha")?.cut).toEqual({ axis: "y", start: 7, end: 8 });
  });

  it("cuts nothing in a volume view", () => {
    const contexts = viewContextsOf(scene("xy"), { id: 1, draws: ["alpha"], cameraMode: "arcball" }, 0);
    expect(contexts.get("alpha")).toEqual({ cut: null, t: 0, channels: [0] });
  });
});
