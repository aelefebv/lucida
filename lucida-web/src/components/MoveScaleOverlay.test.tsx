// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { WasmScene } from "lucida-core";
import type { UserTransformActions } from "../hooks/useUserTransforms.ts";
import { readPlacement } from "../placement.ts";
import { __resetEscapeLayersForTesting, escapeTopLayer } from "../ui/escape.ts";
import {
  IDENTITY_USER_TRANSFORM,
  readUserTransform,
  setUserTransformCommand,
  type UserTransform,
} from "../userTransform.ts";
import { VIEWPORTS, fixture, joinedScene, loadWasm, renamed } from "../viewProperties.ts";
import { MoveScaleOverlay } from "./MoveScaleOverlay.tsx";

beforeAll(loadWasm);

afterEach(() => {
  cleanup();
  __resetEscapeLayersForTesting();
});

/** Two volumes, and actions that place B in the scene as the page would. */
function setup() {
  const scene = joinedScene(VIEWPORTS[0], 1, [renamed(fixture("volume"), "a"), renamed(fixture("volume"), "b")]);
  const place = (t: UserTransform) => scene.apply_command(JSON.stringify(setUserTransformCommand("b", t)));
  const actions: UserTransformActions = {
    canEdit: true,
    current: (id) => readUserTransform(scene, id) ?? IDENTITY_USER_TRANSFORM,
    preview: vi.fn((_id: string, t: UserTransform) => place(t)),
    commit: vi.fn((_id: string, _from: UserTransform, to: UserTransform) => place(to)),
    reset: vi.fn(),
    restored: vi.fn(),
  };
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const panned = vi.fn();
  pane.addEventListener("pointerdown", panned);
  const surface = { view: scene.active_view(), element: pane };
  render(<MoveScaleOverlay datasetId="b" name="b" scene={scene} surface={surface} actions={actions} />, {
    container: pane,
  });
  return { scene, actions, pane, panned };
}

function pointer(target: Element, type: string, x: number, y: number, init: PointerEventInit = {}) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...init }),
    );
  });
}

const grip = (pane: Element, name: string) => pane.querySelector(`[data-grip="${name}"]`)!;
const offsetX = (scene: WasmScene) => readPlacement(scene, "b").offset[0];

describe("MoveScaleOverlay", () => {
  it("moves the layer by the drag and places it once, on release, without panning the view", () => {
    const { scene, actions, pane, panned } = setup();
    const before = offsetX(scene);
    const box = grip(pane, "move");
    pointer(box, "pointerdown", 100, 100);
    pointer(box, "pointermove", 130, 100);
    pointer(box, "pointermove", 150, 100);
    expect(actions.preview).toHaveBeenCalledTimes(2);
    expect(actions.commit).not.toHaveBeenCalled();
    pointer(box, "pointerup", 150, 100);

    expect(actions.commit).toHaveBeenCalledTimes(1);
    const [, from] = vi.mocked(actions.commit).mock.calls[0];
    expect(from).toEqual(IDENTITY_USER_TRANSFORM);
    // 50 CSS pixels at the view's zoom.
    expect(offsetX(scene) - before).toBeCloseTo(50 / scene.zoom(scene.active_view()), 6);
    expect(panned).not.toHaveBeenCalled();
  });

  it("scales from a corner, alike on both axes unless Shift is held", () => {
    const { scene, actions, pane } = setup();
    const corner = grip(pane, "se");
    pointer(corner, "pointerdown", 0, 0);
    pointer(corner, "pointermove", 200, 10);
    pointer(corner, "pointerup", 200, 10);
    const uniform = vi.mocked(actions.commit).mock.calls[0][2];
    expect(uniform.scale[0]).toBeCloseTo(uniform.scale[1], 9);
    expect(uniform.scale[2]).toBeCloseTo(uniform.scale[0], 9);
    expect(uniform.scale[0]).toBeGreaterThan(1);

    pointer(corner, "pointerdown", 0, 0);
    pointer(corner, "pointermove", 200, 0, { shiftKey: true });
    pointer(corner, "pointerup", 200, 0, { shiftKey: true });
    const perAxis = vi.mocked(actions.commit).mock.calls[1][2];
    expect(perAxis.scale[0]).toBeGreaterThan(uniform.scale[0]);
    expect(perAxis.scale[1]).toBeCloseTo(uniform.scale[1], 9);
    expect(readUserTransform(scene, "b")).toEqual(perAxis);
  });

  it("puts the layer back where it began on Escape, and places nothing", () => {
    const { scene, actions, pane } = setup();
    const before = offsetX(scene);
    const box = grip(pane, "move");
    pointer(box, "pointerdown", 100, 100);
    pointer(box, "pointermove", 160, 140);
    expect(offsetX(scene)).not.toBeCloseTo(before, 6);
    act(() => {
      escapeTopLayer();
    });
    expect(offsetX(scene)).toBeCloseTo(before, 9);
    pointer(box, "pointerup", 160, 140);
    expect(actions.commit).not.toHaveBeenCalled();
  });
});
