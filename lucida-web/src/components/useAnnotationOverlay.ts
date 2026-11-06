/**
 * The view-independent half of the 2D and 3D annotation overlays: the pin set
 * read from the WASM scene, and which pin's thread is open.
 *
 * The pin set is re-read in an effect when `version` or the dataset changes,
 * never during render or in the RAF tick. The open thread closes when its pin
 * vanishes, the dataset changes, or annotations are hidden. Projection and
 * gestures stay in the components.
 */
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
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

  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  useEffect(() => {
    if (openPinId !== null && !annotations.some((p) => p.id === openPinId)) {
      // The pin backing the open thread was removed, so close it rather than
      // leave it dangling. An external-data reset, so keep the effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenPinId(null);
    }
  }, [annotations, openPinId]);

  useEffect(() => {
    // The open thread belongs to the previous dataset's pin.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenPinId(null);
  }, [datasetId]);

  useEffect(() => {
    // Hiding drops the open thread so a later re-show doesn't pop a stale one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!visible) setOpenPinId(null);
  }, [visible]);

  // Render-phase mirror so the RAF loop reads the latest pins without
  // remounting. Written, never read, during render.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;

  return { annotations, annotationsRef, openPinId, setOpenPinId };
}
