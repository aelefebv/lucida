// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { __resetCommandsForTesting, useCommand } from "./commands.ts";
import { KeyboardHelp } from "./KeyboardHelp.tsx";
import { showKeyboardHelp } from "./keyboardHelpState.ts";
import { __resetShortcutsForTesting, useShortcut } from "./shortcuts.ts";

afterEach(() => {
  cleanup();
  act(() => showKeyboardHelp(null));
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
});

function Features({ zoomIn = () => {}, onLeft = () => {} }: { zoomIn?: () => void; onLeft?: () => void }) {
  useCommand({ id: "view.zoomIn", label: "Zoom in", group: "View", keys: ["+", "="], run: zoomIn });
  useCommand({ id: "view.zoomOut", label: "Zoom out", group: "View", keys: ["-"], run: () => {} });
  useCommand({ id: "panels.toggleLeft", label: "Show or hide the layers panel", group: "Panels", run: onLeft });
  // Bound by its owner, apart from the command above, under the same id.
  useShortcut({ id: "panels.toggleLeft", keys: ["Alt+["], label: "Toggle left", group: "Panels", onTrigger: onLeft });
  useShortcut({
    id: "fly.move",
    keys: ["W", "A", "S", "D"],
    label: "Move forward, left, back, right",
    group: "Fly camera",
    scope: "fly",
    onTrigger: () => {},
  });
  return null;
}

function App({ withFeatures = true, zoomIn }: { withFeatures?: boolean; zoomIn?: () => void }) {
  return (
    <>
      {withFeatures && <Features zoomIn={zoomIn} />}
      <KeyboardHelp />
    </>
  );
}

async function pressOnWindow(init: KeyboardEventInit) {
  await act(async () => {
    fireEvent.keyDown(window, init);
  });
}

/** The open palette's search field, focused as a browser leaves it. */
async function paletteSearch(): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const search = within(dialog).getByRole("searchbox");
  // A browser focuses the field on open; happy-dom leaves focus on the
  // dialog, and the list follows the keys only from the field.
  act(() => search.focus());
  return search;
}

/** Type into the field. The list moves to its first match on typed input only. */
async function type(search: HTMLElement, value: string) {
  await act(async () => {
    fireEvent(search, new InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true }));
    fireEvent.change(search, { target: { value } });
  });
}

async function enter(search: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(search, { key: "Enter" });
  });
}

describe("the command palette", () => {
  it("opens on Mod+K, finds a command by partial name, and runs it on Enter", async () => {
    const zoomIn = vi.fn();
    render(<App zoomIn={zoomIn} />);
    await pressOnWindow({ key: "k", code: "KeyK", ctrlKey: true });
    const search = await paletteSearch();

    await type(search, "zoo");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      expect.stringContaining("Zoom in"),
      expect.stringContaining("Zoom out"),
    ]);

    await enter(search);
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("shows each command's shortcut, wherever the key was bound", async () => {
    render(<App />);
    act(() => showKeyboardHelp("commandPalette"));
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const row = (label: string) =>
      within(dialog)
        .getAllByRole("menuitem")
        .find((item) => item.textContent?.includes(label))!;
    expect(row("Zoom in").querySelector(".lc-kbd")?.textContent).toBe("+");
    expect(row("layers panel").querySelector(".lc-kbd")?.textContent).toBe("Alt[");
    expect(row("Keyboard shortcuts").querySelector(".lc-kbd")?.textContent).toBe("?");
  });

  it("says so when nothing matches, and runs nothing", async () => {
    const zoomIn = vi.fn();
    render(<App zoomIn={zoomIn} />);
    act(() => showKeyboardHelp("commandPalette"));
    const search = await paletteSearch();
    await type(search, "nothing like this");
    expect(screen.getByText("No commands match")).toBeTruthy();
    await enter(search);
    expect(zoomIn).not.toHaveBeenCalled();
  });

  it("hands over to the shortcut sheet from its own command", async () => {
    render(<App />);
    act(() => showKeyboardHelp("commandPalette"));
    const search = await paletteSearch();
    await type(search, "keyboard");
    await enter(search);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("closes on Mod+K from its own field instead of passing the key to the browser", async () => {
    render(<App />);
    act(() => showKeyboardHelp("commandPalette"));
    const search = await paletteSearch();
    const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      search.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});

describe("the shortcut sheet", () => {
  it("gives way to the palette on Mod+K", async () => {
    render(<App />);
    act(() => showKeyboardHelp("shortcutSheet"));
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await act(async () => {
      fireEvent.keyDown(sheet, { key: "k", code: "KeyK", ctrlKey: true });
    });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("opens on ? and lists every registered shortcut by group", async () => {
    render(<App />);
    await pressOnWindow({ key: "?", code: "Slash", shiftKey: true });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const groups = within(sheet)
      .getAllByRole("region")
      .map((section) => section.getAttribute("aria-label"));
    expect(groups).toEqual(["General", "Panels", "View", "Fly camera"]);

    const view = within(sheet).getByRole("region", { name: "View" });
    expect(within(view).getByText("Zoom in").nextElementSibling?.textContent).toBe("+=");
    const fly = within(sheet).getByRole("region", { name: "Fly camera" });
    expect(fly.textContent).toContain("in fly mode");
    expect(within(sheet).getByText("Command palette")).toBeTruthy();
  });

  it("follows the registry as features come and go", async () => {
    const { rerender } = render(<App />);
    act(() => showKeyboardHelp("shortcutSheet"));
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).queryByText("Zoom in")).toBeTruthy();
    rerender(<App withFeatures={false} />);
    expect(within(sheet).queryByText("Zoom in")).toBeNull();
  });
});
