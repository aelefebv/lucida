// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  __resetCommandsForTesting,
  listCommands,
  registerCommand,
  runCommand,
  searchCommands,
  useCommand,
  useCommandList,
  useCommands,
  type CommandInfo,
  type CommandOptions,
} from "./commands.ts";
import { __resetShortcutsForTesting, listShortcuts } from "./shortcuts.ts";

afterEach(() => {
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
});

function command(overrides: Partial<CommandOptions> = {}): CommandOptions {
  return { id: "view.zoomIn", label: "Zoom in", group: "View", run: () => {}, ...overrides };
}

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("the command registry", () => {
  it("lists and runs a command", () => {
    const run = vi.fn();
    registerCommand(command({ run, keywords: ["magnify"] }));
    expect(listCommands()).toEqual([{ id: "view.zoomIn", label: "Zoom in", group: "View", keywords: ["magnify"] }]);
    expect(runCommand("view.zoomIn")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runCommand("view.missing")).toBe(false);
  });

  it("rejects an id that is already taken", () => {
    registerCommand(command());
    expect(() => registerCommand(command({ label: "Something else" }))).toThrow(/already registered/);
  });

  it("binds its keys as a shortcut under the same id, label, and group", () => {
    const run = vi.fn();
    const unregister = registerCommand(command({ run, keys: ["+", "="] }));
    expect(listShortcuts()).toEqual([
      { id: "view.zoomIn", keys: ["+", "="], label: "Zoom in", group: "View", scope: "global" },
    ]);
    press({ key: "=", code: "Equal" });
    expect(run).toHaveBeenCalledTimes(1);

    unregister();
    expect(listCommands()).toEqual([]);
    expect(listShortcuts()).toEqual([]);
  });

  it("registers nothing while disabled", () => {
    registerCommand(command({ keys: ["+"], enabled: false }));
    expect(listCommands()).toEqual([]);
    expect(listShortcuts()).toEqual([]);
  });
});

describe("useCommand", () => {
  it("offers the command while mounted and runs the latest handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ run }) => useCommand(command({ run, keys: ["+"] })), {
      initialProps: { run: first },
    });
    rerender({ run: second });
    runCommand("view.zoomIn");
    press({ key: "+", code: "Equal", shiftKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);

    unmount();
    expect(listCommands()).toEqual([]);
    expect(listShortcuts()).toEqual([]);
  });

  it("follows a label change and unbinds while disabled", () => {
    const { rerender } = renderHook(({ label, enabled }) => useCommand(command({ label, enabled, keys: ["+"] })), {
      initialProps: { label: "Zoom in", enabled: true },
    });
    rerender({ label: "Magnify", enabled: true });
    expect(listCommands().map((c) => c.label)).toEqual(["Magnify"]);
    expect(listShortcuts().map((s) => s.label)).toEqual(["Magnify"]);
    rerender({ label: "Magnify", enabled: false });
    expect(listCommands()).toEqual([]);
    expect(listShortcuts()).toEqual([]);
  });

  it("feeds useCommandList", () => {
    const { result } = renderHook(() => useCommandList());
    let unregister = () => {};
    act(() => {
      unregister = registerCommand(command());
    });
    expect(result.current.map((c) => c.id)).toEqual(["view.zoomIn"]);
    act(() => unregister());
    expect(result.current).toEqual([]);
  });
});

describe("useCommands", () => {
  it("registers a list that may change, running each command's latest handler", () => {
    const dark = vi.fn();
    const light = vi.fn();
    const { rerender, unmount } = renderHook(({ items }) => useCommands(items), {
      initialProps: {
        items: [command({ id: "theme.dark", label: "Theme: Dark", run: () => {} })],
      },
    });
    rerender({
      items: [
        command({ id: "theme.dark", label: "Theme: Dark", run: dark }),
        command({ id: "theme.light", label: "Theme: Light", run: light, enabled: true }),
        command({ id: "theme.system", label: "Theme: System", enabled: false }),
      ],
    });
    expect(listCommands().map((c) => c.id)).toEqual(["theme.dark", "theme.light"]);
    runCommand("theme.dark");
    runCommand("theme.light");
    expect(dark).toHaveBeenCalledTimes(1);
    expect(light).toHaveBeenCalledTimes(1);
    unmount();
    expect(listCommands()).toEqual([]);
  });
});

describe("searchCommands", () => {
  const info = (id: string, label: string, group: CommandInfo["group"], keywords: string[] = []): CommandInfo => ({
    id,
    label,
    group,
    keywords,
  });
  const commands = [
    info("theme.dark", "Theme: Dark", "Appearance", ["mode"]),
    info("view.zoomIn", "Zoom in", "View"),
    info("panels.left", "Show or hide the layers panel", "Panels"),
    info("tools.pan", "Pan tool", "Tools", ["navigate"]),
    info("view.fit", "Fit to view", "View"),
  ];
  const ids = (query: string) => searchCommands(commands, query).map((c) => c.id);

  it("lists everything by group for an empty query", () => {
    expect(ids("")).toEqual(["panels.left", "view.zoomIn", "view.fit", "tools.pan", "theme.dark"]);
  });

  it("finds commands by a partial name, in any case", () => {
    expect(ids("zoo")).toEqual(["view.zoomIn"]);
    expect(ids("LAYER")).toEqual(["panels.left"]);
  });

  it("needs every word to match somewhere", () => {
    expect(ids("hide layers")).toEqual(["panels.left"]);
    expect(ids("hide zoom")).toEqual([]);
  });

  it("matches keywords and the group name", () => {
    expect(ids("navigate")).toEqual(["tools.pan"]);
    expect(ids("appearance")).toEqual(["theme.dark"]);
  });

  it("puts label prefixes before word starts before the rest", () => {
    // "pan" starts "Pan tool", starts a word in "panel", and sits inside nothing else.
    expect(ids("pan")).toEqual(["tools.pan", "panels.left"]);
    // "view" starts no label, ends "Fit to view", and names the View group.
    expect(ids("view")).toEqual(["view.fit", "view.zoomIn"]);
  });
});
