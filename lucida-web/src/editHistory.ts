/**
 * Undo and redo of the document edits made on this page. An edit records the
 * commands that make it and the commands that take it back, and undoing one
 * sends the second like any other edit, so peers and the stored workspace
 * follow. Only this page's edits are recorded, so undo never takes back a
 * peer's work, and the history ends with the page.
 */
import type { DocumentCommand } from "./commands.ts";

export interface DocumentEdit {
  /** Says what the edit did, after "Undo" or "Redo", e.g. "placing volume.ome.zarr". */
  label: string;
  redo: readonly DocumentCommand[];
  undo: readonly DocumentCommand[];
}

export interface EditHistoryState {
  /** The edit an undo takes back, or null. */
  undo: DocumentEdit | null;
  /** The edit a redo makes again, or null. */
  redo: DocumentEdit | null;
}

/** Edits kept for undo; the oldest go first. */
const HISTORY_LIMIT = 100;

export class EditHistory {
  private done: DocumentEdit[] = [];
  private undone: DocumentEdit[] = [];
  private state: EditHistoryState = { undo: null, redo: null };
  private readonly listeners = new Set<() => void>();

  /** Record an edit just made. A new edit ends the redo branch. */
  record(edit: DocumentEdit): void {
    this.done.push(edit);
    if (this.done.length > HISTORY_LIMIT) this.done.shift();
    this.undone = [];
    this.changed();
  }

  /** The edit to take back, moved onto the redo side, or null. With `only`,
   *  null unless that edit is the newest, so a stale prompt can't take back a
   *  later one. */
  takeUndo(only?: DocumentEdit): DocumentEdit | null {
    if (only && this.done.at(-1) !== only) return null;
    const edit = this.done.pop() ?? null;
    if (edit) {
      this.undone.push(edit);
      this.changed();
    }
    return edit;
  }

  /** The edit to make again, moved back onto the undo side, or null. */
  takeRedo(): DocumentEdit | null {
    const edit = this.undone.pop() ?? null;
    if (edit) {
      this.done.push(edit);
      this.changed();
    }
    return edit;
  }

  getState = (): EditHistoryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    this.state = { undo: this.done.at(-1) ?? null, redo: this.undone.at(-1) ?? null };
    for (const listener of [...this.listeners]) listener();
  }
}
