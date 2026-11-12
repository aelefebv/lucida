/**
 * Editing that both annotation overlays share: deleting the selected
 * annotation from the Delete key or the context menu, Escape to deselect, and
 * dropping a point from the context menu. The overlays own the gestures and
 * the projection; this owns what an edit sends.
 */
import { useEffect, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { applyDocumentCommand } from "../applyAndSend.ts";
import type { SavedView } from "../savedView/types.ts";
import { useCommand } from "../ui/commands.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { toast } from "../ui/toastQueue.ts";
import type { Annotation } from "./annotationDocument.ts";
import type { AnnotationOverlayState, Mark } from "./useAnnotationOverlay.ts";

/** Where a new point goes: the dataset, the point's place across its frame and its depth. */
export interface AnnotationPlacement {
  datasetId: string;
  position: [number, number];
  z: number;
}

/** What to call an annotation in a label: point, line, or box. */
export function annotationNoun(pin: Annotation): string {
  return pin.kind === "line" || pin.kind === "box" ? pin.kind : "point";
}

/** A placement as people read coordinates, one decimal at most. */
export function formatCoordinates({ position, z }: AnnotationPlacement): string {
  const n = (v: number) => String(Number(v.toFixed(1)));
  return `x ${n(position[0])}, y ${n(position[1])}, z ${n(z)}`;
}

export function newAnnotationId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useAnnotationEditing({
  state,
  myId,
  active,
  wasmSceneRef,
  sendCommand,
  onDocumentChanged,
  onSelectDataset,
}: {
  state: AnnotationOverlayState;
  myId: string;
  /** Whether commands steer this view. Each view keeps its own selection, and
   * only the active one's answers Delete and Escape. */
  active: boolean;
  wasmSceneRef: RefObject<WasmScene | null>;
  sendCommand: (json: string) => void;
  onDocumentChanged: () => void;
  /** Select a layer, as a point placed on it does. */
  onSelectDataset: (datasetId: string) => void;
}) {
  const { marks, openPinId, setOpenPinId, selectedId, setSelectedId, reread } = state;
  // Deleting an annotation that has comments asks first, in its thread. The
  // nonce re-keys an already open thread so it remounts with the confirm armed.
  const [deleteRequest, setDeleteRequest] = useState<{ id: string; nonce: number } | null>(null);
  // A point made to comment on opens with its comment field focused, once.
  const [composeId, setComposeId] = useState<string | null>(null);
  const selected = marks.find(({ pin }) => pin.id === selectedId && pin.author === String(myId)) ?? null;

  useEffect(
    () => (selectedId === null || !active ? undefined : pushEscapeLayer(() => setSelectedId(null))),
    [selectedId, active, setSelectedId],
  );

  useEffect(() => {
    // The request is spent once its thread closes, so reopening it starts unarmed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (deleteRequest && openPinId !== deleteRequest.id) setDeleteRequest(null);
    if (composeId && openPinId !== composeId) setComposeId(null);
  }, [openPinId, deleteRequest, composeId]);

  /** Delete one's own annotation, through the thread's confirm when comments
   * would go with it. */
  const remove = ({ datasetId, pin }: Mark) => {
    if (pin.author !== String(myId)) return;
    if ((pin.comments?.length ?? 0) > 0) {
      setOpenPinId(pin.id);
      setDeleteRequest((prev) => ({ id: pin.id, nonce: (prev?.nonce ?? 0) + 1 }));
      return;
    }
    const scene = wasmSceneRef.current;
    if (!scene) return;
    applyDocumentCommand(scene, { type: "remove_annotation", dataset_id: datasetId, id: pin.id }, sendCommand);
    onDocumentChanged();
    const noun = annotationNoun(pin);
    toast(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} deleted`);
  };

  const removeSelected = () => {
    if (selected) remove(selected);
  };

  // Every view's overlay offers this; only the active one's is enabled, as
  // two enabled commands may not share an id.
  useCommand({
    id: "annotations.deleteSelected",
    label: selected ? `Delete the selected ${annotationNoun(selected.pin)}` : "Delete the selected annotation",
    group: "Annotations",
    keys: ["Delete", "Backspace"],
    enabled: selected !== null && active,
    run: removeSelected,
  });

  /** Add a point of one's own on its dataset, select that layer, and
   * optionally open the point's thread to comment. */
  const addPoint = (
    at: AnnotationPlacement,
    context: { t: number; c: number; view: SavedView | null; openThread: boolean },
  ) => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const id = newAnnotationId();
    // Applied locally and sent, as a drawn point is: the server's rebroadcast
    // leaves out the sender.
    applyDocumentCommand(
      scene,
      {
        type: "add_annotation",
        dataset_id: at.datasetId,
        id,
        position: at.position,
        end: null,
        z: at.z,
        t: context.t,
        c: context.c,
        author: String(myId),
        kind: "point",
        ...(context.view ? { view: context.view } : {}),
      },
      sendCommand,
    );
    onDocumentChanged();
    onSelectDataset(at.datasetId);
    if (context.openThread) {
      reread();
      setOpenPinId(id);
      setSelectedId(id);
      setComposeId(id);
    }
  };

  return {
    /** The selected annotation, when it is one's own to edit. */
    selected,
    /** Delete the selected annotation, as the Delete key does. */
    removeSelected,
    addPoint,
    /** The key for a pin's thread, which a delete request changes. */
    threadKey: (pinId: string) => (deleteRequest?.id === pinId ? `${pinId}:delete:${deleteRequest.nonce}` : pinId),
    /** Whether a pin's thread opens with its delete confirm showing. */
    armsDelete: (pinId: string) => deleteRequest?.id === pinId,
    /** Whether a pin's thread opens with its comment field focused. */
    focusesComposer: (pinId: string) => composeId === pinId,
  };
}
