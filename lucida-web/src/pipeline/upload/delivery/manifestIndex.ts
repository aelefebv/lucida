/**
 * Per-image manifest index. Built once per `deliverToWorker` tick from
 * `ctx.datasets` so chunk dispatch is O(1) per chunk instead of O(D×I).
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
 * If two datasets contain images sharing an image_id (not expected in
 * practice), last-writer-wins.
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
