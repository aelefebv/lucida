/**
 * Per-image manifest index for fast O(1) lookup during chunk dispatch.
 *
 * Built once per `deliverToWorker` tick from `ctx.datasets`. Replaces
 * the per-chunk O(D × I) scan that the old `sendDeliveryToWorker`
 * helper did when resolving manifest + image spec + level meta.
 *
 * See Pass 1 Risk C, Pass 2 Seam D, Pass 6 Item 7 of the dechaos
 * upload scan for the rationale.
 */

import type {
  DatasetManifest,
  ImageSpec,
  LevelGeometry,
} from "../../../manifestTypes.ts";
import type { DatasetEntry } from "../../../renderLoopTypes.ts";

export interface ManifestEntry {
  manifest: DatasetManifest;
  image: ImageSpec;
  levels: LevelGeometry[];
}

/**
 * Build a per-image index from the per-dataset manifests for fast
 * O(1) lookup during chunk dispatch. Eliminates the O(D × I) per-chunk
 * manifest scan that `sendDeliveryToWorker` used to do.
 *
 * If two datasets contain images sharing an image_id (not expected in
 * practice), last-writer-wins — same behaviour as the previous linear
 * scan, which also returned the first matching dataset.
 */
export function buildManifestByImage(
  datasets: Map<string, DatasetEntry>,
): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>();
  for (const [, ds] of datasets) {
    for (const image of ds.manifest.images) {
      out.set(image.image_id, {
        manifest: ds.manifest,
        image,
        levels: image.multiscale.levels,
      });
    }
  }
  return out;
}
