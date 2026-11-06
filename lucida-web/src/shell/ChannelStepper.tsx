import { StackIcon } from "@phosphor-icons/react";
import { IconButton } from "../ui/Button.tsx";
import { AxisScrubber } from "./AxisScrubber.tsx";

export interface ChannelStepperProps {
  c: number;
  dimC: number;
  onCChange: (c: number) => void;
  /** Composite of every channel, rather than the one at `c`. */
  multiChannel: boolean;
  onMultiChannelToggle: () => void;
}

/** Shows one channel at a time and steps through them, or shows all of them at once. */
export function ChannelStepper({ c, dimC, onCChange, multiChannel, onMultiChannelToggle }: ChannelStepperProps) {
  if (dimC <= 1) return null;
  const composite = (
    <IconButton
      icon={StackIcon}
      size="sm"
      label="Show all channels"
      isSelected={multiChannel}
      onSelectedChange={onMultiChannelToggle}
    />
  );
  if (multiChannel) {
    return (
      <div className="lc-dim-group" role="group" aria-label="Channel">
        <span className="lc-dim-axis" aria-hidden="true">
          C
        </span>
        {composite}
      </div>
    );
  }
  return (
    <AxisScrubber axis="C" name="channel" value={c} count={dimC} onChange={onCChange} trailing={composite} />
  );
}
