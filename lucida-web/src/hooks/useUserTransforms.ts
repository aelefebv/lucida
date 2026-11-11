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
  type UserTransform,
} from "../userTransform.ts";
import type { EditHistoryControls } from "./useEditHistory.ts";

/** What places a dataset by hand: the Move and scale tool and the layer's fields. */
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
  /** Put `datasetId` back where its metadata places it. */
  reset(datasetId: string): void;
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
        redo,
        undo: setUserTransformCommand(datasetId, from),
      });
    };
    return {
      canEdit,
      current,
      preview,
      commit,
      reset(datasetId) {
        commit(datasetId, current(datasetId), IDENTITY_USER_TRANSFORM);
      },
    };
  }, [engine, canEdit, sendCommand, history, nameOf, onDocumentChanged]);
}
