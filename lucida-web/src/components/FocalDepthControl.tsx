/**
 * Focal-depth slider: biases the 3D center-out chunk-spawn origin along the
 * near-far axis. Shown only in 3D, in the dimension-controls row beside
 * {@link DimensionControls}.
 *
 * Reads and writes {@link configStore} `depthBiasView` (-1..1, 0 = centered)
 * directly, so it persists like every other planning tunable. 0 leaves the
 * planner unchanged (see emit.ts `applyDepthBias`).
 */

import { useSyncExternalStore } from "react";
import { configStore } from "../pipeline/planning/configStore.ts";
import { DEPTH_BIAS_VIEW } from "../pipeline/planning/config.ts";

/** Slider bounds for the near↔far bias. Mirrors the configStore field range. */
const MIN = -1;
const MAX = 1;
const STEP = 0.05;

function useDepthBias(): number {
  return useSyncExternalStore(
    (cb) => configStore.subscribe(cb),
    () => configStore.get().depthBiasView,
    () => configStore.get().depthBiasView,
  );
}

export function FocalDepthControl() {
  const value = useDepthBias();
  const centered = value === DEPTH_BIAS_VIEW;

  const onChange = (next: number) => {
    if (Number.isNaN(next)) return;
    const clamped = Math.min(MAX, Math.max(MIN, next));
    configStore.set("depthBiasView", clamped);
  };

  return (
    <div className="dim-control" data-testid="focal-depth-control">
      <span className="dim-label" title="3D chunk-spawn focal depth (near↔far)">
        Focal
      </span>
      <span className="dim-endcap" aria-hidden="true">
        near
      </span>
      <input
        type="range"
        className="dim-slider"
        aria-label="Focal depth (near↔far)"
        min={MIN}
        max={MAX}
        step={STEP}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="dim-endcap" aria-hidden="true">
        far
      </span>
      <button
        className="dim-btn"
        aria-label="Reset focal depth to center"
        title="Reset focal depth to center"
        disabled={centered}
        onClick={() => configStore.reset("depthBiasView")}
      >
        ⌖
      </button>
    </div>
  );
}
