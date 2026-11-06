import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "../ui/Button.tsx";
import type { KeyCombo } from "../ui/shortcuts.ts";
import { Slider } from "../ui/Slider.tsx";

export interface AxisScrubberProps {
  /** The short letter drawn before the controls, e.g. `Z`. */
  axis: string;
  /** What one position is called, in lower case after its first letter, e.g. `Z plane`. */
  name: string;
  /** Zero-based. */
  value: number;
  /** How many positions the axis has. */
  count: number;
  /** Called with a zero-based position, from the slider or a step button. */
  onChange: (value: number) => void;
  previousShortcut?: readonly KeyCombo[];
  nextShortcut?: readonly KeyCombo[];
  /** Drawn after the letter, e.g. a play button. */
  leading?: ReactNode;
  /** Drawn after the readout. */
  trailing?: ReactNode;
}

/** Step buttons, a slider, and an `n / total` readout for one axis. */
export function AxisScrubber({
  axis,
  name,
  value,
  count,
  onChange,
  previousShortcut,
  nextShortcut,
  leading,
  trailing,
}: AxisScrubberProps) {
  const last = count - 1;
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <div className="lc-dim-group lc-dim-scrubber" role="group" aria-label={title}>
      <span className="lc-dim-axis" aria-hidden="true">
        {axis}
      </span>
      {leading}
      <IconButton
        icon={CaretLeftIcon}
        size="sm"
        label={`Previous ${name}`}
        shortcut={previousShortcut}
        isDisabled={value <= 0}
        onPress={() => onChange(Math.max(0, value - 1))}
      />
      {/* One-based, so the value a screen reader announces matches the readout. */}
      <Slider
        label={title}
        labelPosition="hidden"
        valueDisplay="none"
        minValue={1}
        maxValue={count}
        value={value + 1}
        onChange={(position) => onChange(position - 1)}
        className="lc-dim-slider"
      />
      <IconButton
        icon={CaretRightIcon}
        size="sm"
        label={`Next ${name}`}
        shortcut={nextShortcut}
        isDisabled={value >= last}
        onPress={() => onChange(Math.min(last, value + 1))}
      />
      <span className="lc-dim-readout" aria-hidden="true">
        {/* Wide enough for the largest position, so the readout never shifts. */}
        <span className="lc-dim-readout-value" style={{ minWidth: `${String(count).length}ch` }}>
          {value + 1}
        </span>
        {` / ${count}`}
      </span>
      {trailing}
    </div>
  );
}
