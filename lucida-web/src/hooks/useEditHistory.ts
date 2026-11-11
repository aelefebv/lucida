import { useCallback, useState, useSyncExternalStore } from "react";
import { applyDocumentCommand } from "../applyAndSend.ts";
import { EditHistory, type DocumentEdit } from "../editHistory.ts";
import type { Engine } from "../engine.ts";
import { useCommand } from "../ui/commands.ts";
import type { KeyCombo } from "../ui/shortcuts.ts";

const UNDO_KEYS: readonly KeyCombo[] = ["Mod+Z"];
const REDO_KEYS: readonly KeyCombo[] = ["Mod+Shift+Z", "Mod+Y"];

export interface EditHistoryControls {
  /** Record a document edit this page just made and sent, for undo. */
  record(edit: DocumentEdit): void;
}

/**
 * The page's undo history of document edits, with Undo and Redo as commands
 * and keys. Undoing sends the edit's opposite, so it reaches peers and the
 * stored workspace as the edit did.
 */
export function useEditHistory({
  engine,
  sendCommand,
  onDocumentChanged,
}: {
  engine: Engine;
  sendCommand: (json: string) => void;
  /** Tell the page the document changed here, as a peer's edit does. */
  onDocumentChanged: () => void;
}): EditHistoryControls {
  const [history] = useState(() => new EditHistory());
  const state = useSyncExternalStore(history.subscribe, history.getState, history.getState);

  const send = useCallback(
    (edit: DocumentEdit | null, side: "undo" | "redo") => {
      const scene = engine.scene();
      if (!edit || !scene) return;
      applyDocumentCommand(scene, edit[side], sendCommand, engine.loop());
      onDocumentChanged();
    },
    [engine, sendCommand, onDocumentChanged],
  );

  useCommand({
    id: "edit.undo",
    label: state.undo ? `Undo ${state.undo.label}` : "Undo",
    group: "General",
    keys: UNDO_KEYS,
    enabled: state.undo !== null,
    run: () => send(history.takeUndo(), "undo"),
  });
  useCommand({
    id: "edit.redo",
    label: state.redo ? `Redo ${state.redo.label}` : "Redo",
    group: "General",
    keys: REDO_KEYS,
    enabled: state.redo !== null,
    run: () => send(history.takeRedo(), "redo"),
  });

  const record = useCallback((edit: DocumentEdit) => history.record(edit), [history]);
  return { record };
}
