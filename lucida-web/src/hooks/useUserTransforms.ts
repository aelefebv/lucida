import { useMemo } from "react";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { Engine } from "../engine.ts";
import { invalidateDisplaySettings } from "../invalidation.ts";
import { guardedSceneCall } from "../sceneGuard.ts";
import {
  IDENTITY_USER_TRANSFORM,
  readUserTransform,
  sameUserTransform,
  setUserTransformCommand,
  userTransformTurned,
  type UserTransform,
} from "../userTransform.ts";
import type { PlacementChange } from "../savedView/applier.ts";
import { toast } from "../ui/toastQueue.ts";
import type { EditHistoryControls } from "./useEditHistory.ts";

/** What places a dataset by hand: the Move, scale and rotate tool and the layer's fields. */
export interface UserTransformActions {
  /** Whether this member may place datasets, which changes the shared workspace. */
  canEdit: boolean;
  /** `datasetId`'s transform now, the identity where nobody placed it. */
  current(datasetId: string): UserTransform;
  /** Draw `datasetId` at `transform` on this page alone, as a drag shows it
   *  before it lets go. A commit or a cancel follows. */
  preview(datasetId: string, transform: UserTransform): void;
  /** Place `datasetId` at `to` for everyone, from `from`, as one step undo
   *  takes back. Nothing when the two are the same. */
  commit(datasetId: string, from: UserTransform, to: UserTransform): void;
  /** Turn `datasetId` to `degrees` about X, then Y, then Z, about its
   *  center, from `from`, as one step undo takes back: the transform that
   *  placed it, or null where nothing did. */
  turnTo(datasetId: string, from: UserTransform, degrees: [number, number, number]): UserTransform | null;
  /** Put `datasetId` back where its metadata places it. */
  reset(datasetId: string): void;
  /** Make placements a chosen saved view just restored one step undo takes
   *  back, and say so. Nothing when it changed none. */
  restored(changes: readonly PlacementChange[]): void;
}

export function useUserTransforms({
  engine,
  canEdit,
  sendCommand,
  history,
  nameOf,
  onDocumentChanged,
}: {
  engine: Engine;
  canEdit: boolean;
  sendCommand: (json: string) => void;
  history: EditHistoryControls;
  nameOf: (datasetId: string) => string;
  /** Tell the page the document changed here, so the layer panel and the
   *  saved-view capture read the new placement. */
  onDocumentChanged: () => void;
}): UserTransformActions {
  return useMemo(() => {
    const current = (datasetId: string) => {
      const scene = engine.scene();
      return (scene && readUserTransform(scene, datasetId)) ?? IDENTITY_USER_TRANSFORM;
    };
    const preview = (datasetId: string, transform: UserTransform) => {
      const scene = engine.scene();
      if (!scene || !canEdit) return;
      const json = JSON.stringify(setUserTransformCommand(datasetId, transform));
      guardedSceneCall("apply_command", scene, () => scene.apply_command(json));
      invalidateDisplaySettings(engine.loop(), "user_transform_preview");
    };
    const commit = (datasetId: string, from: UserTransform, to: UserTransform) => {
      const scene = engine.scene();
      if (!scene || !canEdit) return;
      // A gesture that ends where it began takes back its preview and sends
      // nothing, so the workspace records no step that changed nothing.
      if (sameUserTransform(from, to)) {
        preview(datasetId, from);
        return;
      }
      const redo = setUserTransformCommand(datasetId, to);
      applyDocumentCommand(scene, redo, sendCommand, engine.loop());
      onDocumentChanged();
      history.record({
        label: `placing ${nameOf(datasetId)}`,
        redo: [redo],
        undo: [setUserTransformCommand(datasetId, from)],
      });
    };
    return {
      canEdit,
      current,
      preview,
      commit,
      turnTo(datasetId, from, degrees) {
        const scene = engine.scene();
        const to = scene && canEdit ? userTransformTurned(scene, datasetId, from, degrees) : null;
        if (to) commit(datasetId, from, to);
        return to;
      },
      reset(datasetId) {
        commit(datasetId, current(datasetId), IDENTITY_USER_TRANSFORM);
      },
      restored(changes) {
        if (changes.length === 0) return;
        onDocumentChanged();
        const edit = {
          label: "restoring the saved positions",
          redo: changes.map((c) => setUserTransformCommand(c.datasetId, c.to)),
          undo: changes.map((c) => setUserTransformCommand(c.datasetId, c.from)),
        };
        history.record(edit);
        toast({
          title: "Restored the positions saved with this view.",
          description: "Undo to keep the current ones.",
          action: { label: "Undo", onPress: () => history.undo(edit) },
        });
      },
    };
  }, [engine, canEdit, sendCommand, history, nameOf, onDocumentChanged]);
}
