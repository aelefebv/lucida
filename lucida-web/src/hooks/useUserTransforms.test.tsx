// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Engine } from "../engine.ts";
import { SavedViewApplier } from "../savedView/applier.ts";
import { buildCapture } from "../savedView/captureBuilder.ts";
import { __resetCommandsForTesting, runCommand } from "../ui/commands.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { toastQueue } from "../ui/toastQueue.ts";
import { readUserTransform, setUserTransformCommand, type UserTransform } from "../userTransform.ts";
import { VIEWPORTS, fixture, joinedScene, loadWasm, renamed } from "../viewProperties.ts";
import { useEditHistory } from "./useEditHistory.ts";
import { useUserTransforms } from "./useUserTransforms.ts";

beforeAll(loadWasm);

afterEach(() => {
  cleanup();
  toastQueue.clear();
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
});

const moved: UserTransform = { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] };

/** A page holding datasets `a` and `b`, with its placement actions and undo. */
function page() {
  const scene = joinedScene(VIEWPORTS[0], 1, [renamed(fixture("volume"), "a"), renamed(fixture("volume"), "b")]);
  const sent: string[] = [];
  const sendCommand = (json: string) => sent.push(json);
  const engine = { scene: () => scene, loop: () => null } as unknown as Engine;
  const { result } = renderHook(() => {
    const history = useEditHistory({ engine, sendCommand, onDocumentChanged: () => {} });
    return useUserTransforms({ engine, canEdit: true, sendCommand, history, nameOf: (id) => id, onDocumentChanged: () => {} });
  });
  return { scene, sent, actions: () => result.current };
}

describe("useUserTransforms", () => {
  it("makes the positions a chosen saved view restores one undoable step, and says so", async () => {
    const { scene, sent, actions } = page();
    // A view saved with both datasets where they declare.
    const view = buildCapture({ scene, urlByDatasetId: new Map(), datasetReferenceMode: "workspace-dataset-id" });
    // A colleague has moved b since.
    scene.apply_command(JSON.stringify(setUserTransformCommand("b", moved)));
    const applier = new SavedViewApplier(
      { sendOpenRemoteDataset: () => {}, sendCommand: (json) => sent.push(json) },
      () => scene,
      (url) => url,
      1000,
      "workspace-dataset-id",
      "broadcast",
    );
    const placed = await applier.apply(view, { chosen: true });
    act(() => actions().restored(placed));
    expect(readUserTransform(scene, "b")).toBeNull();
    expect(toastQueue.visibleToasts.map((t) => t.content.title)).toEqual([
      "Restored the positions saved with this view.",
    ]);

    act(() => {
      runCommand("edit.undo");
    });
    expect(readUserTransform(scene, "b")).toEqual(moved);
    expect(JSON.parse(sent.at(-1)!)).toEqual(setUserTransformCommand("b", moved));
  });

  it("says nothing and records nothing when a restore moved no dataset", () => {
    const { actions } = page();
    act(() => actions().restored([]));
    expect(toastQueue.visibleToasts).toEqual([]);
    expect(runCommand("edit.undo")).toBe(false);
  });

  it("takes back a placement made by hand and makes it again", () => {
    const { scene, actions } = page();
    act(() => actions().commit("a", actions().current("a"), moved));
    expect(readUserTransform(scene, "a")).toEqual(moved);
    act(() => {
      runCommand("edit.undo");
    });
    expect(readUserTransform(scene, "a")).toBeNull();
    act(() => {
      runCommand("edit.redo");
    });
    expect(readUserTransform(scene, "a")).toEqual(moved);
  });
});
