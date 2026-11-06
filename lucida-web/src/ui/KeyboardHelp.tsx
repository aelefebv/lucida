import { CommandPalette } from "./CommandPalette.tsx";
import { useCommand } from "./commands.ts";
import { showKeyboardHelp, useKeyboardHelp } from "./keyboardHelpState.ts";
import { ShortcutSheet } from "./ShortcutSheet.tsx";
import { useShortcut } from "./shortcuts.ts";

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
