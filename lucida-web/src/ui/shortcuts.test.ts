// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  __resetShortcutsForTesting,
  activateShortcutScope,
  ariaKeyShortcut,
  comboFromEvent,
  formatKeyCombo,
  listShortcuts,
  registerShortcut,
  useShortcut,
  useShortcutList,
  type ShortcutOptions,
} from "./shortcuts.ts";

afterEach(() => {
  __resetShortcutsForTesting();
  document.body.innerHTML = "";
});

function shortcut(overrides: Partial<ShortcutOptions> = {}): ShortcutOptions {
  return {
    id: "test.mode",
    keys: "M",
    label: "Switch 2D and 3D",
    group: "View",
    onTrigger: () => {},
    ...overrides,
  };
}

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("comboFromEvent", () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it.each([
    ["a letter, in either case", { key: "m", code: "KeyM" }, false, "M"],
    ["Shift with a letter", { key: "A", code: "KeyA", shiftKey: true }, false, "Shift+A"],
    ["a shifted symbol, without Shift", { key: "?", code: "Slash", shiftKey: true }, false, "?"],
    ["Ctrl as Mod off Apple", { key: "k", code: "KeyK", ctrlKey: true }, false, "Mod+K"],
    ["Cmd as Mod on Apple", { key: "k", code: "KeyK", metaKey: true }, true, "Mod+K"],
    ["Option+[ on Apple, which types “", { key: "“", code: "BracketLeft", altKey: true }, true, "Alt+["],
    ["Alt+[ elsewhere", { key: "[", code: "BracketLeft", altKey: true }, false, "Alt+["],
    ["Option+1 on Apple, which types ¡", { key: "¡", code: "Digit1", altKey: true }, true, "Alt+1"],
    ["Shift with a digit", { key: "!", code: "Digit1", shiftKey: true }, false, "Shift+1"],
    ["Shift with an arrow", { key: "ArrowUp", code: "ArrowUp", shiftKey: true }, false, "Shift+ArrowUp"],
    ["the space bar", { key: " ", code: "Space" }, false, "Space"],
    ["a numpad plus", { key: "+", code: "NumpadAdd" }, false, "+"],
  ] as const)("reads %s", (_, init, apple, expected) => {
    expect(comboFromEvent(ev(init), apple)).toBe(expected);
  });

  it("refuses modifiers the grammar cannot write", () => {
    expect(comboFromEvent(ev({ key: "k", code: "KeyK", ctrlKey: true }), true)).toBeNull();
    expect(comboFromEvent(ev({ key: "k", code: "KeyK", metaKey: true }), false)).toBeNull();
    expect(comboFromEvent(ev({ key: "Shift", code: "ShiftLeft", shiftKey: true }), false)).toBeNull();
  });
});

