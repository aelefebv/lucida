// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { CLIP_BINDINGS, FLY_BINDINGS } from "../config/keyBindings.ts";
import {
  __resetShortcutsForTesting,
  activateShortcutScope,
  listShortcuts,
  registerShortcut,
} from "../ui/shortcuts.ts";
import { useHeldKeys } from "./useHeldKeys.ts";

afterEach(() => {
  __resetShortcutsForTesting();
  document.body.innerHTML = "";
});

function key(type: "keydown" | "keyup", key: string, code: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
}

function flyKeys(enabled = true) {
  return renderHook(({ on }) => useHeldKeys(FLY_BINDINGS, { group: "Fly camera", scope: "fly", enabled: on }), {
    initialProps: { on: enabled },
  });
}

describe("useHeldKeys", () => {
  it("lists each binding in the registry, in its scope", () => {
    flyKeys();
    expect(listShortcuts().map((s) => [s.id, s.keys.join(" "), s.scope])).toEqual([
      ["fly.move", "W A S D", "fly"],
      ["fly.rise", "Q E", "fly"],
      ["fly.look", "I J K L", "fly"],
      ["fly.roll", "U O", "fly"],
    ]);
  });

  it("holds an action from press to release, without focusing anything first", () => {
    const deactivate = activateShortcutScope("fly");
    const { result } = flyKeys();
    key("keydown", "w", "KeyW");
    key("keydown", "j", "KeyJ");
    expect([...result.current].sort()).toEqual(["forward", "yawLeft"]);
    key("keyup", "W", "KeyW"); // Shift came down meanwhile; the physical key still matches.
    expect([...result.current]).toEqual(["yawLeft"]);
    window.dispatchEvent(new Event("blur"));
    expect(result.current.size).toBe(0);
    deactivate();
  });

  it("holds nothing outside its scope, or while typing", () => {
    const { result } = flyKeys();
    key("keydown", "w", "KeyW");
    expect(result.current.size).toBe(0);

    const deactivate = activateShortcutScope("fly");
    const field = document.createElement("input");
    document.body.appendChild(field);
    key("keydown", "w", "KeyW", field);
    expect(result.current.size).toBe(0);
    deactivate();
  });

  it("takes precedence over a global key while its scope is active", () => {
    const lineTool = vi.fn();
    registerShortcut({ id: "tools.line", keys: ["L"], label: "Line tool", group: "Tools", onTrigger: lineTool });
    const { result } = flyKeys();

    key("keydown", "l", "KeyL");
    expect(lineTool).toHaveBeenCalledTimes(1);
    expect(result.current.size).toBe(0);
    key("keyup", "l", "KeyL");

    const deactivate = activateShortcutScope("fly");
    key("keydown", "l", "KeyL");
    expect(lineTool).toHaveBeenCalledTimes(1);
    expect([...result.current]).toEqual(["yawRight"]);
    deactivate();
  });

  it("binds global keys without a scope, and unbinds when disabled", () => {
    const { result, rerender } = renderHook(({ on }) => useHeldKeys(CLIP_BINDINGS, { group: "View", enabled: on }), {
      initialProps: { on: true },
    });
    key("keydown", "]", "BracketRight");
    expect([...result.current]).toEqual(["clipFarther"]);
    rerender({ on: false });
    expect(result.current.size).toBe(0);
    expect(listShortcuts()).toEqual([]);
  });
});
