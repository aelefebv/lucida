import { useEffect } from "react";
import { CommandPalette } from "./CommandPalette.tsx";
import { useCommand } from "./commands.ts";
import { showKeyboardHelp, useKeyboardHelp } from "./keyboardHelpState.ts";
import { ShortcutSheet } from "./ShortcutSheet.tsx";
import { comboFromEvent, useShortcut } from "./shortcuts.ts";

/** The command palette and the shortcut sheet, with the keys that open them. Mount once. */
export function KeyboardHelp() {
  const open = useKeyboardHelp();

  useShortcut({
    id: "general.commandPalette",
    keys: ["Mod+K"],
    label: "Command palette",
    group: "General",
    onTrigger: () => showKeyboardHelp("commandPalette"),
  });
  useCommand({
    id: "general.shortcuts",
    keys: ["?"],
    label: "Keyboard shortcuts",
    group: "General",
    keywords: ["keys", "help"],
    run: () => showKeyboardHelp("shortcutSheet"),
  });

  // The registry stays quiet inside an overlay, so with the palette or the
  // sheet open Mod+K would reach the browser, which takes it for its own
  // search box. Here it closes the palette, or swaps the sheet for it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (comboFromEvent(event) !== "Mod+K") return;
      event.preventDefault();
      event.stopPropagation();
      showKeyboardHelp(open === "commandPalette" ? null : "commandPalette");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const closeOnFalse = (isOpen: boolean) => {
    if (!isOpen) showKeyboardHelp(null);
  };
  return (
    <>
      <CommandPalette isOpen={open === "commandPalette"} onOpenChange={closeOnFalse} />
      <ShortcutSheet isOpen={open === "shortcutSheet"} onOpenChange={closeOnFalse} />
    </>
  );
}
