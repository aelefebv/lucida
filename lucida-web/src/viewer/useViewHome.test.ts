// @vitest-environment happy-dom
/**
 * Home's key against the real wasm scene: the active view, panned and
 * zoomed away, fits its data again and is framed, and the page hears of it
 * as of any camera move.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { RenderLoop } from "../renderLoop.ts";
import { __resetCommandsForTesting, runCommand } from "../ui/commands.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { VIEWPORTS, fixture, joinedScene, loadWasm } from "../viewProperties.ts";
import { useViewHome } from "./useViewHome.ts";

beforeAll(loadWasm);

afterEach(() => {
  cleanup();
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
});

describe("useViewHome", () => {
  it("fits the active view to its data again on the key", () => {
    const viewport = VIEWPORTS[0];
    const scene = joinedScene(viewport, 1, [fixture("volume").opened]);
    const canvas = { clientWidth: viewport.css[0], clientHeight: viewport.css[1] } as HTMLCanvasElement;
    const view = scene.active_view();
    const pose = () => [Array.from(scene.center(view)), scene.zoom(view)];
    const framed = pose();
    scene.apply_command(JSON.stringify({ type: "pan", dx: 300, dy: -120 }));
    scene.apply_command(JSON.stringify({ type: "zoom_by", factor: 6 }));
    expect(scene.camera_framing()).toBe("placed");
    const markInput = vi.fn();
    const breakFollow = vi.fn();
    const emitPresence = vi.fn();
    const loopRef = { current: { markInput } as unknown as RenderLoop };
    renderHook(() => useViewHome({ viewers: { scene, canvas }, loopRef, breakFollow, emitPresence }));
    expect(runCommand("view.home")).toBe(true);
    expect(scene.camera_framing()).toBe("framed");
    expect(pose()).toEqual(framed);
    expect(breakFollow).toHaveBeenCalledOnce();
    expect(emitPresence).toHaveBeenCalledOnce();
    expect(markInput).toHaveBeenCalledWith("zoom");
  });

  it("offers nothing before there is a scene", () => {
    const { result } = renderHook(() =>
      useViewHome({ viewers: null, loopRef: { current: null }, breakFollow: vi.fn(), emitPresence: vi.fn() }),
    );
    expect(result.current).toBeNull();
    expect(runCommand("view.home")).toBe(false);
  });
});
