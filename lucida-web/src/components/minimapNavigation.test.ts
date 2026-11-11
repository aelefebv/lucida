/**
 * Minimap input against a real scene: the frame comes from the render path's
 * own `tickMinimap`, so the inversion is checked against the camera and the
 * member placement the minimap actually draws with.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmScene } from "lucida-core";

import { createMinimapState, tickMinimap } from "../minimapPath.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { MinimapOverlayData, TickContext } from "../renderLoopTypes.ts";
import { datasetId, fixture, loadWasm, manifest, openedScene, type ViewFixture } from "../viewProperties.ts";
import { wheelZoom } from "../input/wheel.ts";
import { projectToCanvas, sliceLocalToUnit, sliceUnitDepth, transformPoint } from "./minimapMath.ts";
import {
  MinimapNavigator,
  minimapToScene,
  pickSceneAt,
  pickVolumeAt,
  sceneToMinimap,
  type MinimapFrame,
} from "./minimapNavigation.ts";

const MINIMAP_SIZE = 200;
const CANVAS_CSS: [number, number] = [800, 600];
/** What one mouse notch zooms by, in and out, as the main view reads it. */
const NOTCH_IN = wheelZoom({ deltaY: -100, deltaMode: 0, ctrlKey: false });
const NOTCH_OUT = wheelZoom({ deltaY: 100, deltaMode: 0, ctrlKey: false });

function mainCanvas(): HTMLCanvasElement {
  return { clientWidth: CANVAS_CSS[0], clientHeight: CANVAS_CSS[1] } as unknown as HTMLCanvasElement;
}

/** The overlay frame the render path hands the minimap for `scene` at slice `z`. */
function frameOf(scene: WasmScene, f: ViewFixture, mode: "slice" | "volume", z = 0): MinimapOverlayData {
  let frame: MinimapOverlayData | null = null;
  const state = createMinimapState();
  state.enabled = true;
  state.size = MINIMAP_SIZE;
  state.overlayCallback = (data) => {
    frame = data;
  };
  const ctx = {
    scene,
    datasets: new Map([[datasetId(f), { manifest: manifest(f) }]]),
    client: { minimapRender: () => {} } as unknown as RenderClient,
    canvas: mainCanvas(),
    views: [{ id: scene.active_view(), mode, rect: [0, 0, CANVAS_CSS[0] * devicePixelRatio, CANVAS_CSS[1] * devicePixelRatio] }],
  } as unknown as TickContext;
  tickMinimap(ctx, state, z);
  if (!frame) throw new Error("the minimap drew no overlay");
  return frame;
}

function navigatorFor(scene: WasmScene, frame: MinimapFrame) {
  const loop = { markInput: vi.fn(), setRenderScale: vi.fn() };
  const deps = {
    scene: () => scene,
    canvas: mainCanvas,
    loop: () => loop,
    frame: () => frame,
    emitPresence: vi.fn(),
    breakFollow: vi.fn(),
  };
  return { navigator: new MinimapNavigator(deps, MINIMAP_SIZE), loop, deps };
}

/** A backing pixel as minimap CSS pixels. */
function css(frame: MinimapFrame, [px, py]: [number, number]): [number, number] {
  return [(px * MINIMAP_SIZE) / frame.canvasW, (py * MINIMAP_SIZE) / frame.canvasH];
}

function expectNear(actual: ArrayLike<number> | null, expected: ArrayLike<number>, tolerance: number): void {
  expect(actual).not.toBeNull();
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual![i] - expected[i])).toBeLessThan(tolerance);
}

/** The scene XY at the middle of a member's footprint. */
function memberCenter(frame: MinimapFrame, index: number): [number, number] {
  const m = frame.members[index];
  return [m.position[0] + m.width / 2, m.position[1] + m.height / 2];
}

beforeAll(() => loadWasm());

