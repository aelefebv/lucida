import type { Icon } from "@phosphor-icons/react";
import { useId } from "react";
import { SelectionIndicator, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Tooltip } from "./Tooltip.tsx";
import "./SegmentedControl.css";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon?: Icon;
}

export interface SegmentedControlProps<V extends string> {
  /** Names the group. Visible only with `labelPosition`. */
  label: string;
  /** Default `hidden`. */
  labelPosition?: "top" | "side" | "hidden";
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Show only icons, with the labels as tooltips. Every option needs an icon. */
  iconOnly?: boolean;
  /** Default `md`. */
  size?: "md" | "sm";
  isDisabled?: boolean;
  className?: string;
}

/** Pick one of two to four short options, all visible at once. */
export function SegmentedControl<V extends string>({
  label,
  labelPosition = "hidden",
  options,
  value,
  onChange,
  iconOnly,
  size = "md",
  isDisabled,
  className,
}: SegmentedControlProps<V>) {
  const labelId = useId();
  const group = (
    <ToggleButtonGroup
      className="lc-segmented"
      data-size={size}
      aria-label={labelPosition === "hidden" ? label : undefined}
      aria-labelledby={labelPosition === "hidden" ? undefined : labelId}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [next] = keys;
        if (next !== undefined && next !== value) onChange(next as V);
      }}
      isDisabled={isDisabled}
    >
      {options.map((option) => {
        const OptionIcon = option.icon;
        const segment = (
          <ToggleButton
            key={option.value}
            id={option.value}
            className="lc-segment"
            data-icon-only={iconOnly || undefined}
            aria-label={iconOnly ? option.label : undefined}
          >
            <SelectionIndicator className="lc-segment-indicator" />
            {OptionIcon && <OptionIcon className="lc-segment-icon" size={16} aria-hidden />}
            {!iconOnly && <span className="lc-segment-label">{option.label}</span>}
          </ToggleButton>
        );
        return iconOnly ? (
          <Tooltip key={option.value} content={option.label}>
            {segment}
          </Tooltip>
        ) : (
          segment
        );
      })}
    </ToggleButtonGroup>
  );
  if (labelPosition === "hidden") {
    return className ? <div className={className}>{group}</div> : group;
  }
  return (
    <div
      className={className ? `lc-field ${className}` : "lc-field"}
      data-label-position={labelPosition}
    >
      <span id={labelId} className="lc-field-label">
        {label}
      </span>
      <div className="lc-field-control">{group}</div>
    </div>
  );
}
