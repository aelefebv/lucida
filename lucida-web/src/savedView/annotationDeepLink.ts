// Resolving a `#a=<annotation-id>` workspace-scoped annotation DEEP-LINK against
// the LOADED workspace document (annotation-views slice 3).
//
// This is the recipient half of "share an annotation by link". The link is the
// workspace URL + `#a=<annotationId>`; opening it loads the workspace through
// the EXISTING gate (membership / anyone-with-link), and the annotation lives in
// that workspace's document — so by the time this resolver runs, the pin is
// either present in the loaded doc or it isn't. There is NO separate annotation
// fetch and NO new access path: annotation access == workspace access.
//
// TIMING (why this is a separate, post-doc-load step — NOT part of UrlSync's
// scene-bootstrap): annotations exist only AFTER the workspace document snapshot
// has loaded into the scene. Resolving at initial bootstrap would search an
// empty document and focus an unloaded pin (the #802 class). The host (App.tsx)
// calls `resolveAnnotationDeepLink` from a post-document-load path keyed on the
// remote-document version, once the pins are actually readable.
//
// NEVER-LEAK: a recipient who lacks workspace access never reaches this code —
// the workspace load fails at the gate first (WorkspaceRoot renders the unified
// denied/not-found message). When the recipient DOES have access but the
// annotation id isn't in the loaded doc (deleted, or a wrong/forged id), the
// result is a plain `not-found` — the SAME outcome as a missing annotation —
// which the host surfaces as a non-blocking "couldn't be found" notice. No
// branch here distinguishes "exists but you can't see it" from "doesn't exist",
// because by construction this code only ever sees the doc the recipient is
// already authorized to read.

import type { Annotation } from "../components/annotationDocument.ts";

/** The minimal slice of `WasmScene` the resolver reads. Structural so it needn't
 *  depend on the WASM type and is trivial to drive in a test (the real
 *  `WasmScene` is assignable to it). Both methods return JSON strings. */
export interface AnnotationDocScene {
  /** Dataset ids that currently have at least one annotation, JSON array, in
   *  document order. Keyed off `document.annotations`, independent of manifests
   *  — so it surfaces a pin even on a dataset this client hasn't selected. */
  annotation_dataset_ids(): string;
  /** Pins (with nested comments) for `datasetId` as a JSON array, `"[]"` when
   *  none. */
  annotations(datasetId: string): string;
}

/** A found annotation plus the id of the dataset it lives on (the clamp target
 *  the LIGHT restore needs). */
export interface ResolvedAnnotation {
  status: "found";
  annotation: Annotation;
  datasetId: string;
}

/** The annotation id isn't present in the loaded document — deleted, or a
 *  wrong/forged id. Indistinguishable (by design) from a recipient who can't
 *  see it: this code only runs once the workspace doc is authorized + loaded. */
export interface AnnotationNotFound {
  status: "not-found";
}

export type AnnotationDeepLinkResult = ResolvedAnnotation | AnnotationNotFound;

/**
 * Resolve a `#a=<annotationId>` deep-link against the LOADED document: scan
 * every annotated dataset (the pin may live on any dataset in the workspace
 * doc, not just the selected one) and return the matching pin with its owning
 * dataset id, or `not-found`.
 *
 * Pure + total: never throws. A malformed/empty scene read degrades to
 * `not-found` rather than surfacing a false positive. Returns the FIRST match
 * in document order; annotation ids are client-minted UUIDs, so a collision
 * across datasets is not a real case.
 */
export function resolveAnnotationDeepLink(
  scene: AnnotationDocScene | null,
  annotationId: string,
): AnnotationDeepLinkResult {
  if (!scene) return { status: "not-found" };

  let datasetIds: string[];
  try {
    const parsed = JSON.parse(scene.annotation_dataset_ids()) as unknown;
    datasetIds = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return { status: "not-found" };
  }

  for (const datasetId of datasetIds) {
    if (typeof datasetId !== "string") continue;
    let pins: Annotation[];
    try {
      const parsed = JSON.parse(scene.annotations(datasetId)) as unknown;
      pins = Array.isArray(parsed) ? (parsed as Annotation[]) : [];
    } catch {
      continue;
    }
    // Guard each element: a malformed doc could carry a null/non-object entry,
    // and `p.id` on null would throw — breaking the "never throws / totality"
    // contract above. A bad element simply doesn't match.
    const match = pins.find(
      (p): p is Annotation => p != null && (p as Annotation).id === annotationId,
    );
    if (match) return { status: "found", annotation: match, datasetId };
  }

  return { status: "not-found" };
}