describe.each([1, 2])("minimap input at device pixel ratio %i", (ratio) => {
  beforeEach(() => {
    globalThis.devicePixelRatio = ratio;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the inversion", () => {
    it.each(["image", "collection", "volume"])("maps the %s's scene points back from the minimap", (name) => {
      const f = fixture(name);
      const scene = openedScene(f, { name: "landscape", css: CANVAS_CSS }, ratio, "slice");
      const frame = frameOf(scene, f, "slice", name === "volume" ? 40 : 0);
      expect(frame.members.length).toBe(manifest(f).images.length);
      for (const [index, member] of frame.members.entries()) {
        for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.9], [0.95, 0.05], [1.2, -0.3]]) {
          const point: [number, number] = [member.position[0] + fx * member.width, member.position[1] + fy * member.height];
          const at = sceneToMinimap(frame, member, ...point);
          expect(at, `${name} member ${index}`).not.toBeNull();
          expectNear(minimapToScene(frame, member, ...at!), point, 1e-3 * Math.max(member.width, member.height));
        }
      }
    });

    it("maps the corners of the drawn view rectangle back to the slice view's own", () => {
      const f = fixture("collection");
      const scene = openedScene(f, { name: "landscape", css: CANVAS_CSS }, ratio, "slice");
      const frame = frameOf(scene, f, "slice");
      expect(frame.sliceViewports.length).toBeGreaterThan(1);
      for (const viewport of frame.sliceViewports) {
        const member = frame.members.find((m) => m.memberId === viewport.memberId)!;
        const nz = sliceUnitDepth(frame.currentZ, viewport.depth);
        const { minX, maxY } = viewport.bounds;
        // The corner as `drawSliceViewportRect` strokes it.
        const unit = sliceLocalToUnit(minX, maxY, viewport.width, viewport.height, nz);
        const world = transformPoint(viewport.modelMatrix, ...unit);
        const drawn = projectToCanvas(frame.viewProj, ...world, frame.canvasW, frame.canvasH)!;
        expectNear(minimapToScene(frame, member, ...drawn), [minX + member.position[0], maxY + member.position[1]], 0.5);
      }
    });

    it("leaves a side view alone, whose plane the minimap neither outlines nor maps", () => {
      const f = fixture("volume");
      const scene = openedScene(f, { name: "landscape", css: CANVAS_CSS }, ratio, "slice");
      scene.apply_command(JSON.stringify({ type: "set_slice_plane", plane: "xz" }));
      const frame = frameOf(scene, f, "slice", 40);
      expect(frame.sliceViewports).toEqual([]);
      const { navigator, loop } = navigatorFor(scene, frame);
      const center = scene.center(scene.active_view());
      expect(navigator.pressAt(MINIMAP_SIZE / 2, MINIMAP_SIZE / 2, "mouse")).toBe(false);
      expect(navigator.cursorAt(MINIMAP_SIZE / 2, MINIMAP_SIZE / 2)).toBe("default");
      expect(Array.from(scene.center(scene.active_view()))).toEqual(Array.from(center));
      expect(loop.markInput).not.toHaveBeenCalled();
    });

    it("picks the collection member under the pointer", () => {
      const f = fixture("collection");
      const scene = openedScene(f, { name: "landscape", css: CANVAS_CSS }, ratio, "slice");
      const frame = frameOf(scene, f, "slice");
      const last = frame.members.length - 1;
      const target = memberCenter(frame, last);
      const pick = pickSceneAt(frame, ...sceneToMinimap(frame, frame.members[0], ...target)!);
      expect(pick?.member).toBe(frame.members[last]);
      expectNear(pick!.scene, target, 1);
    });
  });

  describe("in the slice view", () => {
    function setup(name = "collection") {
      const f = fixture(name);
      const scene = openedScene(f, { name: "landscape", css: CANVAS_CSS }, ratio, "slice");
      // Zoomed in, so the view rectangle covers part of the data.
      scene.apply_command(JSON.stringify({ type: "zoom_by", factor: 8 }));
      const frame = frameOf(scene, f, "slice");
      return { scene, frame, ...navigatorFor(scene, frame) };
    }

    it("centres the view on a clicked spot at the current zoom", () => {
      const { scene, frame, navigator, loop, deps } = setup();
      const zoom = scene.zoom(scene.active_view());
      const target = memberCenter(frame, frame.members.length - 1);
      const at = css(frame, sceneToMinimap(frame, frame.members[0], ...target)!);
      expect(navigator.cursorAt(...at)).toBe("crosshair");
      expect(navigator.pressAt(...at, "mouse", 10)).toBe(true);
      navigator.releaseAt(...at, 20);
      expectNear(scene.center(scene.active_view()), target, 1);
      expect(scene.zoom(scene.active_view())).toBe(zoom);
      expect(loop.markInput).toHaveBeenCalledWith("pan", 10);
      expect(deps.breakFollow).toHaveBeenCalled();
      expect(deps.emitPresence).toHaveBeenCalled();
    });

    it("drags the view rectangle, and the view pans with it", () => {
      const { scene, frame, navigator, loop } = setup();
      const start = [...scene.center(scene.active_view())] as [number, number];
      const member = pickSceneAt(frame, ...sceneToMinimap(frame, frame.members[0], ...start)!)!.member;
      // Grab the rectangle off its center, so the grab offset is under test.
      const grab = css(frame, sceneToMinimap(frame, member, start[0] + 2, start[1] + 1)!);
      expect(navigator.cursorAt(...grab)).toBe("move");
      navigator.pressAt(...grab, "mouse");
      expectNear(scene.center(scene.active_view()), start, 1e-9);
      const path: [number, number][] = [[5, 2], [12, 6], [30, 18]];
      for (const [dx, dy] of path) {
        navigator.moveTo(grab[0] + dx, grab[1] + dy, 100 + dx);
        // The point grabbed stays under the pointer, so the center keeps its offset from it.
        const under = minimapToScene(frame, member, ...backingOf(frame, grab[0] + dx, grab[1] + dy))!;
        expectNear(scene.center(scene.active_view()), [under[0] - 2, under[1] - 1], 1e-3);
      }
      navigator.releaseAt(grab[0] + 30, grab[1] + 18);
      expect(loop.markInput).toHaveBeenCalledTimes(path.length);
      expect(scene.center(scene.active_view())[0]).toBeGreaterThan(start[0]);
      expect(scene.center(scene.active_view())[1]).toBeGreaterThan(start[1]);
    });

    it("jumps to a press outside the view rectangle, then drags from there", () => {
      const { scene, frame, navigator } = setup();
      const target = memberCenter(frame, 0);
      const at = css(frame, sceneToMinimap(frame, frame.members[0], ...target)!);
      navigator.pressAt(...at, "touch");
      expectNear(scene.center(scene.active_view()), target, 1);
      // A finger's wobble inside the touch slop moves nothing.
      navigator.moveTo(at[0] + 3, at[1], 5);
      expectNear(scene.center(scene.active_view()), target, 1);
      navigator.moveTo(at[0] + 20, at[1], 6);
      const under = minimapToScene(frame, frame.members[0], ...backingOf(frame, at[0] + 20, at[1]))!;
      expectNear(scene.center(scene.active_view()), under, 1e-3);
    });

    it("zooms about the spot under the wheel", () => {
      const { scene, frame, navigator, loop } = setup("image");
      const spot = memberCenter(frame, 0);
      spot[0] += frame.members[0].width / 4;
      const onScreen = () => {
        const c = scene.center(scene.active_view());
        return [(spot[0] - c[0]) * scene.zoom(scene.active_view()), (spot[1] - c[1]) * scene.zoom(scene.active_view())];
      };
      const before = onScreen();
      const zoom = scene.zoom(scene.active_view());
      expect(navigator.wheelAt(...css(frame, sceneToMinimap(frame, frame.members[0], ...spot)!), NOTCH_IN, 7)).toBe(true);
      expect(scene.zoom(scene.active_view()) / zoom).toBeCloseTo(1.1, 9);
      expectNear(onScreen(), before, 0.05 * scene.zoom(scene.active_view()));
      expect(loop.markInput).toHaveBeenCalledWith("zoom", 7);
    });

    it("moves the view rectangle along an arrow key", () => {
      const { scene, frame, navigator } = setup("image");
      const member = frame.members[0];
      const centerOnMinimap = () => {
        const [x, y] = scene.center(scene.active_view());
        return sceneToMinimap(frame, member, x, y)!;
      };
      const before = centerOnMinimap();
      expect(navigator.key("ArrowRight")).toBe(true);
      const after = centerOnMinimap();
      const step = (10 * frame.canvasW) / MINIMAP_SIZE;
      expectNear(after, [before[0] + step, before[1]], 1e-3);
      expect(navigator.key("a")).toBe(false);
    });
  });

  describe("in the volume view", () => {
    function setup() {
      const f = fixture("volume");
      const scene = openedScene(f, { name: "landscape", css: CANVAS_CSS }, ratio, "arcball");
      const frame = frameOf(scene, f, "volume");
      return { scene, frame, ...navigatorFor(scene, frame) };
    }

    it("orbits on a drag, at the interaction scale", () => {
      vi.useFakeTimers();
      const { scene, navigator, loop } = setup();
      const theta = scene.camera_theta();
      const phi = scene.camera_phi();
      expect(navigator.cursorAt(100, 100)).toBe("grab");
      navigator.pressAt(100, 100, "mouse");
      expect(loop.setRenderScale).toHaveBeenLastCalledWith(0.5);
      navigator.moveTo(120, 100, 1);
      navigator.moveTo(150, 90, 2);
      navigator.releaseAt(150, 90);
      expect(scene.camera_theta()).toBeCloseTo(theta - (50 * Math.PI) / MINIMAP_SIZE, 6);
      expect(scene.camera_phi()).toBeCloseTo(phi + (10 * Math.PI) / MINIMAP_SIZE, 6);
      expect(loop.markInput).toHaveBeenCalledWith("orbit", 2);
      vi.runAllTimers();
      expect(loop.setRenderScale).toHaveBeenLastCalledWith(1);
    });

    it("makes a clicked point of the data the orbit's target", () => {
      const { scene, frame, navigator, loop } = setup();
      // Off the data's center, so the target has to move.
      const at: [number, number] = [MINIMAP_SIZE * 0.42, MINIMAP_SIZE * 0.55];
      const picked = pickVolumeAt(frame, (at[0] * frame.canvasW) / MINIMAP_SIZE, (at[1] * frame.canvasH) / MINIMAP_SIZE);
      expect(picked).not.toBeNull();
      const eye = [...scene.eye_position(scene.active_view())];
      navigator.pressAt(...at, "mouse");
      navigator.releaseAt(...at, 3);
      expect([...scene.eye_position(scene.active_view())]).not.toEqual(eye);
      const [w, h] = [CANVAS_CSS[0] * ratio, CANVAS_CSS[1] * ratio];
      expectNear(scene.project_to_screen(...picked!.world), [w / 2, h / 2], 1);
      expect(loop.markInput).toHaveBeenCalledWith("pan", 3);
    });

    it("zooms by a wheel notch as far as the slice view does, and back out", () => {
      vi.useFakeTimers();
      const { scene, navigator, loop } = setup();
      const zoom = scene.zoom(scene.active_view());
      expect(navigator.wheelAt(100, 100, NOTCH_IN, 4)).toBe(true);
      expect(scene.zoom(scene.active_view()) / zoom).toBeCloseTo(1.1, 9);
      expect(loop.setRenderScale).toHaveBeenLastCalledWith(0.5);
      expect(navigator.wheelAt(100, 100, NOTCH_OUT, 5)).toBe(true);
      expect(scene.zoom(scene.active_view()) / zoom).toBeCloseTo(1, 9);
      expect(loop.markInput).toHaveBeenCalledWith("zoom", 5);
      expect(navigator.wheelAt(100, 100, 1, 6)).toBe(false);
      vi.runAllTimers();
      expect(loop.setRenderScale).toHaveBeenLastCalledWith(1);
    });

    it("leaves the target alone on a click off the data", () => {
      const { scene, navigator, loop } = setup();
      const eye = [...scene.eye_position(scene.active_view())];
      navigator.pressAt(2, 2, "mouse");
      navigator.releaseAt(2, 2);
      expect([...scene.eye_position(scene.active_view())]).toEqual(eye);
      expect(loop.markInput).not.toHaveBeenCalled();
    });
  });
});

/** The backing pixel under a point in minimap CSS pixels. */
function backingOf(frame: MinimapFrame, x: number, y: number): [number, number] {
  return [(x * frame.canvasW) / MINIMAP_SIZE, (y * frame.canvasH) / MINIMAP_SIZE];
}
