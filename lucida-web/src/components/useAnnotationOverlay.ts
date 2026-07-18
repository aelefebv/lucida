/**
 * Shared document/thread state for an annotation overlay — the view-independent
 * half of {@link AnnotationOverlay} (2D) and {@link AnnotationOverlay3D} (3D).
 *
 * Both overlays hold exactly the same non-dimensional state: the authoritative
 * pin set read from the WASM scene, and WHICH pin's thread popover is open.
 * This hook owns both, plus every lifecycle rule that keeps them honest:
 *
 * - **Re-read on epoch**: the pin set is re-read whenever the remote-document
 *   `version` bumps (a pin/comment was added/removed locally or by a peer) or
 *   the scoped dataset changes. Reading happens in an effect (never render) so
 *   the scene ref is not touched mid-render; each overlay's RAF tick only
 *   repositions existing DOM nodes and never re-reads.
 * - **Close on vanish**: if the pin whose thread is open disappears (removed by
 *   its author or a peer), the popover closes so it can't dangle.
 * - **Close on dataset change**: the open thread belongs to the previous
 *   dataset's pin, so switching datasets closes it.
 * - **Close on hide** (issue #792): hiding all annotations drops the open
 *   thread so a later re-show starts from a quiet baseline (no stale popover
 *   popping open). The set itself is untouched — hidden, not deleted — so
 *   flipping back re-renders everything exactly as it was.
 *
 * It also mirrors the latest pin set into a ref (`annotationsRef`) so each
 * overlay's RAF projection loop reads it per frame without remounting when the
 * set changes — the same render-phase, write-only mirror pattern PeerCursors
 * uses.
 *
 * Everything dimensional stays in the components: marker projection, the pin
 * gestures (pan vs orbit), `focusPin`'s recenter mechanics, and the 2D-only
 * hover-revealed shape handles.
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
  /** Run an external focus exactly when `pinId` exists in this overlay's
   * authoritative set. The promise resolves after the supplied scene mutation
   * completes; a newer request supersedes an older queued one. */
  focusPinWhenAvailable: (
    pinId: string,
    focus: (pin: Annotation) => boolean | Promise<boolean>,
  ) => Promise<boolean>;
}

export function useAnnotationOverlay(opts: {
  wasmSceneRef: RefObject<WasmScene | null>;
  datasetId: string;
  /** Bumped whenever the remote document changes; re-reads the pin set. */
  version: number;
  /** Personal, view-only visibility (issue #792); `false` closes the thread. */
  visible: boolean;
}): AnnotationOverlayState {
  const { wasmSceneRef, datasetId, version, visible } = opts;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Which pin's thread popover is open. The overlay owns only WHICH pin is open
  // and where it sits on screen; the thread UI itself (comment list, add box,
  // edit/remove, delete+confirm) lives in the shared <ThreadPopover>, which owns
  // its own ephemeral draft/edit/confirm state and is remounted (keyed by pin
  // id) whenever the open pin changes.
  const [openPinId, setOpenPinId] = useState<string | null>(null);

  // Re-read the authoritative pin set whenever the document version changes or
  // the scoped dataset changes.
  useEffect(() => {
    setAnnotations(readAnnotations(wasmSceneRef.current, datasetId));
  }, [wasmSceneRef, datasetId, version]);

  // If the pin whose thread is open disappears, close the popover.
  useEffect(() => {
    if (openPinId !== null && !annotations.some((p) => p.id === openPinId)) {
      // Deliberate cleanup: the pin backing the open thread was removed (by its
      // author or a peer, or the dataset changed), so the popover must close or
      // it would dangle. External-data-driven reset, not avoidable derived
      // render state — keep the effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenPinId(null);
    }
  }, [annotations, openPinId]);

  useEffect(() => {
    // Deliberate transient-UI reset on a prop (dataset) change: the open thread
    // belongs to the previous dataset's pin, so switching datasets must close
    // it. Syncing transient state to a changed prop — keep the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenPinId(null);
  }, [datasetId]);

  useEffect(() => {
    // Deliberate transient-UI reset on a prop (visibility) change: hiding the
    // overlay drops the open thread so a later re-show starts clean (no stale
    // popover pops open). Runs on the false→… transition (and harmlessly while
    // staying hidden); when visible it's inert.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!visible) setOpenPinId(null);
  }, [visible]);

  // Mirror the latest pins into a ref so each overlay's RAF loop reads them
  // without remounting when the set changes. Written, never read, during this
  // render — the idempotent render-phase mirror pattern.
  const annotationsRef = useRef(annotations);
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations;

  const pendingFocusRef = useRef<{
    pinId: string;
    focus: (pin: Annotation) => boolean | Promise<boolean>;
    resolve: (focused: boolean) => void;
    reject: (error: unknown) => void;
  } | null>(null);
  const [focusRequestVersion, setFocusRequestVersion] = useState(0);

  const runFocus = useCallback((
    pin: Annotation,
    focus: (pin: Annotation) => boolean | Promise<boolean>,
  ): Promise<boolean> => {
    try {
      return Promise.resolve(focus(pin));
    } catch (error) {
      return Promise.reject(error);
    }
  }, []);

  const focusPinWhenAvailable = useCallback((
    pinId: string,
    focus: (pin: Annotation) => boolean | Promise<boolean>,
  ): Promise<boolean> => {
    const pin = annotationsRef.current.find((candidate) => candidate.id === pinId);
    if (pin) return runFocus(pin, focus);
    return new Promise<boolean>((resolve, reject) => {
      pendingFocusRef.current?.resolve(false);
      pendingFocusRef.current = { pinId, focus, resolve, reject };
      setFocusRequestVersion((version) => version + 1);
    });
  }, [annotationsRef, runFocus]);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const pin = annotations.find((candidate) => candidate.id === pending.pinId);
    if (!pin) return;
    pendingFocusRef.current = null;
    void runFocus(pin, pending.focus).then(pending.resolve, pending.reject);
  }, [annotations, focusRequestVersion, runFocus]);

  useEffect(() => () => {
    pendingFocusRef.current?.resolve(false);
    pendingFocusRef.current = null;
  }, []);

  return {
    annotations,
    annotationsRef,
    openPinId,
    setOpenPinId,
    focusPinWhenAvailable,
  };
}
