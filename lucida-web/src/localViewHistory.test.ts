// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { LocalViewHistory, viewerHistoryShortcut } from "./localViewHistory.ts";

describe("LocalViewHistory", () => {
  it("coalesces one gesture but seals the boundary between drags", () => {
    const history = new LocalViewHistory<number>("workspace-a", Object.is);
    history.record(0, 1, { label: "pan", coalesceKey: "pan", coalesceWindowMs: Infinity, timestampMs: 1 });
    history.record(1, 2, { label: "pan", coalesceKey: "pan", coalesceWindowMs: Infinity, timestampMs: 2 });
    history.endCoalescing("pan");
    history.record(2, 3, { label: "pan", coalesceKey: "pan", coalesceWindowMs: Infinity, timestampMs: 3 });

    const restored: number[] = [];
    expect(history.undo((value) => restored.push(value))).toBe(true);
    expect(history.undo((value) => restored.push(value))).toBe(true);
    expect(restored).toEqual([2, 0]);
  });

  it("coalesces wheel bursts by time and starts a new entry after the window", () => {
    const history = new LocalViewHistory<number>("workspace-a", Object.is);
    history.record(0, 1, { label: "zoom", coalesceKey: "wheel", coalesceWindowMs: 250, timestampMs: 0 });
    history.record(1, 2, { label: "zoom", coalesceKey: "wheel", coalesceWindowMs: 250, timestampMs: 200 });
    history.record(2, 3, { label: "zoom", coalesceKey: "wheel", coalesceWindowMs: 250, timestampMs: 500 });

    const restored: number[] = [];
    history.undo((value) => restored.push(value));
    history.undo((value) => restored.push(value));
    expect(restored).toEqual([2, 0]);
  });

  it("invalidates redo on a new branch and bounds retained entries", () => {
    const history = new LocalViewHistory<number>("workspace-a", Object.is, 2);
    history.record(0, 1, { label: "one" });
    history.record(1, 2, { label: "two" });
    history.record(2, 3, { label: "three" });
    history.undo(() => {});
    expect(history.getState().canRedo).toBe(true);
    history.record(2, 4, { label: "branch" });
    expect(history.getState().canRedo).toBe(false);

    const restored: number[] = [];
    history.undo((value) => restored.push(value));
    history.undo((value) => restored.push(value));
    expect(history.undo(() => {})).toBe(false);
    expect(restored).toEqual([2, 1]);
  });

  it("clears on workspace replacement and leaves stacks unchanged if restore fails", () => {
    const history = new LocalViewHistory<number>("workspace-a", Object.is);
    const listener = vi.fn();
    history.subscribe(listener);
    history.record(0, 1, { label: "pan" });
    expect(() => history.undo(() => { throw new Error("restore failed"); })).toThrow("restore failed");
    expect(history.getState().canUndo).toBe(true);
    history.setScope("workspace-b");
    expect(history.getState()).toMatchObject({ canUndo: false, canRedo: false });
    expect(listener).toHaveBeenCalled();
  });
});

describe("viewerHistoryShortcut", () => {
  it("recognizes platform undo and redo only inside the active viewer", () => {
    const viewer = document.createElement("div");
    const canvas = document.createElement("canvas");
    const outside = document.createElement("div");
    viewer.append(canvas);
    document.body.append(viewer, outside);
    const event = (key: string, target: Element, overrides: Partial<KeyboardEvent> = {}) => ({
      key,
      target,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      ...overrides,
    });

    expect(viewerHistoryShortcut(event("z", canvas), viewer)).toBe("undo");
    expect(viewerHistoryShortcut(event("z", canvas, { shiftKey: true }), viewer)).toBe("redo");
    expect(viewerHistoryShortcut(event("y", canvas), viewer)).toBe("redo");
    expect(viewerHistoryShortcut(event("z", canvas, { ctrlKey: false, metaKey: true }), viewer)).toBe("undo");
    expect(viewerHistoryShortcut(event("z", outside), viewer)).toBeNull();
  });

  it("yields to editable fields, native controls, dialogs, and handled events", () => {
    const viewer = document.createElement("div");
    const input = document.createElement("input");
    const button = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const child = document.createElement("span");
    dialog.append(child);
    viewer.append(input, button, dialog);
    const event = (target: Element, defaultPrevented = false) => ({
      key: "z",
      target,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented,
    });

    expect(viewerHistoryShortcut(event(input), viewer)).toBeNull();
    expect(viewerHistoryShortcut(event(button), viewer)).toBeNull();
    expect(viewerHistoryShortcut(event(child), viewer)).toBeNull();
    expect(viewerHistoryShortcut(event(dialog, true), viewer)).toBeNull();
  });
});
