import { useMemo, useState } from "react";
import {
  Autocomplete,
  Dialog as AriaDialog,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { runCommand, searchCommands, useCommandList } from "./commands.ts";
import { Kbd } from "./Kbd.tsx";
import { useShortcutList, type KeyCombo } from "./shortcuts.ts";
import { SearchField } from "./TextField.tsx";
import "./Dialog.css";
import "./Overlay.css";
import "./CommandPalette.css";

export interface CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

/**
 * A searchable list of every registered command. Typing filters by partial
 * name, the arrow keys move, Enter runs, Escape clears and then closes.
 */
export function CommandPalette({ isOpen, onOpenChange }: CommandPaletteProps) {
  return (
    <ModalOverlay className="lc-dialog-overlay lc-command-overlay" isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal className="lc-dialog lc-command-palette" data-lc-overlay="">
        <AriaDialog className="lc-command-dialog" aria-label="Command palette">
          {({ close }) => <PaletteBody close={close} />}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Mounted while open, so each opening starts from an empty query. */
function PaletteBody({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const commands = useCommandList();
  const shortcuts = useShortcutList();
  const results = useMemo(() => searchCommands(commands, query), [commands, query]);
  // A command's keys are whatever shortcut shares its id.
  const keysById = useMemo(() => {
    const map = new Map<string, KeyCombo>();
    for (const shortcut of shortcuts) if (shortcut.keys[0]) map.set(shortcut.id, shortcut.keys[0]);
    return map;
  }, [shortcuts]);

  return (
    <Autocomplete inputValue={query} onInputChange={setQuery}>
      <SearchField label="Search commands" placeholder="Type a command" autoFocus className="lc-command-search" />
      <AriaMenu
        className="lc-menu lc-command-list"
        aria-label="Commands"
        items={results}
        dependencies={[keysById]}
        onAction={(id) => {
          close();
          runCommand(String(id));
        }}
        renderEmptyState={() => <div className="lc-command-empty">No commands match</div>}
      >
        {(command) => {
          const keys = keysById.get(command.id);
          return (
            <AriaMenuItem id={command.id} textValue={command.label} className="lc-menu-item lc-command-item">
              <span className="lc-menu-item-label">{command.label}</span>
              <span className="lc-command-group">{command.group}</span>
              <span className="lc-command-keys">{keys && <Kbd keys={keys} />}</span>
            </AriaMenuItem>
          );
        }}
      </AriaMenu>
    </Autocomplete>
  );
}
