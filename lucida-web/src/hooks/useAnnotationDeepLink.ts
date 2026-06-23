// The recipient side of an annotation DEEP-LINK (`#a=<annotationId>`,
// annotation-views slice 3): resolve the linked pin against the LOADED workspace
// document, run the slice-2 LIGHT restore + focus, and collapse the hash to the
// live `#view=` form — or surface a graceful "couldn't be found".
//
// TIMING IS THE WHOLE POINT (and why this is a hook keyed on the remote-document
// version rather than a line in UrlSync's scene-bootstrap):
//
//   Annotations exist only AFTER the workspace document snapshot has loaded into
//   the scene. UrlSync's bootstrap fires when the SCENE first appears, which is
//   BEFORE the doc snapshot lands — resolving there would search an empty
//   document and focus an unloaded pin (the #802 class: focus no-ops on a pin
//   that isn't in the overlay yet). So we re-check on every `docVersion` bump
//   (the bridge bumps it once a snapshot/command applies) and act on the FIRST
//   tick where the pin is actually readable.
//
// The `handledRef` gate makes the restore fire ONCE per link id: a peer's later
// comment bumps `docVersion` again but must not re-yank the camera. A not-found
// result does NOT mark the id handled, so a pin that arrives in a later bump
// (e.g. created live by a peer) can still resolve and clear the notice.
//
// NEVER-LEAK: a recipient who lacks workspace access never reaches this hook —
// the workspace load fails at the gate first (see WorkspaceRoot). When the
// recipient DOES have access but the id isn't in the doc, the result is plain
// `not-found` — the SAME outcome as a deleted/forged id — surfaced as a
// non-blocking notice, never a confirmation that the annotation existed.

import { useEffect, useRef } from "react";
import {
  resolveAnnotationDeepLink,
  type AnnotationDocScene,
} from "../savedView/annotationDeepLink.ts";
import { parseAnnotationHash } from "../savedView/urlSync.ts";
import type { Annotation } from "../components/AnnotationOverlay.tsx";

export interface UseAnnotationDeepLinkParams {
  /** The live scene (annotations are read from it), or null before it exists. */
  getScene: () => AnnotationDocScene | null;
  /** Bumped by the bridge whenever the workspace document changes (a snapshot or
   *  command applied). The hook re-checks the deep-link on each bump — this is
   *  the post-doc-load signal that makes the timing correct. */
  docVersion: number;
  /** Reads `window.location.hash` (injectable for tests). Defaults to the live
   *  location hash. */
  getHash?: () => string;
  /** Perform the slice-2 LIGHT restore + focus of the resolved pin against its
   *  owning dataset, then invoke `onRestored` once the restore has ACTUALLY
   *  applied. The host wires this to `restoreAnnotationDeepLinkPin` (selecting
   *  the pin's dataset so the overlay mounts, then restoring). `onRestored` is
   *  the hash-collapse: it MUST run after the restore lands — the restore may be
   *  deferred a frame when the pin is on a not-yet-selected dataset, and
   *  collapsing before it applies would capture the PRE-restore camera into
   *  `#view=` (a stale frame in the URL for the ~one-frame window). */
  onRestore: (pin: Annotation, datasetId: string, onRestored: () => void) => void;
  /** Collapse the `#a=` hash to the live `#view=` form. Handed to `onRestore`
   *  to run in its tail (after the restore applies), NOT called directly here —
   *  see `onRestore`. */
  onCollapseHash: () => void;
  /** Surface (true) or clear (false) the graceful "couldn't be found" notice. */
  onNotFound: (notFound: boolean) => void;
}

/**
 * Resolve a `#a=<id>` deep-link once the workspace document's annotations are
 * loaded. Idempotent per link id; safe to call before the scene/doc exist (it
 * simply waits for the next `docVersion` bump).
 */
export function useAnnotationDeepLink({
  getScene,
  docVersion,
  getHash = () => window.location.hash,
  onRestore,
  onCollapseHash,
  onNotFound,
}: UseAnnotationDeepLinkParams): void {
  // Which `#a=<id>` we've already restored, so we fire once per link rather than
  // on every doc-version bump.
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    const scene = getScene();
    if (!scene) return;
    const annotationId = parseAnnotationHash(getHash());
    if (annotationId === null) return;
    if (handledRef.current === annotationId) return;

    const result = resolveAnnotationDeepLink(scene, annotationId);
    if (result.status === "not-found") {
      // The doc has loaded (scene + a version) but the id isn't present. Surface
      // the notice WITHOUT marking handled, so a later bump that DOES carry the
      // pin still restores it and clears the notice.
      onNotFound(true);
      return;
    }

    handledRef.current = annotationId;
    onNotFound(false);
    // Hand the collapse to the restore so it runs AFTER the restore applies
    // (the restore can defer a frame). Collapsing here, synchronously, would
    // snapshot the pre-restore camera into `#view=` — a stale frame in the URL.
    onRestore(result.annotation, result.datasetId, onCollapseHash);
    // Re-run on each doc-version bump (the post-doc-load signal); the callbacks
    // are stable from the host. `handledRef` keeps it once-per-link.
  }, [docVersion, getScene, getHash, onRestore, onCollapseHash, onNotFound]);
}
