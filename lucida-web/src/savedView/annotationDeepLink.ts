// Resolve a `#a=<annotation-id>` deep link against the loaded workspace
// document. Annotation access is workspace access: there is no separate fetch,
// and a recipient without access fails at the workspace gate before this runs.
//
// The host calls this after the document snapshot loads, not at UrlSync's
// scene bootstrap, because annotations don't exist until then. A missing id is
// a plain `not-found`; nothing here can tell "exists but hidden" from "doesn't
// exist", because this code only sees a document the recipient may read.

import type { Annotation } from "../components/annotationDocument.ts";

/** The slice of `WasmScene` the resolver reads, structural so tests can drive
 *  it. Both methods return JSON strings. */
export interface AnnotationDocScene {
  /** Dataset ids with at least one annotation, in document order. Independent
   *  of manifests, so it finds a pin on a dataset this client hasn't
   *  selected. */
  annotation_dataset_ids(): string;
  /** Pins (with nested comments) for `datasetId`, `"[]"` when none. */
  annotations(datasetId: string): string;
}

/** A found annotation plus its dataset id, the clamp target the light restore
 *  needs. */
export interface ResolvedAnnotation {
  status: "found";
  annotation: Annotation;
  datasetId: string;
}

/** The id isn't in the loaded document: deleted, wrong, or forged. */
export interface AnnotationNotFound {
  status: "not-found";
}

export type AnnotationDeepLinkResult = ResolvedAnnotation | AnnotationNotFound;

/**
 * Find the pin across every annotated dataset, not just the selected one.
 * Never throws: a malformed scene read degrades to `not-found`. Returns the
 * first match in document order; ids are client-minted UUIDs.
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
    // A malformed doc could hold a null entry; `p.id` on it would throw.
    const match = pins.find(
      (p): p is Annotation => p != null && (p as Annotation).id === annotationId,
    );
    if (match) return { status: "found", annotation: match, datasetId };
  }

  return { status: "not-found" };
}