describe("the registry", () => {
  it("runs the handler and claims the event", () => {
    const onTrigger = vi.fn();
    registerShortcut(shortcut({ onTrigger }));
    const event = press({ key: "m", code: "KeyM" });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("rejects a combo that is already taken", () => {
    registerShortcut(shortcut({ id: "a", keys: ["PageUp", "Shift+ArrowUp"] }));
    expect(() => registerShortcut(shortcut({ id: "b", keys: "Shift+ArrowUp" }))).toThrow(
      /"Shift\+ArrowUp" is already bound to "a"/,
    );
  });

  it("rejects an id that is already taken", () => {
    registerShortcut(shortcut({ id: "a", keys: "M" }));
    expect(() => registerShortcut(shortcut({ id: "a", keys: "N" }))).toThrow(/already registered/);
  });

  it("frees a combo once unregistered", () => {
    const unregister = registerShortcut(shortcut({ id: "a" }));
    unregister();
    expect(() => registerShortcut(shortcut({ id: "b" }))).not.toThrow();
  });

  it.each([
    ["a text input", () => Object.assign(document.createElement("input"), { type: "text" })],
    ["a number input", () => Object.assign(document.createElement("input"), { type: "number" })],
    ["a textarea", () => document.createElement("textarea")],
    [
      "an editable element",
      () => {
        const el = document.createElement("div");
        el.contentEditable = "true";
        return el;
      },
    ],
  ])("stays quiet while typing in %s", (_, make) => {
    const onTrigger = vi.fn();
    registerShortcut(shortcut({ onTrigger }));
    const field = make();
    document.body.appendChild(field);
    const event = press({ key: "m", code: "KeyM" }, field);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("fires from a checkbox, which takes no text", () => {
    const onTrigger = vi.fn();
    registerShortcut(shortcut({ onTrigger }));
    const box = Object.assign(document.createElement("input"), { type: "checkbox" });
    document.body.appendChild(box);
    press({ key: "m", code: "KeyM" }, box);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("stays quiet inside an open overlay", () => {
    const onTrigger = vi.fn();
    registerShortcut(shortcut({ onTrigger }));
    const overlay = document.createElement("div");
    overlay.setAttribute("data-lc-overlay", "");
    const button = document.createElement("button");
    overlay.appendChild(button);
    document.body.appendChild(overlay);
    press({ key: "m", code: "KeyM" }, button);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("leaves an event another handler already claimed", () => {
    const onTrigger = vi.fn();
    registerShortcut(shortcut({ onTrigger }));
    const el = document.createElement("div");
    el.addEventListener("keydown", (e) => e.preventDefault());
    document.body.appendChild(el);
    press({ key: "m", code: "KeyM" }, el);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat unless asked", () => {
    const toggle = vi.fn();
    const step = vi.fn();
    registerShortcut(shortcut({ id: "toggle", keys: "M", onTrigger: toggle }));
    registerShortcut(shortcut({ id: "step", keys: "PageDown", repeat: true, onTrigger: step }));
    press({ key: "m", code: "KeyM", repeat: true });
    press({ key: "PageDown", code: "PageDown", repeat: true });
    expect(toggle).not.toHaveBeenCalled();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("lets an active scope reuse a global key and take precedence", () => {
    const lineTool = vi.fn();
    const yaw = vi.fn();
    registerShortcut(shortcut({ id: "tools.line", keys: "L", group: "Tools", onTrigger: lineTool }));
    registerShortcut(shortcut({ id: "fly.yawRight", keys: "L", group: "Fly camera", scope: "fly", onTrigger: yaw }));

    press({ key: "l", code: "KeyL" });
    expect(lineTool).toHaveBeenCalledTimes(1);

    const deactivate = activateShortcutScope("fly");
    press({ key: "l", code: "KeyL" });
    expect(yaw).toHaveBeenCalledTimes(1);
    expect(lineTool).toHaveBeenCalledTimes(1);

    deactivate();
    press({ key: "l", code: "KeyL" });
    expect(lineTool).toHaveBeenCalledTimes(2);
  });

  it("falls through when the condition is false", () => {
    const flyOnly = vi.fn();
    const global = vi.fn();
    let flying = false;
    registerShortcut(shortcut({ id: "global", keys: "F", onTrigger: global }));
    registerShortcut(shortcut({ id: "fly", keys: "F", scope: "fly", when: () => flying, onTrigger: flyOnly }));
    activateShortcutScope("fly");
    press({ key: "f", code: "KeyF" });
    expect(global).toHaveBeenCalledTimes(1);
    flying = true;
    press({ key: "f", code: "KeyF" });
    expect(flyOnly).toHaveBeenCalledTimes(1);
  });

  it("lists what is registered", () => {
    registerShortcut(shortcut({ id: "a", keys: ["PageUp", "Shift+ArrowUp"], label: "Previous Z plane", group: "Dimensions" }));
    expect(listShortcuts()).toEqual([
      { id: "a", keys: ["PageUp", "Shift+ArrowUp"], label: "Previous Z plane", group: "Dimensions", scope: "global" },
    ]);
  });
});

describe("useShortcut", () => {
  it("binds while mounted and always calls the latest handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ onTrigger }) => useShortcut(shortcut({ onTrigger })), {
      initialProps: { onTrigger: first },
    });
    rerender({ onTrigger: second });
    press({ key: "m", code: "KeyM" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unmount();
    press({ key: "m", code: "KeyM" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(listShortcuts()).toEqual([]);
  });

  it("registers only while enabled", () => {
    const onTrigger = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useShortcut(shortcut({ onTrigger, enabled })), {
      initialProps: { enabled: false },
    });
    press({ key: "m", code: "KeyM" });
    expect(onTrigger).not.toHaveBeenCalled();
    rerender({ enabled: true });
    press({ key: "m", code: "KeyM" });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("feeds useShortcutList", () => {
    const { result } = renderHook(() => useShortcutList());
    expect(result.current).toEqual([]);
    let unregister = () => {};
    act(() => {
      unregister = registerShortcut(shortcut());
    });
    expect(result.current.map((s) => s.id)).toEqual(["test.mode"]);
    act(() => unregister());
    expect(result.current).toEqual([]);
  });
});

describe("display", () => {
  it("names keys in the platform's words", () => {
    expect(formatKeyCombo("Mod+Shift+K", true)).toEqual(["⌘", "⇧", "K"]);
    expect(formatKeyCombo("Mod+Shift+K", false)).toEqual(["Ctrl", "Shift", "K"]);
    expect(formatKeyCombo("Alt+[", false)).toEqual(["Alt", "["]);
    expect(formatKeyCombo("Mod++", false)).toEqual(["Ctrl", "+"]);
    expect(formatKeyCombo("Shift+ArrowUp", false)).toEqual(["Shift", "↑"]);
  });

  it("writes aria-keyshortcuts", () => {
    expect(ariaKeyShortcut("Mod+K", true)).toBe("Meta+K");
    expect(ariaKeyShortcut("Mod+K", false)).toBe("Control+K");
    expect(ariaKeyShortcut("+", false)).toBe("+");
  });
});
