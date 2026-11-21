import { afterEach, describe, expect, it } from "vitest";
import { gesturePixelsPerWorld } from "./volumePath.ts";
import { INTERACTION_RENDER_SCALE } from "./components/volumeRenderScale.ts";

const scene = { pixels_per_world: (view: number) => (view === 3 ? 900 : 0) };

function frame(scale: number) {
  return { canvasW: 1000 * scale, canvasH: 800 * scale, scale };
}

describe("a frame's scale for the levels its march samples", () => {
  const ratio = globalThis.devicePixelRatio;
  afterEach(() => {
    globalThis.devicePixelRatio = ratio;
  });

  it("is none for a frame at the resolution the level selection measures at, so it samples every level", () => {
    globalThis.devicePixelRatio = 2;
    expect(gesturePixelsPerWorld(scene, 3, frame(1))).toBe(0);
    // Past the pixel-ratio cap the selection measures at the cap, and a
    // frame there is at full resolution.
    globalThis.devicePixelRatio = 3;
    expect(gesturePixelsPerWorld(scene, 3, frame(2 / 3))).toBe(0);
  });

  it("is the view's perspective scale in the frame's own pixels below that resolution", () => {
    globalThis.devicePixelRatio = 2;
    const reduced = INTERACTION_RENDER_SCALE * 0.6;
    expect(gesturePixelsPerWorld(scene, 3, frame(reduced))).toBeCloseTo(900 * reduced);
    globalThis.devicePixelRatio = 3;
    expect(gesturePixelsPerWorld(scene, 3, frame((2 / 3) * INTERACTION_RENDER_SCALE))).toBeCloseTo(900 * (2 / 3) * INTERACTION_RENDER_SCALE);
  });

  it("is none for a view the scene draws without perspective", () => {
    globalThis.devicePixelRatio = 2;
    expect(gesturePixelsPerWorld(scene, 0, frame(0.5))).toBe(0);
  });
});
