/**
 * The 3D clip plane as a fraction of the volume's depth. The scene stores the
 * plane as a distance from the eye, which means nothing to a reader and shifts
 * as the camera moves; a fraction of the depth the dataset spans in front of
 * the camera reads the same from any angle: 0 hides nothing and 1 reaches the
 * far side.
 */
import type { WasmScene } from "lucida-core";

/** Reads and moves the clip plane as a fraction of the volume's depth. */
export interface ClipDepth {
  read: () => number;
  write: (fraction: number) => void;
}

/** Distances from the eye, along the view direction, that the dataset's box
 * spans, or null when it has none in front of the camera. */
function depthSpan(scene: WasmScene, datasetId: string): [number, number] | null {
  const b = scene.dataset_fit_bounds(datasetId);
  if (b.length < 6) return null;
  const eye = scene.eye_position();
  const forward = scene.camera_forward();
  let near = Infinity;
  let far = -Infinity;
  for (const x of [b[0], b[3]]) {
    for (const y of [b[1], b[4]]) {
      for (const z of [b[2], b[5]]) {
        const d = (x - eye[0]) * forward[0] + (y - eye[1]) * forward[1] + (z - eye[2]) * forward[2];
        near = Math.min(near, d);
        far = Math.max(far, d);
      }
    }
  }
  near = Math.max(near, 0);
  return far > near ? [near, far] : null;
}

/** A {@link ClipDepth} over the live scene. `onChange` repaints and shares the
 * camera, as the keys do. */
export function sceneClipDepth(scene: WasmScene, datasetId: string, onChange: () => void): ClipDepth {
  return {
    read: () => {
      const span = depthSpan(scene, datasetId);
      const distance = scene.clip_distance();
      if (!span || distance <= 0) return 0;
      return Math.min(1, Math.max(0, (distance - span[0]) / (span[1] - span[0])));
    },
    write: (fraction) => {
      const span = depthSpan(scene, datasetId);
      if (!span) return;
      const target = fraction <= 0 ? 0 : span[0] + fraction * (span[1] - span[0]);
      scene.adjust_clip_distance(target - scene.clip_distance());
      onChange();
    },
  };
}
