/**
 * Resolve the annotations the mention machinery should read (issue #526 / the
 * #802 fix).
 *
 * The "mentions of me" badge and the @-mention candidate builder both read the
 * CURRENT dataset's annotations. "Current" is normally the user's selected
 * dataset — but `selectedDatasetId` is `null` until a dataset is actually
 * selected, and the auto-select only fires when exactly one dataset is open
 * (see `setupFetchPipeline` in sessionController.ts). That leaves a real window — a
 * peer-opened dataset, or a multi-/zero-dataset snapshot — where a peer's
 * annotations have ALREADY landed in the scene while nothing is selected.
 *
 * Bug #802: in that window, reading `null` returned `[]`, so the FIRST inbound
 * @-mention was invisible in the indicator until a later selection (or a page
 * refresh whose snapshot carries the manifest) happened to re-run the read; a
 * LATER mention then appeared "live" only because selection had since occurred.
 *
 * The fix: when nothing is selected, fall back to the first dataset that
 * actually HAS annotations. That set is keyed independently of the manifests
 * (`annotation_dataset_ids()` reads `document.annotations`, not `manifests`), so
 * it surfaces a peer's pin even for a dataset this client hasn't opened yet — so
 * the indicator reflects a mention the moment it arrives rather than waiting on
 * a selection. A truthy `selectedDatasetId` always wins, so a user who has a
 * dataset selected sees exactly the previous behavior (their dataset, scoped).
 */
import type { Annotation } from "./annotationDocument.ts";

/** The minimal slice of `WasmScene` this resolver reads — kept structural so it
 * needn't depend on the WASM type and is trivial to drive in a test (the real
 * `WasmScene` is assignable to it). Both methods return JSON strings. */
export interface AnnotationScene {
  /** Pins (with nested comments) for `datasetId` as a JSON array, `"[]"` when
   * none. */
  annotations(datasetId: string): string;
  /** Dataset ids that currently have at least one annotation, JSON array, in
   * document order. Keyed off `document.annotations`, independent of manifests. */
  annotation_dataset_ids(): string;
}

/**
 * Resolve WHICH dataset the mention machinery (and, crucially, the annotation
 * navigation) should treat as "current": `selectedDatasetId` if truthy, else the
 * first dataset that actually HAS annotations. Returns `null` when there is no
 * scene, nothing is selected, and no dataset has annotations (or the scene
 * returns malformed JSON).
 *
 * This is the SAME id the pin set below was read from, so a caller that found a
 * pin in `currentDatasetAnnotations(scene, selectedDatasetId)` can recover the
 * pin's OWNING dataset id with `resolveAnnotationDatasetId(scene,
 * selectedDatasetId)` — even in the null-selection window (multi-/zero-dataset
 * snapshots) where `selectedDatasetId` is null but a peer's pin has already
 * landed via the inbox. Restore uses this to clamp a captured Z/T/C against the
 * pin's real extents instead of `""` (whose WASM `dataset_volume_shape` is the
 * `[1,1,1]` sentinel — clamping against it collapses a deep slab to plane 0, the
 * #814 regression class).
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
 * The annotations for the mention indicator/candidate builder, given the live
 * scene (or `null` before it exists) and the user's selected dataset (or `null`
 * before one is selected).
 *
 * Resolution: `selectedDatasetId` if truthy, else the first dataset that has
 * annotations. Returns `[]` (never throws) when there is no scene, no resolvable
 * dataset, or the scene returns malformed JSON — degrading to "no mentions"
 * rather than surfacing a false count.
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
