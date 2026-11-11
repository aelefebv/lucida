import { describe, expect, it, vi } from "vitest";
import type { DocumentCommand } from "./commands.ts";
import { EditHistory, type DocumentEdit } from "./editHistory.ts";

const rename = (name: string): DocumentCommand => ({ type: "rename_dataset", id: "ds", name });
const edit = (from: string, to: string): DocumentEdit => ({ label: `renaming to ${to}`, redo: rename(to), undo: rename(from) });

describe("EditHistory", () => {
  it("takes edits back newest first and makes them again in order", () => {
    const history = new EditHistory();
    history.record(edit("a", "b"));
    history.record(edit("b", "c"));
    expect(history.getState().undo?.label).toBe("renaming to c");

    expect(history.takeUndo()?.undo).toEqual(rename("b"));
    expect(history.takeUndo()?.undo).toEqual(rename("a"));
    expect(history.takeUndo()).toBeNull();
    expect(history.getState()).toEqual({ undo: null, redo: edit("a", "b") });

    expect(history.takeRedo()?.redo).toEqual(rename("b"));
    expect(history.getState().redo?.label).toBe("renaming to c");
  });

  it("drops what redo would make again once a new edit is recorded", () => {
    const history = new EditHistory();
    history.record(edit("a", "b"));
    history.takeUndo();
    history.record(edit("a", "z"));
    expect(history.takeRedo()).toBeNull();
    expect(history.getState().undo?.label).toBe("renaming to z");
  });

  it("tells its subscribers of every change and keeps one state between them", () => {
    const history = new EditHistory();
    const listener = vi.fn();
    const stop = history.subscribe(listener);
    const before = history.getState();
    expect(history.getState()).toBe(before);
    history.record(edit("a", "b"));
    history.takeUndo();
    history.takeUndo();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    history.takeRedo();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
