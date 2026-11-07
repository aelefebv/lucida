import { Switch as AriaSwitch } from "react-aria-components";
import "./Switch.css";

export interface SwitchProps {
  label: string;
  /** `side` puts the label at the left and the switch at the right. Default `side`. */
  labelPosition?: "side" | "hidden";
  description?: string;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
  className?: string;
}

/** An on/off setting that applies at once. */
export function Switch({
  label,
  labelPosition = "side",
  description,
  isSelected,
  onChange,
  isDisabled,
  className,
}: SwitchProps) {
  return (
    <AriaSwitch
      className={className ? `lc-switch ${className}` : "lc-switch"}
      data-label-position={labelPosition}
      aria-label={labelPosition === "hidden" ? label : undefined}
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
    >
      {labelPosition !== "hidden" && (
        <span className="lc-switch-text">
          <span className="lc-switch-label">{label}</span>
          {description && <span className="lc-switch-description">{description}</span>}
        </span>
      )}
      <span className="lc-switch-track" aria-hidden>
        <span className="lc-switch-thumb" />
      </span>
    </AriaSwitch>
  );
}
