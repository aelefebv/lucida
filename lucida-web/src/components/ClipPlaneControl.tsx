/**
 * Clip-plane slider for the 3D view, the on-screen twin of the `[` and `]`
 * keys. Shown in the dimension bar's camera popover.
 */
import { EraserIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { frameClock } from "../frameClock.ts";
import { IconButton } from "../ui/Button.tsx";
import { Slider } from "../ui/Slider.tsx";
import type { ClipDepth } from "./clipDepth.ts";

export function ClipPlaneControl({ depth }: { depth: ClipDepth }) {
  const [value, setValue] = useState(() => depth.read());
  // The host may pass a fresh object each render; the loop reads the latest.
  const depthRef = useRef(depth);
  useEffect(() => {
    depthRef.current = depth;
  });

  // The keys and the camera move the plane while this is open, so follow it.
  useEffect(() => frameClock.subscribe(() => setValue(depthRef.current.read())), []);

  const move = (next: number) => {
    if (Number.isNaN(next)) return;
    depth.write(next);
    setValue(depth.read());
  };

  return (
    <div className="lc-focal-depth" data-testid="clip-plane-control">
      <div className="lc-focal-depth-header">
        <span className="lc-focal-depth-label">Clip plane</span>
        <IconButton
          icon={EraserIcon}
          size="sm"
          label="Clear the clip plane"
          isDisabled={value === 0}
          onPress={() => move(0)}
        />
      </div>
      <p className="lc-focal-depth-hint">Hides what’s nearer than it.</p>
      <Slider
        label="Clip plane"
        labelPosition="hidden"
        valueDisplay="none"
        minValue={0}
        maxValue={1}
        step={0.01}
        value={value}
        onChange={move}
      />
      <div className="lc-focal-depth-ends" aria-hidden="true">
        <span>Off</span>
        <span>Far side</span>
      </div>
    </div>
  );
}
