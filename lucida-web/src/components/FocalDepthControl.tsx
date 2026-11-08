/**
 * Focal-depth slider: biases the 3D center-out chunk-spawn origin along the
 * near-far axis. Shown only in 3D, in the dimension bar's camera popover.
 *
 * Reads and writes {@link configStore} `depthBiasView` (-1..1, 0 = centered)
 * directly. It persists as a preference and, unlike the Dev controls knobs,
 * applies with developer tools off. 0 leaves the planner unchanged (see
 * emit.ts `applyDepthBias`).
 */

import { CrosshairSimpleIcon } from "@phosphor-icons/react";
import { useSyncExternalStore } from "react";
import { configStore } from "../pipeline/planning/configStore.ts";
import { DEPTH_BIAS_VIEW } from "../pipeline/planning/config.ts";
import { IconButton } from "../ui/Button.tsx";
import { Slider } from "../ui/Slider.tsx";

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
    <div className="lc-focal-depth" data-testid="focal-depth-control">
      <div className="lc-focal-depth-header">
        <span className="lc-focal-depth-label">Focal depth</span>
        <IconButton
          icon={CrosshairSimpleIcon}
          size="sm"
          label="Reset focal depth to center"
          isDisabled={centered}
          onPress={() => configStore.reset("depthBiasView")}
        />
      </div>
      <p className="lc-focal-depth-hint">Which depth loads first.</p>
      <Slider
        label="Focal depth"
        labelPosition="hidden"
        valueDisplay="none"
        minValue={MIN}
        maxValue={MAX}
        step={STEP}
        value={value}
        onChange={onChange}
      />
      <div className="lc-focal-depth-ends" aria-hidden="true">
        <span>Near</span>
        <span>Far</span>
      </div>
    </div>
  );
}
