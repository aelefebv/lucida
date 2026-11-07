/**
 * The view-independent half of the 2D and 3D annotation overlays: the pin set
 * read from the WASM scene, which pin's thread is open, and which annotation is
 * selected for editing.
 *
 * The pin set is re-read in an effect when `version` or the dataset changes,
 * never during render or in the RAF tick. The open thread and the selection
 * clear when their pin vanishes, the dataset changes, or annotations are
 * hidden. Projection and gestures stay in the components.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { WasmScene } from "lucida-core";
import { readAnnotations, type Annotation } from "./annotationDocument.ts";

export interface AnnotationOverlayState {
  /** The authoritative pin set (with threads) for the scoped dataset. */
  annotations: Annotation[];
  /** Render-phase mirror of `annotations` for per-frame (RAF) reads. */
  annotationsRef: RefObject<Annotation[]>;
  /** Which pin's thread popover is open (by pin id), or null when none. */
  openPinId: string | null;
  setOpenPinId: Dispatch<SetStateAction<string | null>>;
  /** The annotation selected for editing, by id, or null. */
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  /** Re-read the pin set now, so a pin this client just added can be opened
   * or selected in the same update without the vanish check closing it. */
  reread: () => void;
}

export function useAnnotationOverlay(opts: {
  wasmSceneRef: RefObject<WasmScene | null>;
  datasetId: string;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** Personal, view-only visibility; `false` closes the thread. */
  visible: boolean;
}): AnnotationOverlayState {
  const { wasmSceneRef, datasetId, version, visible } = opts;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // The thread UI lives in <ThreadPopover>, keyed by pin id, so it remounts
  // with fresh draft state whenever the open pin changes.
  const [openPinId, setOpenPinId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reread = useCallback(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId]);

  useEffect(() => {
    reread();
  }, [reread, version]);

  useEffect(() => {
    // The pin backing the open thread or the selection was removed, so drop it
    // rather than leave it dangling. An external-data reset, so keep the effect.
    const exists = (id: string | null) => id !== null && annotations.some((p) => p.id === id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (openPinId !== null && !exists(openPinId)) setOpenPinId(null);
    if (selectedId !== null && !exists(selectedId)) setSelectedId(null);
  }, [annotations, openPinId, selectedId]);

  useEffect(() => {
    // The open thread and selection belong to the previous dataset's pins.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenPinId(null);
    setSelectedId(null);
  }, [datasetId]);

  useEffect(() => {
    // Hiding drops the open thread and selection, so a later re-show doesn't
    // pop a stale one.
    if (!visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenPinId(null);
      setSelectedId(null);
    }
  }, [visible]);

  // Render-phase mirror so the RAF loop reads the latest pins without
  // remounting. Written, never read, during render.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;

  return { annotations, annotationsRef, openPinId, setOpenPinId, selectedId, setSelectedId, reread };
}
