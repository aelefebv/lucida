/**
 * Per-image manifest index. Built once per `deliverToWorker` tick from
 * `ctx.datasets` so chunk dispatch is O(1) per chunk instead of O(D×I).
 */

import type {
  DatasetManifest,
  ImageSpec,
  LevelGeometry,
} from "../../../manifestTypes.ts";
import type { Level0 } from "../../../renderer/labelLayout.ts";
import type { DatasetEntry } from "../../../renderLoopTypes.ts";

export interface ManifestEntry {
  manifest: DatasetManifest;
  image: ImageSpec;
  levels: LevelGeometry[];
  /**
   * Set for a label overlay's own image (kept out of `manifest.images`).
   * Its presence routes delivery to the r32uint label pool via
   * `labelSliceChunkData` instead of the intensity `sliceChunkData`.
   */
  isLabel?: boolean;
  /**
   * Label-only: level-0 geometry of the label and its source image, so the
   * delivery path can map the current source Z to the label's own Z.
   */
  labelSourceLevel0?: Level0;
  labelLevel0?: Level0;
}

/**
 * If two datasets contain images sharing an image_id (not expected in
 * practice), last-writer-wins. Label images are indexed alongside the
 * intensity images (under their own distinct image ids) so their chunk
 * deliveries resolve geometry the same way.
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
    for (const label of ds.manifest.labels ?? []) {
      const source = ds.manifest.images.find(
        (img) => img.image_id === label.source_image_id,
      );
      const label0 = label.image.multiscale.levels[0];
      const source0 = source?.multiscale.levels[0] ?? label0;
      if (!label0) continue;
      out.set(label.image.image_id, {
        manifest: ds.manifest,
        image: label.image,
        levels: label.image.multiscale.levels,
        isLabel: true,
        labelSourceLevel0: { shape: source0.shape, scale: source0.scale },
        labelLevel0: { shape: label0.shape, scale: label0.scale },
      });
    }
  }
  return out;
}
