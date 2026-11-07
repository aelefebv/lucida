/**
 * Resolve which dataset's annotations the mention badge and candidate builder
 * read.
 *
 * `selectedDatasetId` is null until a dataset is selected, and auto-select only
 * fires when exactly one dataset is open. A peer's annotations can land in that
 * window, so with nothing selected this falls back to the first dataset that has
 * annotations. That set is keyed off `document.annotations`, not manifests, so
 * it works for a dataset this client hasn't opened.
 */
import type { Annotation } from "./annotationDocument.ts";

/** The slice of `WasmScene` this resolver reads, structural so tests can drive
 * it. Both methods return JSON strings. */
export interface AnnotationScene {
  /** Pins (with nested comments) for `datasetId` as a JSON array, `"[]"` when
   * none. */
  annotations(datasetId: string): string;
  /** Dataset ids that currently have at least one annotation, JSON array, in
   * document order. Keyed off `document.annotations`, independent of manifests. */
  annotation_dataset_ids(): string;
}

/**
 * The dataset the mention machinery and annotation navigation treat as current:
 * `selectedDatasetId` if truthy, else the first dataset with annotations, else
 * null.
 *
 * This is the id {@link currentDatasetAnnotations} reads from, so a caller can
 * recover a found pin's owning dataset even with nothing selected. Restore
 * clamps Z/T/C against that dataset's extents; clamping against `""` would hit
 * the `[1,1,1]` sentinel shape and collapse a deep slab to plane 0.
 */
export function resolveAnnotationDatasetId(
  scene: AnnotationScene | null,
  selectedDatasetId: string | null,
): string | null {
  if (selectedDatasetId) return selectedDatasetId;
  if (!scene) return null;
  try {
    const annotated = JSON.parse(scene.annotation_dataset_ids()) as unknown;
    if (Array.isArray(annotated) && typeof annotated[0] === "string") {
      return annotated[0];
    }
  } catch {
    // annotation_dataset_ids unreadable — no resolvable dataset.
  }
  return null;
}

/**
 * The current dataset's annotations for the mention indicator and candidate
 * builder. Returns `[]` rather than throwing on a missing scene or bad JSON, so
 * a failure reads as "no mentions", not a false count.
 */
export function currentDatasetAnnotations(
  scene: AnnotationScene | null,
  selectedDatasetId: string | null,
): Annotation[] {
  if (!scene) return [];

  const datasetId = resolveAnnotationDatasetId(scene, selectedDatasetId);
  if (!datasetId) return [];

  try {
    const parsed = JSON.parse(scene.annotations(datasetId)) as unknown;
    return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
  } catch {
    return [];
  }
}
