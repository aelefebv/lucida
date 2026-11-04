// The recipient side of an annotation deep-link (`#a=<annotationId>`): resolve
// the pin against the loaded workspace document, restore and focus it, and
// collapse the hash to the live `#view=` form, or show a "couldn't be found"
// notice.
//
// Keyed on the document version, not UrlSync's scene bootstrap: the scene
// appears before the document snapshot lands, and resolving then would search
// an empty document. The restore fires once per link id, so a peer's later edit
// doesn't re-yank the camera. A missing id is reported exactly like a deleted
// or forged one, so the notice never confirms the annotation existed.

import { useEffect, useRef } from "react";
import {
  resolveAnnotationDeepLink,
  type AnnotationDocScene,
} from "../savedView/annotationDeepLink.ts";
import { parseAnnotationHash } from "../savedView/urlSync.ts";
import type { Annotation } from "../components/annotationDocument.ts";

export interface UseAnnotationDeepLinkParams {
  getScene: () => AnnotationDocScene | null;
  /** Bumped by the bridge whenever a snapshot or command applies. The hook
   *  re-checks the deep-link on each bump. */
  docVersion: number;
  /** Defaults to `window.location.hash`. */
  getHash?: () => string;
  /** Restore and focus the pin on its dataset, then call `onRestored` once the
   *  restore has applied. The restore may defer a frame when the pin's dataset
   *  isn't selected yet, and collapsing earlier would write the pre-restore
   *  camera into `#view=`. */
  onRestore: (pin: Annotation, datasetId: string, onRestored: () => void) => void;
  /** Collapse `#a=` to `#view=`. Passed to `onRestore`, never called directly. */
  onCollapseHash: () => void;
  /** Show (true) or clear (false) the "couldn't be found" notice. */
  onNotFound: (notFound: boolean) => void;
}

/**
 * Resolve a `#a=<id>` deep-link once the document's annotations are loaded.
 * Safe to call before the scene exists; it waits for the next `docVersion`.
 */
export function useAnnotationDeepLink({
  getScene,
  docVersion,
  getHash = () => window.location.hash,
  onRestore,
  onCollapseHash,
  onNotFound,
}: UseAnnotationDeepLinkParams): void {
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    const scene = getScene();
    if (!scene) return;
    const annotationId = parseAnnotationHash(getHash());
    if (annotationId === null) return;
    if (handledRef.current === annotationId) return;

    const result = resolveAnnotationDeepLink(scene, annotationId);
    if (result.status === "not-found") {
      // Not marked handled, so a pin that arrives in a later bump (created live
      // by a peer) still restores and clears the notice.
      onNotFound(true);
      return;
    }

    handledRef.current = annotationId;
    onNotFound(false);
    onRestore(result.annotation, result.datasetId, onCollapseHash);
  }, [docVersion, getScene, getHash, onRestore, onCollapseHash, onNotFound]);
}
