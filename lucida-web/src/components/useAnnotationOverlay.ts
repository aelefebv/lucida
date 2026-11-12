/**
 * The view-independent half of the 2D and 3D annotation overlays: the marks
 * read from the WASM scene for every dataset a view draws them for, which
 * mark's thread is open, and which one is selected for editing.
 *
 * The marks are re-read in an effect when `version` or the datasets change,
 * never during render or in the RAF tick. The open thread and the selection
 * clear when their mark vanishes or annotations are hidden. Projection and
 * gestures stay in the components.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { WasmScene } from "lucida-core";
import { readAnnotations, type Annotation } from "./annotationDocument.ts";

/** A pin and the dataset it belongs to, whose frame its points are in. Pin
 * ids are unique across datasets, so an id alone names a mark. */
export interface Mark {
  datasetId: string;
  pin: Annotation;
}

export interface AnnotationOverlayState {
  /** The authoritative marks (with threads) of the view's datasets, in their order. */
  marks: Mark[];
  /** Render-phase mirror of `marks` for per-frame (RAF) reads. */
  marksRef: RefObject<Mark[]>;
  /** Which pin's thread popover is open (by pin id), or null when none. */
  openPinId: string | null;
  setOpenPinId: Dispatch<SetStateAction<string | null>>;
  /** The annotation selected for editing, by id, or null. */
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  /** Re-read the marks now, so a pin this client just added can be opened
   * or selected in the same update without the vanish check closing it. */
  reread: () => void;
}

export function useAnnotationOverlay(opts: {
  wasmSceneRef: RefObject<WasmScene | null>;
  /** The datasets whose marks the view draws, in layer order. */
  datasetIds: readonly string[];
  /** Bumped whenever the remote document changes; re-reads the marks. */
  version: number;
  /** Personal, view-only visibility; `false` closes the thread. */
  visible: boolean;
}): AnnotationOverlayState {
  const { wasmSceneRef, datasetIds, version, visible } = opts;
  // Callers build the list each render, so the read keys on its contents.
  const datasetKey = JSON.stringify(datasetIds);
  const [read, setRead] = useState<Mark[]>([]);
  // The thread UI lives in <ThreadPopover>, keyed by pin id, so it remounts
  // with fresh draft state whenever the open pin changes.
  const [openPinId, setOpenPinId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reread = useCallback(() => {
    const scene = wasmSceneRef.current;
    const ids = JSON.parse(datasetKey) as string[];
    setRead(ids.flatMap((datasetId) => readAnnotations(scene, datasetId).map((pin) => ({ datasetId, pin }))));
  }, [wasmSceneRef, datasetKey]);

  useEffect(() => {
    reread();
  }, [reread, version]);

  // Until the re-read a change of datasets starts lands, a dataset the view
  // no longer draws keeps no marks in it.
  const marks = useMemo(() => {
    const ids = new Set(JSON.parse(datasetKey) as string[]);
    return read.filter((mark) => ids.has(mark.datasetId));
  }, [read, datasetKey]);

  useEffect(() => {
    // The mark backing the open thread or the selection was removed, or its
    // dataset left the view, so drop it rather than leave it dangling. An
    // external-data reset, so keep the effect.
    const exists = (id: string | null) => id !== null && marks.some((mark) => mark.pin.id === id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (openPinId !== null && !exists(openPinId)) setOpenPinId(null);
    if (selectedId !== null && !exists(selectedId)) setSelectedId(null);
  }, [marks, openPinId, selectedId]);

  useEffect(() => {
    // Hiding drops the open thread and selection, so a later re-show doesn't
    // pop a stale one.
    if (!visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenPinId(null);
      setSelectedId(null);
    }
  }, [visible]);

  // Render-phase mirror so the RAF loop reads the latest marks without
  // remounting. Written, never read, during render.
  const marksRef = useRef(marks);
  // eslint-disable-next-line react-hooks/refs
  marksRef.current = marks;

  return { marks, marksRef, openPinId, setOpenPinId, selectedId, setSelectedId, reread };
}
